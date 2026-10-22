/**
 * `webview.send()` throws when the guest webContents is not attached yet (a push can land before the guest
 * finishes loading) or is tearing down. Both are expected races for a host pushing into an isolated guest
 * (plugin panels, DataviewJS); anything else is a real error worth reporting.
 */
export function isDetachedWebviewError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /destroyed|disposed|detached|not attached|must be attached/i.test(message);
}
