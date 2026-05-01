/**
 * Conversational PRD Planner — file-backed session store
 *
 * Persists sessions to a JSON file under userData so they survive app restarts.
 *
 * Design decisions:
 *  - Whole-file writes on every mutation (acceptable at low volumes; future task
 *    can switch to per-session files if needed).
 *  - In-process Promise queue prevents concurrent-write races (optimistic lock).
 *  - Constructor is synchronous; initial load happens via loadSync() using the
 *    injected fs — test-friendly because fs is a dependency-injected interface.
 *  - Corrupt / missing file → empty store + console.warn (never throws on read).
 *  - The `archived` flag hides sessions from default listSessions() results.
 */

import crypto from 'crypto';
import path from 'path';

import { MAESTRO_USER_DATA_DIR } from '../../shared/install-paths';
import type {
	ConversationalPrdDraft,
	ConversationalPrdMessage,
	ConversationalPrdSession,
	ConversationalPrdSessionMetadata,
	ConversationalPrdSessionStatus,
} from '../../shared/conversational-prd-types';
import type { IConversationalPrdStore } from './session-store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONV_PRD_SESSIONS_FILE = path.join(
	MAESTRO_USER_DATA_DIR,
	'conversational-prd-sessions.json'
);

// ---------------------------------------------------------------------------
// Fs interface (injected for testability)
// ---------------------------------------------------------------------------

export interface FsAdapter {
	readFile(path: string, encoding: 'utf8'): Promise<string>;
	writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
	mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
	stat(path: string): Promise<{ isFile(): boolean }>;
}

// ---------------------------------------------------------------------------
// Persisted shape
// ---------------------------------------------------------------------------

/** Session as stored in the JSON file — includes the `archived` flag. */
export interface PersistedConversationalPrdSession extends ConversationalPrdSession {
	/** When true the session is hidden from the default listSessions() results. */
	archived?: boolean;
}

interface StoreFile {
	version: 1;
	sessions: PersistedConversationalPrdSession[];
}

// ---------------------------------------------------------------------------
// FileConversationalPrdStore
// ---------------------------------------------------------------------------

