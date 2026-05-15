/**
 * SessionFileWatcher
 *
 * Generic watcher for an agent's on-disk session storage directory. Surfaces
 * activity from agent processes Maestro did NOT spawn — typically sessions
 * started over SSH by the same local user — by reacting to JSONL appends and
 * file creations under `storageDir`. Same-user only: relies on local filesystem
 * permissions, no cross-user or remote-FS support. Local FS only — SSH paths
 * are out of scope. We watch artifacts on disk; we do not track PIDs.
 */

import { EventEmitter } from 'events';
import { promises as fs, type Stats } from 'fs';
import * as path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ToolType } from '../../shared/types';
import { EXTERNAL_ACTIVITY_IDLE_MS, type SessionActivityEvent } from '../../shared/sessionActivity';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[SessionFileWatcher]';
const DEFAULT_DEBOUNCE_MS = 250;

export interface SessionFileMatch {
	sessionId: string;
	projectPath: string;
}

export type SessionFileMatcher = (relPath: string) => SessionFileMatch | null;

export interface SessionFileWatcherOptions {
	agentId: ToolType;
	storageDir: string;
	fileMatcher: SessionFileMatcher;
	/** Per-sessionId debounce window for collapsing rapid appends. Default 250ms. */
	debounceMs?: number;
}

type PendingEventType = 'create' | 'append';

interface WatchedSession {
	sessionId: string;
	projectPath: string;
	filePath: string;
	sizeBytes: number;
	lastActivityAt: number;
	pendingEvent: PendingEventType | null;
	debounceTimer: NodeJS.Timeout | null;
	idleTimer: NodeJS.Timeout | null;
}

/**
 * Emits `'create'` when a new matching session file appears, `'append'` when an
 * already-seen file grows, and `'idle'` after EXTERNAL_ACTIVITY_IDLE_MS of
 * silence on a previously-active session. Every event payload is a fully
 * populated {@link SessionActivityEvent} with `source: 'external'`.
 */
export class SessionFileWatcher extends EventEmitter {
	readonly agentId: ToolType;
	readonly storageDir: string;
	private readonly fileMatcher: SessionFileMatcher;
	private readonly debounceMs: number;

	private watcher: FSWatcher | null = null;
	private readonly sessions = new Map<string, WatchedSession>();

	constructor(options: SessionFileWatcherOptions) {
		super();
		this.agentId = options.agentId;
		this.storageDir = options.storageDir;
		this.fileMatcher = options.fileMatcher;
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	}

	/**
	 * Begin watching `storageDir`. No-op (with an info log) if the directory is
	 * missing or unreadable — same-user scope means missing dirs are normal
	 * (e.g., user has Claude installed but not Codex).
	 */
	async start(): Promise<void> {
		if (this.watcher) return;

		try {
			await fs.access(this.storageDir);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
				logger.warn(
					`Storage dir not accessible (${code}); watcher will not start: ${this.storageDir}`,
					LOG_CONTEXT
				);
				return;
			}
			logger.warn(
				`Unexpected error accessing storage dir ${this.storageDir}: ${(err as Error).message}`,
				LOG_CONTEXT
			);
			return;
		}

