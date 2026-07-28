const FREE_CHAT_KEY = 'portside_free_chat_used';

export function hasUsedFreeChat(): boolean {
  try {
    return localStorage.getItem(FREE_CHAT_KEY) === '1';
  } catch {
    return false;
  }
}

export function markFreeChatUsed(): void {
  try {
    localStorage.setItem(FREE_CHAT_KEY, '1');
  } catch {
    // Ignore private-mode / blocked storage.
  }
}
