// Module-level live draft tracking for the active AI tab's textarea.
//
// Live input text lives in `useInputHandlers` local React state for perf
// (avoids re-rendering session subscribers on every keystroke). It is only
// flushed to `tab.inputValue` on blur/submit/tab-switch.
//
// `hasDraft(tab)` consults this store first so the close-tab confirmation
// (and unread/draft indicators) reflect what's actually on screen, not the
// stale persisted value. Falls back to `tab.inputValue` for non-active tabs.

const liveDrafts = new Map<string, string>();

export function setLiveDraft(tabId: string, value: string): void {
	liveDrafts.set(tabId, value);
}

export function getLiveDraft(tabId: string): string | undefined {
	return liveDrafts.get(tabId);
}

export function clearLiveDraft(tabId: string): void {
	liveDrafts.delete(tabId);
}
