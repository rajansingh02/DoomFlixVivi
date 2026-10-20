import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { series, sections } from '../schema.js';
import { normalizeTitle } from './catalog.js';
import { searchPublishedSeries } from './search.js';
import {
  getOwnerDraft,
  updateOwnerDraft,
  clearOwnerDraft,
} from './drafts.js';
import {
  prepareSeriesPartUpload,
} from './owner_series_setup.js';

export async function handleOwnerDraftMessage(message) {
  const userId = message.from?.id;
  const chat = message.chat;
  const text = message.text?.trim();

  if (
    !userId ||
    chat?.type !== 'private' ||
    !text
  ) {
    return false;
  }

  const draft = await getOwnerDraft(userId);

  if (!draft || draft.ownerChatId !== chat.id) {
    return false;
  }

  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    if (draft.step === 'part_upload') {
      await api.sendMessage({
        chat_id: chat.id,
        text:
          'A part upload is active. Send /done to review it, then /confirm or /discard before cancelling part entry.',
      });
      return true;
    }

    if (
      ['part_identifier', 'part_wait'].includes(draft.step) &&
      Number.isSafeInteger(draft.seriesId)
    ) {
      const existingSections = await db
        .select()
        .from(sections)
        .where(eq(sections.seriesId, draft.seriesId))
        .all();

      if (existingSections.length === 0) {
        await db
          .delete(series)
          .where(eq(series.id, draft.seriesId))
          .run();
      }
    }

    await clearOwnerDraft(userId);

    await api.sendMessage({
      chat_id: chat.id,
      text: 'Series setup or part entry cancelled.',
    });

    return true;
  }

  if (draft.step === 'part_upload' && text.startsWith('/')) {
    await api.sendMessage({
      chat_id: chat.id,
      text:
        'Finish this part upload with /done, then /confirm or /discard before continuing.',
    });
    return true;
  }

  if (draft.step === 'part_wait' && /^\/finish(?:@\w+)?$/i.test(text)) {
    await clearOwnerDraft(userId);
    await api.sendMessage({
      chat_id: chat.id,
      text: 'Part entry finished. You can return to the owner panel or start another admin task.',
    });
    return true;
  }

  if (
    text.startsWith('/') &&
    !(
      draft.step === 'part_identifier' &&
      /^\/finish(?:@\w+)?$/i.test(text)
    )
  ) {
    await api.sendMessage({
      chat_id: chat.id,
      text: 'Please answer the current question, or use /cancel.',
    });

    return true;
  }

  if (draft.step === 'edit_title') {
    const title = normalizeTitle(text);

    if (!title || title.length < 2 || title.length > 150) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'Send a series title between 2 and 150 characters, or /cancel.',
      });
      return true;
    }

    const matches = await searchPublishedSeries(title);
    const match = matches.length === 1 ? matches[0] : null;

    if (!match) {
      await api.sendMessage({
        chat_id: chat.id,
        text:
          `I couldn't find one unambiguous published series matching "${title}".\n` +
          'Try a longer or more specific title, or send /cancel.',
      });
      return true;
    }

    await updateOwnerDraft(userId, {
      title: match.title,
      seriesId: match.seriesId,
      sectionId: null,
      seasonNumber: null,
      quality: null,
      step: 'edit_action',
    });

    await api.sendMessage({
      chat_id: chat.id,
      text: `Found: ${match.title}\n\nWhat would you like to do?`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '➕ Add Season / Quality',
              callback_data: 'editseries:addseason',
            },
          ],
          [
            {
              text: '♻️ Edit Existing Season',
              callback_data: 'editseries:editseason',
            },
          ],
        ],
      },
    });

    return true;
  }

  if (draft.step === 'sinfo_title') {
    const title = normalizeTitle(text);

    if (!title || title.length < 2 || title.length > 150) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'Send a series title between 2 and 150 characters, or /cancel.',
      });
      return true;
    }

    const matches = await searchPublishedSeries(title);
    const match = matches.length === 1 ? matches[0] : null;

    if (!match) {
      await api.sendMessage({
        chat_id: chat.id,
        text:
          `I couldn't find one unambiguous published series matching "${title}".\n` +
          'Try a longer or more specific title, or send /cancel.',
      });
      return true;
    }

    await updateOwnerDraft(userId, {
      title: match.title,
      seriesId: match.seriesId,
      step: 'sinfo_status',
    });

    await api.sendMessage({
      chat_id: chat.id,
      text:
        `Series: ${match.title}\n` +
        `Current status: ${match.status.toUpperCase()}\n\n` +
        'Choose the new status:',
      reply_markup: {
        inline_keyboard: [[
          {
            text: '🟢 ONGOING',
            callback_data: `sinfostatus:${match.seriesId}:ongoing`,
          },
          {
            text: '✅ FINISHED',
            callback_data: `sinfostatus:${match.seriesId}:finished`,
          },
        ]],
      },
    });

    return true;
  }

  if (draft.step === 'edit_add_season') {
    if (!/^\d+$/.test(text)) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'Send a whole-number season number between 1 and 100.',
      });
      return true;
    }

    const seasonNumber = Number(text);

    if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 1 || seasonNumber > 100) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'Season number must be between 1 and 100.',
      });
      return true;
    }

    const normalizedTitle = normalizeTitle(draft.title);
    const matches = await db
      .select()
      .from(series)
      .where(eq(series.normalizedTitle, normalizedTitle))
      .all();

    const seriesRecord = matches.find((item) => item.published === true);

    if (!seriesRecord) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'The published series could not be found. Cancel and start Edit Series again.',
      });
      return true;
    }

    const existingSections = await db
      .select()
      .from(sections)
      .where(eq(sections.seriesId, seriesRecord.id))
      .all();

    const qualitiesForSeason = existingSections
      .filter((item) => item.seasonNumber === seasonNumber)
      .map((item) => item.quality.trim().toLowerCase());

    const commonQualities = ['480p', '720p', '1080p', '2160p'];
    const missingQualities = commonQualities.filter(
      (quality) => !qualitiesForSeason.includes(quality.toLowerCase()),
    );

    if (missingQualities.length === 0) {
      await api.sendMessage({
        chat_id: chat.id,
        text:
          `Season ${seasonNumber} already has all standard qualities (480p, 720p, 1080p, 2160p).\n` +
          'Send a different season number, or /cancel.',
      });
      return true;
    }

    await updateOwnerDraft(userId, {
      seasonNumber,
      step: 'edit_add_quality',
    });

    const qualityButtons = missingQualities.map((quality) => ({
      text: quality === '2160p' ? '2160p (4K)' : quality,
      callback_data: `editaddquality:${quality}`,
    }));

    await api.sendMessage({
      chat_id: chat.id,
      text:
        (qualitiesForSeason.length
          ? `Season ${seasonNumber} already exists. Choose a missing quality to add.\n\n`
          : `Season ${seasonNumber} doesn't exist yet. Choose a quality to create it.\n\n`) +
        `Available qualities: ${missingQualities.join(', ')}`,
      reply_markup: {
        inline_keyboard: [
          qualityButtons.slice(0, 2),
          qualityButtons.slice(2, 4),
        ].filter((row) => row.length > 0),
      },
    });

    return true;
  }
  if (draft.step === 'title') {
    const title = normalizeTitle(text);

    if (!title || title.length < 2 || title.length > 150) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'Please send a valid series title between 2 and 150 characters.',
      });

      return true;
    }

    await updateOwnerDraft(userId, {
      title,
      step: 'status',
    });

    await api.sendMessage({
      chat_id: chat.id,
      text: `Series title: ${title}\n\nChoose the series status:`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🟢 ONGOING',
              callback_data: 'draftstatus:ongoing',
            },
            {
              text: '✅ FINISHED',
              callback_data: 'draftstatus:finished',
            },
          ],
        ],
      },
    });

    return true;
  }

  if (draft.step === 'status') {
    const status = text.toLowerCase();

    if (!['ongoing', 'finished'].includes(status)) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'Choose ONGOING or FINISHED using the buttons above.',
      });

      return true;
    }

    await updateOwnerDraft(userId, {
      status,
      step: 'season',
    });

    await api.sendMessage({
      chat_id: chat.id,
      text: 'Send the season number, for example: 1',
    });

    return true;
  }

  if (draft.step === 'season') {
    if (!/^\d+$/.test(text)) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'Please send a whole-number season number between 1 and 100.',
      });

      return true;
    }

    const seasonNumber = Number(text);

    if (
      !Number.isSafeInteger(seasonNumber) ||
      seasonNumber < 1 ||
      seasonNumber > 100
    ) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'Season number must be between 1 and 100.',
      });

      return true;
    }

    await updateOwnerDraft(userId, {
      seasonNumber,
      step: 'quality',
    });

    await api.sendMessage({
      chat_id: chat.id,
      text: 'Choose the quality for this season:',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '480p', callback_data: 'draftquality:480p' },
            { text: '720p', callback_data: 'draftquality:720p' },
          ],
          [
            { text: '1080p', callback_data: 'draftquality:1080p' },
            { text: '2160p (4K)', callback_data: 'draftquality:2160p' },
          ],
        ],
      },
    });

    return true;
  }

  if (draft.step === 'quality') {
    const quality = text.replace(/\s+/g, ' ').trim();

    if (
      quality.length < 2 ||
      quality.length > 40 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/.test(quality)
    ) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'Please send a valid quality label between 2 and 40 characters, using letters, numbers, spaces, dots, underscores or hyphens.',
      });

      return true;
    }

    await updateOwnerDraft(userId, {
      quality,
      step: 'part_choice',
    });

    await api.sendMessage({
      chat_id: chat.id,
      text: 'Does this season contain multiple parts?',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Yes', callback_data: 'partchoice:yes' },
          { text: 'No', callback_data: 'partchoice:no' },
        ]],
      },
    });

    return true;
  }

  if (draft.step === 'part_identifier') {
    if (/^\/finish(?:@\w+)?$/i.test(text)) {
      if (Number.isSafeInteger(draft.seriesId)) {
        const existingSections = await db
          .select()
          .from(sections)
          .where(eq(sections.seriesId, draft.seriesId))
          .all();

        if (existingSections.length === 0) {
          await db
            .delete(series)
            .where(eq(series.id, draft.seriesId))
            .run();
        }
      }

      await clearOwnerDraft(userId);
      await api.sendMessage({
        chat_id: chat.id,
        text: 'Part entry finished. You can return to the owner panel or start another admin task.',
      });
      return true;
    }

    const match = text.match(/^(\d+)\.(\d+)$/);
    if (!match) {
      await api.sendMessage({
        chat_id: chat.id,
        text:
          `Send a part identifier in SEASON.PART format, for example ${draft.seasonNumber}.1.\n` +
          'Send /finish to end part entry or /cancel to cancel.',
      });
      return true;
    }

    const seasonNumber = Number(match[1]);
    const partNumber = Number(match[2]);

    if (
      !Number.isSafeInteger(seasonNumber) ||
      seasonNumber !== draft.seasonNumber ||
      !Number.isSafeInteger(partNumber) ||
      partNumber < 1
    ) {
      await api.sendMessage({
        chat_id: chat.id,
        text:
          `Use the selected season number (${draft.seasonNumber}) and a positive part number, for example ${draft.seasonNumber}.1.`,
      });
      return true;
    }

    try {
      const result = await prepareSeriesPartUpload(
        userId,
        chat.id,
        seasonNumber,
        partNumber,
      );

      await api.sendMessage({
        chat_id: chat.id,
        text:
          `📦 Season ${seasonNumber} — Part ${partNumber} upload prepared\n\n` +
          `Series: ${result.series.title}\n` +
          `Quality: ${result.section.quality}\n\n` +
          'Send the episode files for this part in this private chat.\n' +
          'Send /done to review this part, then /confirm to publish it.\n' +
          'After confirmation, you can add another part or finish part entry.',
      });
    } catch (error) {
      await api.sendMessage({
        chat_id: chat.id,
        text:
          `Could not prepare Season ${seasonNumber} — Part ${partNumber}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }\n\nSend a different identifier or /finish.`,
      });
    }

    return true;
  }

  return false;
}