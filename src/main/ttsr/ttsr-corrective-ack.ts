/**
 * Phase 4b - check the promise the interrupt toast makes.
 *
 * `ttsr:triggered` is broadcast and the orange toast is raised optimistically,
 * before any renderer has spawned anything: the corrective turn must start as
 * fast as possible, so main does not wait on a round-trip to tell the user. The
 * cost of that ordering is a promise nobody verifies - if the desktop renderer
 * never spawns (it was reloading, it crashed, the ownership gate matched no
 * window), the failure toast raised by `useTtsr` is renderer-local, and a user
 * watching a web-desktop client keeps an orange toast that has quietly become a
 * lie.
 *
 * This tracker closes that loop. Each interrupt arms a one-shot watchdog keyed
 * by the process id; the spawning renderer acks over `ttsr:correctiveResult`,
 * which cancels it. An explicit failure, or silence past the timeout, broadcasts
 * a sticky red toast to every client. Web clients and non-owning windows never
 * ack (they never spawn), which is exactly why the timeout - not the absence of
 * an ack - is what raises the alarm.
 */

import type { TtsrCorrectiveResult, TtsrTriggeredPayload } from '../../shared/ttsr-types';
import { emitTtsrFailureToast } from './ttsr-notify';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'TTSR';

/**
 * How long a corrective turn has to report in.
 *
 * Long enough that a slow spawn (SSH remote, a cold agent binary) does not
 * false-alarm, short enough that a user staring at a stalled tab is told before
 * they conclude Maestro ate their turn.
 */
export const TTSR_CORRECTIVE_ACK_TIMEOUT_MS = 10_000;

export interface TtsrCorrectiveAckDeps {
	/** Renderer push channel; the same `safeSend` the runtime was built with. */
	safeSend(channel: string, ...args: unknown[]): void;
	/** Test override for {@link TTSR_CORRECTIVE_ACK_TIMEOUT_MS}. */
	timeoutMs?: number;
}

interface PendingAck {
	timer: ReturnType<typeof setTimeout>;
	payload: TtsrTriggeredPayload;
}

/**
 * Watchdog for the corrective spawn. One entry per interrupted turn, cleared by
 * the ack, the timeout, or {@link dispose}.
 */
export class TtsrCorrectiveAckTracker {
	private readonly pending = new Map<string, PendingAck>();
	private readonly timeoutMs: number;

	constructor(private readonly deps: TtsrCorrectiveAckDeps) {
		this.timeoutMs = deps.timeoutMs ?? TTSR_CORRECTIVE_ACK_TIMEOUT_MS;
	}

	/**
	 * Start watching one interrupt. Armed only for payloads that actually aborted
	 * a turn, which is precisely what `ttsr:triggered` already means.
	 */
	arm(payload: TtsrTriggeredPayload): void {
		// A second interrupt on the same turn supersedes the first: only the latest
		// corrective turn is the one a renderer is trying to spawn, and leaving the
		// older timer standing would fire a failure toast for a turn that moved on.
		this.cancel(payload.sessionId);

		const timer = setTimeout(() => {
			this.pending.delete(payload.sessionId);
			this.fail(payload, undefined);
		}, this.timeoutMs);
		this.pending.set(payload.sessionId, { timer, payload });
	}

	/**
	 * Record a renderer's ack. Unknown ids are ignored: a late ack that lost the
	 * race with the timeout has already been reported, and re-reporting it would
	 * contradict the toast the user just read.
	 */
	resolve(result: TtsrCorrectiveResult): void {
		const entry = this.pending.get(result.sessionId);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.pending.delete(result.sessionId);
		if (!result.ok) this.fail(entry.payload, result.error);
	}

	/** Drop every watchdog (runtime dispose / app shutdown). */
	dispose(): void {
		for (const entry of this.pending.values()) clearTimeout(entry.timer);
		this.pending.clear();
	}

	/** Pending watchdog count. Test/diagnostic read only. */
	get pendingCount(): number {
		return this.pending.size;
	}

	private cancel(sessionId: string): void {
		const entry = this.pending.get(sessionId);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.pending.delete(sessionId);
	}

	private fail(payload: TtsrTriggeredPayload, error: string | undefined): void {
		logger.warn('Corrective turn did not start', LOG_CONTEXT, {
			sessionId: payload.sessionId,
			reason: error ?? `no ack within ${this.timeoutMs}ms`,
		});
		emitTtsrFailureToast(this.deps.safeSend, payload, error);
	}
}
