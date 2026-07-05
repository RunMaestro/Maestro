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
 *  - 'off'       : no per-call approval (the interaction permission alone gates),
 *                  EXCEPT `eval`, which always requires approval (see below).
 *  - 'dangerous' : approve the sharp-edge ops (navigate, eval, type, newTab, closeTab). Default.
 *  - 'all'       : approve every interaction op. */
export type BrowserConfirmPolicy = 'off' | 'dangerous' | 'all';

/** Policy used when an agent has no explicit confirm entry configured. */
export const DEFAULT_BROWSER_CONFIRM_POLICY: BrowserConfirmPolicy = 'dangerous';

/** Ops the 'dangerous' policy routes through per-call approval. `type` is
 *  included because a silent form-fill can populate login / cross-site fields;
 *  `newTab` is navigation-equivalent (loads an arbitrary URL) and `closeTab`
 *  is destructive, so both sit alongside navigate/eval. */
export const ALWAYS_CONFIRM_KINDS: readonly BrowserInteractionKind[] = [
	'navigate',
	'eval',
	'type',
	'newTab',
	'closeTab',
];

/** Ops that ALWAYS require per-call approval regardless of policy (even 'off').
 *  `eval` runs arbitrary JavaScript in a privileged in-app webview, so a page
 *  the agent just loaded must never be able to drive it unattended. */
export const FORCE_CONFIRM_KINDS: readonly BrowserInteractionKind[] = ['eval'];

/** Whether a browser op requires per-call user approval under the given policy.
 *  `read` never needs approval; `eval` always does. */
export function browserOpNeedsConfirm(
	policy: BrowserConfirmPolicy,
	kind: BrowserOp['kind']
): boolean {
	if (kind === 'read') return false;
	// eval is force-confirmed even when the policy is 'off'.
	if (FORCE_CONFIRM_KINDS.includes(kind as BrowserInteractionKind)) return true;
	if (policy === 'off') return false;
	if (policy === 'all') return true;
	// 'dangerous': only the sharp-edge ops.
	return ALWAYS_CONFIRM_KINDS.includes(kind);
}

/** Main-process cap for a single interaction browser op (navigate/click/eval/...).
 *  Long because these ops can block on a human approval dialog. Shared so the
 *  main resolver and the renderer approval timeout can't drift apart. */
export const BROWSER_INTERACT_TIMEOUT_MS = 300_000;

/** Renderer-side cap on how long a per-call approval dialog may stay open before
 *  auto-declining. Kept below BROWSER_INTERACT_TIMEOUT_MS so a late decision
 *  resolves as a clean decline BEFORE the main resolver gives up - otherwise a
 *  belatedly-approved navigate/eval would execute against a tool call the agent
 *  already saw time out (the abandoned-action race). */
export const BROWSER_APPROVAL_TIMEOUT_MS = BROWSER_INTERACT_TIMEOUT_MS - 10_000;
