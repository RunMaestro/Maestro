/**
 * TTSR spawn registry - the main-side record of what started each turn.
 *
 * `ManagedProcess` deliberately keeps no prompt or spawn config, so nothing in
 * the process manager can answer "what goal was this turn pursuing?" once the
 * process is running. The registry resolves the project and AI tab for matching and native Steer.
 *
 * The registry is fed from the public `spawn` / `session-id` / `exit`
 * ProcessManager events, so the process manager keeps no TTSR dependency
 * (Gate B: this state is main-authoritative and lives here, not on the
 * renderer or on the dying `ManagedProcess`).
 */

import { isValidAgentId, type AgentId } from '../../shared/agentIds';
import { parseAiTabSpawnId } from '../coworking/coworking-session-id';

/** Everything TTSR knows about one in-flight turn. */
export interface TtsrSpawnMeta {
	/** Maestro process id, `${session.id}-ai-${tabId}`. */
	sessionId: string;
	agentId: AgentId;
	/** Project root used to resolve `.maestro/rules`. */
	projectRoot: string;
	/** AI tab that owns the turn, parsed from the spawn id. */
	tabId: string;
	/** Known from spawn time on a resume, otherwise once `session-id` fires. */
	providerSessionId?: string;
}

/** The subset of a spawn config the registry reads. */
export interface TtsrSpawnConfigLike {
	sessionId: string;
	toolType: string;
	cwd: string;
	prompt?: string;
	projectPath?: string;
	agentSessionId?: string;
}

/** Minimal event surface the registry attaches to (ProcessManager in prod). */
export interface TtsrProcessEventSource {
	on(event: 'spawn', listener: (config: TtsrSpawnConfigLike) => void): unknown;
	on(event: 'session-id', listener: (sessionId: string, agentSessionId: string) => void): unknown;
	on(event: 'exit', listener: (sessionId: string, code: number, signal?: number) => void): unknown;
	off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export class TtsrSpawnRegistry {
	private readonly entries = new Map<string, TtsrSpawnMeta>();

	/**
	 * Record a turn, or return `null` for one TTSR must not touch.
	 *
	 * Two gates, both load-bearing:
	 *
	 * - **Agent:** terminal is out of scope for v1 (Gate A tier C) and an unknown
	 *   agent id has no capability row to reason about.
	 * - **Spawn flavor:** only AI-tab spawns are registered. Their existing
	 *   queue and native Steer owner handle guidance; other automation has no
	 *   AI-tab queue to receive it.

	 */
	noteSpawn(config: TtsrSpawnConfigLike): TtsrSpawnMeta | null {
		if (!isValidAgentId(config.toolType) || config.toolType === 'terminal') return null;

		const parsedId = parseAiTabSpawnId(config.sessionId);
		if (!parsedId) return null;
		const meta: TtsrSpawnMeta = {
			sessionId: config.sessionId,
			agentId: config.toolType,
			// SSH spawns run the local ssh client from the user's home dir, so `cwd`
			// is not the project. `projectPath` carries the real workspace root and
			// is what `.maestro/rules` must be resolved against.
			projectRoot: config.projectPath || config.cwd,
			// Parsed from the spawn id rather than read from `config.tabId`, which
			// no spawn caller currently sets.
			tabId: parsedId.tabId,
			// A resume spawn already knows the conversation it re-attaches to, so
			// repeat state is keyed correctly from the very first delta rather than
			// spending the turn in the pending bucket.
			providerSessionId: config.agentSessionId,
		};
		this.entries.set(meta.sessionId, meta);
		return meta;
	}

	/** Record the provider conversation id once the agent announces it. */
	noteProviderSessionId(sessionId: string, providerSessionId: string): void {
		const meta = this.entries.get(sessionId);
		if (!meta || !providerSessionId) return;
		meta.providerSessionId = providerSessionId;
	}

	get(sessionId: string): TtsrSpawnMeta | undefined {
		return this.entries.get(sessionId);
	}

	/** Drop a finished turn. */
	clear(sessionId: string): void {
		this.entries.delete(sessionId);
	}

	/** Live turn count. Test/diagnostic affordance. */
	get size(): number {
		return this.entries.size;
	}
}
