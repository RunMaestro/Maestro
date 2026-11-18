import { canonicalJson } from '../../canonicalJson';
import { createIdleWatchdog, type IdleWatchdog } from '../control/idle-watchdog';
import {
	grokEffectGranted,
	type GrokEffectAuthority,
	type GrokEffectBinding,
	type GrokEffectVerdict,
} from './host-seams';
import type { TurnTerminal } from '../streaming/turn-outcome';
import type { GrokAcpClientOptions } from './acp-client';
import {
	GrokAcpTransportError,
	type AcpAnswer,
	type AcpCall,
	type AcpRequestId,
} from './acp-protocol';

export interface GrokAcpPermissionTurn {
	sessionId: string;
	/** Host dispatch identity; never substitute it for a native prompt ID. */
	turnId: string;
	promptId?: string;
	/** Abort synchronously on cancellation/revocation, before sending session/cancel. */
	signal: AbortSignal;
	/** The host composes consent and policy here. Missing authority/binding cannot grant. */
	authority?: GrokEffectAuthority;
	binding?: Pick<GrokEffectBinding, 'actor' | 'leaseId'>;
}

type PermissionReason =
	| 'allowed'
	| 'denied'
	| 'unavailable'
	| 'unknown'
	| 'unsupported-options'
	| 'invalid-request'
	| 'stale-request'
	| 'cancelled'
	| 'turn-ended'
	| 'timeout'
	| 'disconnected';

export interface GrokAcpPermissionSettlement {
	requestId: AcpRequestId;
	sessionId: string | null;
	turnId: string | null;
	reason: PermissionReason;
	decision?: GrokEffectVerdict;
	/** A successful local write, not acknowledgement that the provider received it. */
	responseWritten: boolean;
	/** Non-grants must override a later successful prompt result in the composed turn. */
	terminal?: TurnTerminal;
}

/** Pinned ACP extensions use an underscore on the wire (ACP crate 0.10.4). */
export type GrokAcpQuestionMethod = '_x.ai/ask_user_question' | '_x.ai/mcp/elicit';

export interface GrokAcpQuestionIdentity {
	/** Connection/account/host/session/turn/method/typed-request correlation, not a provider ID. */
	questionId: string;
	requestId: AcpRequestId;
	sessionId: string | null;
	turnId: string | null;
	processGeneration: string;
}

export interface GrokAcpQuestionSettlement extends Omit<GrokAcpPermissionSettlement, 'decision'> {
	kind: 'question';
	decision?: never;
	method: GrokAcpQuestionMethod;
	identity: GrokAcpQuestionIdentity;
}

/**
 * Consumer port for phases 07/10. Pending carries the original prompt/options/schema
 * without interpreting it as a permission. The pinned peer advertises no question
 * capability, so this adapter currently emits ONLY settled events, never pending.
 */
export type GrokAcpQuestionEvent =
	| {
			state: 'pending';
			identity: GrokAcpQuestionIdentity;
			method: GrokAcpQuestionMethod;
			request: AcpCall['params'];
			deadlineAt: number;
	  }
	| { state: 'settled'; settlement: GrokAcpQuestionSettlement };

export interface GrokAcpRequestOptions {
	/** One adapter per admitted process/connection. These references are never credentials. */
	account: string;
	host: string;
	cwd: string;
	processGeneration: string;
	timeoutMs?: number;
	/** Common terminal channel: an unavailable question also prevents successful completion. */
	onSettlement: (settlement: GrokAcpPermissionSettlement | GrokAcpQuestionSettlement) => void;
	onQuestion?: (event: GrokAcpQuestionEvent) => void;
	/** Must close the transport/owned process without throwing; diagnostics contain no payload. */
	onFault: (error: GrokAcpTransportError) => void;
}

type PermissionOwner = Readonly<GrokAcpPermissionTurn> & { detach: () => void };
interface PendingRequest {
	id: AcpRequestId;
	owner?: PermissionOwner;
	sessionId: string | null;
	respond: (answer: AcpAnswer) => boolean;
	controller: AbortController;
	watchdog?: IdleWatchdog;
	allow?: string;
	deny?: string;
	questionMethod?: GrokAcpQuestionMethod;
}

/**
 * Incoming request lifetime only. No tool execution, policy classification or implicit grant.
 * Register requestHandlers once; beginTurn immediately before dispatch, end it on settlement,
 * and close on pipe/process loss. An untagged request belongs only to the exclusive active turn.
 */
