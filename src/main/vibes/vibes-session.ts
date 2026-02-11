// VIBES v1.0 Session Manager — Manages per-agent VIBES session state, tracking
// annotations created, maintaining the current environment hash, and coordinating
// writes to the project's .ai-audit/ directory via vibes-io.

import { generateUUID } from '../../shared/uuid';
import { createEnvironmentEntry, createSessionRecord } from './vibes-annotations';
import { appendAnnotation, addManifestEntry } from './vibes-io';
import type {
	VibesAssuranceLevel,
	VibesAnnotation,
	VibesManifestEntry,
} from '../../shared/vibes-types';

// ============================================================================
// Session State
// ============================================================================

/** State tracked per active VIBES session. */
export interface VibesSessionState {
	/** Maestro's internal session ID. */
	sessionId: string;
	/** UUID identifying this VIBES session record. */
	vibesSessionId: string;
	/** Absolute path to the project root. */
	projectPath: string;
	/** The agent ToolType (e.g. 'claude-code', 'codex'). */
	agentType: string;
	/** Assurance level for this session. */
	assuranceLevel: VibesAssuranceLevel;
	/** Hash of the environment manifest entry, set after creation. */
	environmentHash: string | null;
	/** Number of annotations recorded during this session. */
	annotationCount: number;
	/** ISO timestamp when the session started. */
	startedAt: string;
	/** Whether the session is still active. */
	isActive: boolean;
}

// ============================================================================
// Session Manager
// ============================================================================

/**
 * Manages VIBES session lifecycle and annotation recording for agent sessions.
 * Each Maestro agent session maps to one VibesSessionState. The manager
 * coordinates writes through vibes-io and builds entries through vibes-annotations.
 */
export class VibesSessionManager {
	private sessions: Map<string, VibesSessionState> = new Map();

	/**
	 * Start a new VIBES session for an agent.
	 * Creates the session state, writes a session start annotation, and
	 * creates an environment manifest entry.
	 */
	async startSession(
		sessionId: string,
		projectPath: string,
		agentType: string,
		assuranceLevel: VibesAssuranceLevel,
	): Promise<VibesSessionState> {
		const vibesSessionId = generateUUID();
		const startedAt = new Date().toISOString();

		const state: VibesSessionState = {
			sessionId,
			vibesSessionId,
			projectPath,
			agentType,
			assuranceLevel,
			environmentHash: null,
			annotationCount: 0,
			startedAt,
			isActive: true,
		};

		this.sessions.set(sessionId, state);

		// Write session start annotation
		const startRecord = createSessionRecord({
			event: 'start',
			sessionId: vibesSessionId,
			assuranceLevel,
			description: `${agentType} agent session`,
		});
		await appendAnnotation(projectPath, startRecord);
		state.annotationCount++;

		return state;
	}

	/**
	 * End a VIBES session. Writes a session end annotation and marks the
	 * session as inactive.
	 */
	async endSession(sessionId: string): Promise<void> {
		const state = this.sessions.get(sessionId);
		if (!state || !state.isActive) {
			return;
		}

		const endRecord = createSessionRecord({
			event: 'end',
			sessionId: state.vibesSessionId,
			environmentHash: state.environmentHash ?? undefined,
			assuranceLevel: state.assuranceLevel,
			description: `${state.agentType} agent session ended`,
		});
		await appendAnnotation(state.projectPath, endRecord);
		state.annotationCount++;

		state.isActive = false;
	}

	/**
	 * Get the session state for a Maestro session ID.
	 * Returns null if no session exists.
	 */
	getSession(sessionId: string): VibesSessionState | null {
		return this.sessions.get(sessionId) ?? null;
	}

	/**
	 * Check whether a session is currently active.
	 */
	isSessionActive(sessionId: string): boolean {
		const state = this.sessions.get(sessionId);
		return state !== undefined && state.isActive;
	}

	/**
	 * Record a VIBES annotation for a session, appending it to the
	 * project's annotations.jsonl via vibes-io.
	 */
	async recordAnnotation(sessionId: string, annotation: VibesAnnotation): Promise<void> {
		const state = this.sessions.get(sessionId);
		if (!state || !state.isActive) {
			return;
		}

		await appendAnnotation(state.projectPath, annotation);
		state.annotationCount++;
	}

	/**
	 * Record a manifest entry for a session, adding it to the
	 * project's manifest.json via vibes-io.
	 */
	async recordManifestEntry(
		sessionId: string,
		hash: string,
		entry: VibesManifestEntry,
	): Promise<void> {
		const state = this.sessions.get(sessionId);
		if (!state || !state.isActive) {
			return;
		}

		await addManifestEntry(state.projectPath, hash, entry);
	}

	/**
	 * Get the count of currently active sessions.
	 */
	getActiveSessionCount(): number {
		let count = 0;
		for (const state of this.sessions.values()) {
			if (state.isActive) {
				count++;
			}
		}
		return count;
	}

	/**
	 * Get stats for a session: annotation count, duration, and assurance level.
	 * Returns null if the session does not exist.
	 */
	getSessionStats(
		sessionId: string,
	): { annotationCount: number; duration: number; assuranceLevel: VibesAssuranceLevel } | null {
		const state = this.sessions.get(sessionId);
		if (!state) {
			return null;
		}

		const startMs = new Date(state.startedAt).getTime();
		const nowMs = Date.now();
		const duration = nowMs - startMs;

		return {
			annotationCount: state.annotationCount,
			duration,
			assuranceLevel: state.assuranceLevel,
		};
	}
}
