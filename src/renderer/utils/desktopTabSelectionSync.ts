const pendingDesktopAiTabSelections = new Map<string, string>();
let selectionConsumers = 0;

/** Retain navigation intent only while a Live inventory owner can consume it. */
export function startDesktopAiTabSelectionSync(): () => void {
	if (selectionConsumers++ === 0) clearDesktopAiTabSelections();
	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		if (--selectionConsumers === 0) clearDesktopAiTabSelections();
	};
}

/** Drop intent for sessions no longer present in the current Live inventory. */
export function pruneDesktopAiTabSelections(sessionIds: ReadonlySet<string>): void {
	for (const sessionId of pendingDesktopAiTabSelections.keys()) {
		if (!sessionIds.has(sessionId)) pendingDesktopAiTabSelections.delete(sessionId);
	}
}

/**
 * Record an explicit AI-tab selection made in the desktop renderer.
 *
 * The Live Mode inventory poll consumes this signal so it can distinguish a
 * human navigation gesture from lifecycle changes that also replace
 * `activeTabId`, such as closing the active tab.
 */
export function noteDesktopAiTabSelection(sessionId: string, tabId: string): void {
	if (selectionConsumers > 0) pendingDesktopAiTabSelections.set(sessionId, tabId);
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
 * Discard pending intent at an explicit reset or Live-owner lifecycle boundary.
 */
export function clearDesktopAiTabSelections(): void {
	pendingDesktopAiTabSelections.clear();
}
