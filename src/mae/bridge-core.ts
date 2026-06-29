// Shared, transport- and app-agnostic core of the Maestro bridge / session
// ingest host. Both the dev reference server (`reference-server.ts`) and the
// real Electron host (`src/main/mae/mae-bridge-host.ts`) wrap this with a
// transport + concrete handlers, so the contract logic - and the security
// model - lives in exactly one tested place.
//
// Security model implemented here (W1 + W5):
//   - per-run scoped bearer tokens, minted from a bootstrap secret, with TTL;
//   - a fixed live-verb allowlist; dispatch-equivalent verbs refused (403);
//   - ActionGuard-style rate + concurrency caps per token;
//   - token revocation by run (on session end / process exit).
// No general/ambient credential is ever exposed; a verb with no handler entry
// cannot be invoked.

import { randomUUID } from 'node:crypto';
import {
	BridgeErrorCode,
	type IssueResponse,
	LIVE_VERBS,
	type NotifyParams,
	type SessionEndParams,
	type SessionEventParams,
	type SessionRegisterParams,
	err,
	isDispatchVerb,
	ok,
	parseBridgeRequest,
	parseIssueRequest,
	parseNotify,
	parseSessionEnd,
	parseSessionEvent,
	parseSessionRegister,
} from './protocol';

export interface SessionListEntry {
	id: string;
	title: string;
	status: string;
	projectPath: string;
	// Engine + resume key let `mae resume` continue an omp-native session
	// surfaced by the desktop (vs. only mae's own local-map sessions). Optional:
	// non-omp sessions omit ompSessionId (import-as-context only).
	engine?: string;
	ompSessionId?: string;
}
export interface PlaybookEntry {
	id: string;
	name: string;
}
export interface CueEntry {
	name: string;
	lastFiredAt?: number;
}

// The concrete effects the host performs. Implemented in-memory by the
// reference server and against real Maestro services by the Electron host.
// Every method is async; handlers must never throw for control flow (a throw
// maps to a 500 internal error).
export interface BridgeHandlers {
	listSessions(): Promise<SessionListEntry[]>;
	listPlaybooks(): Promise<PlaybookEntry[]>;
	observeCues(): Promise<CueEntry[]>;
	toast(params: NotifyParams): Promise<void>;
	registerSession(params: SessionRegisterParams): Promise<void>;
	recordEvent(params: SessionEventParams): Promise<void>;
	endSession(params: SessionEndParams): Promise<void>;
}

export interface RateLimits {
	windowMs: number;
	maxPerWindow: number;
	maxConcurrent: number;
}

// Generous but bounded: ingest streams (session.event) are legitimately
// high-frequency, so caps exist to bound a compromised/looping client, not to
// throttle normal use.
export const DEFAULT_RATE_LIMITS: RateLimits = {
	windowMs: 10_000,
	maxPerWindow: 200,
	maxConcurrent: 8,
};

const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface AuditEntry {
	runId: string;
	verb: string;
	at: number;
}

export interface BridgeCoreOptions {
	secret: string;
	handlers: BridgeHandlers;
	now?: () => number;
	tokenTtlMs?: number;
	rate?: RateLimits;
	audit?: (entry: AuditEntry) => void;
}

export interface HttpResult {
	status: number;
	body: unknown;
}

export interface BridgeCore {
	// POST /v1/sessions/issue
	issue(raw: unknown): HttpResult;
	// POST /v1/bridge
	handle(authHeader: string | undefined, raw: unknown): Promise<HttpResult>;
	// Drop every token bound to a run (called on session end / process exit).
	revokeRun(runId: string): void;
	activeTokenCount(): number;
}

interface TokenState {
	runId: string;
	expiresAt: number;
	recent: number[];
	concurrent: number;
}

function bearer(authHeader: string | undefined): string | undefined {
	if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return undefined;
	const token = authHeader.slice('Bearer '.length).trim();
	return token === '' ? undefined : token;
}

