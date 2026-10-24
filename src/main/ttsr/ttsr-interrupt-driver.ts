/**
 * Phase 3a - turn a detected interrupting match into an actual abort.
 *
 * Maestro cannot edit an external CLI's transcript, so "time travel" is:
 * signal the in-flight process, wait for it to exit (stdout drained, provider
 * transcript flushed), then hand the renderer everything it needs to respawn
 * the turn with a corrective `<system-interrupt>` prompt.
 *
 * The driver acts in main with no renderer round-trip - bad output has to stop
 * as soon as it is seen. It owns only the abort; the respawn belongs to the
 * renderer's execution layer (Phase 3b), which keeps tab state, the execution
 * queue, and the message list coherent.
 */

import { logger } from '../utils/logger';
import { generateUUID } from '../../shared/uuid';
import {
	TTSR_AGENT_CAPABILITIES,
	type TtsrAbortClearedPayload,
	type TtsrAbortPendingPayload,
	type TtsrContextMode,
	type TtsrRuleRef,
	type TtsrTriggeredPayload,
} from '../../shared/ttsr-types';
import { buildFreshInjectionPrompt, renderTtsrInterrupt } from './ttsr-injection';
import type { TtsrMatch } from './ttsr-manager';
import type { TtsrSpawnMeta } from './ttsr-spawn-registry';

const LOG_CONTEXT = 'TTSR';

/**
 * How long the aborted turn is given to exit before the corrective payload is
 * emitted anyway. `ProcessManager.interrupt` escalates SIGINT to a hard kill
 * after 2s, so this only trips when even that fails - better to reinject a
 * little early than to strand the turn.
 */
const DEFAULT_EXIT_TIMEOUT_MS = 5_000;

/** The `ProcessManager` surface the driver signals through. */
export interface TtsrInterruptTarget {
	/** SIGINT (escalating to kill after 2s). Used for `contextMode: keep`. */
	interrupt(sessionId: string): boolean;
	/** Immediate teardown. Used for `contextMode: discard`. */
	kill(sessionId: string, options?: { sync?: boolean; shutdown?: boolean }): boolean;
}

export interface TtsrInterruptDriverDeps {
	target: TtsrInterruptTarget;
	/**
	 * Sink for `ttsr:triggered`. Wired to `safeSend` by the main entry point.
	 * The matches are handed along with the payload - including any folded in
	 * after the signal - so the caller can recover the guidance if the corrective
	 * turn it announces never actually spawns.
	 */
	onTriggered(payload: TtsrTriggeredPayload, matches: TtsrMatch[]): void;
	/**
	 * Sink for `ttsr:abortPending`, fired before the process is signalled so the
	 * renderer can suppress its normal exit handling for the abort that follows.
	 */
	onAbortPending?(payload: TtsrAbortPendingPayload): void;
	/**
	 * Sink for `ttsr:abortCleared`. Fired instead of `onTriggered` when the
	 * process could not be signalled, so the renderer resumes its normal exit
	 * handling for a turn that is still running rather than staying wedged.
	 */
	onAbortCleared?(payload: TtsrAbortClearedPayload): void;
	/**
	 * Called with the matches drained for an abort that was announced and then
	 * withdrawn. Their guidance never reached the agent, so the runtime refunds
	 * the budget charge, re-arms the rules, and re-queues them as deferred
	 * reminders. Kept as a callback so the driver owns no repeat bookkeeping.
	 */
	onWithdrawn?(sessionId: string, matches: TtsrMatch[]): void;
	/** Override for tests. */
	exitTimeoutMs?: number;
}

/** One abort in flight, from the signal until `ttsr:triggered` is emitted. */
interface PendingAbort {
	matches: TtsrMatch[];
	contextMode: TtsrContextMode;
	/** Resolved by {@link TtsrInterruptDriver.noteExit} or by the timeout. */
	resolveExit: () => void;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface TtsrTriggerInput {
	sessionId: string;
	/** Live registry entry; `providerSessionId` may still be filled in after. */
	meta: TtsrSpawnMeta;
	matches: TtsrMatch[];
	contextMode: TtsrContextMode;
}

function toRuleRefs(matches: TtsrMatch[]): TtsrRuleRef[] {
	const seen = new Set<string>();
	const refs: TtsrRuleRef[] = [];
	for (const match of matches) {
		if (seen.has(match.rule.name)) continue;
		seen.add(match.rule.name);
		refs.push({ name: match.rule.name, path: match.rule.path });
	}
	return refs;
}

export class TtsrInterruptDriver {
	private readonly pending = new Map<string, PendingAbort>();

	constructor(private readonly deps: TtsrInterruptDriverDeps) {}

	/**
	 * True between the abort signal and the corrective payload. Exit handling
	 * consults it so a TTSR abort is not also reported as a failed turn (the
	 * `ttsrAbortPending` flag from the plan).
	 */
	isAbortPending(sessionId: string): boolean {
		return this.pending.has(sessionId);
	}

