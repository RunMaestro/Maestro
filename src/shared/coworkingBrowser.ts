/**
 * Shared browser-coworking contract types.
 *
 * Used across the main process (registry / tools / bridge), the preload bridge,
 * and the renderer responder. Kept in `src/shared` (compiled by every tsconfig)
 * so the contract has a single source of truth instead of being duplicated
 * across the IPC boundary.
 */

import type { ToolType } from './types';
import type { BrowserViewportPreset } from './browserViewport';

/** Main-process launch identity, resolved from the MCP caller's process tree. */
export interface CoworkingBrowserCaller {
	sessionId: string;
	processSessionId: string;
	provider: ToolType;
}

export interface CoworkingBrowserPolicy {
	interactionEnabled: boolean;
	confirmPolicy: BrowserConfirmPolicy;
}

export type CoworkingBrowserPolicies = Partial<Record<ToolType, CoworkingBrowserPolicy>>;

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
 * is state-changing and gated behind the browser-interaction permission, except
 * the host-only kinds (see {@link UNGATED_BROWSER_OP_KINDS}).
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
	| BrowserPickOp
	| BrowserViewportOp;

/**
 * A box in a browser tab's viewport, in the page's CSS pixels from the
 * viewport's top-left corner: the region a `pick` names instead of an element
 * (`maestro-cli browser-pick --rect`). The page clips it to what is on screen.
 */
export interface BrowserPickRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * What a Design Mode pick names: one element, by the first match of a CSS
 * `selector`, or a region of the page, by a `rect`. Always exactly one.
 */
export type BrowserPickTarget =
	| { selector: string; rect?: undefined }
	| { rect: BrowserPickRect; selector?: undefined };

/**
 * Design Mode pick by selector or by region: describe the first element
 * matching `selector` (selector path, trimmed outerHTML, computed styles,
 * cropped screenshot), or list the outermost elements in `rect` with the
 * region's screenshot, and add it to the owning agent's composer as a chip,
 * exactly as a click or a drag in Design Mode does. With `queue` it goes out as
 * its own queued message instead, exactly as the pick card's Queue button does.
 *
 * Not an MCP op. Only `maestro-cli browser-pick` sends it, through the same
 * resolver the MCP tools use, so the CLI and the agent tools address a tab the
 * same way. The MCP bridge never accepts it (`validateInteractionOp` is an
 * allowlist with no `pick` case). An agent can still reach it from its shell
 * through the CLI, like every other CLI verb: that is the CLI-parity contract,
 * and the bundled system prompt tells agents to pass `--background`.
 */
export type BrowserPickOp = BrowserPickTarget & {
	kind: 'pick';
	/** Optional note appended under the pick, as typed in the pick card. */
	note?: string;
	/** True leaves the visible agent and tab alone (CLI `--background`). */
	background?: boolean;
	/**
	 * True queues the pick as its own message on the agent's execution queue
	 * (CLI `--queue`) instead of staging a chip. The composer and the view are
	 * never touched, so `background` has nothing left to decide.
	 */
	queue?: boolean;
};

/**
 * The smallest side a pick's region may have, in CSS pixels. The page finds
 * no region under 1 px, as a drag that comes back to its start picks nothing.
 */
export const BROWSER_PICK_RECT_MIN_SIDE = 1;

/** A plain decimal: optional minus, digits, optional fraction. No exponent, hex or blank. */
const PLAIN_DECIMAL = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * Validate a pick's region: four finite numbers, and a width and height of at
 * least {@link BROWSER_PICK_RECT_MIN_SIDE}. The origin can be negative or past
 * the viewport, because the page clips the box to what is on screen.
 *
 * @returns A fresh box with only the four fields, or null.
 */
export function readBrowserPickRect(value: unknown): BrowserPickRect | null {
	if (!value || typeof value !== 'object') return null;
	const { x, y, width, height } = value as Record<string, unknown>;
	const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
	if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
	if (width < BROWSER_PICK_RECT_MIN_SIDE || height < BROWSER_PICK_RECT_MIN_SIDE) return null;
	return { x, y, width, height };
}

/**
 * Parse a `--rect` value: `x,y,width,height` in CSS pixels, as in
 * `0,120,1280,400`. Space around a number is allowed.
 *
 * @returns The box, or null when it is not four plain numbers or fails
 * {@link readBrowserPickRect}.
 */