		try {
			this.watcher = chokidar.watch(this.storageDir, {
				persistent: true,
				ignoreInitial: true,
				alwaysStat: true,
				depth: 99,
			});

			this.watcher.on('add', (filePath, stats) => this.handleAdd(filePath, stats));
			this.watcher.on('change', (filePath, stats) => this.handleChange(filePath, stats));
			this.watcher.on('error', (error) => {
				const msg = error instanceof Error ? error.message : String(error);
				logger.warn(`Watcher error for ${this.storageDir}: ${msg}`, LOG_CONTEXT);
			});

			logger.info(
				`Started session file watcher for ${this.agentId}: ${this.storageDir}`,
				LOG_CONTEXT
			);
		} catch (err) {
			logger.warn(
				`Failed to initialize chokidar for ${this.storageDir}: ${(err as Error).message}`,
				LOG_CONTEXT
			);
			this.watcher = null;
		}
	}

	/** Stop watching, clear all timers, and drop tracked-session state. */
	async stop(): Promise<void> {
		for (const session of this.sessions.values()) {
			if (session.debounceTimer) clearTimeout(session.debounceTimer);
			if (session.idleTimer) clearTimeout(session.idleTimer);
		}
		this.sessions.clear();

		if (this.watcher) {
			try {
				await this.watcher.close();
			} catch (err) {
				logger.warn(
					`Error closing watcher for ${this.storageDir}: ${(err as Error).message}`,
					LOG_CONTEXT
				);
			}
			this.watcher = null;
		}
	}

	/**
	 * Snapshot of sessions that are still inside the idle window
	 * (last activity within EXTERNAL_ACTIVITY_IDLE_MS of `Date.now()`).
	 */
	listActive(): SessionActivityEvent[] {
		const now = Date.now();
		const events: SessionActivityEvent[] = [];
		for (const session of this.sessions.values()) {
			if (now - session.lastActivityAt <= EXTERNAL_ACTIVITY_IDLE_MS) {
				events.push(this.toEvent(session));
			}
		}
		return events;
	}

	private handleAdd(filePath: string, stats?: Stats): void {
		const match = this.matchPath(filePath);
		if (!match) return;

		const size = stats?.size ?? 0;
		const now = Date.now();
		const existing = this.sessions.get(match.sessionId);
		const session: WatchedSession = existing ?? {
			sessionId: match.sessionId,
			projectPath: match.projectPath,
			filePath,
			sizeBytes: size,
			lastActivityAt: now,
			pendingEvent: null,
			debounceTimer: null,
			idleTimer: null,
		};

		session.filePath = filePath;
		session.projectPath = match.projectPath;
		session.sizeBytes = size;
		session.lastActivityAt = now;
		// If a debounced event is already queued for this session (rare —
		// would only happen if 'add' fires twice without an intervening flush),
		// keep the earlier event type since 'create' must be emitted first.
		session.pendingEvent = session.pendingEvent ?? 'create';
		this.sessions.set(match.sessionId, session);

		this.scheduleDebounce(session);
		this.scheduleIdle(session);
	}

	private handleChange(filePath: string, stats?: Stats): void {
		const match = this.matchPath(filePath);
		if (!match) return;

		const size = stats?.size ?? 0;
		const now = Date.now();
		let session = this.sessions.get(match.sessionId);

		if (!session) {
			// We missed the 'add' (e.g., file existed before start with ignoreInitial,
			// then was written to). Treat this first observation as 'append' so the
			// renderer reacts to live activity rather than spuriously announcing a
			// "new" session that already existed.
			session = {
				sessionId: match.sessionId,
				projectPath: match.projectPath,
				filePath,
				sizeBytes: size,
				lastActivityAt: now,
				pendingEvent: 'append',
				debounceTimer: null,
				idleTimer: null,
			};
			this.sessions.set(match.sessionId, session);
		} else {
			if (size <= session.sizeBytes) {
				// Spurious change (touch, metadata) — no append, don't reset idle.
				return;
			}
			session.sizeBytes = size;
			session.lastActivityAt = now;
			session.filePath = filePath;
			session.projectPath = match.projectPath;
			// Preserve a queued 'create' so it still fires first; otherwise this
			// is an append.
			if (session.pendingEvent !== 'create') {
				session.pendingEvent = 'append';
			}
		}

		this.scheduleDebounce(session);
		this.scheduleIdle(session);
	}

	private matchPath(filePath: string): SessionFileMatch | null {
		const rel = path.relative(this.storageDir, filePath);
		if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
		return this.fileMatcher(rel);
	}

	private scheduleDebounce(session: WatchedSession): void {
		if (session.debounceTimer) clearTimeout(session.debounceTimer);
		session.debounceTimer = setTimeout(() => {
			session.debounceTimer = null;
			const eventType = session.pendingEvent;
			session.pendingEvent = null;
			if (eventType) {
				// Emit with (event, filePath) so consumers that need the absolute
				// path (e.g., the stats ingester tailing the JSONL) get it without
				// exposing it on the IPC-visible SessionActivityEvent payload.
				// Single-arg listeners on the existing 'append' / 'create' channels
				// still work — the second arg is just ignored.
				this.emit(eventType, this.toEvent(session), session.filePath);
			}
		}, this.debounceMs);
	}

	private scheduleIdle(session: WatchedSession): void {
		if (session.idleTimer) clearTimeout(session.idleTimer);
		session.idleTimer = setTimeout(() => {
			session.idleTimer = null;
			const event = this.toEvent(session);
			this.sessions.delete(session.sessionId);
			this.emit('idle', event);
		}, EXTERNAL_ACTIVITY_IDLE_MS);
	}

	private toEvent(session: WatchedSession): SessionActivityEvent {
		return {
			agentId: this.agentId,
			sessionId: session.sessionId,
			projectPath: session.projectPath,
			lastActivityAt: session.lastActivityAt,
			source: 'external',
			sizeBytes: session.sizeBytes,
		};
	}
}
