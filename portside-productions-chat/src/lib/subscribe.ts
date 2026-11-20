const SUBSCRIBE_KEY = 'portside_subscribed_email';

export function getSubscribedEmail(): string | null {
  try {
    const value = localStorage.getItem(SUBSCRIBE_KEY)?.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function saveSubscribedEmail(email: string): void {
  try {
    localStorage.setItem(SUBSCRIBE_KEY, email);
  } catch {
    // Ignore private-mode / blocked storage.
  }
}
