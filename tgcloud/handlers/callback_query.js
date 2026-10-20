
import { api, BotApiError, db } from 'sdk';
import { and, eq } from 'sdk/db';
import { sections, series } from '../schema.js';
import {
  buildQualityKeyboard,
  buildPartKeyboard,
  buildDeliveryKeyboard,
} from '../lib/keyboards.js';
import {
  createDeliveryJob,
  findMatchingActiveDeliveryJob,
} from '../lib/delivery_jobs.js';
import { processDeliveryJob } from '../lib/delivery.js';
import { isOwner } from '../lib/config.js';
import { checkChannelMembership, buildFsubPrompt, sendFsubPrompt, handlePickPayload } from '../lib/fsub.js';
import { isAuthorizedSearchGroup } from '../lib/group_auth.js';
import {

  getOwnerDraft,
  updateOwnerDraft,
  startOwnerDraft,
  clearOwnerDraft,
} from '../lib/drafts.js';
import {
  prepareNewSeriesUpload,
  prepareNewSeriesParts,
  prepareSeriesPartUpload,
  prepareAddSeasonUpload,
  prepareReplacementUpload,
  prepareAppendEpisodeUpload,
} from '../lib/owner_series_setup.js';
import { findBlockingUploadSession } from '../lib/sessions.js';
import { normalizeTitle } from '../lib/catalog.js';

