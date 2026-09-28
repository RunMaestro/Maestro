/**
 * toastClickAction - the canonical "what happens when a toast is clicked" type.
 *
 * A toast can be fired from the renderer, from Cue in the main process, from
 * the CLI over the WebSocket bridge, or from the web interface. Only the first
 * of those can attach a function callback, so every other producer describes
 * the click intent as DATA and the renderer dispatches on `kind`.
 *
 * This shape used to be copy-pasted in five places (notificationStore,
 * web-server/types, preload/process, global.d.ts, cue-notify-bridge), which
 * meant adding a kind meant finding all five. It lives here now; those modules
 * alias this type. The renderer's dispatcher is
 * `renderer/services/toastClickActions.ts` - keep the two in step when adding
 * a kind, and extend `parseToastClickAction()` below so external callers get a
 * clear error instead of a toast that silently does nothing when clicked.
 */

/**
 * Data-driven click intent for a toast. Every variant that targets a surface
 * inside an agent carries `sessionId`, because a tab is only addressable
 * through its owning agent.
 *
 *   jump-session  - switch to the agent, optionally to one of its AI tabs
 *   open-file     - switch to the agent and open a file in its File Preview pane
 *   open-terminal - switch to the agent and focus one of its terminal tabs
 *   open-browser  - focus an existing in-app browser tab, or open `url` in a new one
 *   open-url      - open a URL in the system browser (no agent involved)
 */
export type ToastClickAction =
	| { kind: 'jump-session'; sessionId: string; tabId?: string }
	| { kind: 'open-file'; sessionId: string; path: string }
	| {
			kind: 'open-terminal';
			sessionId: string;
			/**
			 * Terminal tab id, or its display name. Omitted means "the agent's
			 * active terminal tab, or its only one" - the same resolution the CLI's
			 * `send-terminal --tab` uses (see `resolveTerminalTab`).
			 */
			tabRef?: string;
	  }
	| {
			kind: 'open-browser';
			sessionId: string;
			/** Existing browser tab to focus. Wins over `url` when the tab still exists. */
			tabId?: string;
			/**
			 * URL to open in a NEW in-app browser tab when `tabId` is absent or the
			 * tab it names is gone. At least one of `tabId` / `url` must be set.
			 */
			url?: string;
	  }
	| { kind: 'open-url'; url: string };

/** Every valid `kind`, for validation messages and CLI help. */
export const TOAST_CLICK_ACTION_KINDS = [
	'jump-session',
	'open-file',
	'open-terminal',
	'open-browser',
	'open-url',
] as const;

export type ToastClickActionKind = (typeof TOAST_CLICK_ACTION_KINDS)[number];

/** Read a non-empty string field, or undefined when absent/blank/not a string. */
function str(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Validate an untrusted click-action payload (CLI / web / plugin).
 *
 * Returns `{}` when `raw` is absent (no click action is a valid toast),
 * `{ action }` on success, and `{ error }` with a human-readable reason when
 * the shape is wrong. Callers surface the error rather than dropping it, so a
 * malformed action never becomes a toast whose click does nothing.
 */
export function parseToastClickAction(raw: unknown): {
	action?: ToastClickAction;
	error?: string;
} {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== 'object') return { error: 'clickAction must be an object' };
	const obj = raw as Record<string, unknown>;
	const kind = obj.kind;

	switch (kind) {
		case 'jump-session': {
			const sessionId = str(obj, 'sessionId');
			if (!sessionId) return { error: "clickAction kind 'jump-session' requires sessionId" };
			return { action: { kind, sessionId, tabId: str(obj, 'tabId') } };
		}
		case 'open-file': {
			const sessionId = str(obj, 'sessionId');
			if (!sessionId) return { error: "clickAction kind 'open-file' requires sessionId" };
			const path = str(obj, 'path');
			if (!path) return { error: "clickAction kind 'open-file' requires path" };
			return { action: { kind, sessionId, path } };
		}
		case 'open-terminal': {
			const sessionId = str(obj, 'sessionId');
			if (!sessionId) return { error: "clickAction kind 'open-terminal' requires sessionId" };
			return { action: { kind, sessionId, tabRef: str(obj, 'tabRef') } };
		}
		case 'open-browser': {
			const sessionId = str(obj, 'sessionId');
			if (!sessionId) return { error: "clickAction kind 'open-browser' requires sessionId" };
			const tabId = str(obj, 'tabId');
			const url = str(obj, 'url');
			if (!tabId && !url) {
				return { error: "clickAction kind 'open-browser' requires tabId or url" };
			}
			return { action: { kind, sessionId, tabId, url } };
		}
		case 'open-url': {
			const url = str(obj, 'url');
			if (!url) return { error: "clickAction kind 'open-url' requires url" };
			return { action: { kind, url } };
		}
		default:
			return {
				error: `Invalid clickAction kind: ${String(kind)}. Must be one of: ${TOAST_CLICK_ACTION_KINDS.join(', ')}`,
			};
	}
}
