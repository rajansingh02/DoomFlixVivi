
import { api, BotApiError, db } from 'sdk';
import { and, desc, eq, inArray, lt } from 'sdk/db';
import { episodes, sections, series, uploadSessions } from '../schema.js';
import { isOwner } from './config.js';
import {
  findBlockingUploadSession,
  findReviewUploadSession,
  getUploadSession,
  OPERATION_RECOVERY_DELAY_SECONDS,
} from './sessions.js';
import { publishUploadSession } from './publishing.js';
import {
  getOwnerDraft,
  updateOwnerDraft,
} from './drafts.js';

export async function handleOwnerReviewCommand(message) {
  const userId = message.from?.id;
  const chat = message.chat;
  const text = message.text?.trim();

  if (
    !userId ||
    !chat ||
    chat.type !== 'private' ||
    !isOwner(userId) ||
    !text
  ) {
    return false;
  }

  const command = text.match(
    /^\/(confirm|confirm_with_warnings|discard|partcontinue)(?:@\w+)?$/i,
  );

  if (!command) return false;

  const action = command[1].toLowerCase();

  if (action === 'partcontinue') {
    const draft = await getOwnerDraft(userId);
    if (
      !draft ||
      draft.ownerChatId !== chat.id ||
      draft.step !== 'part_upload' ||
      !Number.isSafeInteger(draft.seriesId) ||
      !Number.isSafeInteger(draft.sectionId)
    ) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'There is no interrupted part-entry workflow to resume.',
      });
      return true;
    }

    const blockingSession = await findBlockingUploadSession(userId);
    if (blockingSession) {
      await api.sendMessage({
        chat_id: chat.id,
        text:
          'A part upload is still active or awaiting review. Finish or discard it before continuing part entry.',
      });
      return true;
    }

    const confirmedSession = await db
      .select({ sectionId: uploadSessions.sectionId })
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.ownerUserId, userId),
          eq(uploadSessions.seriesId, draft.seriesId),
          eq(uploadSessions.sectionId, draft.sectionId),
          eq(uploadSessions.status, 'confirmed'),
          eq(uploadSessions.mode, 'add'),
        ),
      )
      .orderBy(desc(uploadSessions.id))
      .limit(1)
      .get();
    const section = confirmedSession
      ? await db
          .select()
          .from(sections)
          .where(eq(sections.id, confirmedSession.sectionId))
          .get()
      : null;

    if (
      !section ||
      section.seriesId !== draft.seriesId ||
      section.partNumber < 1 ||
      !section.published
    ) {
      await api.sendMessage({
        chat_id: chat.id,
        text:
          'The part upload is not confirmed yet. Complete the current upload or review, then retry /partcontinue.',
      });
      return true;
    }

    await updateOwnerDraft(userId, { step: 'part_wait' });
    await api.sendMessage({
      chat_id: chat.id,
      text: 'The last part was already published. Continue part entry or finish.',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Add another part', callback_data: 'partflow:add' },
          { text: 'Finish', callback_data: 'partflow:finish' },
        ]],
      },
    });
    return true;
  }

  const session = await findReviewUploadSession(userId);

  if (!session || session.ownerChatId !== chat.id) {
    await api.sendMessage({
      chat_id: chat.id,
      text: 'There is no upload batch awaiting review.',
    });
    return true;
  }

  if (action === 'confirm' || action === 'confirm_with_warnings') {
    if (session.status !== 'review' && session.status !== 'publishing') {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'This batch is being discarded or is no longer awaiting publication.',
      });
      return true;
    }

    let result;
    try {
      result = await publishUploadSession({
        sessionId: session.id,
        ownerUserId: userId,
        allowReviewFlags: action === 'confirm_with_warnings',
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      await api.sendMessage({
        chat_id: chat.id,
        text:
          `Publication was not completed: ${errorMessage}\n\n` +
          'Review the batch and try the appropriate confirmation command.',
      });
      return true;
    }

    await api.sendMessage({
      chat_id: chat.id,
      text:
        'Publication completed.\n\n' +
        `Session: ${result.sessionId}\n` +
        `Episodes published: ${result.publishedEpisodes}\n` +
        `Review warnings were present: ${result.reviewFlagsPresent ? 'Yes' : 'No'}\n\n` +
        'The series is now available through group search.',
    });

    let draft;
    try {
      draft = await getOwnerDraft(userId);
    } catch (error) {
      await api.sendMessage({
        chat_id: chat.id,
        text:
          'Publication completed, but the follow-up workflow state could not be checked. ' +
          'If this was a part upload, send /partcontinue to resume. ' +
          `Database error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
      return true;
    }
    if (
      draft?.step === 'part_upload' &&
      draft.ownerChatId === chat.id &&
      draft.seriesId === session.seriesId &&
      draft.sectionId === session.sectionId
    ) {
      try {
        await updateOwnerDraft(userId, { step: 'part_wait' });
        await api.sendMessage({
          chat_id: chat.id,
          text: 'This part is published. Add another part or finish part entry.',
          reply_markup: {
            inline_keyboard: [[
              { text: 'Add another part', callback_data: 'partflow:add' },
              { text: 'Finish', callback_data: 'partflow:finish' },
            ]],
          },
        });
      } catch (error) {
        await api.sendMessage({
          chat_id: chat.id,
          text:
            'The part was published, but the part-entry workflow could not be advanced. ' +
            `Send /partcontinue to resume. Database error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }

    return true;
  }

  if (session.status === 'publishing') {
    await api.sendMessage({
      chat_id: chat.id,
      text: 'Publication is running and cannot be discarded. Retry /discard only if publication is not in progress.',
    });
    return true;
  }

  const now = Math.floor(Date.now() / 1000);
  const discardConditions = [
    eq(uploadSessions.id, session.id),
    eq(uploadSessions.ownerUserId, userId),
  ];

  if (session.status === 'review') {
    discardConditions.push(eq(uploadSessions.status, 'review'));
  } else {
    discardConditions.push(
      eq(uploadSessions.status, 'discarding'),
      eq(uploadSessions.updatedAt, session.updatedAt),
      lt(
        uploadSessions.updatedAt,
        now - OPERATION_RECOVERY_DELAY_SECONDS,
      ),
    );
  }

  const discardStarted = await db
    .update(uploadSessions)
    .set({
      status: 'discarding',
      updatedAt: now,
    })
    .where(and(...discardConditions))
    .run();

  if (discardStarted.rowsAffected !== 1) {
    await api.sendMessage({
      chat_id: chat.id,
      text:
        session.status === 'discarding'
          ? 'Discard cleanup is already running. If it was interrupted by a restart, retry /discard after five minutes.'
          : 'The upload batch changed before cleanup could start. Check its status and retry.',
    });
    return true;
  }

  const stagedEpisodes = await db
    .select({
      id: episodes.id,
      vaultChatId: episodes.vaultChatId,
      vaultMessageId: episodes.vaultMessageId,
    })
    .from(episodes)
    .where(
      and(
        eq(episodes.sessionId, session.id),
        eq(episodes.published, false),
      ),
    )
    .all();

  const deletedEpisodeIds = [];
  let discardLeaseUpdatedAt = now;

  async function renewDiscardLease() {
    const updatedAt = Math.floor(Date.now() / 1000);
    const result = await db
      .update(uploadSessions)
      .set({ updatedAt })
      .where(
        and(
          eq(uploadSessions.id, session.id),
          eq(uploadSessions.ownerUserId, userId),
          eq(uploadSessions.status, 'discarding'),
          eq(uploadSessions.updatedAt, discardLeaseUpdatedAt),
        ),
      )
      .run();

    if (result.rowsAffected !== 1) {
      throw new Error('The discard recovery claim expired or was taken over.');
    }

    discardLeaseUpdatedAt = updatedAt;
  }

  for (const episode of stagedEpisodes) {
    try {
      await api.deleteMessage({
        chat_id: episode.vaultChatId,
        message_id: episode.vaultMessageId,
      });
      deletedEpisodeIds.push(episode.id);
    } catch (error) {
      const alreadyDeleted =
        error instanceof BotApiError &&
        error.code === 400 &&
        /message to delete not found/i.test(error.description ?? '');

      if (alreadyDeleted) {
        deletedEpisodeIds.push(episode.id);
      } else if (error instanceof BotApiError && error.code === 429) {
        break;
      }
    }

    await renewDiscardLease();
  }

  const deleteFailures = stagedEpisodes.length - deletedEpisodeIds.length;

  // Remove only records whose vault posts were successfully deleted.
  for (let start = 0; start < deletedEpisodeIds.length; start += 500) {
    const batch = deletedEpisodeIds.slice(start, start + 500);
    await db
      .delete(episodes)
      .where(inArray(episodes.id, batch))
      .run();
    await renewDiscardLease();
  }

  const draft = await getOwnerDraft(userId);

  // For a new series, remove the empty unpublished section and series
  // only when every staged vault post was deleted successfully.
  if (session.mode === 'add' && deleteFailures === 0) {
    const activePartWorkflow =
      draft?.step === 'part_upload' &&
      draft.ownerChatId === chat.id &&
      draft.seriesId === session.seriesId;

    await db
      .delete(sections)
      .where(
        and(
          eq(sections.id, session.sectionId),
          eq(sections.published, false),
        ),
      )
      .run();

    const remainingSection = await db
      .select({ id: sections.id })
      .from(sections)
      .where(eq(sections.seriesId, session.seriesId))
      .get();

    if (!remainingSection && !activePartWorkflow) {
      await db
        .delete(series)
        .where(
          and(
            eq(series.id, session.seriesId),
            eq(series.published, false),
          ),
        )
        .run();
    }
  }

  if (deleteFailures === 0) {
    const updateResult = await db
      .update(uploadSessions)
      .set({
        status: 'discarded',
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(
        and(
          eq(uploadSessions.id, session.id),
          eq(uploadSessions.ownerUserId, userId),
          eq(uploadSessions.status, 'discarding'),
          eq(uploadSessions.updatedAt, discardLeaseUpdatedAt),
        ),
      )
      .run();

    if (updateResult.rowsAffected !== 1) {
      const currentSession = await getUploadSession(session.id, userId);
      if (currentSession?.status !== 'discarded') {
        throw new Error('The upload batch changed while it was being discarded.');
      }
    }
  }

  if (
    deleteFailures === 0 &&
    draft?.step === 'part_upload' &&
    draft.ownerChatId === chat.id &&
    draft.seriesId === session.seriesId &&
    draft.sectionId === session.sectionId
  ) {
    await updateOwnerDraft(userId, {
      step: 'part_identifier',
      sectionId: null,
    });
  }

  await api.sendMessage({
    chat_id: chat.id,
    text:
      'Upload batch discarded; it will not be published.\n' +
      `Vault posts successfully deleted: ${deletedEpisodeIds.length}\n` +
      `Vault posts that could not be deleted: ${deleteFailures}` +
      (deleteFailures
        ? '\nFailed posts remain recorded. Fix the vault permissions or wait for Telegram limits to clear, then retry /discard after five minutes.'
        : ''),
  });

  return true;
}