export class GrokAcpRequestAdapter {
	readonly requestHandlers: NonNullable<GrokAcpClientOptions['requestHandlers']>;
	/** Source-known methods are not a negotiated feature. Never infer this from permissions. */
	readonly questionSupport = Object.freeze({
		status: 'unsupported' as const,
		reason: 'not-advertised' as const,
	});
	private readonly options: Readonly<GrokAcpRequestOptions>;
	private readonly timeoutMs: number;
	private readonly seen = new Set<AcpRequestId>();
	private readonly pending = new Map<AcpRequestId, PendingRequest>();
	private owner?: PermissionOwner;
	private closed = false;
	private draining = false;
	private faultReason?: 'write' | 'handler-failed' | 'malformed-frame';
	private faultReported = false;

	constructor(options: GrokAcpRequestOptions) {
		this.options = Object.freeze({ ...options });
		this.timeoutMs = options.timeoutMs ?? 30_000;
		if (
			!Number.isSafeInteger(this.timeoutMs) ||
			this.timeoutMs <= 0 ||
			this.timeoutMs > 2_147_483_647
		)
			throw new GrokAcpTransportError('invalid-timeout');
		if (
			[options.account, options.host, options.cwd, options.processGeneration].some(
				(s) => !s?.trim()
			)
		)
			throw new TypeError('Grok ACP permission identity is required');
		this.requestHandlers = new Map([
			['session/request_permission', this.request],
			['_x.ai/ask_user_question', this.request],
			['_x.ai/mcp/elicit', this.request],
		]);
	}

	/**
	 * Correlated answer operation for interactive consumers. There can be no pending
	 * question without a verified advertised contract, so every answer is unavailable.
	 * This includes stale/foreign identities and permission IDs: no wire write, authority
	 * call or fabricated accepted answer. Future negotiation must preserve that separation.
	 */
	answerQuestion(_identity: GrokAcpQuestionIdentity, _answer: unknown): 'unavailable' {
		return 'unavailable';
	}

