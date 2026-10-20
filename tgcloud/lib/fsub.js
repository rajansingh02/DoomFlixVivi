import { api, db } from 'sdk';
import { and, eq } from 'sdk/db';
import { sections, series } from '../schema.js';
import { buildDeliveryKeyboard } from './keyboards.js';

export async function checkChannelMembership(userId) {
  try {
    const result = await api.getChatMember({
      chat_id: '@DoomFlix',
      user_id: userId,
    });

    const status = result?.status;
    if (['creator', 'administrator', 'member'].includes(status)) {
      return true;
    }
    if (status === 'restricted') {
      return result.is_member === true;
    }
    return false;
  } catch {
    return null;
  }
}

export function buildFsubPrompt(payload = 'home', verificationFailed = false) {
  const safePayload =
    typeof payload === 'string' &&
    /^(?:home|pick_\d+_\d+)$/.test(payload)
      ? payload
      : 'home';

  return {
    text:
      (verificationFailed
        ? "I couldn't verify your membership right now. Please try Check Again in a moment.\n\n"
        : 'Please join our channel to continue.\n\n') +
      '1. Join @DoomFlix using the button below.\n' +
      '2. Return here and tap Check Again.',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Join @DoomFlix', url: 'https://t.me/DoomFlix' }],
        [{ text: 'Check Again', callback_data: `fsubcheck:${safePayload}` }],
      ],
    },
  };
}

export async function sendFsubPrompt(chatId, payload = 'home', verificationFailed = false) {
  const prompt = buildFsubPrompt(payload, verificationFailed);
  await api.sendMessage({
    chat_id: chatId,
    text: prompt.text,
    reply_markup: prompt.reply_markup,
  });
}

export async function handlePickPayload(payload, userId, chatId) {
  const pickMatch = payload.match(/^pick_(\d+)_(\d+)$/);

  if (!pickMatch) {
    await api.sendMessage({
      chat_id: chatId,
      text: 'This link is invalid or expired. Please search for the series again.',
    });
    return;
  }

  const sectionId = Number(pickMatch[1]);
  const intendedUserId = Number(pickMatch[2]);

  if (
    !Number.isSafeInteger(sectionId) || sectionId < 1 ||
    !Number.isSafeInteger(intendedUserId) || intendedUserId < 1
  ) {
    await api.sendMessage({
      chat_id: chatId,
      text: 'This link is invalid or expired. Please search for the series again.',
    });
    return;
  }

  if (intendedUserId !== userId) {
    await api.sendMessage({
      chat_id: chatId,
      text: "This link isn't meant for you. Please search for the series yourself.",
    });
    return;
  }

  const section = await db
    .select()
    .from(sections)
    .where(and(
      eq(sections.id, sectionId),
      eq(sections.published, true),
    ))
    .get();

  if (!section) {
    await api.sendMessage({
      chat_id: chatId,
      text: 'This season is no longer available. Please search for the series again.',
    });
    return;
  }

  const seriesRecord = await db
    .select()
    .from(series)
    .where(and(
      eq(series.id, section.seriesId),
      eq(series.published, true),
    ))
    .get();

  if (!seriesRecord) {
    await api.sendMessage({
      chat_id: chatId,
      text: 'This series is no longer available. Please search again.',
    });
    return;
  }

  if (!['finished', 'ongoing'].includes(seriesRecord.status)) {
    await api.sendMessage({
      chat_id: chatId,
      text: 'This series currently cannot be delivered.',
    });
    return;
  }

  const replyMarkup =
    seriesRecord.status === 'ongoing'
      ? buildDeliveryKeyboard(sectionId, seriesRecord.status, userId)
      : {
          inline_keyboard: [[{
            text: 'All episodes',
            callback_data: `deliver:${sectionId}:all:${userId}`,
          }]],
        };

  await api.sendMessage({
    chat_id: chatId,
    text:
      `${seriesRecord.title} — Season ${section.seasonNumber} — ${section.quality}\n\n` +
      (seriesRecord.status === 'ongoing'
        ? 'Choose which episodes to receive:'
        : 'This series is finished. Start delivery to receive its episodes.'),
    reply_markup: replyMarkup,
  });
}