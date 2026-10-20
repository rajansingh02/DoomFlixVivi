import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { groupAuthorization } from '../schema.js';
import { isOwner } from './config.js';

const AUTHORIZATION_ID = 1;

function isGroup(chat) {
  return chat && ['group', 'supergroup'].includes(chat.type);
}

export async function isAuthorizedSearchGroup(chatId) {
  const authorization = await db
    .select()
    .from(groupAuthorization)
    .where(eq(groupAuthorization.id, AUTHORIZATION_ID))
    .get();

  return Boolean(
    authorization &&
    String(authorization.chatId) === String(chatId)
  );
}

export async function handleGroupAuthCommand(message) {
  const text = message.text?.trim();
  const chat = message.chat;
  const userId = message.from?.id;

  if (
    !text ||
    !/^\/avivi(?:_status|_remove)?(?:@\w+)?$/i.test(text)
  ) {
    return false;
  }

  if (!isOwner(userId)) {
    await api.sendMessage({
      chat_id: chat.id,
      text: 'You are not authorized to manage the search group.',
    });
    return true;
  }

  if (!isGroup(chat)) {
    await api.sendMessage({
      chat_id: chat.id,
      text: 'Use /avivi, /avivi_status, or /avivi_remove inside a group.',
    });
    return true;
  }

  const command = text.match(/^\/(avivi(?:_status|_remove)?)(?:@\w+)?$/i)?.[1]
    ?.toLowerCase();

  if (command === 'avivi') {
    await db
      .insert(groupAuthorization)
      .values({
        id: AUTHORIZATION_ID,
        chatId: String(chat.id),
        chatTitle: chat.title ?? 'Unnamed group',
        authorizedBy: userId,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoUpdate({
        target: groupAuthorization.id,
        set: {
          chatId: String(chat.id),
          chatTitle: chat.title ?? 'Unnamed group',
          authorizedBy: userId,
          updatedAt: Math.floor(Date.now() / 1000),
        },
      })
      .run();

    await api.sendMessage({
      chat_id: chat.id,
      text:
        '✅ DoomFlix Series search enabled for this group.\n\n' +
        'Only this group can search series and use season/quality selection buttons. ' +
        'If you authorize another group, that group will replace this one.',
    });

    return true;
  }

  if (command === 'avivi_status') {
    const authorization = await db
      .select()
      .from(groupAuthorization)
      .where(eq(groupAuthorization.id, AUTHORIZATION_ID))
      .get();

    if (!authorization) {
      await api.sendMessage({
        chat_id: chat.id,
        text: 'No search group is currently authorized.',
      });
    } else {
      await api.sendMessage({
        chat_id: chat.id,
        text:
          'Authorized search group:\n' +
          `${authorization.chatTitle}\n` +
          `Chat ID: ${authorization.chatId}\n` +
          `This is the authorized group: ${
            String(chat.id) === String(authorization.chatId) ? 'Yes' : 'No'
          }`,
      });
    }

    return true;
  }

  if (command === 'avivi_remove') {
    const result = await db
      .delete(groupAuthorization)
      .where(eq(groupAuthorization.id, AUTHORIZATION_ID))
      .run();

    await api.sendMessage({
      chat_id: chat.id,
      text: result.rowsAffected
        ? 'Search-group authorization has been removed.'
        : 'There was no authorized search group to remove.',
    });

    return true;
  }

  return false;
}

