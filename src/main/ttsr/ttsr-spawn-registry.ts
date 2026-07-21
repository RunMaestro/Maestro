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
import { parseAiTabSpawnId } from '../coworking/coworking-session-id';
import type { TtsrMatch } from './ttsr-manager';

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
	/** AI tab that owns the turn, parsed from the spawn id. */
	tabId: string;
	/** Known from spawn time on a resume, otherwise once `session-id` fires. */
	providerSessionId?: string;
	startedAt: number;
	/**
	 * Guidance from a corrective turn that was announced but never spawned: this
	 * spawn is a different turn, so the `<system-interrupt>` block is gone for
	 * good. Set only on that spawn, so the caller can re-file the matches as
	 * deferred reminders rather than drop them (the renderer may have been closed,
	 * refused the respawn, or errored between the payload and the respawn).
	 */
	lostCorrective?: TtsrMatch[];
}

/**
 * A corrective turn TTSR is about to ask the renderer to spawn.
 *
 * The respawn goes back through `ProcessManager.spawn`, so it re-enters
 * {@link TtsrSpawnRegistry.noteSpawn} with the `<system-interrupt>` block as its
 * prompt. Without this hand-off the registry would record that block as the
 * turn's `originalPrompt`, and a second interrupt on a degraded (`fresh`) agent
 * would restate the previous injection instead of the user's actual goal.
 */
interface PendingCorrectiveTurn {
	/** Goal to keep attributing the corrective turn to. */
	originalPrompt: string;
	/**
	 * The payload's `ttsrCorrelationId`. The respawn hands it straight back on
	 * its spawn config, which is how this turn is recognised.
	 */
	correlationId?: string;
	/** Exact prompt handed to the renderer. Fallback when no id comes back. */
	injectionPrompt: string;
	/**
	 * The matches whose guidance rides that injection. Handed back on the spawn
	 * that proves the corrective turn never came, so it can be recovered.
	 */
	matches: TtsrMatch[];
}

/** The subset of a spawn config the registry reads. */
export interface TtsrSpawnConfigLike {
	sessionId: string;
	toolType: string;
	cwd: string;
	prompt?: string;
	projectPath?: string;
	agentSessionId?: string;
	/** Echoed back from `ttsr:triggered` when this spawn IS the corrective turn. */
	ttsrCorrelationId?: string;
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
	private readonly pendingCorrective = new Map<string, PendingCorrectiveTurn>();

	/**
	 * Record a turn, or return `null` for one TTSR must not touch.
	 *
	 * Two gates, both load-bearing:
	 *
	 * - **Agent:** terminal is out of scope for v1 (Gate A tier C) and an unknown
	 *   agent id has no capability row to reason about.
	 * - **Spawn flavor:** only AI-tab spawns (`{sessionId}-ai-{tabId}`) are
	 *   registered. Interrupting is worthless without a matching respawn, and the
	 *   corrective respawn can only target an AI tab - the renderer has no tab to
	 *   put a corrective turn in for an Auto Run task, a background synopsis, a
	 *   tab-naming run or a group-chat participant. Registering those would let
	 *   TTSR kill an unattended turn it can never restart, silently truncating it.
	 */
	noteSpawn(config: TtsrSpawnConfigLike): TtsrSpawnMeta | null {
		if (!isValidAgentId(config.toolType) || config.toolType === 'terminal') return null;

		const parsedId = parseAiTabSpawnId(config.sessionId);
		if (!parsedId) {
			// A corrective turn is never coming for this spawn, so its carry-over
			// (if any) is stale bookkeeping.
			this.pendingCorrective.delete(config.sessionId);
			return null;
		}

		const corrective = this.resolveCorrective(config);
		const meta: TtsrSpawnMeta = {
			sessionId: config.sessionId,
			agentId: config.toolType,
			// SSH spawns run the local ssh client from the user's home dir, so `cwd`
			// is not the project. `projectPath` carries the real workspace root and
			// is what `.maestro/rules` must be resolved against.
			projectRoot: config.projectPath || config.cwd,
			originalPrompt: corrective.originalPrompt,
			lostCorrective: corrective.lostCorrective,
			// Parsed from the spawn id rather than read from `config.tabId`, which
			// no spawn caller currently sets.
			tabId: parsedId.tabId,
			// A resume spawn already knows the conversation it re-attaches to, so
			// repeat state is keyed correctly from the very first delta rather than
			// spending the turn in the pending bucket.
			providerSessionId: config.agentSessionId,
			startedAt: Date.now(),
		};
		this.entries.set(meta.sessionId, meta);
		return meta;
	}

	/**
	 * Note that a corrective turn was handed to the renderer, so the respawn it
	 * performs is attributed to the goal the aborted turn was pursuing rather
	 * than to the injected `<system-interrupt>` block.
	 */
	noteCorrectiveTurn(sessionId: string, pending: PendingCorrectiveTurn): void {
		this.pendingCorrective.set(sessionId, pending);
	}

	/**
	 * The goal to record for a spawn: the carried-over one when this really is
	 * the corrective respawn we asked for, otherwise the spawn's own prompt.
	 *
	 * Recognition is by correlation id. Main both builds the payload and observes
	 * the spawn, so the renderer only has to hand the id back on its spawn config;
	 * inspecting the prompt instead made goal carry-over depend on nothing ever
	 * decorating the prompt after the injection block.
	 *
	 * The `endsWith` check stays as a fallback for a spawn that carries no id (an
	 * older renderer, or a caller that rebuilt the config). It is `endsWith`
	 * rather than equality because the spawn path may prepend deferred
	 * `<system-reminder>` blocks on the way out.
	 *
	 * The next spawn of a session is also the deadline for the corrective turn:
	 * once a different turn starts, the injection will never be delivered, so its
	 * matches come back out here for the caller to recover.
	 */
	private resolveCorrective(config: TtsrSpawnConfigLike): {
		originalPrompt: string;
		lostCorrective?: TtsrMatch[];
	} {
		const prompt = config.prompt ?? '';
		const pending = this.pendingCorrective.get(config.sessionId);
		// Consumed either way: a spawn that is not the corrective turn means it
		// never arrived, and a later unrelated turn must not inherit the goal.
		this.pendingCorrective.delete(config.sessionId);
		if (!pending) return { originalPrompt: prompt };

		const isCorrective =
			pending.correlationId && config.ttsrCorrelationId
				? config.ttsrCorrelationId === pending.correlationId
				: prompt.endsWith(pending.injectionPrompt);
		if (isCorrective) return { originalPrompt: pending.originalPrompt };
		return {
			originalPrompt: prompt,
			lostCorrective: pending.matches.length > 0 ? pending.matches : undefined,
		};
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
