/**
 * Coworking registry — main-process mirror of the renderer's terminal-tab state,
 * scoped to the active AI tab's session.
 *
 * The renderer pushes registry updates (open/close/rename/cwd-change/active-session-change)
 * via the `coworking:*` preload bridge. The MCP server pulls from here when an agent
 * calls `list_terminals`.
 */

import { captureException } from '../utils/sentry';
import type { CoworkingTerminalEntry, CoworkingTerminalRecord } from './coworking-types';

type ChangeListener = () => void;

class CoworkingRegistry {
	private records = new Map<string, CoworkingTerminalRecord>();
	private activeSessionId: string | null = null;
	private listeners = new Set<ChangeListener>();

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
		if (mutated) this.notify();
	}

	/** Set which session's terminals are advertised to MCP clients. */
	setActiveSession(sessionId: string | null): void {
		if (this.activeSessionId === sessionId) return;
		this.activeSessionId = sessionId;
		this.notify();
	}

	getActiveSessionId(): string | null {
		return this.activeSessionId;
	}

	/** List the public-facing entries the agent should see for the current active session. */
	listForActiveSession(): CoworkingTerminalEntry[] {
		if (!this.activeSessionId) return [];
		const out: CoworkingTerminalEntry[] = [];
		for (const rec of this.records.values()) {
			if (rec.sessionId !== this.activeSessionId) continue;
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

	/** Resolve a public id (e.g. "term:3") to the renderer-side UUID, scoped to the active session. */
	resolveTabUuidForActiveSession(publicId: string): string | null {
		if (!this.activeSessionId) return null;
		for (const rec of this.records.values()) {
			if (rec.sessionId === this.activeSessionId && rec.id === publicId) {
				return rec.tabUuid;
			}
		}
		return null;
	}

	/** Subscribe to any registry change. Returns an unsubscribe fn. Used by MCP server to
	 *  emit `notifications/tools/list_changed` when active-session/terminals change. */
	onChange(listener: ChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Test-only: clear all state. */
	reset(): void {
		this.records.clear();
		this.activeSessionId = null;
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

/** Singleton — the main process holds exactly one registry. */
export const coworkingRegistry = new CoworkingRegistry();

/** Exported class for test harnesses that want their own instance. */
export { CoworkingRegistry };
