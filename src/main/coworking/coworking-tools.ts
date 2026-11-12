/**
 * Coworking tools - main-process implementations of the MCP tools advertised
 * to agents. Pure-ish: state comes from the registry; buffer reads delegate
 * to a renderer-buffer-resolver injected at startup so this module stays
 * unit-testable without an Electron runtime.
 *
 * `sessionId` is always supplied by the caller (the bridge), resolved from
 * the MCP subprocess's handshake. There is no "active session" fallback -
 * that was the privacy bug PR #948 had to fix.
 */

import { coworkingRegistry, type CoworkingRegistry } from './coworking-registry';
import type {
	BrowserOp,
	BrowserOpResult,
	CoworkingBrowserEntry,
	CoworkingTerminalEntry,
} from './coworking-types';

/** Fetcher for terminal scrollback. The default implementation rounds-trips to the renderer
 *  via webContents.send + a responseChannel; tests inject a stub. The sessionId is forwarded
 *  so the renderer can pick the correct TerminalView from its per-session ref map. */
export type TerminalBufferResolver = (sessionId: string, tabUuid: string) => Promise<string>;

let bufferResolver: TerminalBufferResolver | null = null;

/** Hard ceiling on the number of scrollback lines a single readTerminal may
 *  return, so a caller can't request an arbitrarily large slice. */
export const MAX_TERMINAL_LINES = 10_000;

/** readBrowser response caps. When the caller omits maxChars we apply a sane
 *  default so a huge page (esp. format:'html') doesn't dump its entire DOM to
 *  the agent; an explicit maxChars is honored up to a hard ceiling. The full
 *  size is always reported via totalChars + truncated. */
export const DEFAULT_BROWSER_MAX_CHARS = 200_000;
export const MAX_BROWSER_MAX_CHARS = 2_000_000;

/** Wire the renderer-buffer fetcher. Called once during main-process bootstrap. */
export function setTerminalBufferResolver(resolver: TerminalBufferResolver | null): void {
	bufferResolver = resolver;
}

/** List terminals visible to the agent in its own session. */
export function listTerminals(
	sessionId: string,
	registry: CoworkingRegistry = coworkingRegistry
): { terminals: CoworkingTerminalEntry[] } {
	return { terminals: registry.listForSession(sessionId) };
}

/** Read scrollback for a single terminal in the caller's session, optionally tail-truncated. */
export async function readTerminal(
	sessionId: string,
	args: { id: string; lines?: number },
	deps: { registry?: CoworkingRegistry; resolver?: TerminalBufferResolver } = {}
): Promise<{ id: string; content: string; truncated: boolean; totalLines: number }> {
	const registry = deps.registry ?? coworkingRegistry;
	const resolver = deps.resolver ?? bufferResolver;
	if (!resolver) {
		throw new Error('coworking tools: buffer resolver not configured');
	}
	const tabUuid = registry.resolveTabUuidForSession(sessionId, args.id);
	if (!tabUuid) {
		throw new Error(
			`coworking tools: terminal '${args.id}' not found in your session (it may have been closed)`
		);
	}
	const full = await resolver(sessionId, tabUuid);
	// A buffer that ends in `\n` would otherwise be counted as one extra empty line
	// and `lines: N` would return N-1 real lines plus a synthetic trailing blank.
	// Treat a single trailing newline as a terminator, not a line.
	const splitLines = (s: string): string[] => {
		if (s.length === 0) return [];
		const parts = s.split('\n');
		if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
		return parts;
	};
	const allLines = splitLines(full);
	if (typeof args.lines === 'number' && Number.isFinite(args.lines) && args.lines > 0) {
		const lines = Math.min(Math.floor(args.lines), MAX_TERMINAL_LINES);
		if (allLines.length > lines) {
			return {
				id: args.id,
				content: allLines.slice(-lines).join('\n'),
				truncated: true,
				totalLines: allLines.length,
			};
		}
		return { id: args.id, content: full, truncated: false, totalLines: allLines.length };
	}
	return { id: args.id, content: full, truncated: false, totalLines: allLines.length };
}

// ─── Browser tools ───────────────────────────────────────────────────────────

/** Resolves a browser op against the LIVE webview by round-tripping to the
 *  renderer (which prefers an already-mounted hidden webview and only activates
 *  the target tab as a fallback). Tests inject a stub. */
export type BrowserResolver = (
	sessionId: string,
	tabUuid: string,
	op: BrowserOp
) => Promise<BrowserOpResult>;

