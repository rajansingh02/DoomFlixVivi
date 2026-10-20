import { api, BotApiError } from 'sdk';
import { isOwner, isVaultConfigured, VAULT_CHAT_ID } from './config.js';
import { findActiveUploadSession, setUploadSessionStatus } from './sessions.js';
import {
  analyzeUploadSession,
  recordCopiedEpisode,
} from './episodes.js';

function getEpisodeMedia(message) {
  if (message.document) {
    return {
      fileName: message.document.file_name,
      type: 'document',
    };
  }

  if (message.audio) {
    return {
      fileName: message.audio.file_name,
      type: 'audio',
    };
  }

  if (message.video) {
    return {
      fileName: message.video.file_name || message.caption?.trim() || null,
      type: 'video',
    };
  }

  if (message.animation) {
    return {
      fileName: message.animation.file_name || message.caption?.trim() || null,
      type: 'animation',
    };
  }

  return null;
}

export async function handleOwnerEpisodeUpload(message) {
  const userId = message.from?.id;
  const chat = message.chat;

  if (
    !userId ||
    !chat ||
    chat.type !== 'private' ||
    !isOwner(userId)
  ) {
    return false;
  }

  const session = await findActiveUploadSession(userId);

  if (!session || session.ownerChatId !== chat.id) {
    return false;
  }

  const media = getEpisodeMedia(message);

  if (!media) {
    return false;
  }

  if (!isVaultConfigured()) {
    await api.sendMessage({
      chat_id: chat.id,
      text:
        'The private vault channel is not configured yet. ' +
        'Ask the bot owner to configure VAULT_CHAT_ID before uploading episodes.',
    });

    return true;
  }

  if (!media.fileName) {
    await api.sendMessage({
      chat_id: chat.id,
      text:
        'I could not identify this file name reliably. ' +
        'Please resend it as a document with its original filename, ' +
        'so episode numbering can be reviewed correctly.',
    });

    return true;
  }

  let copiedMessage;

  try {
    copiedMessage = await api.copyMessage({
      chat_id: VAULT_CHAT_ID,
      from_chat_id: chat.id,
      message_id: message.message_id,
    });
  } catch (error) {
    const retryAfter =
      error instanceof BotApiError
        ? Number(error.parameters?.retry_after)
        : 0;

    const description =
      typeof error?.description === 'string'
        ? error.description
        : typeof error?.message === 'string'
          ? error.message
          : 'Unknown Telegram API error';

    const text =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? `Telegram rate-limited the vault copy. Wait ${Math.ceil(retryAfter)} seconds, then resend this episode.`
        : `Could not copy this episode.\nTelegram error: ${description}`;

    await api.sendMessage({
      chat_id: chat.id,
      text,
    });

    return true;
  }

  let result;

  // Save the copied episode's metadata separately from notifications.
  try {
    result = await recordCopiedEpisode({
      sessionId: session.id,
      ownerUserId: userId,
      fileName: media.fileName,
      vaultChatId: VAULT_CHAT_ID,
      vaultMessageId: copiedMessage.message_id,
    });
  } catch (error) {
    // The copy succeeded, but the metadata write failed.
    // Attempt to remove the untracked vault post.
    let cleanupSucceeded = false;

    try {
      await api.deleteMessage({
        chat_id: VAULT_CHAT_ID,
        message_id: copiedMessage.message_id,
      });

      cleanupSucceeded = true;
    } catch {
      // Cleanup failure means the vault may contain an untracked post.
    }

    await api.sendMessage({
      chat_id: chat.id,
      text: cleanupSucceeded
        ? 'The episode was copied, but its metadata could not be saved. The vault copy was removed. Please retry the upload.'
        : 'The episode was copied, but its metadata could not be saved, and cleanup failed. The vault may contain an untracked post. Check the batch before retrying.',
    });

    return true;
  }

  // Build review warnings from the saved result.
  const warnings = [];

  if (!result.parsed) {
    warnings.push(
      'Episode number was not recognized; it will need review.',
    );
  }

  if (result.seasonMismatch) {
    warnings.push(
      'The filename appears to indicate a different season.',
    );
  }

  // Notification failure must never delete an episode whose metadata
  // has already been saved successfully.
  try {
    await api.sendMessage({
      chat_id: chat.id,
      text:
        `Episode copied to vault. Upload order: ${result.uploadOrder}.` +
        (warnings.length
          ? `\n\nReview warning:\n${warnings.join('\n')}`
          : ''),
    });
  } catch {
    // The episode remains recorded. The /done review can still show it.
  }

  return true;
}

export async function handleOwnerUploadCommand(message) {
  const userId = message.from?.id;
  const chat = message.chat;
  const text = message.text?.trim();

  if (
    !userId ||
    !chat ||
    chat.type !== 'private' ||
    !isOwner(userId) ||
    !text ||
    !/^\/done(?:@\w+)?$/i.test(text)
  ) {
    return false;
  }

  const session = await findActiveUploadSession(userId);

  if (!session || session.ownerChatId !== chat.id) {
    await api.sendMessage({
      chat_id: chat.id,
      text: 'There is no active episode upload session to finish.',
    });

    return true;
  }

  try {
    const review = await analyzeUploadSession(session.id, userId);

    if (review.totalEpisodes === 0) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'No episodes have been uploaded yet. Send the files before using /done.',
      });

      return true;
    }

    await setUploadSessionStatus(session.id, userId, 'review');

    const flagged = review.episodes.filter(
      (episode) => episode.reviewFlags.length > 0,
    );

    const preview = review.episodes.slice(0, 15).map((episode, index) => {
      const number = episode.episodeNumber
        ? `Episode ${episode.episodeNumber}`
        : 'Episode number unknown';

      const flags = episode.reviewFlags.length
        ? ` ⚠️ ${episode.reviewFlags.join(', ')}`
        : '';

      return `${index + 1}. ${number} — ${episode.fileName}${flags}`;
    });

    const remaining = review.totalEpisodes - preview.length;

    await api.sendMessage({
      chat_id: chat.id,
      text:
        `Upload batch ready for review.\n\n` +
        `Series ID: ${session.seriesId}\n` +
        `Section ID: ${session.sectionId}\n` +
        `Session ID: ${session.id}\n` +
        `Episodes: ${review.totalEpisodes}\n` +
        `Files requiring review: ${flagged.length}\n\n` +
        preview.join('\n') +
        (remaining > 0 ? `\n…and ${remaining} more file(s).` : '') +
        '\n\nThe series is still unpublished. Next, review the warnings and explicitly confirm or discard this batch.',
    });
  } catch {
    await api.sendMessage({
      chat_id: chat.id,
      text: 'Could not finish the upload batch. Please try again.',
    });
  }

  return true;
}