export class FileConversationalPrdStore implements IConversationalPrdStore {
	private sessions = new Map<string, PersistedConversationalPrdSession>();
	/** Serialised write queue — prevents concurrent writes from racing. */
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly filePath: string,
		private readonly fs: FsAdapter
	) {
		// Synchronous in-process population happens via loadSync.
		// Actual disk load is async — call await store.init() before first use,
		// or accept that in-process state starts empty until the first mutation.
		// IPC handler construction calls init() before registering handlers.
	}

	/**
	 * Load persisted sessions from disk.  Must be called once after construction.
	 * Tolerates a missing file (empty store) and a malformed file (warns + empty store).
	 */
	async init(): Promise<void> {
		try {
			await this.fs.stat(this.filePath);
		} catch {
			// File does not exist — start empty
			return;
		}

		let raw: string;
		try {
			raw = await this.fs.readFile(this.filePath, 'utf8');
		} catch (err) {
			console.warn('[FileConversationalPrdStore] Could not read sessions file:', err);
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			console.warn('[FileConversationalPrdStore] Malformed sessions file — starting empty:', err);
			return;
		}

		if (!isValidStoreFile(parsed)) {
			console.warn('[FileConversationalPrdStore] Unexpected sessions file schema — starting empty');
			return;
		}

		for (const session of parsed.sessions) {
			this.sessions.set(session.conversationId, session);
		}
	}

	// -------------------------------------------------------------------------
	// IConversationalPrdStore
	// -------------------------------------------------------------------------

	create(input: {
		projectPath: string;
		gitPath: string;
		actor?: ConversationalPrdSessionMetadata['actor'];
	}): ConversationalPrdSession {
		const now = new Date().toISOString();
		const session: PersistedConversationalPrdSession = {
			conversationId: crypto.randomUUID(),
			status: 'active',
			messages: [],
			draft: {},
			archived: false,
			metadata: {
				projectPath: input.projectPath,
				gitPath: input.gitPath,
				startedAt: now,
				updatedAt: now,
				actor: input.actor,
			},
		};
		this.sessions.set(session.conversationId, session);
		this.enqueueWrite();
		return session;
	}

	appendMessage(
		sessionId: string,
		message: Omit<ConversationalPrdMessage, 'id' | 'createdAt'>
	): ConversationalPrdSession {
		const session = this.requireSession(sessionId);
		const newMessage: ConversationalPrdMessage = {
			...message,
			id: crypto.randomUUID(),
			createdAt: new Date().toISOString(),
		};
		const updated: PersistedConversationalPrdSession = {
			...session,
			messages: [...session.messages, newMessage],
			metadata: { ...session.metadata, updatedAt: new Date().toISOString() },
		};
		this.sessions.set(sessionId, updated);
		this.enqueueWrite();
		return updated;
	}

	mergeDraft(sessionId: string, delta: Partial<ConversationalPrdDraft>): ConversationalPrdSession {
		const session = this.requireSession(sessionId);
		const filteredDelta = Object.fromEntries(
			Object.entries(delta).filter(([, v]) => v !== undefined)
		) as Partial<ConversationalPrdDraft>;
		const updated: PersistedConversationalPrdSession = {
			...session,
			draft: { ...session.draft, ...filteredDelta },
			metadata: { ...session.metadata, updatedAt: new Date().toISOString() },
		};
		this.sessions.set(sessionId, updated);
		this.enqueueWrite();
		return updated;
	}

	updateStatus(
		sessionId: string,
		status: ConversationalPrdSessionStatus
	): ConversationalPrdSession {
		const session = this.requireSession(sessionId);
		const updated: PersistedConversationalPrdSession = {
			...session,
			status,
			metadata: { ...session.metadata, updatedAt: new Date().toISOString() },
		};
		this.sessions.set(sessionId, updated);
		this.enqueueWrite();
		return updated;
	}

	get(sessionId: string): ConversationalPrdSession | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * List sessions.
	 *
	 * By default archived sessions are excluded.  Pass `{ includeArchived: true }`
	 * to include them.
	 */
	list(filters?: { projectPath?: string; includeArchived?: boolean }): ConversationalPrdSession[] {
		let all = [...this.sessions.values()];
		if (!filters?.includeArchived) {
			all = all.filter((s) => !s.archived);
		}
		if (filters?.projectPath) {
			all = all.filter((s) => s.metadata.projectPath === filters.projectPath);
		}
		return all;
	}

	delete(sessionId: string): boolean {
		const existed = this.sessions.has(sessionId);
		this.sessions.delete(sessionId);
		if (existed) {
			this.enqueueWrite();
		}
		return existed;
	}

	finalize(
		sessionId: string,
		prdWorkItemId: string,
		finalizedAt: string
	): ConversationalPrdSession {
		const session = this.requireSession(sessionId);
		const updated: PersistedConversationalPrdSession = {
			...session,
			status: 'finalized',
			finalized: true,
			finalizedAt,
			prdWorkItemId,
			metadata: { ...session.metadata, updatedAt: finalizedAt },
		};
		this.sessions.set(sessionId, updated);
		this.enqueueWrite();
		return updated;
	}

	/** Archive a session so it no longer appears in default listSessions() results. */
	archive(sessionId: string): ConversationalPrdSession {
		const session = this.requireSession(sessionId);
		const updated: PersistedConversationalPrdSession = {
			...session,
			archived: true,
			metadata: { ...session.metadata, updatedAt: new Date().toISOString() },
		};
		this.sessions.set(sessionId, updated);
		this.enqueueWrite();
		return updated;
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	private requireSession(sessionId: string): PersistedConversationalPrdSession {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`ConversationalPrdSession not found: ${sessionId}`);
		}
		return session;
	}

	/**
	 * Append a write to the serialised queue so concurrent mutations don't race.
	 */
	private enqueueWrite(): void {
		this.writeQueue = this.writeQueue
			.then(() => this.persist())
			.catch((err) => {
				console.error('[FileConversationalPrdStore] Failed to persist sessions:', err);
			});
	}

	private async persist(): Promise<void> {
		const file: StoreFile = {
			version: 1,
			sessions: [...this.sessions.values()],
		};
		const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
		await this.fs.mkdir(dir, { recursive: true });
		await this.fs.writeFile(this.filePath, JSON.stringify(file, null, 2), 'utf8');
	}
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isValidStoreFile(value: unknown): value is StoreFile {
	if (typeof value !== 'object' || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (obj['version'] !== 1) return false;
	if (!Array.isArray(obj['sessions'])) return false;
	return true;
}
