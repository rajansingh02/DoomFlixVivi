
export const OWNER_USER_ID = 924952328;

// Replace this placeholder with your private vault channel ID.
// Telegram channel IDs are usually negative numbers, e.g. -1001234567890.
export const VAULT_CHAT_ID = '-1004309475693';

export function isOwner(userId) {
  return (
    Number.isSafeInteger(userId) &&
    OWNER_USER_ID > 0 &&
    userId === OWNER_USER_ID
  );
}

export function isVaultConfigured() {
  return (
    typeof VAULT_CHAT_ID === 'string' &&
    /^-100\d+$/.test(VAULT_CHAT_ID)
  );
}
