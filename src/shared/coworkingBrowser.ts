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
	| { kind: 'closeTab' }
	| BrowserPickOp;

/**
 * Design Mode pick by selector: describe the first element matching `selector`
 * (selector path, trimmed outerHTML, computed styles, cropped screenshot) and
 * add it to the owning agent's composer, exactly as a click in Design Mode does.
 *
 * Not an MCP op. Only `maestro-cli browser-pick` sends it, through the same
 * resolver the MCP tools use, so the CLI and the agent tools address a tab the
 * same way. The MCP bridge never accepts it (`validateInteractionOp` is an
 * allowlist with no `pick` case). An agent can still reach it from its shell
 * through the CLI, like every other CLI verb: that is the CLI-parity contract,
 * and the bundled system prompt tells agents to pass `--background`.
 */
export interface BrowserPickOp {
	kind: 'pick';
	selector: string;
	/** Optional note appended under the element, as typed in the pick card. */
	note?: string;
	/** True leaves the visible agent and tab alone (CLI `--background`). */
	background?: boolean;
}

/** Interaction (state-changing) op kinds, gated behind the interaction
 *  permission. `read` and the host-only `pick` are excluded. */
export type BrowserInteractionKind = Exclude<BrowserOp['kind'], 'read' | 'pick'>;

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
	/** `pick`: the AI tab the element was added to. */
	aiTabId?: string;
}

/** Per-agent policy for whether a state-changing browser op needs an explicit
 *  per-call user approval, layered on top of the per-agent interaction permission.
 *  - 'off'       : approve eval, plus typing until separately allowed.
 *  - 'dangerous' : approve navigate, eval, newTab, closeTab, and typing until separately allowed. Default.
 *  - 'all'       : approve every interaction op. */
export type BrowserConfirmPolicy = 'off' | 'dangerous' | 'all';

/** Policy used when an agent has no explicit confirm entry configured. */
export const DEFAULT_BROWSER_CONFIRM_POLICY: BrowserConfirmPolicy = 'dangerous';

/** Ops the 'dangerous' policy routes through per-call approval after the
 *  separate typing and eval checks. New tabs can navigate to arbitrary URLs,
 *  and closing tabs is destructive. */
export const ALWAYS_CONFIRM_KINDS: readonly BrowserInteractionKind[] = [
	'navigate',
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
	kind: BrowserOp['kind'],
	allowUnconfirmedTyping = false
): boolean {
	// `pick` never changes the page and only reaches here from the host (CLI),
	// so it is never gated, like `read`.
	if (kind === 'read' || kind === 'pick') return false;
	// eval is force-confirmed even when the policy is 'off'.
	if (FORCE_CONFIRM_KINDS.includes(kind as BrowserInteractionKind)) return true;
	if (policy === 'all') return true;
	// A saved permissive policy alone does not authorize filling fields.
	if (kind === 'type') return allowUnconfirmedTyping !== true;
	if (policy === 'off') return false;
	// 'dangerous': only the sharp-edge ops.
	return ALWAYS_CONFIRM_KINDS.includes(kind);
}

/** Main-process cap for a `pick` (mount a kept-alive tab, wait for the page to
 *  settle, crop). Below the CLI's own wait so the caller hears the real error
 *  rather than a bare CLI timeout; a pick never waits on an approval dialog, so
 *  it does not need the interaction cap below. */
export const BROWSER_PICK_TIMEOUT_MS = 25_000;

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
