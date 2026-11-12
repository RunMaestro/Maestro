const pendingDesktopAiTabSelections = new Map<string, string>();

/**
 * Record an explicit AI-tab selection made in the desktop renderer.
 *
 * The Live Mode inventory poll consumes this signal so it can distinguish a
 * human navigation gesture from lifecycle changes that also replace
 * `activeTabId`, such as closing the active tab.
 */
export function noteDesktopAiTabSelection(sessionId: string, tabId: string): void {
	pendingDesktopAiTabSelections.set(sessionId, tabId);
}

/**
 * Consume the pending desktop selection for a session, returning true only
 * when it still matches the active tab that is about to be broadcast.
 */
export function consumeDesktopAiTabSelection(sessionId: string, activeTabId: string): boolean {
	const selectedTabId = pendingDesktopAiTabSelections.get(sessionId);
	pendingDesktopAiTabSelections.delete(sessionId);
	return selectedTabId === activeTabId;
}

/**
 * Discard selections made while Live Mode was inactive so they cannot be
 * replayed as fresh navigation when the server starts later.
 */
export function clearDesktopAiTabSelections(): void {
	pendingDesktopAiTabSelections.clear();
}