	/** End the previous turn first. The returned end operation cannot invalidate a later turn. */
	beginTurn(turn: GrokAcpPermissionTurn): () => void {
		if (this.closed) throw new GrokAcpTransportError('closed');
		if (this.owner) throw new TypeError('Grok ACP permission turn is already active');
		if (
			!turn.sessionId?.trim() ||
			!turn.turnId?.trim() ||
			(turn.promptId !== undefined && !turn.promptId.trim())
		)
			throw new TypeError('Grok ACP permission turn identity is required');
		const signal = turn.signal;
		const onAbort = (): void => this.end(owner, 'cancelled');
		const owner: PermissionOwner = Object.freeze({
			...turn,
			binding:
				turn.binding &&
				Object.freeze({
					leaseId: turn.binding.leaseId,
					actor: Object.freeze({ ...turn.binding.actor }),
				}),
			detach: () => signal.removeEventListener('abort', onAbort),
		});
		this.owner = owner;
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) onAbort();
		return () => this.end(owner, 'turn-ended');
	}

	/** Disconnect invalidates authority work locally; it never invents a delivered denial. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.owner?.detach();
		this.owner = undefined;
		this.draining = true;
		try {
			for (const pending of [...this.pending.values()]) this.settle(pending, 'disconnected');
		} finally {
			this.draining = false;
			this.seen.clear();
		}
		if (this.faultReason) this.fault(this.faultReason);
	}

	private end(owner: PermissionOwner, reason: 'cancelled' | 'turn-ended'): void {
		if (this.owner !== owner) return;
		this.owner = undefined;
		owner.detach();
		for (const pending of [...this.pending.values()])
			if (pending.owner === owner) this.settle(pending, reason);
	}

	private readonly request = (request: AcpCall, respond: (answer: AcpAnswer) => boolean): void => {
		// Notifications, even with permission-shaped data, have no authority channel.
		const questionMethod =
			request.method === '_x.ai/ask_user_question' || request.method === '_x.ai/mcp/elicit'
				? request.method
				: undefined;
		if (
			request.id === undefined ||
			(request.method !== 'session/request_permission' && !questionMethod) ||
			this.closed
		)
			return;
		const id = request.id;
		// Bound tombstones for this connection; never evict one and allow request replay.
		if (
			(typeof id !== 'string' && !Number.isSafeInteger(id)) ||
			(typeof id === 'string' && id.length > 1024) ||
			this.seen.has(id) ||
			this.seen.size >= 4096 ||
			this.pending.size >= 64
		) {
			this.fault('malformed-frame');
			return;
		}
		this.seen.add(id);
		const params = request.params;
		const validParams = params !== null && typeof params === 'object' && !Array.isArray(params);
		const sessionId = validParams && typeof params.sessionId === 'string' ? params.sessionId : null;
		const owner = this.owner;
		const pending: PendingRequest = {
			id,
			owner,
			sessionId,
			respond,
			controller: new AbortController(),
			questionMethod,
		};
		this.pending.set(id, pending);
		if (!owner || owner.signal.aborted || sessionId !== owner.sessionId) {
			// Foreign requests never acquire the current turn's identity or outcome.
			pending.owner = undefined;
			this.settle(pending, 'stale-request');
			return;
		}
		if (!validParams) {
			this.settle(pending, 'invalid-request');
			return;
		}
		const meta = params._meta;
		if (meta != null && (typeof meta !== 'object' || Array.isArray(meta))) {
			this.settle(pending, 'invalid-request');
			return;
		}
		const metadata = meta as Record<string, unknown> | undefined;
		if (
			(metadata?.sessionId !== undefined && metadata.sessionId !== owner.sessionId) ||
			(metadata?.promptId !== undefined && metadata.promptId !== owner.promptId)
		) {
			pending.owner = undefined;
			this.settle(pending, 'stale-request');
			return;
		}
		if (questionMethod) {
			// The pinned initialize response has no ask-back/elicitation capability. Both
			// recognized reverse methods have explicit cancellation outcomes. Never show a
			// question, parse a schema, open a URL or wait for an absent UI in this state.
			this.settle(pending, 'unavailable');
			return;
		}
		const tool = params.toolCall;
		if (
			!tool ||
			typeof tool !== 'object' ||
			Array.isArray(tool) ||
			typeof (tool as Record<string, unknown>).toolCallId !== 'string' ||
			!(tool as Record<string, unknown>).toolCallId ||
			!Array.isArray(params.options) ||
			params.options.length === 0 ||
			params.options.length > 64
		) {
			this.settle(pending, 'invalid-request');
			return;
		}
		const ids = new Set<string>();
		for (const option of params.options) {
			if (
				!option ||
				typeof option !== 'object' ||
				Array.isArray(option) ||
				typeof option.optionId !== 'string' ||
				!option.optionId ||
				ids.has(option.optionId) ||
				typeof option.name !== 'string' ||
				typeof option.kind !== 'string'
			) {
				this.settle(pending, 'invalid-request');
				return;
			}
			ids.add(option.optionId);
			if (option.kind === 'allow_once') {
				if (pending.allow !== undefined) {
					this.settle(pending, 'unsupported-options');
					return;
				}
				pending.allow = option.optionId;
			}
			if (option.kind === 'reject_once') pending.deny ??= option.optionId;
		}
		if (pending.allow === undefined) {
			this.settle(pending, 'unsupported-options');
			return;
		}
		if (!owner.authority || !owner.binding?.leaseId || !owner.binding.actor.id) {
			this.settle(pending, 'unavailable');
			return;
		}
		const binding: GrokEffectBinding = {
			...owner.binding,
			provider: 'grok',
			threadId: owner.sessionId,
			turnId: owner.promptId ?? null,
			// Preserve typed IDs, process generation and host turn without inventing native IDs.
			requestId: canonicalJson([this.options.processGeneration, owner.turnId, id]),
		};
		pending.watchdog = createIdleWatchdog({
			idleMs: this.timeoutMs,
			onIdle: () => this.settle(pending, 'timeout'),
		});
		// Preserve the complete exact request; title/kind/rawInput are not a trusted effect classifier.
		const effect = {
			kind: 'permissions' as const,
			permissions: {
				method: request.method,
				requestId: id,
				scope: 'once',
				account: this.options.account,
				host: this.options.host,
				cwd: this.options.cwd,
				processGeneration: this.options.processGeneration,
				turnId: owner.turnId,
				request: structuredClone(params),
			},
		};
		void Promise.resolve()
			.then(() => {
				if (this.pending.get(id) !== pending || this.owner !== owner || owner.signal.aborted)
					return;
				return owner.authority!.decide(effect, binding, pending.controller.signal);
			})
			.then(
				(decision) => {
					if (this.pending.get(id) !== pending) return;
					if (this.owner !== owner || owner.signal.aborted) {
						this.settle(pending, 'cancelled');
						return;
					}
					const reason = grokEffectGranted(decision)
						? 'allowed'
						: decision?.decision === 'deny'
							? 'denied'
							: decision?.decision === 'unavailable'
								? 'unavailable'
								: 'unknown';
					this.settle(pending, reason, decision?.decision);
				},
				() => {
					if (this.pending.get(id) !== pending) return;
					this.settle(pending, 'unknown', 'unknown');
					this.fault('handler-failed');
				}
			);
	};

	private settle(
		pending: PendingRequest,
		reason: PermissionReason,
		decision?: GrokEffectVerdict
	): void {
		if (this.pending.get(pending.id) !== pending) return;
		this.pending.delete(pending.id);
		pending.watchdog?.disarm();
		pending.controller.abort();
		// Abort listeners are host code and may synchronously cancel or replace this turn.
		if (reason === 'allowed' && (this.owner !== pending.owner || pending.owner?.signal.aborted))
			reason = 'cancelled';
		const optionId =
			reason === 'allowed' ? pending.allow : reason === 'denied' ? pending.deny : undefined;
		let responseWritten = false;
		let writeFailed = false;
		if (!this.closed) {
			try {
				responseWritten = pending.respond({
					result: pending.questionMethod
						? { outcome: pending.questionMethod === '_x.ai/mcp/elicit' ? 'cancel' : 'cancelled' }
						: {
								outcome:
									optionId === undefined
										? { outcome: 'cancelled' }
										: { outcome: 'selected', optionId },
							},
				});
			} catch {
				writeFailed = true;
			}
		}
		if (!responseWritten) reason = 'disconnected';
		let terminal: TurnTerminal | undefined;
		if (reason === 'disconnected') terminal = { status: 'failed', kind: 'transport' };
		else if (reason === 'timeout') terminal = { status: 'timeout', kind: 'deadline' };
		else if (reason === 'cancelled' || reason === 'turn-ended')
			terminal = { status: 'cancelled', origin: 'host' };
		else if (pending.questionMethod) terminal = { status: 'cancelled', origin: 'host' };
		else if (reason !== 'allowed') terminal = { status: 'refused', origin: 'effect' };
		try {
			const settlement: Omit<GrokAcpPermissionSettlement, 'decision'> = {
				requestId: pending.id,
				sessionId: pending.sessionId,
				turnId: pending.owner?.turnId ?? null,
				reason,
				responseWritten,
				terminal: terminal && {
					...terminal,
					reason: `${pending.questionMethod ? 'user-input' : 'permission'}-${reason}`,
					dispatchState: 'dispatched',
				},
			};
			if (pending.questionMethod) {
				const question: GrokAcpQuestionSettlement = {
					...settlement,
					kind: 'question',
					method: pending.questionMethod,
					identity: {
						questionId: canonicalJson([
							this.options.account,
							this.options.host,
							this.options.processGeneration,
							pending.sessionId,
							settlement.turnId,
							pending.questionMethod,
							pending.id,
						]),
						requestId: pending.id,
						sessionId: pending.sessionId,
						turnId: settlement.turnId,
						processGeneration: this.options.processGeneration,
					},
				};
				// Observers must not rewrite one another's original request/turn identity.
				const event: GrokAcpQuestionEvent = {
					state: 'settled',
					settlement: structuredClone(question),
				};
				this.options.onSettlement(question);
				this.options.onQuestion?.(event);
			} else this.options.onSettlement({ ...settlement, decision });
		} catch {
			// Observer failures are reported without exposing request/authority payloads.
			this.fault('handler-failed');
		} finally {
			if (writeFailed || (!responseWritten && !this.closed)) this.fault('write');
		}
	}

	private fault(reason: 'write' | 'handler-failed' | 'malformed-frame'): void {
		this.faultReason ??= reason;
		if (this.draining || this.faultReported) return;
		this.close();
		if (this.faultReported) return;
		this.faultReported = true;
		this.options.onFault(new GrokAcpTransportError(this.faultReason));
	}
}