export default async function (callbackQuery, ctx) {
  const callbackId = callbackQuery.id;
  const userId = callbackQuery.from?.id;
  const message = callbackQuery.message;
  const data = callbackQuery.data ?? '';

  let answered = false;

  async function answer(text) {
    if (answered) return;

    await api.answerCallbackQuery({
      callback_query_id: callbackId,
      text,
    });

    answered = true;
  }

  async function editSelection(text, replyMarkup) {
    if (!message?.chat?.id || !message?.message_id) {
      throw new Error('This button is not attached to a normal chat message.');
    }

    const payload = {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text,
    };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    await api.editMessageText(payload);
  }

  function continueKeyboard(jobId, recipientUserId) {
    return {
      inline_keyboard: [[
        {
          text: 'Continue delivery',
          callback_data: `continue:${jobId}:${recipientUserId}`,
        },
      ]],
    };
  }

  async function reportDeliveryFailure(error) {
    if (error instanceof BotApiError && error.code === 403) {
      const bot = await api.getMe();

      await api.sendMessage({
        chat_id: message.chat.id,
        text:
          `Please start the bot in private chat first: ` +
          `https://t.me/${bot.username}?start=1\n` +
          'Then return here and select the season and quality again.',
      });

      return;
    }

    await api.sendMessage({
      chat_id: message.chat.id,
      text: 'Delivery failed. Please try again later.',
    });
  }

  async function runDeliveryJob(jobId) {
    const result = await processDeliveryJob({
      jobId,
      targetUserId: userId,
    });

    // Remove the button that was just clicked. A fresh status message
    // will be posted below the latest batch.
    await editSelection(
      'This Continue button has been used.',
      { inline_keyboard: [] },
    );

    if (result.status === 'completed') {
      await api.sendMessage({
        chat_id: message.chat.id,
        text: `Delivery complete. Sent ${result.sentThisBatch} episode(s) in this batch.`,
      });
      return;
    }

    if (result.status === 'busy') {
      await api.sendMessage({
        chat_id: message.chat.id,
        text: 'This delivery is already being processed. Please wait a moment.',
        reply_markup: continueKeyboard(jobId, userId),
      });
      return;
    }

    if (result.status === 'waiting') {
      await api.sendMessage({
        chat_id: message.chat.id,
        text:
          `Sent ${result.sentThisBatch} episode(s) in this batch. ` +
          `Telegram asked us to wait ${result.retryAfter} seconds before continuing.`,
        reply_markup: continueKeyboard(jobId, userId),
      });
      return;
    }

    await api.sendMessage({
      chat_id: message.chat.id,
      text:
        `Sent ${result.sentThisBatch} episode(s) in this batch. ` +
        `${result.remaining} episode(s) remain.`,
      reply_markup: continueKeyboard(jobId, userId),
    });
  }
  try {
    if (!userId || !message?.chat?.id || !message?.message_id) {
      await answer('This button is no longer available.');
      return;
    }

    if (data.startsWith('fsubcheck:')) {
      if (message.chat.type !== 'private') {
        await answer('Please check membership in the bot private chat.');
        return;
      }

      const payload = data.slice('fsubcheck:'.length);
      const membership = await checkChannelMembership(userId);

      if (membership !== true) {
        await answer(
          membership === null
            ? 'Could not verify membership. Please try again.'
            : 'Please join @DoomFlix first.',
        );
        const prompt = buildFsubPrompt(
          payload,
          membership === null,
        );
        await editSelection(prompt.text, prompt.reply_markup);
        return;
      }

      await answer('Membership verified.');

      if (payload.startsWith('pick_')) {
        await handlePickPayload(payload, userId, message.chat.id);
      } else {
        await api.sendMessage({
          chat_id: message.chat.id,
          text:
            'Welcome to DoomFlix Series!\n\n' +
            'Open your group and type a series name to find available seasons.\n' +
            'When you select episodes, I will send them to this private chat.',
        });
      }
      return;
    }
    if (data.startsWith('menu:')) {
      if (
        !isOwner(userId) ||
        userId !== 924952328 ||
        message.chat.type !== 'private'
      ) {
        await answer('This menu is only available to the bot owner.');
        return;
      }

      if (data === 'menu:edit_series') {
        const existingDraft = await getOwnerDraft(userId);

        if (existingDraft) {
          await answer('Finish or cancel the current draft first.');
          await api.sendMessage({
            chat_id: message.chat.id,
            text: 'Another setup is in progress. Finish it or send /cancel before editing a series.',
          });
          return;
        }

        const activeSession = await findBlockingUploadSession(userId);

        if (activeSession) {
          await answer('An upload is already in progress.');
          await api.sendMessage({
            chat_id: message.chat.id,
            text: 'Finish reviewing or discard your current upload before editing a series.',
          });
          return;
        }

        await startOwnerDraft(userId, message.chat.id);
        await updateOwnerDraft(userId, { step: 'edit_title' });
        await answer('Edit Series started.');

        await api.sendMessage({
          chat_id: message.chat.id,
          text: '✏️ Edit Series\n\nSend the exact title of an existing published series.\n\nExample: The Vampire Diaries\n\nSend /cancel to cancel.',
        });
        return;
      }
      if (data === 'menu:add_series') {
        const existingDraft = await getOwnerDraft(userId);

        if (existingDraft) {
          await answer('A series setup is already in progress.');
          await api.sendMessage({
            chat_id: message.chat.id,
            text:
              'You already have a series draft in progress. ' +
              'Continue answering its current question, or send /cancel to restart.',
          });
          return;
        }

        await startOwnerDraft(userId, message.chat.id);
        await answer('Series setup started.');

        await api.sendMessage({
          chat_id: message.chat.id,
          text:
            '➕ Add a series\n\n' +
            'Send the series title.\n\n' +
            'Send /cancel at any time to cancel this setup.',
        });

        return;
      }

      if (data === 'menu:replace_help') {
        await answer('Replacement instructions opened.');

        await api.sendMessage({
          chat_id: message.chat.id,
          text:
            '♻️ Replace Episodes\n\n' +
            'Send this command, replacing the example values:\n\n' +
            '/eseries Series Title | Season Number | Quality\n\n' +
            'Example:\n' +
            '/eseries Example Series | 1 | 1080p',
        });

        return;
      }

      if (data === 'menu:upload_help') {
        await answer('Upload instructions opened.');

        await api.sendMessage({
          chat_id: message.chat.id,
          text:
            '📋 Upload workflow\n\n' +
            '1. Start with Add Series or /aseries.\n' +
            '2. Choose whether the season has multiple parts. For parts, send identifiers such as 1.1 and 1.2; upload and confirm each part separately.\n' +
            '3. Send the episode files in this private chat.\n' +
            '4. Send /done to review the batch.\n' +
            '5. Review the list and warnings.\n' +
            '6. Send /confirm to publish, or /discard to abandon the batch.\n' +
            'If the bot restarts during confirmation or discard, retry the same command after five minutes to resume from the saved batch state.\n' +
            'After a part is published, choose Add another part or Finish. You can also send /finish while entering part identifiers.\n\n' +
            'Nothing is published before confirmation.\n\n' +
            'Use /sinfo to change a published series between ONGOING and FINISHED.',
        });

        return;
      }

      await answer('Unknown menu action.');
      return;
    }

    if (data.startsWith('sinfostatus:')) {
      if (
        !isOwner(userId) ||
        message.chat.type !== 'private'
      ) {
        await answer('This action is only available to the bot owner in private chat.');
        return;
      }

      const [prefix, seriesIdText, status, extra] = data.split(':');
      const seriesId = Number(seriesIdText);

      if (
        prefix !== 'sinfostatus' ||
        extra !== undefined ||
        !Number.isSafeInteger(seriesId) ||
        seriesId < 1 ||
        !['ongoing', 'finished'].includes(status)
      ) {
        await answer('Invalid series status selection.');
        return;
      }

      const draft = await getOwnerDraft(userId);
      if (
        !draft ||
        draft.ownerChatId !== message.chat.id ||
        draft.step !== 'sinfo_status' ||
        draft.seriesId !== seriesId
      ) {
        await answer('This status selection has expired. Start again with /sinfo.');
        return;
      }

      const blockingSession = await findBlockingUploadSession(userId);
      if (blockingSession) {
        await answer('Finish or discard your active upload first.');
        await api.sendMessage({
          chat_id: message.chat.id,
          text: 'A series status cannot be changed while an upload is active or awaiting review. Your selection is still available after that upload is finished.',
        });
        return;
      }

      const seriesRecord = await db
        .select()
        .from(series)
        .where(and(eq(series.id, seriesId), eq(series.published, true)))
        .get();

      if (!seriesRecord) {
        await answer('Published series not found. Start again with /sinfo.');
        return;
      }

      const changed = seriesRecord.status !== status;
      if (changed) {
        await db
          .update(series)
          .set({
            status,
            updatedAt: Math.floor(Date.now() / 1000),
          })
          .where(and(eq(series.id, seriesId), eq(series.published, true)))
          .run();
      }

      let draftCleanupWarning = false;
      try {
        await clearOwnerDraft(userId);
      } catch {
        draftCleanupWarning = true;
      }

      await answer(
        changed
          ? `Status set to ${status.toUpperCase()}.`
          : `Already ${status.toUpperCase()}.`,
      );
      await api.sendMessage({
        chat_id: message.chat.id,
        text:
          `${seriesRecord.title} is ${status.toUpperCase()} now.` +
          (draftCleanupWarning
            ? '\n\nThe status was saved, but the workflow could not be cleared. Send /cancel before starting another owner task.'
            : ''),
      });
      return;
    }

    if (
      data.startsWith('editseries:') ||
      data.startsWith('editseason:') ||
      data.startsWith('editreplace:') ||
      data.startsWith('editaddquality:') ||
      data.startsWith('editappendquality:')
    ) {
      if (
        !isOwner(userId) ||
        userId !== 924952328 ||
        message.chat.type !== 'private'
      ) {
        await answer('This action is only available to the bot owner in private chat.');
        return;
      }

      const draft = await getOwnerDraft(userId);

      if (!draft || draft.ownerChatId !== message.chat.id) {
        await answer('This edit session has expired. Start Edit Series again.');
        return;
      }

      if (data === 'editseries:addseason') {
        if (draft.step !== 'edit_action' || !draft.title) {
          await answer('This selection has expired.');
          return;
        }

        await updateOwnerDraft(userId, {
          step: 'edit_add_season',
          seasonNumber: null,
          quality: null,
        });

        await answer('Add Season selected.');
        await editSelection(
          `${draft.title}\n\nSend the season number to add, for example: 2`,
          { inline_keyboard: [] },
        );
        return;
      }

      if (data === 'editseries:add_episode') {
        if (draft.step !== 'edit_action' || !draft.title) {
          await answer('This selection has expired.');
          return;
        }

        const normalizedTitle = normalizeTitle(draft.title);
        const matches = await db
          .select()
          .from(series)
          .where(eq(series.normalizedTitle, normalizedTitle))
          .all();
        const seriesRecord = matches.find(
          (item) => item.published === true && item.status === 'ongoing',
        );

        if (!seriesRecord) {
          await answer('Add New Episode is only available for a published ongoing series.');
          return;
        }

        const allSections = await db
          .select()
          .from(sections)
          .where(eq(sections.seriesId, seriesRecord.id))
          .all();
        const publishedSections = allSections.filter(
          (item) => item.published === true,
        );

        if (publishedSections.length === 0) {
          await answer('No published seasons or qualities were found.');
          return;
        }

        const latestSeason = Math.max(
          ...publishedSections.map((item) => item.seasonNumber),
        );
        const latestSections = publishedSections
          .filter((item) => item.seasonNumber === latestSeason)
          .sort((a, b) => a.quality.localeCompare(b.quality));

        await updateOwnerDraft(userId, {
          step: 'edit_add_episode_quality',
          seasonNumber: latestSeason,
          quality: null,
        });

        await answer(`Choose a quality from Season ${latestSeason}.`);
        await editSelection(
          `${seriesRecord.title}\n\n` +
            `Latest published season: ${latestSeason}\n` +
            'Choose the existing quality to add episodes to:',
          {
            inline_keyboard: latestSections.map((section) => [{
              text: section.quality,
              callback_data: `editappendquality:${section.id}`,
            }]),
          },
        );
        return;
      }

      if (data === 'editseries:editseason') {
        if (draft.step !== 'edit_action' || !draft.title) {
          await answer('This selection has expired.');
          return;
        }

        const normalizedTitle = normalizeTitle(draft.title);
        const matches = await db
          .select()
          .from(series)
          .where(eq(series.normalizedTitle, normalizedTitle))
          .all();
        const seriesRecord = matches.find((item) => item.published === true);

        if (!seriesRecord) {
          await answer('Published series not found.');
          return;
        }

        const allSections = await db
          .select()
          .from(sections)
          .where(eq(sections.seriesId, seriesRecord.id))
          .all();

        const seasonNumbers = [...new Set(
          allSections
            .filter((item) => item.published === true)
            .map((item) => item.seasonNumber),
        )].sort((a, b) => a - b);

        if (seasonNumbers.length === 0) {
          await answer('No published seasons found.');
          return;
        }

        await answer('Choose a season.');
        await editSelection(
          `${seriesRecord.title}\n\nChoose the season you want to edit:`,
          {
            inline_keyboard: seasonNumbers.map((number) => [{
              text: `Season ${number}`,
              callback_data: `editseason:${seriesRecord.id}:${number}`,
            }]),
          },
        );
        return;
      }

      if (data.startsWith('editappendquality:')) {
        const sectionId = Number(data.slice('editappendquality:'.length));

        if (
          draft.step !== 'edit_add_episode_quality' ||
          !draft.title ||
          !Number.isSafeInteger(sectionId)
        ) {
          await answer('This episode-append selection has expired.');
          return;
        }

        try {
          const result = await prepareAppendEpisodeUpload(
            userId,
            message.chat.id,
            sectionId,
          );

          await answer('Add-episode upload prepared.');
          await editSelection(
            '➕ Add New Episode — upload prepared\n\n' +
              `Series: ${result.series.title}\n` +
              `Season: ${result.section.seasonNumber}\n` +
              `Quality: ${result.section.quality}\n\n` +
              'Send the new episode files in this private chat.\n' +
              'Send /done to review the batch.\n' +
              'After reviewing, send /confirm to publish the new episodes.\n' +
              'Existing published episodes will remain available.',
            { inline_keyboard: [] },
          );

          if (result.draftCleanupWarning) {
            await api.sendMessage({
              chat_id: message.chat.id,
              text: 'Warning: the selection draft could not be cleared. Finish or discard this upload before starting another.',
            });
          }
        } catch (error) {
          await answer('Could not prepare the episode upload.');
          await api.sendMessage({
            chat_id: message.chat.id,
            text:
              `Could not prepare the append upload: ${error instanceof Error ? error.message : 'Unknown error'}\n\n` +
              'No existing published episodes were replaced.',
          });
        }
        return;
      }

      if (data.startsWith('editaddquality:')) {
        const quality = data.slice('editaddquality:'.length);
        const allowedQualities = ['480p', '720p', '1080p', '2160p'];

        if (
          draft.step !== 'edit_add_quality' ||
          !draft.title ||
          !Number.isSafeInteger(draft.seasonNumber) ||
          !allowedQualities.includes(quality)
        ) {
          await answer('This quality selection has expired.');
          return;
        }

        try {
          const result = await prepareAddSeasonUpload(
            userId,
            message.chat.id,
            draft.title,
            draft.seasonNumber,
            quality,
          );

          let cleanupWarning = false;
          try {
            await clearOwnerDraft(userId);
          } catch {
            cleanupWarning = true;
          }

          await answer(`Preparing ${quality} upload.`);
          await editSelection(
            '📦 Season upload prepared\n\n' +
              `Series: ${result.series.title}\n` +
              `Season: ${result.section.seasonNumber}\n` +
              `Quality: ${result.section.quality}\n\n` +
              'Send the episode files in this private chat.\n' +
              'Send /done when finished to review the batch.\n' +
              'Nothing will be published until you send /confirm.' +
              (cleanupWarning ? '\n\nWarning: draft cleanup failed; finish this upload before starting another.' : ''),
            { inline_keyboard: [] },
          );
        } catch (error) {
          await answer('Could not prepare the upload.');
          await api.sendMessage({
            chat_id: message.chat.id,
            text: `Could not prepare this season: ${error instanceof Error ? error.message : 'Unknown error'}\n\nYour existing published episodes have not been replaced.`,
          });
        }
        return;
      }
    }

    if (data.startsWith('editseason:')) {
      if (
        !isOwner(userId) ||
        userId !== 924952328 ||
        message.chat.type !== 'private'
      ) {
        await answer('This action is only available to the bot owner.');
        return;
      }

      const draft = await getOwnerDraft(userId);
      const parts = data.split(':');
      const seriesId = Number(parts[1]);
      const seasonNumber = Number(parts[2]);

      if (
        !draft ||
        draft.ownerChatId !== message.chat.id ||
        draft.step !== 'edit_action' ||
        parts.length !== 3 ||
        !Number.isSafeInteger(seriesId) ||
        !Number.isSafeInteger(seasonNumber)
      ) {
        await answer('This season selection has expired.');
        return;
      }

      const seriesRecord = await db
        .select()
        .from(series)
        .where(and(eq(series.id, seriesId), eq(series.published, true)))
        .get();

      if (!seriesRecord || seriesRecord.title !== draft.title) {
        await answer('Series not found. Start Edit Series again.');
        return;
      }

      const matchingSections = await db
        .select()
        .from(sections)
        .where(eq(sections.seriesId, seriesId))
        .all();

      const seasonSections = matchingSections
        .filter((item) => item.seasonNumber === seasonNumber && item.published === true)
        .sort((a, b) => a.quality.localeCompare(b.quality));

      if (seasonSections.length === 0) {
        await answer('No published qualities found for that season.');
        return;
      }

      await answer(`Season ${seasonNumber} selected.`);
      await editSelection(
        `${seriesRecord.title} — Season ${seasonNumber}\n\nChoose the quality to replace:`,
        {
          inline_keyboard: seasonSections.map((section) => [{
            text: section.quality,
            callback_data: `editreplace:${seriesId}:${section.id}`,
          }]),
        },
      );
      return;
    }

    if (data.startsWith('editreplace:')) {
      if (
        !isOwner(userId) ||
        userId !== 924952328 ||
        message.chat.type !== 'private'
      ) {
        await answer('This action is only available to the bot owner.');
        return;
      }

      const parts = data.split(':');
      const seriesId = Number(parts[1]);
      const sectionId = Number(parts[2]);

      if (
        parts.length !== 3 ||
        !Number.isSafeInteger(seriesId) ||
        !Number.isSafeInteger(sectionId)
      ) {
        await answer('Invalid replacement selection.');
        return;
      }

      try {
        const seriesRecord = await db
          .select()
          .from(series)
          .where(and(eq(series.id, seriesId), eq(series.published, true)))
          .get();

        const section = await db
          .select()
          .from(sections)
          .where(and(eq(sections.id, sectionId), eq(sections.published, true)))
          .get();

        if (!seriesRecord || !section || section.seriesId !== seriesId) {
          await answer('That published season or quality no longer exists.');
          return;
        }

        const result = await prepareReplacementUpload(
          userId,
          message.chat.id,
          seriesRecord.title,
          section.seasonNumber,
          section.quality,
        );

        let cleanupWarning = false;
        try {
          await clearOwnerDraft(userId);
        } catch {
          cleanupWarning = true;
        }

        await answer('Replacement upload prepared.');
        await editSelection(
          '♻️ Replacement upload prepared\n\n' +
            `Series: ${result.series.title}\n` +
            `Season: ${result.section.seasonNumber}\n` +
            `Quality: ${result.section.quality}\n\n` +
            'Send the replacement episode files in this private chat.\n' +
            'Send /done to review the batch, then /confirm to publish it.\n' +
            'The existing published episodes remain available until confirmation.' +
            (cleanupWarning ? '\n\nWarning: draft cleanup failed. Finish this upload before starting another.' : ''),
          { inline_keyboard: [] },
        );
      } catch (error) {
        await answer('Could not prepare replacement.');
        await api.sendMessage({
          chat_id: message.chat.id,
          text: `Could not prepare replacement: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
      return;
    }
    if (data.startsWith('draftstatus:')) {
      if (
        !isOwner(userId) ||
        message.chat.type !== 'private' ||
        !['draftstatus:ongoing', 'draftstatus:finished'].includes(data)
      ) {
        await answer('This button is not available to you.');
        return;
      }

      const draft = await getOwnerDraft(userId);

      if (
        !draft ||
        draft.ownerChatId !== message.chat.id ||
        draft.step !== 'status'
      ) {
        await answer('This series setup has expired. Start again with /aseries.');
        return;
      }

      const status = data === 'draftstatus:ongoing'
        ? 'ongoing'
        : 'finished';

      await updateOwnerDraft(userId, {
        status,
        step: 'season',
      });

      await answer(`Status set to ${status.toUpperCase()}.`);

      await editSelection(
        `Series title: ${draft.title}\nStatus: ${status.toUpperCase()}\n\nSend the season number, for example: 1`,
        null,
      );

      return;
    }

    if (data.startsWith('draftquality:')) {
      const quality = data.slice('draftquality:'.length);
      const allowedQualities = ['480p', '720p', '1080p', '2160p'];

      if (
        !isOwner(userId) ||
        message.chat.type !== 'private' ||
        !allowedQualities.includes(quality)
      ) {
        await answer('This button is not available to you.');
        return;
      }

      const draft = await getOwnerDraft(userId);

      if (
        !draft ||
        draft.ownerChatId !== message.chat.id ||
        draft.step !== 'quality'
      ) {
        await answer('This series setup has expired. Start again with /aseries.');
        return;
      }

      await updateOwnerDraft(userId, {
        quality,
        step: 'part_choice',
      });
      await answer(`Quality set to ${quality}.`);
      await editSelection(
        'Does this season contain multiple parts?',
        {
          inline_keyboard: [[
            { text: 'Yes', callback_data: 'partchoice:yes' },
            { text: 'No', callback_data: 'partchoice:no' },
          ]],
        },
      );

      return;
    }

    if (data.startsWith('partchoice:')) {
      const choice = data.slice('partchoice:'.length);

      if (
        !isOwner(userId) ||
        message.chat.type !== 'private' ||
        !['yes', 'no'].includes(choice)
      ) {
        await answer('This action is only available to an authorized admin.');
        return;
      }

      const draft = await getOwnerDraft(userId);
      if (
        !draft ||
        draft.ownerChatId !== message.chat.id ||
        draft.step !== 'part_choice'
      ) {
        await answer('This season setup has expired.');
        return;
      }

      if (choice === 'yes') {
        try {
          const seriesRecord = await prepareNewSeriesParts(
            userId,
            message.chat.id,
          );
          await answer('Part entry started.');
          await editSelection(
            `${seriesRecord.title} — Season ${draft.seasonNumber}\n\n` +
              `Send part identifiers in SEASON.PART format, such as ${draft.seasonNumber}.1, ${draft.seasonNumber}.2, and ${draft.seasonNumber}.3.\n` +
              'Each part is uploaded and reviewed separately.\n\n' +
              'Send /finish when all parts are entered, or /cancel to cancel part entry.',
            { inline_keyboard: [] },
          );
        } catch (error) {
          await answer('Could not start part entry.');
          await api.sendMessage({
            chat_id: message.chat.id,
            text:
              `Could not start this series: ${
                error instanceof Error ? error.message : 'Unknown error'
              }\n\nThe current setup draft was retained.`,
          });
        }
        return;
      }

      try {
        const result = await prepareNewSeriesUpload(userId, message.chat.id);
        await answer('Preparing the season upload.');
        await editSelection(
          '📦 Series upload prepared\n\n' +
            `Series: ${result.series.title}\n` +
            `Status: ${result.series.status.toUpperCase()}\n` +
            `Season: ${result.section.seasonNumber}\n` +
            `Quality: ${result.section.quality}\n\n` +
            'Send the episode files in this private chat.\n' +
            'When finished, send /done to review the batch.\n' +
            'Nothing will be published until you explicitly confirm it.',
          { inline_keyboard: [] },
        );
      } catch (error) {
        await answer('Could not prepare the upload.');
        await api.sendMessage({
          chat_id: message.chat.id,
          text:
            `Could not prepare this season: ${
              error instanceof Error ? error.message : 'Unknown error'
            }\n\nYour existing setup draft was retained.`,
        });
      }
      return;
    }

    if (data.startsWith('partflow:')) {
      if (!isOwner(userId) || message.chat.type !== 'private') {
        await answer('This action is only available to an authorized admin.');
        return;
      }

      const action = data.slice('partflow:'.length);
      const draft = await getOwnerDraft(userId);
      if (
        !draft ||
        draft.ownerChatId !== message.chat.id ||
        draft.step !== 'part_wait' ||
        !['add', 'finish'].includes(action)
      ) {
        await answer('This part-entry action has expired.');
        return;
      }

      if (action === 'add') {
        await updateOwnerDraft(userId, { step: 'part_identifier' });
        await answer('Add another part.');
        await editSelection(
          `Send the next part identifier in SEASON.PART format, for example ${draft.seasonNumber}.2.\nSend /finish when all parts are entered.`,
          { inline_keyboard: [] },
        );
        return;
      }

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
      await clearOwnerDraft(userId);
      await answer('Part entry finished.');
      await editSelection(
        'Part entry finished. You can return to the owner panel or start another admin task.',
        { inline_keyboard: [] },
      );
      return;
    }

    const parts = data.split(':');
    const action = parts[0];

    if (['season', 'part', 'parts', 'quality'].includes(action)) {
      const allowedGroup =
        message?.chat &&
        ['group', 'supergroup'].includes(message.chat.type) &&
        await isAuthorizedSearchGroup(message.chat.id);

      if (!allowedGroup) {
        await answer('Search selections are only available in the authorized group.');
        return;
      }

      const requesterUserId = Number(parts[parts.length - 1]);

      if (
        !Number.isSafeInteger(requesterUserId) ||
        requesterUserId < 1 ||
        requesterUserId !== userId
      ) {
        await answer("This button isn't meant for you. Please search for the series yourself.");
        return;
      }
    }

    if (['deliver', 'continue'].includes(action)) {
      if (message?.chat?.type !== 'private') {
        await answer('Please open the bot privately to receive episodes.');
        return;
      }

      const recipientUserId = Number(parts[parts.length - 1]);

      if (
        !Number.isSafeInteger(recipientUserId) ||
        recipientUserId < 1 ||
        recipientUserId !== userId
      ) {
        await answer("This button isn't meant for you.");
        return;
      }
    }
    if (['deliver', 'continue'].includes(action) && !isOwner(userId)) {
      const membership = await checkChannelMembership(userId);

      if (membership !== true) {
        await answer(
          membership === null
            ? 'Could not verify membership. Please try again.'
            : 'Please join @DoomFlix first.',
        );
        await sendFsubPrompt(
          message.chat.id,
          'home',
          membership === null,
        );
        return;
      }
    }
    if (action === 'season' && parts.length === 4) {
      const seriesId = Number(parts[1]);
      const seasonNumber = Number(parts[2]);

      if (
        !Number.isSafeInteger(seriesId) ||
        !Number.isSafeInteger(seasonNumber) ||
        seriesId < 1 ||
        seasonNumber < 1
      ) {
        await answer('Invalid season selection.');
        return;
      }

      const seriesRecord = await db
        .select()
        .from(series)
        .where(
          and(
            eq(series.id, seriesId),
            eq(series.published, true),
          ),
        )
        .get();

      if (!seriesRecord) {
        await answer('This series is no longer available.');
        return;
      }

      const allSections = await db
        .select()
        .from(sections)
        .where(
          and(
            eq(sections.seriesId, seriesId),
            eq(sections.seasonNumber, seasonNumber),
            eq(sections.published, true),
          ),
        )
        .all();

      if (allSections.length === 0) {
        await answer('No published qualities for this season.');
        return;
      }

      const splitSections = allSections.filter(
        (section) => (section.partNumber ?? 0) > 0,
      );

      if (splitSections.length > 0) {
        await answer(`Season ${seasonNumber} selected.`);
        await editSelection(
          `${seriesRecord.title} — Season ${seasonNumber}\nSelect a part:`,
          buildPartKeyboard(
            allSections,
            seriesId,
            seasonNumber,
            userId,
          ),
        );
      } else {
        await answer(`Season ${seasonNumber} selected.`);
        await editSelection(
          `${seriesRecord.title} — Season ${seasonNumber}\nSelect quality:`,
          buildQualityKeyboard(allSections, userId),
        );
      }

      return;
    }

    if (action === 'part' && parts.length === 5) {
      const seriesId = Number(parts[1]);
      const seasonNumber = Number(parts[2]);
      const partNumber = Number(parts[3]);

      if (
        !Number.isSafeInteger(seriesId) ||
        seriesId < 1 ||
        !Number.isSafeInteger(seasonNumber) ||
        seasonNumber < 1 ||
        !Number.isSafeInteger(partNumber) ||
        partNumber < 0
      ) {
        await answer('Invalid part selection.');
        return;
      }

      const seriesRecord = await db
        .select()
        .from(series)
        .where(
          and(
            eq(series.id, seriesId),
            eq(series.published, true),
          ),
        )
        .get();
      const matchingSections = await db
        .select()
        .from(sections)
        .where(
          and(
            eq(sections.seriesId, seriesId),
            eq(sections.seasonNumber, seasonNumber),
            eq(sections.published, true),
          ),
        )
        .all();
      const partSections = matchingSections.filter(
        (section) => (section.partNumber ?? 0) === partNumber,
      );

      if (!seriesRecord || partSections.length === 0) {
        await answer('This part is no longer available.');
        return;
      }

      await answer(partNumber === 0 ? 'Full season selected.' : `Part ${partNumber} selected.`);
      await editSelection(
        `${seriesRecord.title} — Season ${seasonNumber}` +
          (partNumber > 0 ? ` — Part ${partNumber}` : '') +
          '\nSelect quality:',
        buildQualityKeyboard(partSections, userId),
      );
      return;
    }

    if (action === 'parts' && parts.length === 4) {
      const seriesId = Number(parts[1]);
      const seasonNumber = Number(parts[2]);

      if (
        !Number.isSafeInteger(seriesId) ||
        seriesId < 1 ||
        !Number.isSafeInteger(seasonNumber) ||
        seasonNumber < 1
      ) {
        await answer('Invalid part selector.');
        return;
      }

      const seriesRecord = await db
        .select()
        .from(series)
        .where(
          and(
            eq(series.id, seriesId),
            eq(series.published, true),
          ),
        )
        .get();
      const matchingSections = await db
        .select()
        .from(sections)
        .where(
          and(
            eq(sections.seriesId, seriesId),
            eq(sections.seasonNumber, seasonNumber),
            eq(sections.published, true),
          ),
        )
        .all();

      if (!seriesRecord || !matchingSections.some((section) => section.partNumber > 0)) {
        await answer('This part selector is no longer available.');
        return;
      }

      await answer('Choose another part.');
      await editSelection(
        `${seriesRecord.title} — Season ${seasonNumber}\nSelect a part:`,
        buildPartKeyboard(
          matchingSections,
          seriesId,
          seasonNumber,
          userId,
        ),
      );
      return;
    }

    if (action === 'quality' && parts.length === 3) {
      const sectionId = Number(parts[1]);

      if (!Number.isSafeInteger(sectionId) || sectionId < 1) {
        await answer('Invalid quality selection.');
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
        await answer('This quality is no longer available.');
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
        await answer('This series is no longer available.');
        return;
      }

      if (!['finished', 'ongoing'].includes(seriesRecord.status)) {
        await answer('This series has an invalid status.');
        return;
      }

      const bot = await api.getMe();

      await answer('Quality selected. Open the bot privately to continue.');

      const seasonSections = await db
        .select()
        .from(sections)
        .where(
          and(
            eq(sections.seriesId, section.seriesId),
            eq(sections.seasonNumber, section.seasonNumber),
            eq(sections.published, true),
          ),
        )
        .all();
      const hasParts = seasonSections.some(
        (item) => (item.partNumber ?? 0) > 0,
      );
      const partLabel =
        (section.partNumber ?? 0) > 0
          ? ` — Part ${section.partNumber}`
          : '';

      await editSelection(
        `${seriesRecord.title} — Season ${section.seasonNumber}${partLabel} — ${section.quality}\n\nOpen the bot privately to choose episodes and receive them.`,
        {
          inline_keyboard: [
            [{
              text: '➡️ Open bot to continue',
              url: `https://t.me/${bot.username}?start=pick_${sectionId}_${userId}`,
            }],
            ...(hasParts
              ? [[{
                  text: '↩️ Choose another part',
                  callback_data:
                    `parts:${section.seriesId}:${section.seasonNumber}:${userId}`,
                }]]
              : []),
          ],
        },
      );

      return;
    }
    if (action === 'deliver' && parts.length === 4) {
      const sectionId = Number(parts[1]);
      const mode = parts[2];

      if (
        !Number.isSafeInteger(sectionId) ||
        sectionId < 1 ||
        !['all', 'latest'].includes(mode)
      ) {
        await answer('Invalid delivery selection.');
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
        await answer('This season is no longer available.');
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
        await answer('This series is no longer available.');
        return;
      }

      if (mode === 'latest' && seriesRecord.status !== 'ongoing') {
        await answer('Latest-only delivery is for ongoing series.');
        return;
      }

      await answer('Starting delivery in batches.');

      try {
        const existingJob = await findMatchingActiveDeliveryJob({
  targetUserId: userId,
  sectionId,
  mode,
});

const job = existingJob ?? await createDeliveryJob({
  ownerUserId: userId,
  targetUserId: userId,
  sectionId,
  mode,
});

await runDeliveryJob(job.id);
      } catch (error) {
        await reportDeliveryFailure(error);
      }

      return;
    }

    if (action === 'continue' && parts.length === 3) {
      const jobId = Number(parts[1]);

      if (!Number.isSafeInteger(jobId) || jobId < 1) {
        await answer('Invalid delivery job.');
        return;
      }

      await answer('Resuming delivery.');

      try {
        await runDeliveryJob(jobId);
      } catch (error) {
        await reportDeliveryFailure(error);
      }

      return;
    }

    await answer('Unknown or expired button.');
  } catch (error) {
    if (!answered) {
      try {
        await answer('Something went wrong. Please try again.');
      } catch {
        // The callback may have expired or already been answered.
      }
    }
  }
}