export function createBridgeCore(options: BridgeCoreOptions): BridgeCore {
	const now = options.now ?? Date.now;
	const ttl = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
	const rate = options.rate ?? DEFAULT_RATE_LIMITS;
	const handlers = options.handlers;
	const tokens = new Map<string, TokenState>();

	function issue(raw: unknown): HttpResult {
		const request = parseIssueRequest(raw);
		if (!request || request.secret !== options.secret) {
			return { status: 401, body: err(BridgeErrorCode.Unauthorized, 'invalid bootstrap secret') };
		}
		const token = randomUUID();
		const expiresAt = now() + ttl;
		tokens.set(token, { runId: request.runId, expiresAt, recent: [], concurrent: 0 });
		const response: IssueResponse = { token, verbs: [...LIVE_VERBS], expiresAt };
		return { status: 200, body: response };
	}

	function authorize(authHeader: string | undefined): TokenState | undefined {
		const token = bearer(authHeader);
		if (!token) return undefined;
		const state = tokens.get(token);
		if (!state) return undefined;
		if (state.expiresAt < now()) {
			tokens.delete(token);
			return undefined;
		}
		return state;
	}

	function withinRate(state: TokenState): boolean {
		const cutoff = now() - rate.windowMs;
		state.recent = state.recent.filter((t) => t >= cutoff);
		if (state.recent.length >= rate.maxPerWindow) return false;
		if (state.concurrent >= rate.maxConcurrent) return false;
		return true;
	}

	// A scoped token may only touch its OWN run. The session.* verbs carry a
	// runId; reject any that does not match the token's bound run.
	function runMismatch(boundRunId: string, paramRunId: string): HttpResult | undefined {
		if (paramRunId !== boundRunId) {
			return {
				status: 403,
				body: err(BridgeErrorCode.Unauthorized, 'token is not bound to this run'),
			};
		}
		return undefined;
	}

	async function dispatch(
		request: { verb: string; params?: unknown },
		boundRunId: string
	): Promise<HttpResult> {
		switch (request.verb) {
			case 'sessions.list':
				return { status: 200, body: ok(await handlers.listSessions()) };
			case 'playbook.list':
				return { status: 200, body: ok(await handlers.listPlaybooks()) };
			case 'cue.observe':
				return { status: 200, body: ok(await handlers.observeCues()) };
			case 'notify.toast': {
				const params = parseNotify(request.params);
				if (!params) {
					return {
						status: 400,
						body: err(BridgeErrorCode.BadParams, 'notify requires title and message'),
					};
				}
				await handlers.toast(params);
				return { status: 200, body: ok({ delivered: true }) };
			}
			case 'session.register': {
				const params = parseSessionRegister(request.params);
				if (!params) {
					return { status: 400, body: err(BridgeErrorCode.BadParams, 'invalid session.register') };
				}
				const mismatch = runMismatch(boundRunId, params.runId);
				if (mismatch) return mismatch;
				await handlers.registerSession(params);
				return { status: 200, body: ok({ tracked: true }) };
			}
			case 'session.event': {
				const params = parseSessionEvent(request.params);
				if (!params) {
					return { status: 400, body: err(BridgeErrorCode.BadParams, 'invalid session.event') };
				}
				const mismatch = runMismatch(boundRunId, params.runId);
				if (mismatch) return mismatch;
				await handlers.recordEvent(params);
				return { status: 200, body: ok({ recorded: true }) };
			}
			case 'session.end': {
				const params = parseSessionEnd(request.params);
				if (!params) {
					return { status: 400, body: err(BridgeErrorCode.BadParams, 'invalid session.end') };
				}
				const mismatch = runMismatch(boundRunId, params.runId);
				if (mismatch) return mismatch;
				await handlers.endSession(params);
				revokeRun(params.runId);
				return { status: 200, body: ok({ ended: true }) };
			}
			default:
				return { status: 400, body: err(BridgeErrorCode.UnknownVerb, 'unknown verb') };
		}
	}

	async function handle(authHeader: string | undefined, raw: unknown): Promise<HttpResult> {
		const state = authorize(authHeader);
		if (!state) {
			return { status: 401, body: err(BridgeErrorCode.Unauthorized, 'missing or invalid token') };
		}
		const request = parseBridgeRequest(raw);
		if (!request) {
			return { status: 400, body: err(BridgeErrorCode.BadParams, 'invalid bridge request') };
		}
		if (isDispatchVerb(request.verb)) {
			return {
				status: 403,
				body: err(BridgeErrorCode.Phase4Required, `${request.verb} is gated until Phase 4`),
			};
		}
		if (!withinRate(state)) {
			return { status: 429, body: err(BridgeErrorCode.Internal, 'rate limit exceeded') };
		}
		// Audit before the effect runs (tripwire, not a gate).
		options.audit?.({ runId: state.runId, verb: request.verb, at: now() });
		state.recent.push(now());
		state.concurrent += 1;
		try {
			return await dispatch(request, state.runId);
		} catch (error) {
			return {
				status: 500,
				body: err(
					BridgeErrorCode.Internal,
					error instanceof Error ? error.message : 'handler failed'
				),
			};
		} finally {
			state.concurrent -= 1;
		}
	}

	function revokeRun(runId: string): void {
		for (const [token, state] of tokens) {
			if (state.runId === runId) tokens.delete(token);
		}
	}

	return {
		issue,
		handle,
		revokeRun,
		activeTokenCount: () => tokens.size,
	};
}
