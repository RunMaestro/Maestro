/**
 * Error text that survives JSON and IPC, and reads well when shown.
 *
 * `JSON.stringify(new Error('x'))` is `{}`: `name`, `message` and `stack` are
 * not enumerable. A log entry that carries a raw Error therefore reaches the
 * System Log Viewer (and the log file) as `{}`, and the reason for the failure
 * is lost. Both loggers pass their `data` through `toLoggableData()` so every
 * Error is copied into a plain object before it is stored or sent.
 */

/** Copy an Error's useful fields into a plain, JSON-safe object. */
export function serializeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		// `cause` is ES2022; read it untyped so every tsconfig target compiles.
		const cause = (error as { cause?: unknown }).cause;
		return {
			// Own enumerable extras first (e.g. `code`, `errno`, `path` on Node
			// errors), so the standard fields below always win.
			...(error as unknown as Record<string, unknown>),
			name: error.name,
			message: error.message,
			stack: error.stack,
			...(cause !== undefined ? { cause: toLoggableData(cause) } : {}),
		};
	}
	if (typeof error === 'object' && error !== null) {
		return error as Record<string, unknown>;
	}
	return { value: String(error) };
}

/**
 * Normalize a logger `data` argument: an Error becomes a plain object, and so
 * does an Error held directly by a plain object's own key (the common
 * `logger.error(msg, ctx, { error })` shape). Everything else passes through
 * unchanged, by reference when nothing needed converting.
 */
export function toLoggableData(data: unknown): unknown {
	if (data instanceof Error) return serializeError(data);
	if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
	if (Object.getPrototypeOf(data) !== Object.prototype) return data;

	let copy: Record<string, unknown> | null = null;
	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		if (value instanceof Error) {
			copy ??= { ...(data as Record<string, unknown>) };
			copy[key] = serializeError(value);
		}
	}
	return copy ?? data;
}

const IPC_PREFIX = /^Error invoking remote method '[^']+':\s*/;
const ERROR_PREFIX = /^Error:\s*/;

/**
 * The message to SHOW for a rejected `window.maestro.*` call.
 *
 * Electron wraps a main-process throw as `Error invoking remote method
 * 'fs:writeFile': Error: <message>`, and a handler that re-throws with its own
 * prefix adds another `: Error: ` layer (`Failed to write file: Error: Unable
 * to connect to "pedtome" over SSH.`). The innermost message is the one that
 * names the cause, so that is what comes back.
 */
export function ipcErrorMessage(error: unknown, fallback = 'Unknown error'): string {
	const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	const message = raw.replace(IPC_PREFIX, '').replace(ERROR_PREFIX, '');
	const innermost = message
		.split(/:\s*Error:\s*/)
		.pop()
		?.trim();
	return innermost || fallback;
}
