
import { db } from 'sdk';
import { and, eq, inArray, lt, ne } from 'sdk/db';
import { episodes, sections, series, uploadSessions } from '../schema.js';
import {
  getUploadSession,
  OPERATION_RECOVERY_DELAY_SECONDS,
} from './sessions.js';
import { analyzeUploadSession } from './episodes.js';

export async function publishUploadSession({
  sessionId,
  ownerUserId,
  allowReviewFlags = false,
}) {
  const session = await getUploadSession(sessionId, ownerUserId);

  if (!session || !['review', 'publishing'].includes(session.status)) {
    throw new Error('The upload must be in review before publishing.');
  }

  if (!['add', 'replace', 'append'].includes(session.mode)) {
    throw new Error('Invalid upload session mode.');
  }

  const section = await db
    .select()
    .from(sections)
    .where(eq(sections.id, session.sectionId))
    .get();

  if (!section || section.seriesId !== session.seriesId) {
    throw new Error('The upload session has an invalid target section.');
  }

  const seriesRecord = await db
    .select()
    .from(series)
    .where(eq(series.id, session.seriesId))
    .get();

  if (!seriesRecord) {
    throw new Error('The target series was not found.');
  }

  const review = await analyzeUploadSession(sessionId, ownerUserId);

  if (review.totalEpisodes === 0) {
    throw new Error('Cannot publish an empty upload session.');
  }

  if (review.needsReview && !allowReviewFlags) {
    throw new Error(
      'This batch has review flags. Use the explicit warning confirmation after reviewing them.',
    );
  }

  // Include already-published rows so an interrupted attempt can be retried.
  const batchEpisodeCount = await db.$count(
    episodes,
    eq(episodes.sessionId, sessionId),
  );

  if (batchEpisodeCount !== review.totalEpisodes) {
    throw new Error(
      'The batch changed during review. Run /done again and review it before confirming.',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const claimConditions = [
    eq(uploadSessions.id, sessionId),
    eq(uploadSessions.ownerUserId, ownerUserId),
  ];

  if (session.status === 'review') {
    claimConditions.push(eq(uploadSessions.status, 'review'));
  } else {
    claimConditions.push(
      eq(uploadSessions.status, 'publishing'),
      eq(uploadSessions.updatedAt, session.updatedAt),
      lt(
        uploadSessions.updatedAt,
        now - OPERATION_RECOVERY_DELAY_SECONDS,
      ),
    );
  }

  const publishingSession = await db
    .update(uploadSessions)
    .set({
      status: 'publishing',
      updatedAt: now,
    })
    .where(and(...claimConditions))
    .run();

  if (publishingSession.rowsAffected !== 1) {
    throw new Error(
      session.status === 'publishing'
        ? 'Publication is already running. If it was interrupted by a restart, retry the confirmation after five minutes.'
        : 'Another request changed the upload batch before publication could start.',
    );
  }

  let publishingLeaseUpdatedAt = now;

  async function renewPublishingLease() {
    const updatedAt = Math.floor(Date.now() / 1000);
    const result = await db
      .update(uploadSessions)
      .set({ updatedAt })
      .where(
        and(
          eq(uploadSessions.id, sessionId),
          eq(uploadSessions.ownerUserId, ownerUserId),
          eq(uploadSessions.status, 'publishing'),
          eq(uploadSessions.updatedAt, publishingLeaseUpdatedAt),
        ),
      )
      .run();

    if (result.rowsAffected !== 1) {
      throw new Error('The publication recovery claim expired or was taken over.');
    }

    publishingLeaseUpdatedAt = updatedAt;
  }

  let replacedPosts = [];

  if (session.mode === 'replace') {
    replacedPosts = await db
      .select({
        id: episodes.id,
        vaultChatId: episodes.vaultChatId,
        vaultMessageId: episodes.vaultMessageId,
      })
      .from(episodes)
      .where(
        and(
          eq(episodes.sectionId, session.sectionId),
          eq(episodes.published, true),
          ne(episodes.sessionId, sessionId),
        ),
      )
      .all();
  }

  // Step 1: make every episode in the new batch available.
  await db
    .update(episodes)
    .set({ published: true })
    .where(eq(episodes.sessionId, sessionId))
    .run();
  await renewPublishingLease();

  // Step 2: for replacements, retire only the old entries in this section.
  if (session.mode === 'replace' && replacedPosts.length > 0) {
    await db
      .update(episodes)
      .set({ published: false })
      .where(inArray(episodes.id, replacedPosts.map((episode) => episode.id)))
      .run();
    await renewPublishingLease();
  }

  // Step 3: expose the section and series after the episode updates.
  await db
    .update(sections)
    .set({ published: true })
    .where(eq(sections.id, session.sectionId))
    .run();
  await renewPublishingLease();

  await db
    .update(series)
    .set({
      published: true,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(series.id, session.seriesId))
    .run();
  await renewPublishingLease();

  // Mark the session complete last, so an earlier failure can be retried.
  const confirmedSession = await db
    .update(uploadSessions)
    .set({
      status: 'confirmed',
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(
      and(
        eq(uploadSessions.id, sessionId),
        eq(uploadSessions.ownerUserId, ownerUserId),
        eq(uploadSessions.status, 'publishing'),
        eq(uploadSessions.updatedAt, publishingLeaseUpdatedAt),
      ),
    )
    .run();

  if (confirmedSession.rowsAffected !== 1) {
    throw new Error(
      'The episodes were updated, but publication could not be finalized. Retry confirmation to complete recovery.',
    );
  }

  return {
    sessionId,
    publishedEpisodes: batchEpisodeCount,
    reviewFlagsPresent: review.needsReview,
    replacedPosts: replacedPosts.map((episode) => ({
      vaultChatId: episode.vaultChatId,
      vaultMessageId: episode.vaultMessageId,
    })),
  };
}
