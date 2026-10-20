
import { db } from 'sdk';
import { uploadSessions } from '../schema.js';
import { and, desc, eq, inArray, or } from 'sdk/db';

export const OPERATION_RECOVERY_DELAY_SECONDS = 300;

export async function createUploadSession({
  mode,
  ownerUserId,
  ownerChatId,
  seriesId,
  sectionId,
}) {
  if (!['add', 'replace', 'append'].includes(mode)) {
    throw new Error('Invalid upload session mode.');
  }

  if (
    !Number.isSafeInteger(ownerUserId) ||
    !Number.isSafeInteger(ownerChatId) ||
    !Number.isSafeInteger(seriesId) ||
    !Number.isSafeInteger(sectionId)
  ) {
    throw new Error('Session IDs must be safe integers.');
  }

  const blockingSession = await findBlockingUploadSession(ownerUserId);

  if (blockingSession) {
    throw new Error(
      `Upload session ${blockingSession.id} is already active or awaiting review.`,
    );
  }

  const [session] = await db
    .insert(uploadSessions)
    .values({
      mode,
      status: 'uploading',
      ownerUserId,
      ownerChatId,
      seriesId,
      sectionId,
    })
    .returning()
    .run();

  return session;
}

export async function findActiveUploadSession(ownerUserId) {
  return await db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.ownerUserId, ownerUserId),
        eq(uploadSessions.status, 'uploading'),
      ),
    )
    .orderBy(desc(uploadSessions.id))
    .limit(1)
    .get();
}

export async function findReviewUploadSession(ownerUserId) {
  return await db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.ownerUserId, ownerUserId),
        inArray(uploadSessions.status, ['review', 'publishing', 'discarding']),
      ),
    )
    .orderBy(desc(uploadSessions.id))
    .limit(1)
    .get();
}

export async function findBlockingUploadSession(ownerUserId) {
  return await db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.ownerUserId, ownerUserId),
        or(
          eq(uploadSessions.status, 'uploading'),
          eq(uploadSessions.status, 'review'),
          eq(uploadSessions.status, 'publishing'),
          eq(uploadSessions.status, 'discarding'),
        ),
      ),
    )
    .orderBy(desc(uploadSessions.id))
    .limit(1)
    .get();
}

export async function getUploadSession(sessionId, ownerUserId) {
  return await db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.id, sessionId),
        eq(uploadSessions.ownerUserId, ownerUserId),
      ),
    )
    .get();
}

export async function setUploadSessionStatus(
  sessionId,
  ownerUserId,
  status,
) {
  if (!['uploading', 'review', 'confirmed', 'discarded'].includes(status)) {
    throw new Error('Invalid upload session status.');
  }

  const result = await db
    .update(uploadSessions)
    .set({
      status,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(
      and(
        eq(uploadSessions.id, sessionId),
        eq(uploadSessions.ownerUserId, ownerUserId),
        eq(uploadSessions.status, 'uploading'),
      ),
    )
    .run();

  return result;
}
