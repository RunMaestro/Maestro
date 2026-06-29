// Bridge protocol between the `mae` launcher / the maestro-bridge omp extension
// and the Maestro session-ingest endpoint (the desktop app in production; the
// reference server in dev/test). This module is the single source of truth for
// verbs, the env handshake, discovery, and wire shapes.
//
// Pure: types + guards only, no IO. External (HTTP) input is validated with
// hand-written guards here so the boundary stays dependency-free; the
// model->tool boundary is validated separately by omp via the zod schemas the
// extension declares.

export const PROTOCOL_VERSION = '1.0.0';

// Env handshake: the launcher sets these on the omp child; the extension reads them.
export const BRIDGE_ENV = {
	url: 'MAE_BRIDGE_URL',
	token: 'MAE_BRIDGE_TOKEN',
	runId: 'MAE_RUN_ID',
	maestroSessionId: 'MAE_MAESTRO_SESSION_ID',
	mapPath: 'MAE_MAP_PATH',
} as const;

// Discovery file the desktop app writes. `mae` reads it to obtain the ingest URL
// plus a bootstrap secret, then exchanges the secret for a per-run scoped token.
// `mae` is NEVER given a general desktop token.
export const DISCOVERY_FILENAME = 'mae-bridge.json';

export interface BridgeDiscovery {
	version: string;
	url: string;
	secret: string;
}

// --- Verbs ---------------------------------------------------------------
// Live verbs are wired in Phase 2: read/observe, session ingest, low-risk notify.
export const LIVE_VERBS = [
	'sessions.list',
	'playbook.list',
	'cue.observe',
	'notify.toast',
	'session.register',
	'session.event',
	'session.end',
] as const;

// Dispatch-equivalent verbs resolve to agent execution (RCE-grade by
// transitivity). INERT until Phase 4; refused at both client and server.
export const DISPATCH_VERBS = ['agent.dispatch', 'playbook.run', 'cue.emit'] as const;

export type LiveVerb = (typeof LIVE_VERBS)[number];
export type DispatchVerb = (typeof DISPATCH_VERBS)[number];
export type BridgeVerb = LiveVerb | DispatchVerb;

export const ALL_VERBS: readonly BridgeVerb[] = [...LIVE_VERBS, ...DISPATCH_VERBS];

function oneOf<T extends string>(set: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && (set as readonly string[]).includes(value);
}

export function isLiveVerb(value: unknown): value is LiveVerb {
	return oneOf(LIVE_VERBS, value);
}
export function isDispatchVerb(value: unknown): value is DispatchVerb {
	return oneOf(DISPATCH_VERBS, value);
}

export type VerbClass = 'live' | 'dispatch' | 'unknown';
export function classifyVerb(value: unknown): VerbClass {
	if (isLiveVerb(value)) return 'live';
	if (isDispatchVerb(value)) return 'dispatch';
	return 'unknown';
}

// --- Error codes ---------------------------------------------------------
export const BridgeErrorCode = {
	Unauthorized: 'unauthorized',
	UnknownVerb: 'unknown_verb',
	BadParams: 'bad_params',
	Phase4Required: 'phase4_required',
	AppUnavailable: 'app_unavailable',
	Internal: 'internal',
} as const;
export type BridgeErrorCode = (typeof BridgeErrorCode)[keyof typeof BridgeErrorCode];

// --- Wire shapes ---------------------------------------------------------
export interface BridgeRequest {
	verb: BridgeVerb;
	params?: unknown;
}
export interface BridgeOk<T = unknown> {
	ok: true;
	result: T;
}
export interface BridgeErr {
	ok: false;
	error: { code: BridgeErrorCode; message: string };
}
export type BridgeResponse<T = unknown> = BridgeOk<T> | BridgeErr;

export function ok<T>(result: T): BridgeOk<T> {
	return { ok: true, result };
}
export function err(code: BridgeErrorCode, message: string): BridgeErr {
	return { ok: false, error: { code, message } };
}

// Token issuance: bootstrap secret -> per-run scoped token (live verbs only).
export interface IssueRequest {
	secret: string;
	runId: string;
	cwd: string;
}
export interface IssueResponse {
	token: string;
	verbs: LiveVerb[];
	expiresAt: number;
}

