import { randomUUID } from 'crypto';
import {
	parseHarnessInteractionRequest,
	parseHarnessInteractionResponse,
} from '../../shared/harness-control/validators';
import type {
	HarnessInteractionCancelReason,
	HarnessInteractionOpenRequest,
	HarnessInteractionRequest,
	HarnessInteractionResolution,
	HarnessInteractionResolveResult,
	HarnessInteractionSettledEvent,
} from '../../shared/harness-control/types';

export const HARNESS_INTERACTION_TIMEOUT_MS = 300_000;

export type { HarnessInteractionResolveResult } from '../../shared/harness-control/types';

interface PendingInteraction {
	request: HarnessInteractionRequest;
	timer: NodeJS.Timeout;
	resolve: (resolution: HarnessInteractionResolution) => void;
}

export interface HarnessInteractionOpenResult {
	request: HarnessInteractionRequest;
	completion: Promise<HarnessInteractionResolution>;
}

export interface InteractionBrokerHandlers {
	/** Return false when no authorized owner can display the request. */
	onRequest: (request: HarnessInteractionRequest) => boolean | void;
	onSettled: (event: HarnessInteractionSettledEvent) => void;
}

/**
 * Owns pending native interactions. Adapters await `completion` and translate its
 * resolution exactly once; UI callers can only select a registered option,
 * answer a question, or cancel. Settlement events never contain answer values.
 */
export class InteractionBroker {
	private readonly pending = new Map<string, PendingInteraction>();

	constructor(
		private readonly handlers: InteractionBrokerHandlers,
		private readonly defaultTimeoutMs = HARNESS_INTERACTION_TIMEOUT_MS
	) {}

	/** Register and deliver one request, cancelling immediately when no owner can display it. */
	open(
		raw: HarnessInteractionOpenRequest,
		timeoutMs = this.defaultTimeoutMs
	): HarnessInteractionOpenResult {
		const request = parseHarnessInteractionRequest({
			...raw,
			requestId: randomUUID(),
			createdAt: Date.now(),
		});
		if (!request) throw new TypeError('Invalid harness interaction request');

		const { promise: completion, resolve: resolveCompletion } =
			Promise.withResolvers<HarnessInteractionResolution>();
		const timer = setTimeout(() => {
			this.settle(request.requestId, { outcome: 'cancelled', reason: 'timeout' });
		}, timeoutMs);
		timer.unref?.();
		this.pending.set(request.requestId, { request, timer, resolve: resolveCompletion });

		try {
			if (this.handlers.onRequest(request) === false) {
				this.settle(request.requestId, { outcome: 'cancelled', reason: 'owner-unavailable' });
			}
		} catch {
			this.settle(request.requestId, { outcome: 'cancelled', reason: 'owner-unavailable' });
		}
		return { request, completion };
	}

	/** Validate and settle a user response exactly once, including option membership checks. */
	resolve(raw: unknown): HarnessInteractionResolveResult {
		const response = parseHarnessInteractionResponse(raw);
		if (!response) return 'invalid-response';
		const pending = this.pending.get(response.requestId);
		if (!pending) return 'not-found';
		if (response.outcome === 'selected') {
			if (!pending.request.options.some((option) => option.optionId === response.optionId)) {
				return 'invalid-response';
			}
		} else if (response.outcome === 'answers') {
			if (pending.request.kind === 'permission') return 'invalid-response';
		} else if (response.reason !== 'cancelled') {
			return 'invalid-response';
		}
		const { requestId: _requestId, ...resolution } = response;
		this.settle(response.requestId, resolution);
		return 'resolved';
	}

	/** Cancel a pending request when its provider withdraws the underlying tool call. */
	withdraw(requestId: string, reason: HarnessInteractionCancelReason = 'withdrawn'): boolean {
		return this.settle(requestId, { outcome: 'cancelled', reason });
	}

	/** Cancel requests owned by a process, optionally restricted to one spawn generation. */
	closeSession(
		sessionId: string,
		spawnGeneration?: number,
		reason: HarnessInteractionCancelReason = 'process-exited'
	): number {
		let closed = 0;
		for (const pending of [...this.pending.values()]) {
			if (
				pending.request.sessionId === sessionId &&
				(spawnGeneration === undefined || pending.request.spawnGeneration === spawnGeneration)
			) {
				this.settle(pending.request.requestId, { outcome: 'cancelled', reason });
				closed += 1;
			}
		}
		return closed;
	}

	/** Cancel every request when the native transport has closed. */
	closeAll(reason: HarnessInteractionCancelReason = 'transport-closed'): void {
		for (const requestId of [...this.pending.keys()]) {
			this.settle(requestId, { outcome: 'cancelled', reason });
		}
	}

	/** Return snapshots for owner-filtered restoration without exposing completion callbacks. */
	pendingRequests(): HarnessInteractionRequest[] {
		return [...this.pending.values()].map((pending) => pending.request);
	}

	/** Settle, notify, and forget a request while keeping answer values out of settlement events. */
	private settle(requestId: string, resolution: HarnessInteractionResolution): boolean {
		const pending = this.pending.get(requestId);
		if (!pending) return false;
		this.pending.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve(resolution);
		try {
			this.handlers.onSettled({
				requestId,
				sessionId: pending.request.sessionId,
				spawnGeneration: pending.request.spawnGeneration,
				outcome: resolution.outcome,
				...(resolution.outcome === 'cancelled' ? { reason: resolution.reason } : {}),
			});
		} catch {
			// Settlement is already final. A detached UI listener cannot reopen it.
		}
		return true;
	}
}
