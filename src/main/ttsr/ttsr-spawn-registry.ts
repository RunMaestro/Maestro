/**
 * TTSR spawn registry - the main-side record of what started each turn.
 *
 * `ManagedProcess` deliberately keeps no prompt or spawn config, so nothing in
 * the process manager can answer "what goal was this turn pursuing?" once the
 * process is running. Phase 3's corrective reinject needs exactly that: the
 * provider session id (to `--resume`) and the original goal (to restate on the
 * degraded `fresh` path for agents that never emit an id mid-turn).
 *
 * The registry is fed from the public `spawn` / `session-id` / `exit`
 * ProcessManager events, so the process manager keeps no TTSR dependency
 * (Gate B: this state is main-authoritative and lives here, not on the
 * renderer or on the dying `ManagedProcess`).
 */

import { isValidAgentId, type AgentId } from '../../shared/agentIds';

/** Everything TTSR knows about one in-flight turn. */
export interface TtsrSpawnMeta {
	/** Maestro process id, `${session.id}-ai-${tabId}`. */
	sessionId: string;
	agentId: AgentId;
	/** Project root used to resolve `.maestro/rules`. */
	projectRoot: string;
	/**
	 * The prompt that started this turn. Phase 3's `originalGoal`: for agents
	 * with no mid-turn provider id, the corrective turn restates it.
	 */
	originalPrompt: string;
	tabId?: string;
	/** Known from spawn time on a resume, otherwise once `session-id` fires. */
	providerSessionId?: string;
	startedAt: number;
}

/** The subset of a spawn config the registry reads. */
export interface TtsrSpawnConfigLike {
	sessionId: string;
	toolType: string;
	cwd: string;
	prompt?: string;
	tabId?: string;
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
	 * Record a turn. Terminal spawns and any agent id TTSR does not know are
	 * ignored outright - terminal is out of scope for v1 (Gate A tier C) and an
	 * unknown id has no capability row to reason about.
	 */
	noteSpawn(config: TtsrSpawnConfigLike): TtsrSpawnMeta | null {
		if (!isValidAgentId(config.toolType) || config.toolType === 'terminal') return null;

		const meta: TtsrSpawnMeta = {
			sessionId: config.sessionId,
			agentId: config.toolType,
			// SSH spawns run the local ssh client from the user's home dir, so `cwd`
			// is not the project. `projectPath` carries the real workspace root and
			// is what `.maestro/rules` must be resolved against.
			projectRoot: config.projectPath || config.cwd,
			originalPrompt: config.prompt ?? '',
			tabId: config.tabId,
			// A resume spawn already knows the conversation it re-attaches to, so
			// repeat state is keyed correctly from the very first delta rather than
			// spending the turn in the pending bucket.
			providerSessionId: config.agentSessionId,
			startedAt: Date.now(),
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

	/**
	 * Drop a finished turn. Phase 3 reads the meta while handling the abort's
	 * `exit`, so callers must consume before clearing.
	 */
	clear(sessionId: string): void {
		this.entries.delete(sessionId);
	}

	/** Live turn count. Test/diagnostic affordance. */
	get size(): number {
		return this.entries.size;
	}
}