export function parseBrowserPickRect(text: string): BrowserPickRect | null {
	const parts = text.split(',').map((part) => part.trim());
	if (parts.length !== 4 || !parts.every((part) => PLAIN_DECIMAL.test(part))) return null;
	const [x, y, width, height] = parts.map(Number);
	return readBrowserPickRect({ x, y, width, height });
}

// Plain decimals only: `String(1e-7)` is `1e-7`, which `--rect` rejects.
const PLAIN_DECIMAL_FORMAT = new Intl.NumberFormat('en-US', {
	useGrouping: false,
	maximumFractionDigits: 20,
});

/** A region as `--rect` spells it, `x,y,width,height`: the inverse of {@link parseBrowserPickRect}. */
export function formatBrowserPickRect(rect: BrowserPickRect): string {
	return [rect.x, rect.y, rect.width, rect.height]
		.map((n) => PLAIN_DECIMAL_FORMAT.format(n))
		.join(',');
}

/**
 * Read what a pick request names from its untrusted fields: a selector
 * (trimmed) or a region, exactly one. Shared by the `pick_browser_element`
 * handler and the main-process pick, between a CLI that can be any version and
 * a renderer that must never be handed a half-formed pick.
 */
export function readBrowserPickTarget(fields: {
	selector?: unknown;
	rect?: unknown;
}): { ok: true; target: BrowserPickTarget } | { ok: false; error: string } {
	const selector = typeof fields.selector === 'string' ? fields.selector.trim() : '';
	const rectSent = fields.rect !== undefined && fields.rect !== null;
	if (selector && rectSent) return { ok: false, error: 'Send a selector or a rect, not both' };
	if (rectSent) {
		const rect = readBrowserPickRect(fields.rect);
		if (rect) return { ok: true, target: { rect } };
		return {
			ok: false,
			error: `Invalid rect: x, y, width and height must be numbers, and width and height at least ${BROWSER_PICK_RECT_MIN_SIDE}`,
		};
	}
	if (!selector) return { ok: false, error: 'Missing selector or rect' };
	return { ok: true, target: { selector } };
}

/**
 * Set or read a browser tab's viewport preset (`maestro-cli browser-viewport`):
 * the width the tab shows its page at, as the toolbar's viewport control and the
 * palette's `Browser: Viewport ...` entries choose it. With `preset` it sets it;
 * without, it only reads. Either way the result names the preset the tab shows
 * after the op and the one it showed before.
 *
 * Host-only, like `pick`: not an MCP op (`validateInteractionOp` has no case for
 * it), and never gated, since it never touches the page. The preset is a saved
 * field of the tab, so the renderer reads and writes it in the store and needs
 * no live webview, for any agent's tab and without moving the view.
 */
export interface BrowserViewportOp {
	kind: 'viewport';
	preset?: BrowserViewportPreset;
}

/**
 * Op kinds that are never an interaction: `read` changes nothing, and the
 * host-only `pick` and `viewport` only reach the renderer from the desktop or
 * `maestro-cli`, never from an agent's MCP tool. None of them is gated behind
 * the interaction permission or a per-call approval.
 */
export const UNGATED_BROWSER_OP_KINDS = [
	'read',
	'pick',
	'viewport',
] as const satisfies readonly BrowserOp['kind'][];

export type UngatedBrowserOpKind = (typeof UNGATED_BROWSER_OP_KINDS)[number];

/** Interaction (state-changing) op kinds, gated behind the interaction
 *  permission: every kind except {@link UNGATED_BROWSER_OP_KINDS}. */
export type BrowserInteractionKind = Exclude<BrowserOp['kind'], UngatedBrowserOpKind>;

/** Whether an op kind skips the interaction gate and per-call approval. */
export function isUngatedBrowserOp(kind: BrowserOp['kind']): kind is UngatedBrowserOpKind {
	return (UNGATED_BROWSER_OP_KINDS as readonly string[]).includes(kind);
}

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
	/** `pick`: the AI tab whose composer holds the chip, or whose queue holds the message. */
	aiTabId?: string;
	/** `pick`: the staged chip's id (`maestro-cli browser-picks --remove`). Not set when queued. */
	pickId?: string;
	/** `pick` with `queue`: the queued message's id (`maestro-cli queue remove`). */
	queueItemId?: string;
	/** `viewport`: the preset the tab shows after the op. */
	viewportPreset?: BrowserViewportPreset;
	/** `viewport`: the preset the tab showed before the op. */
	previousViewportPreset?: BrowserViewportPreset;
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
	// `pick` and `viewport` never change the page and only reach here from the
	// host (CLI), so they are never gated, like `read`.
	if (isUngatedBrowserOp(kind)) return false;
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
