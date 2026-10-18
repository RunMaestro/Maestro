/**
 * The message of a rejected IPC call, as a person should read it.
 *
 * Electron wraps a throw from a main-process handler before it reaches the
 * renderer:
 *
 *   Error invoking remote method 'webLogin:createUser': Error: Name is taken.
 *
 * The channel name and the error class are plumbing. What the handler said is
 * the part after them, and that is what a surface shows inline.
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
