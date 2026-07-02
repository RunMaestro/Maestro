/**
 * Shared browser-coworking contract types.
 *
 * Used across the main process (registry / tools / bridge), the preload bridge,
 * and the renderer responder. Kept in `src/shared` (compiled by every tsconfig)
 * so the contract has a single source of truth instead of being duplicated
 * across the IPC boundary.
 */

/** Raw browser-tab data the renderer pushes per session. The registry assigns
 *  the stable public `browser:N` id, so we only carry raw tab metadata here. */
export interface CoworkingBrowserInput {
	tabUuid: string;
	url: string;
	title: string;
	favicon?: string;
	canGoBack: boolean;
	canGoForward: boolean;
	isLoading: boolean;
	/** True when the user hid this tab from agents (eye toggle). Pushed to main
	 *  so the registry can enforce exclusion server-side (defense in depth on
	 *  top of the renderer-side behavior), with no sync-cycle race window. */
	hiddenFromAgent?: boolean;
}

/** Browser tab as advertised to the agent via `list_browsers`, addressed by a
 *  stable readable id (`browser:2`). */
export interface CoworkingBrowserEntry {
	id: string;
	url: string;
	title: string;
	favicon?: string;
	canGoBack: boolean;
	canGoForward: boolean;
	isLoading: boolean;
}

/**
 * A browser operation that needs the LIVE webview (page-text/HTML extraction or
 * any interaction). Routed bridge -> ipc -> renderer responder, which resolves
 * the target tab's BrowserTabView handle. `read` is read-only; every other kind
 * is state-changing and gated behind the browser-interaction permission.
 */
export type BrowserOp =
	| { kind: 'read'; format: 'text' | 'innerText' | 'html'; selector?: string }
	| { kind: 'navigate'; url: string }
	| { kind: 'back' }
	| { kind: 'forward' }
	| { kind: 'reload' }
	| { kind: 'stop' }
	| { kind: 'click'; selector: string }
	| { kind: 'type'; selector: string; text: string }
	| { kind: 'eval'; code: string }
	| { kind: 'screenshot' }
	| { kind: 'waitFor'; selector: string; timeoutMs?: number }
	| { kind: 'newTab'; url?: string; ephemeral?: boolean }
	| { kind: 'closeTab' };

/** Interaction (state-changing) op kinds, gated behind the interaction
 *  permission. `read` is intentionally excluded. */
export type BrowserInteractionKind = Exclude<BrowserOp['kind'], 'read'>;

/** Result of a BrowserOp resolved by the renderer. Fields are populated per op
 *  kind; unused fields are omitted. */
export interface BrowserOpResult {
	/** Page text/html (read), stringified eval result, or a short status note. */
	content?: string;
	/** Data URL (PNG base64) for `screenshot`. */
	dataUrl?: string;
	/** Post-op metadata snapshot when available. */
	url?: string;
	title?: string;
	/** True when the op completed against a live webview. */
	ok: boolean;
}

/** Per-agent policy for whether a state-changing browser op needs an explicit
 *  per-call user approval, layered on top of the per-agent interaction permission.
 *  - 'off'       : no per-call approval (the interaction permission alone gates).
 *  - 'dangerous' : approve only the sharp-edge ops (navigate, eval). Default.
 *  - 'all'       : approve every interaction op. */
export type BrowserConfirmPolicy = 'off' | 'dangerous' | 'all';

/** Policy used when an agent has no explicit confirm entry configured. */
export const DEFAULT_BROWSER_CONFIRM_POLICY: BrowserConfirmPolicy = 'dangerous';

/** Ops the 'dangerous' policy always routes through per-call approval.
 *  `newTab` is navigation-equivalent (loads an arbitrary URL) and `closeTab`
 *  is destructive, so both sit alongside navigate/eval. */
export const ALWAYS_CONFIRM_KINDS: readonly BrowserInteractionKind[] = [
	'navigate',
	'eval',
	'newTab',
	'closeTab',
];

/** Whether a browser op requires per-call user approval under the given policy.
 *  `read` never needs approval. */
export function browserOpNeedsConfirm(
	policy: BrowserConfirmPolicy,
	kind: BrowserOp['kind']
): boolean {
	if (kind === 'read' || policy === 'off') return false;
	if (policy === 'all') return true;
	// 'dangerous': only the sharp-edge ops.
	return ALWAYS_CONFIRM_KINDS.includes(kind);
}