let browserResolver: BrowserResolver | null = null;

/** Wire the renderer browser resolver. Called once during main-process bootstrap. */
export function setBrowserResolver(resolver: BrowserResolver | null): void {
	browserResolver = resolver;
}

/** List browser tabs visible to the agent in its own session (metadata only, no
 *  live webview needed). */
export function listBrowsers(
	sessionId: string,
	registry: CoworkingRegistry = coworkingRegistry
): { browsers: CoworkingBrowserEntry[] } {
	return { browsers: registry.listBrowsersForSession(sessionId) };
}

/** Get the current url + title of a single browser tab (metadata only). */
export function getBrowserUrl(
	sessionId: string,
	args: { id: string },
	registry: CoworkingRegistry = coworkingRegistry
): { id: string; url: string; title: string; isLoading: boolean } {
	const entry = registry.listBrowsersForSession(sessionId).find((b) => b.id === args.id);
	if (!entry) {
		throw new Error(
			`coworking tools: browser '${args.id}' not found in your session (it may have been closed)`
		);
	}
	return { id: entry.id, url: entry.url, title: entry.title, isLoading: entry.isLoading };
}

/** Read the rendered text (or HTML) of a browser tab in the caller's session,
 *  optionally scoped to the first element matching a CSS selector and/or
 *  head-truncated to maxChars. Needs the live webview via the resolver. */
export async function readBrowser(
	sessionId: string,
	args: {
		id: string;
		format?: 'text' | 'innerText' | 'html';
		maxChars?: number;
		selector?: string;
	},
	deps: { registry?: CoworkingRegistry; resolver?: BrowserResolver } = {}
): Promise<{
	id: string;
	url: string;
	title: string;
	format: 'text' | 'innerText' | 'html';
	content: string;
	truncated: boolean;
	totalChars: number;
}> {
	const registry = deps.registry ?? coworkingRegistry;
	const resolver = deps.resolver ?? browserResolver;
	if (!resolver) {
		throw new Error('coworking tools: browser resolver not configured');
	}
	const tabUuid = registry.resolveBrowserTabUuidForSession(sessionId, args.id);
	if (!tabUuid) {
		throw new Error(
			`coworking tools: browser '${args.id}' not found in your session (it may have been closed)`
		);
	}
	const format = args.format ?? 'text';
	const result = await resolver(sessionId, tabUuid, {
		kind: 'read',
		format,
		selector: args.selector,
	});
	const full = result.content ?? '';
	const totalChars = full.length;
	// Honor an explicit maxChars up to a hard ceiling; when omitted, apply a sane
	// default so a huge page (esp. format:'html') can't dump its whole DOM.
	const cap =
		typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) && args.maxChars > 0
			? Math.min(Math.floor(args.maxChars), MAX_BROWSER_MAX_CHARS)
			: DEFAULT_BROWSER_MAX_CHARS;
	const truncated = full.length > cap;
	return {
		id: args.id,
		url: result.url ?? '',
		title: result.title ?? '',
		format,
		content: truncated ? full.slice(0, cap) : full,
		truncated,
		totalChars,
	};
}

/** Run a state-changing browser op against a tab in the caller's session via the
 *  live webview. The per-agent interaction permission is enforced by the bridge
 *  before this is called; this fn only resolves the tab and delegates.
 *  `newTab` is session-scoped rather than tab-scoped: it creates a tab in the
 *  caller's session, so no target id is resolved (the resolver receives an
 *  empty tabUuid and branches on the op kind). */
export async function browserInteract(
	sessionId: string,
	args: { id?: string; op: BrowserOp },
	deps: { registry?: CoworkingRegistry; resolver?: BrowserResolver } = {}
): Promise<BrowserOpResult> {
	const registry = deps.registry ?? coworkingRegistry;
	const resolver = deps.resolver ?? browserResolver;
	if (!resolver) {
		throw new Error('coworking tools: browser resolver not configured');
	}
	if (args.op.kind === 'newTab') {
		return resolver(sessionId, '', args.op);
	}
	if (typeof args.id !== 'string') {
		throw new Error('coworking tools: browser tab `id` is required for this op');
	}
	const tabUuid = registry.resolveBrowserTabUuidForSession(sessionId, args.id);
	if (!tabUuid) {
		throw new Error(
			`coworking tools: browser '${args.id}' not found in your session (it may have been closed)`
		);
	}
	return resolver(sessionId, tabUuid, args.op);
}
