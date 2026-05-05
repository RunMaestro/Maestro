/**
 * Coworking tools — main-process implementations of the MCP tools advertised
 * to agents. Pure-ish: state comes from the registry; buffer reads delegate
 * to a renderer-buffer-resolver injected at startup so this module stays
 * unit-testable without an Electron runtime.
 *
 * `sessionId` is always supplied by the caller (the bridge), resolved from
 * the MCP subprocess's handshake. There is no "active session" fallback —
 * that was the privacy bug PR #948 had to fix.
 */

import { coworkingRegistry, type CoworkingRegistry } from './coworking-registry';
import type { CoworkingTerminalEntry } from './coworking-types';

/** Fetcher for terminal scrollback. The default implementation rounds-trips to the renderer
 *  via webContents.send + a responseChannel; tests inject a stub. The sessionId is forwarded
 *  so the renderer can pick the correct TerminalView from its per-session ref map. */
export type TerminalBufferResolver = (sessionId: string, tabUuid: string) => Promise<string>;

let bufferResolver: TerminalBufferResolver | null = null;

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
		if (allLines.length > args.lines) {
			return {
				id: args.id,
				content: allLines.slice(-args.lines).join('\n'),
				truncated: true,
				totalLines: allLines.length,
			};
		}
		return { id: args.id, content: full, truncated: false, totalLines: allLines.length };
	}
	return { id: args.id, content: full, truncated: false, totalLines: allLines.length };
}