// --- Session ingest payloads --------------------------------------------
export interface SessionRegisterParams {
	runId: string;
	// omp session resume key (the session file path; omp --resume accepts a path).
	ompSessionId: string;
	// Present when this run resumed an existing Maestro session.
	maestroSessionId?: string;
	cwd: string;
	title?: string;
	engine: 'omp';
	model?: string;
	startedAt: number;
}
export type SessionEventKind = 'turn_start' | 'turn_end' | 'message' | 'tool' | 'status';
export const SESSION_EVENT_KINDS: readonly SessionEventKind[] = [
	'turn_start',
	'turn_end',
	'message',
	'tool',
	'status',
];
export interface SessionEventParams {
	runId: string;
	ompSessionId: string;
	kind: SessionEventKind;
	at: number;
	data?: Record<string, unknown>;
}
export type SessionEndStatus = 'completed' | 'aborted' | 'error';
export const SESSION_END_STATUSES: readonly SessionEndStatus[] = ['completed', 'aborted', 'error'];
export interface SessionUsage {
	input?: number;
	output?: number;
	totalTokens?: number;
}
export interface SessionEndParams {
	runId: string;
	ompSessionId: string;
	at: number;
	status: SessionEndStatus;
	usage?: SessionUsage;
	cost?: number;
}

// --- Guards for external (HTTP) input -----------------------------------
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string {
	return typeof value === 'string';
}
function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

export function parseBridgeRequest(value: unknown): BridgeRequest | undefined {
	if (!isObject(value)) return undefined;
	const verb = value.verb;
	if (!isLiveVerb(verb) && !isDispatchVerb(verb)) return undefined;
	return { verb, params: value.params };
}

export function parseIssueRequest(value: unknown): IssueRequest | undefined {
	if (!isObject(value)) return undefined;
	if (!isString(value.secret) || !isString(value.runId) || !isString(value.cwd)) return undefined;
	return { secret: value.secret, runId: value.runId, cwd: value.cwd };
}

export function parseSessionRegister(value: unknown): SessionRegisterParams | undefined {
	if (!isObject(value)) return undefined;
	if (
		!isString(value.runId) ||
		!isString(value.ompSessionId) ||
		!isString(value.cwd) ||
		value.engine !== 'omp' ||
		!isFiniteNumber(value.startedAt)
	) {
		return undefined;
	}
	const out: SessionRegisterParams = {
		runId: value.runId,
		ompSessionId: value.ompSessionId,
		cwd: value.cwd,
		engine: 'omp',
		startedAt: value.startedAt,
	};
	if (isString(value.maestroSessionId)) out.maestroSessionId = value.maestroSessionId;
	if (isString(value.title)) out.title = value.title;
	if (isString(value.model)) out.model = value.model;
	return out;
}

export function parseSessionEvent(value: unknown): SessionEventParams | undefined {
	if (!isObject(value)) return undefined;
	if (!isString(value.runId) || !isString(value.ompSessionId) || !isFiniteNumber(value.at)) {
		return undefined;
	}
	if (!oneOf(SESSION_EVENT_KINDS, value.kind)) return undefined;
	const out: SessionEventParams = {
		runId: value.runId,
		ompSessionId: value.ompSessionId,
		kind: value.kind,
		at: value.at,
	};
	if (isObject(value.data)) out.data = value.data;
	return out;
}

export function parseSessionEnd(value: unknown): SessionEndParams | undefined {
	if (!isObject(value)) return undefined;
	if (!isString(value.runId) || !isString(value.ompSessionId) || !isFiniteNumber(value.at)) {
		return undefined;
	}
	if (!oneOf(SESSION_END_STATUSES, value.status)) return undefined;
	const out: SessionEndParams = {
		runId: value.runId,
		ompSessionId: value.ompSessionId,
		at: value.at,
		status: value.status,
	};
	if (isObject(value.usage)) {
		const usage: SessionUsage = {};
		if (isFiniteNumber(value.usage.input)) usage.input = value.usage.input;
		if (isFiniteNumber(value.usage.output)) usage.output = value.usage.output;
		if (isFiniteNumber(value.usage.totalTokens)) usage.totalTokens = value.usage.totalTokens;
		out.usage = usage;
	}
	if (isFiniteNumber(value.cost)) out.cost = value.cost;
	return out;
}

export interface NotifyParams {
	title: string;
	message: string;
}
export function parseNotify(value: unknown): NotifyParams | undefined {
	if (!isObject(value)) return undefined;
	if (!isString(value.title) || !isString(value.message)) return undefined;
	return { title: value.title, message: value.message };
}

export function parseResponse(value: unknown): BridgeResponse<unknown> {
	if (isObject(value) && value.ok === true && 'result' in value) {
		return { ok: true, result: value.result };
	}
	if (isObject(value) && value.ok === false && isObject(value.error)) {
		const rawCode = value.error.code;
		const code = oneOf(Object.values(BridgeErrorCode), rawCode)
			? rawCode
			: BridgeErrorCode.Internal;
		const message = isString(value.error.message) ? value.error.message : 'bridge error';
		return { ok: false, error: { code, message } };
	}
	return err(BridgeErrorCode.Internal, 'malformed bridge response');
}

export function parseDiscovery(value: unknown): BridgeDiscovery | undefined {
	if (!isObject(value)) return undefined;
	if (!isString(value.url) || !isString(value.secret)) return undefined;
	return {
		version: isString(value.version) ? value.version : '0',
		url: value.url,
		secret: value.secret,
	};
}