	/**
	 * Abort the in-flight turn and emit the corrective payload once it exits.
	 *
	 * Matches arriving while an abort is already in flight (a second rule firing
	 * on the tail of the stream, or a late `astCondition` hit) are folded into
	 * the same corrective turn instead of starting a second abort.
	 */
	async trigger(input: TtsrTriggerInput): Promise<TtsrTriggeredPayload | null> {
		const existing = this.pending.get(input.sessionId);
		if (existing) {
			existing.matches.push(...input.matches);
			return null;
		}

		let resolveExit!: () => void;
		const exited = new Promise<void>((resolve) => {
			resolveExit = resolve;
		});
		const pending: PendingAbort = {
			matches: [...input.matches],
			contextMode: input.contextMode,
			resolveExit,
			timer: null,
		};
		this.pending.set(input.sessionId, pending);

		// Announced before the signal: the exit it produces would otherwise reach
		// the renderer as a failed turn, and the corrective payload only follows
		// once that exit lands.
		this.deps.onAbortPending?.({
			sessionId: input.meta.sessionId,
			tabId: input.meta.tabId,
			agentId: input.meta.agentId,
			rules: toRuleRefs(pending.matches),
			contextMode: input.contextMode,
		});

		// `discard` hard-kills so the provider gets no chance to commit the partial
		// turn; `keep` interrupts and lets it flush. Both are best-effort - Maestro
		// cannot rewrite an external provider's transcript (plan fidelity gap 2).
		let signalled: boolean;
		try {
			signalled =
				input.contextMode === 'discard'
					? this.deps.target.kill(input.sessionId)
					: this.deps.target.interrupt(input.sessionId);
		} catch (err) {
			// The turn is most likely still running, so a corrective respawn would
			// collide with it. Withdraw the abort instead and let the turn finish;
			// the matched rules stay eligible for the next one.
			logger.error('TTSR abort signal failed', LOG_CONTEXT, {
				sessionId: input.sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
			this.withdraw(input.sessionId, input.meta, 'the process could not be signalled');
			return null;
		}

		logger.info('TTSR interrupting turn', LOG_CONTEXT, {
			sessionId: input.sessionId,
			agentId: input.meta.agentId,
			contextMode: input.contextMode,
			rules: pending.matches.map((match) => match.rule.name),
			signalled,
		});

		if (signalled) {
			// Waiting for `exit` guarantees stdout is drained before the corrective
			// turn spawns, so the two turns cannot interleave on the same session id.
			pending.timer = setTimeout(() => {
				logger.warn('TTSR abort timed out waiting for exit', LOG_CONTEXT, {
					sessionId: input.sessionId,
				});
				resolveExit();
			}, this.deps.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS);
			await exited;
		}
		// A false return means the process was already gone (the turn ended between
		// the match and the signal); there is nothing to wait for.

		if (pending.timer) clearTimeout(pending.timer);
		this.pending.delete(input.sessionId);

		const payload = this.buildPayload(input.meta, pending);
		this.deps.onTriggered(payload, pending.matches);
		return payload;
	}

	/**
	 * Report a turn's exit, releasing an abort that is waiting on it. An exit for
	 * a session with no pending abort is simply ignored, so callers can report
	 * every exit without checking first.
	 */
	noteExit(sessionId: string): void {
		this.pending.get(sessionId)?.resolveExit();
	}

	/** Abandon a pending abort (session closed mid-flight). */
	dispose(sessionId: string): void {
		const pending = this.pending.get(sessionId);
		if (!pending) return;
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolveExit();
		this.pending.delete(sessionId);
	}

	// ── internals ──

	/**
	 * Take back an announced abort: drop the pending record and tell the renderer
	 * to stop suppressing this turn's exit. Every `onAbortPending` is answered by
	 * either this or `onTriggered`, or the tab stays busy forever.
	 */
	private withdraw(sessionId: string, meta: TtsrSpawnMeta, reason: string): void {
		const pending = this.pending.get(sessionId);
		if (pending?.timer) clearTimeout(pending.timer);
		pending?.resolveExit();
		this.pending.delete(sessionId);
		// The matches drained for this abort would otherwise be dropped on the
		// floor: nothing re-queues them and their firing is already recorded, so
		// the rules would sit on cooldown having said nothing.
		if (pending && pending.matches.length > 0) {
			this.deps.onWithdrawn?.(sessionId, pending.matches);
		}
		this.deps.onAbortCleared?.({
			sessionId: meta.sessionId,
			tabId: meta.tabId,
			agentId: meta.agentId,
			reason,
		});
	}

	private buildPayload(meta: TtsrSpawnMeta, pending: PendingAbort): TtsrTriggeredPayload {
		// Gate A: only agents that emit their provider session id early enough can
		// resume the aborted conversation. copilot-cli and grok publish theirs on
		// the final event, which an aborted turn never reaches, so they degrade to
		// a fresh turn that restates the goal. Optional-chained so an agent id
		// whose capabilities entry lags behind fails safe to a fresh turn instead
		// of throwing on the corrective-respawn path.
		const canResume =
			TTSR_AGENT_CAPABILITIES[meta.agentId]?.resume === 'clean' && Boolean(meta.providerSessionId);
		const blocks = renderTtsrInterrupt(pending.matches);

		return {
			sessionId: meta.sessionId,
			tabId: meta.tabId,
			agentId: meta.agentId,
			rules: toRuleRefs(pending.matches),
			injectionPrompt: canResume ? blocks : buildFreshInjectionPrompt(meta.originalPrompt, blocks),
			mode: canResume ? 'resume' : 'fresh',
			providerSessionId: canResume ? meta.providerSessionId : undefined,
			originalGoal: meta.originalPrompt,
			contextMode: pending.contextMode,
			// Handed back verbatim on the respawn's spawn config, so the registry
			// recognises this exact corrective turn without reading its prompt.
			ttsrCorrelationId: generateUUID(),
		};
	}
}
