/**
 * Coworking registry - main-process mirror of every Maestro session's terminal-tab state,
 * keyed by sessionId.
 *
 * The renderer pushes registry updates (open/close/rename/cwd-change) for every session
 * via the `coworking:*` preload bridge. The MCP server pulls from here when an agent calls
 * `list_terminals`, scoped to the agent's *own* session id (resolved at bridge-handshake
 * time from the `MAESTRO_COWORKING_SESSION_ID` env var the agent CLI was spawned with).
 *
 * Crucially, there is no "active session" concept here - that singleton was the source
 * of the focus-bound privacy bug fixed in PR #948. Each MCP connection gets its own
 * session id and reads only that session's slice.
 */

import { captureException } from '../utils/sentry';
import type {
	CoworkingBrowserEntry,
	CoworkingBrowserInput,
	CoworkingBrowserRecord,
	CoworkingTerminalEntry,
	CoworkingTerminalRecord,
} from './coworking-types';
import { formatBrowserId, parseBrowserId } from './coworking-types';

type ChangeListener = () => void;

class CoworkingRegistry {
	private records = new Map<string, CoworkingTerminalRecord>();
	private listeners = new Set<ChangeListener>();
	// Browser-tab mirror. Separate from terminal `records` (different id space and
	// shape). Keyed by the renderer BrowserTab.id (UUID, globally unique). The
	// registry assigns the stable public `browser:N` id per session so renderer
	// code never has to mint/persist one.
	private browserRecords = new Map<string, CoworkingBrowserRecord>();
	private browserIdByTabUuid = new Map<string, Map<string, number>>();
	private nextBrowserId = new Map<string, number>();
	// Per-session browser-interaction permission, mirrored from the per-agent
	// `coworkingBrowserInteraction` setting. Gates the state-changing browser
	// tools in the bridge; read tools are always allowed.
	private browserInteraction = new Map<string, boolean>();
	// Per-session agent type (ToolType), mirrored from the renderer for audit logging.
	private sessionAgentType = new Map<string, string>();

	/** Replace the full set of terminals for a given session. Used on initial sync from renderer. */
	syncSessionTerminals(sessionId: string, records: CoworkingTerminalRecord[]): void {
		const incoming = new Map(records.map((r) => [r.tabUuid, { ...r, sessionId }]));
		// Drop any existing records for this session that aren't in the incoming set.
		for (const [key, rec] of this.records) {
			if (rec.sessionId === sessionId && !incoming.has(rec.tabUuid)) {
				this.records.delete(key);
			}
		}
		for (const rec of incoming.values()) {
			this.records.set(rec.tabUuid, rec);
		}
		this.notify();
	}

	/** Insert or update a single terminal record (e.g. on tab open / rename / cwd change). */
	upsertTerminal(record: CoworkingTerminalRecord): void {
		this.records.set(record.tabUuid, record);
		this.notify();
	}

	/** Remove a terminal record by its renderer-side UUID. */
	removeTerminal(tabUuid: string): void {
		if (this.records.delete(tabUuid)) this.notify();
	}

	/** Remove all records for a given session (e.g. when the agent is deleted). */
	removeSession(sessionId: string): void {
		let mutated = false;
		for (const [key, rec] of this.records) {
			if (rec.sessionId === sessionId) {
				this.records.delete(key);
				mutated = true;
			}
		}
		for (const [key, rec] of this.browserRecords) {
			if (rec.sessionId === sessionId) {
				this.browserRecords.delete(key);
				mutated = true;
			}
		}
		this.browserIdByTabUuid.delete(sessionId);
		this.nextBrowserId.delete(sessionId);
		this.browserInteraction.delete(sessionId);
		this.sessionAgentType.delete(sessionId);
		if (mutated) this.notify();
	}

	/** List the public-facing entries for a specific session id. */
	listForSession(sessionId: string): CoworkingTerminalEntry[] {
		const out: CoworkingTerminalEntry[] = [];
		for (const rec of this.records.values()) {
			if (rec.sessionId !== sessionId) continue;
			out.push({ id: rec.id, cwd: rec.cwd, title: rec.title });
		}
		// Stable sort by numeric portion of `term:N` so output order matches user expectation.
		out.sort((a, b) => {
			const ai = Number(a.id.slice('term:'.length));
			const bi = Number(b.id.slice('term:'.length));
			return ai - bi;
		});
		return out;
	}

