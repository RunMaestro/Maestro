/**
 * The message of a rejected or failed IPC call, as a person should read it.
 *
 * Electron wraps a throw from a main-process handler before it reaches the
 * renderer:
 *
 *   Error invoking remote method 'webLogin:createUser': Error: Name is taken.
 *
 * The channel name and the error class are plumbing. What the handler said is
 * the part after them, and that is what a surface shows inline.
 *
 * A handler built with `createIpcHandler` (`src/main/utils/ipcHandler.ts`)
 * does not reject: it answers `{ success: false, error: String(error) }`, so
 * the class name leads the text (`MarketplaceImportError: ...`). That answer
 * goes through `ipcResultErrorMessage`.
 */

/** Electron's wrapper: the channel that was invoked. */
const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*': /;

/** The class name Electron prints in front of the handler's own message. */
const ERROR_CLASS_PREFIX = /^[A-Za-z]*Error: /;

/**
 * What a rejected `window.maestro.*` call should show, without Electron's
 * wrapper. A value that is not an `Error` is shown as text, and a message that
 * was never wrapped comes back as it is.
 */
export function ipcErrorMessage(error: unknown): string {
	if (!(error instanceof Error) || !error.message) return String(error);
	const unwrapped = error.message.replace(IPC_INVOKE_PREFIX, '');
	// The class prefix is dropped only behind the wrapper: a message that
	// merely starts with "Error: " on its own was written that way.
	if (unwrapped === error.message) return error.message.trim();
	return unwrapped.replace(ERROR_CLASS_PREFIX, '').trim();
}

/**
 * What the `error` of a failed `createIpcHandler` answer should show, without
 * the class name `String(error)` put in front of it. A thrown string has no
 * class name and comes back as it is. A missing or blank error is `fallback`.
 * Only for `createIpcHandler` answers: a handler that writes its own `error`
 * text may mean a leading `Error: `.
 */
export function ipcResultErrorMessage(error: string | undefined, fallback: string): string {
	return error?.replace(ERROR_CLASS_PREFIX, '').trim() || fallback;
}
