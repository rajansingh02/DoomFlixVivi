
import { api, db } from 'sdk';
import { and, eq } from 'sdk/db';
import { sections, series } from '../schema.js';
import { searchPublishedSeries } from '../lib/search.js';
import {
  buildSeasonKeyboard,
  buildPartKeyboard,
  buildQualityKeyboard,
  buildDeliveryKeyboard,
} from '../lib/keyboards.js';
import { OWNER_USER_ID, isOwner } from '../lib/config.js';
import { checkChannelMembership, sendFsubPrompt, handlePickPayload } from '../lib/fsub.js';
import { handleGroupAuthCommand, isAuthorizedSearchGroup } from '../lib/group_auth.js';
import {
  getOwnerDraft,
  startOwnerDraft,
  updateOwnerDraft,
} from '../lib/drafts.js';
import { handleOwnerDraftMessage } from '../lib/owner_draft_flow.js';
import {
  handleOwnerEpisodeUpload,
  handleOwnerUploadCommand,
} from '../lib/owner_uploads.js';
import { handleOwnerReviewCommand } from '../lib/owner_review.js';
import { prepareReplacementUpload } from '../lib/owner_series_setup.js';
import { findBlockingUploadSession } from '../lib/sessions.js';

export default async function (message, ctx) {
  const chat = message.chat;
  const text = message.text?.trim();
  const userId = message.from?.id;

  if (!chat || message.from?.is_bot) {
    return;
  }

  if (await handleGroupAuthCommand(message)) {
    return;
  }

  const hasMedia = Boolean(
    message.document ||
    message.audio ||
    message.video ||
    message.animation
  );

  if (!text && !hasMedia) {
    return;
  }

  if (chat.type === 'private') {
    const startMatch = text?.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
    if (!isOwner(userId)) {
      const payload = startMatch?.[1] ?? 'home';
      const membership = await checkChannelMembership(userId);

      if (membership !== true) {
        await sendFsubPrompt(
          chat.id,
          payload.startsWith('pick_') ? payload : 'home',
          membership === null,
        );
        return;
      }
    }

    if (startMatch) {
      const payload = startMatch[1] ?? '';

      if (payload.startsWith('pick_')) {
        const pickMatch = payload.match(/^pick_(\d+)_(\d+)$/);

        if (!pickMatch) {
          await api.sendMessage({
            chat_id: chat.id,
            text: 'This link is invalid or expired. Please search for the series again.',
          });
          return;
        }

        const sectionId = Number(pickMatch[1]);
        const intendedUserId = Number(pickMatch[2]);

        if (
          !Number.isSafeInteger(sectionId) ||
          sectionId < 1 ||
          !Number.isSafeInteger(intendedUserId) ||
          intendedUserId < 1
        ) {
          await api.sendMessage({
            chat_id: chat.id,
            text: 'This link is invalid or expired. Please search for the series again.',
          });
          return;
        }

        if (intendedUserId !== userId) {
          await api.sendMessage({
            chat_id: chat.id,
            text: "This link isn't meant for you. Please search for the series yourself.",
          });
          return;
        }

        const section = await db
          .select()
          .from(sections)
          .where(
            and(
              eq(sections.id, sectionId),
              eq(sections.published, true),
            ),
          )
          .get();

        if (!section) {
          await api.sendMessage({
            chat_id: chat.id,
            text: 'This season is no longer available. Please search for the series again.',
          });
          return;
        }

        const seriesRecord = await db
          .select()
          .from(series)
          .where(
            and(
              eq(series.id, section.seriesId),
              eq(series.published, true),
            ),
          )
          .get();

        if (!seriesRecord) {
          await api.sendMessage({
            chat_id: chat.id,
            text: 'This series is no longer available. Please search again.',
          });
          return;
        }

        if (!['finished', 'ongoing'].includes(seriesRecord.status)) {
          await api.sendMessage({
            chat_id: chat.id,
            text: 'This series currently cannot be delivered.',
          });
          return;
        }

        const replyMarkup =
          seriesRecord.status === 'ongoing'
            ? buildDeliveryKeyboard(sectionId, seriesRecord.status, userId)
            : {
                inline_keyboard: [[
                  {
                    text: 'All episodes',
                    callback_data: `deliver:${sectionId}:all:${userId}`,
                  },
                ]],
              };

        await api.sendMessage({
          chat_id: chat.id,
          text:
            `${seriesRecord.title} — Season ${section.seasonNumber}` +
            ((section.partNumber ?? 0) > 0
              ? ` — Part ${section.partNumber}`
              : '') +
            ` — ${section.quality}\n\n` +
            (seriesRecord.status === 'ongoing'
              ? 'Choose which episodes to receive:'
              : 'This series is finished. Start delivery to receive its episodes.'),
          reply_markup: replyMarkup,
        });

        return;
      }

      if (isOwner(userId) && userId === OWNER_USER_ID) {
        await api.sendMessage({
          chat_id: chat.id,
          text:
            '🎬 DoomFlix Series — Owner Panel\n\n' +
            'Choose an action below, or use /aseries to add a series and /sinfo to change a published series status.',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '➕ Add Series',
                  callback_data: 'menu:add_series',
                },
              ],
              [
                {
                  text: '✏️ Edit Series',
        callback_data: 'menu:edit_series',
                },
                {
                  text: '📋 Upload Help',
                  callback_data: 'menu:upload_help',
                },
              ],
            ],
          },
        });
      } else {
        await api.sendMessage({
          chat_id: chat.id,
          text:
            'Welcome to DoomFlix Series!\n\n' +
            'Open your group and type a series name to find available seasons.\n' +
            'When you select episodes, I will send them to this private chat.',
        });
      }

      return;
    }
    if (text && /^\/aseries(?:@\w+)?$/i.test(text)) {
      if (!isOwner(userId) || userId !== OWNER_USER_ID) {
        await api.sendMessage({
          chat_id: chat.id,
          text: 'You are not authorized to use this command.',
        });
        return;
      }

      const existingDraft = await getOwnerDraft(userId);
      if (existingDraft?.step?.startsWith('part_')) {
        await api.sendMessage({
          chat_id: chat.id,
          text:
            existingDraft.step === 'part_upload'
              ? 'Finish or discard the active part upload before starting another series.'
              : 'Finish part entry with /finish or cancel it with /cancel before starting another series.',
        });
        return;
      }

      if (existingDraft) {
        await api.sendMessage({
          chat_id: chat.id,
          text:
            'A setup is already in progress. Continue answering its current question or send /cancel before starting another series.',
        });
        return;
      }

      try {
        await startOwnerDraft(userId, chat.id);

        await api.sendMessage({
          chat_id: chat.id,
          text:
            '➕ Add a series\n\n' +
            'Send the series title.\n\n' +
            'Send /cancel at any time to cancel this setup.',
        });
      } catch (error) {
        await api.sendMessage({
          chat_id: chat.id,
          text: 'Could not start the series setup. Please try again.',
        });
      }

      return;
    }

    if (text && /^\/sinfo(?:@\w+)?$/i.test(text)) {
      if (!isOwner(userId) || userId !== OWNER_USER_ID) {
        await api.sendMessage({
          chat_id: chat.id,
          text: 'You are not authorized to use this command.',
        });
        return;
      }

      const existingDraft = await getOwnerDraft(userId);
      if (existingDraft) {
        await api.sendMessage({
          chat_id: chat.id,
          text: 'Finish or cancel the current owner workflow before changing a series status.',
        });
        return;
      }

      const blockingSession = await findBlockingUploadSession(userId);
      if (blockingSession) {
        await api.sendMessage({
          chat_id: chat.id,
          text: 'Finish reviewing or discard your current upload before changing a series status.',
        });
        return;
      }

      try {
        await startOwnerDraft(userId, chat.id);
        await updateOwnerDraft(userId, { step: 'sinfo_title' });

        await api.sendMessage({
          chat_id: chat.id,
          text:
            '📊 Change Series Status\n\n' +
            'Send the exact or a distinctive part of the published series title.\n' +
            'You can then set it to ONGOING or FINISHED.\n\n' +
            'Send /cancel to cancel.',
        });
      } catch (error) {
        await api.sendMessage({
          chat_id: chat.id,
          text:
            error instanceof Error
              ? `Could not start the status editor: ${error.message}`
              : 'Could not start the status editor. Please try again.',
        });
      }

      return;
    }

    if (text && /^\/eseries(?:@\w+)?(?:\s|$)/i.test(text)) {
      if (!isOwner(userId) || userId !== OWNER_USER_ID) {
        await api.sendMessage({
          chat_id: chat.id,
          text: 'You are not authorized to use this command.',
        });
        return;
      }

      const args = text.replace(/^\/eseries(?:@\w+)?/i, '').trim();
      const parts = args.split('|').map((part) => part.trim());

      if (parts.length !== 3 || parts.some((part) => !part)) {
        await api.sendMessage({
          chat_id: chat.id,
          text:
            'Usage:\n' +
            '/eseries Series Title | Season Number | Quality\n\n' +
            'Example:\n' +
            '/eseries The Vampire Diaries | 1 | 1080p',
        });
        return;
      }

      const [title, seasonText, quality] = parts;
      const seasonNumber = Number(seasonText);

      if (
        !/^\d+$/.test(seasonText) ||
        !Number.isSafeInteger(seasonNumber) ||
        seasonNumber < 1
      ) {
        await api.sendMessage({
          chat_id: chat.id,
          text: 'Season number must be a positive whole number.',
        });
        return;
      }

      try {
        const result = await prepareReplacementUpload(
          userId,
          chat.id,
          title,
          seasonNumber,
          quality,
        );

        await api.sendMessage({
          chat_id: chat.id,
          text:
            '♻️ Replacement upload started\n\n' +
            `Series: ${result.series.title}\n` +
            `Season: ${result.section.seasonNumber}\n` +
            `Quality: ${result.section.quality}\n\n` +
            'Send the replacement episode files here.\n' +
            'When finished, send /done to review the batch.\n' +
            'The currently published episodes remain available until you confirm the replacement.\n\n' +
            'To abandon this batch, send /done first, then /discard after the review batch is created.',
        });
      } catch (error) {
        await api.sendMessage({
          chat_id: chat.id,
          text:
            error instanceof Error
              ? error.message
              : 'Could not start the replacement upload. Please try again.',
        });
      }

      return;
    }

    try {
      const reviewHandled = await handleOwnerReviewCommand(message);
      if (reviewHandled) return;

      const commandHandled = await handleOwnerUploadCommand(message);
      if (commandHandled) return;

      const uploadHandled = await handleOwnerEpisodeUpload(message);
      if (uploadHandled) return;

      const draftHandled = await handleOwnerDraftMessage(message);
      if (draftHandled) return;
    } catch (error) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'Could not process that message. Please try again.',
      });
    }

    return;
  }

  // Search only ordinary text messages in groups.
  if (
    !['group', 'supergroup'].includes(chat.type) ||
    !text ||
    text.startsWith('/')
  ) {
    return;
  }

  if (
    !['group', 'supergroup'].includes(chat.type) ||
    !(await isAuthorizedSearchGroup(chat.id))
  ) {
    return;
  }

  const results = await searchPublishedSeries(text);

  // Stay silent for unknown or ambiguous titles.
  if (results.length !== 1) {
    return;
  }

  const result = results[0];

  if (result.requestedSeason !== null) {
    const hasParts = result.sections.some(
      (section) => (section.partNumber ?? 0) > 0,
    );

    await api.sendMessage({
      chat_id: chat.id,
      text:
        `${result.title} — Season ${result.requestedSeason}\n` +
        (hasParts ? 'Select a part:' : 'Select quality:'),
      reply_markup: hasParts
        ? buildPartKeyboard(
            result.sections,
            result.seriesId,
            result.requestedSeason,
            userId,
          )
        : buildQualityKeyboard(result.sections, userId),
    });
    return;
  }

  await api.sendMessage({
    chat_id: chat.id,
    text: `${result.title}\nSelect season:`,
    reply_markup: buildSeasonKeyboard(result, userId),
  });
}