	/** Resolve a public id (e.g. "term:3") to the renderer-side UUID, scoped to one session. */
	resolveTabUuidForSession(sessionId: string, publicId: string): string | null {
		for (const rec of this.records.values()) {
			if (rec.sessionId === sessionId && rec.id === publicId) {
				return rec.tabUuid;
			}
		}
		return null;
	}

	/** Replace the full set of browser tabs for a session, assigning stable
	 *  `browser:N` ids to any tab not seen before. Ids are monotonic per session
	 *  and never reused, so a closed tab's id is retired for the app's lifetime. */
	syncSessionBrowsers(
		sessionId: string,
		inputs: CoworkingBrowserInput[],
		interactionEnabled: boolean,
		agentType?: string
	): void {
		this.browserInteraction.set(sessionId, interactionEnabled);
		if (agentType !== undefined) this.sessionAgentType.set(sessionId, agentType);
		let idMap = this.browserIdByTabUuid.get(sessionId);
		if (!idMap) {
			idMap = new Map();
			this.browserIdByTabUuid.set(sessionId, idMap);
		}
		let nextId = this.nextBrowserId.get(sessionId) ?? 1;
		for (const input of inputs) {
			if (!idMap.has(input.tabUuid)) idMap.set(input.tabUuid, nextId++);
		}
		this.nextBrowserId.set(sessionId, nextId);
		// Drop existing records for this session that aren't in the incoming set.
		for (const [key, rec] of this.browserRecords) {
			if (rec.sessionId === sessionId) this.browserRecords.delete(key);
		}
		for (const input of inputs) {
			const numericId = idMap.get(input.tabUuid);
			if (numericId === undefined) continue;
			this.browserRecords.set(input.tabUuid, {
				id: formatBrowserId(numericId),
				url: input.url,
				title: input.title,
				favicon: input.favicon,
				canGoBack: input.canGoBack,
				canGoForward: input.canGoForward,
				isLoading: input.isLoading,
				tabUuid: input.tabUuid,
				sessionId,
			});
		}
		this.notify();
	}

	/** Agent type (ToolType) for a session, mirrored from the renderer (audit). */
	getAgentType(sessionId: string): string | undefined {
		return this.sessionAgentType.get(sessionId);
	}

	/** List the public-facing browser entries for a session, sorted by id. */
	listBrowsersForSession(sessionId: string): CoworkingBrowserEntry[] {
		const out: CoworkingBrowserEntry[] = [];
		for (const rec of this.browserRecords.values()) {
			if (rec.sessionId !== sessionId) continue;
			out.push({
				id: rec.id,
				url: rec.url,
				title: rec.title,
				favicon: rec.favicon,
				canGoBack: rec.canGoBack,
				canGoForward: rec.canGoForward,
				isLoading: rec.isLoading,
			});
		}
		out.sort((a, b) => (parseBrowserId(a.id) ?? 0) - (parseBrowserId(b.id) ?? 0));
		return out;
	}

	/** Resolve a public id (e.g. "browser:2") to the renderer BrowserTab UUID, scoped to one session. */
	resolveBrowserTabUuidForSession(sessionId: string, publicId: string): string | null {
		for (const rec of this.browserRecords.values()) {
			if (rec.sessionId === sessionId && rec.id === publicId) return rec.tabUuid;
		}
		return null;
	}

	/** Subscribe to any registry change. Returns an unsubscribe fn. */
	onChange(listener: ChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Whether browser interaction tools are permitted for a session, mirrored
	 *  from the per-agent setting via syncSessionBrowsers. Defaults to false. */
	isBrowserInteractionEnabled(sessionId: string): boolean {
		return this.browserInteraction.get(sessionId) ?? false;
	}

	/** Test-only: clear all state. */
	reset(): void {
		this.records.clear();
		this.browserRecords.clear();
		this.browserIdByTabUuid.clear();
		this.nextBrowserId.clear();
		this.browserInteraction.clear();
		this.sessionAgentType.clear();
		this.listeners.clear();
	}

	private notify(): void {
		for (const fn of this.listeners) {
			try {
				fn();
			} catch (err) {
				// One bad listener must not bring down the registry, but the failure
				// has to be observable in production. Capture and continue.
				void captureException(err instanceof Error ? err : new Error(String(err)), {
					extra: { scope: 'CoworkingRegistry.notify' },
				});
			}
		}
	}
}

/** Singleton - the main process holds exactly one registry. */
export const coworkingRegistry = new CoworkingRegistry();

/** Exported class for test harnesses that want their own instance. */
export { CoworkingRegistry };
