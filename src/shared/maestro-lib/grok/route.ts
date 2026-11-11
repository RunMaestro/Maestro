import { createHash } from 'node:crypto';
import { canonicalJson } from '../../canonicalJson';
import type { LaunchPermissionMode } from '../launch/env';
import {
	applyWindowsShellRules,
	type LocalLaunchPlan,
	type TurnProcessSpec,
	type WindowsShellRulesOptions,
} from '../run/start-turn';
import { GROK_ACP_PROTOCOL_VERSION } from './acp-protocol';
import type { GrokAcpTurnOptions } from './acp-turn';

/**
 * The negotiated Grok route selector (`grok-route-contract/v1`): ACP over stdio when the
 * binary, account and host advertise it, native headless otherwise, and a refusal when neither fits.
 * A pure decision over what a turn requires and what the selected executable, account and
 * host actually advertised. Every desktop, runtime, CLI and Cue consumer asks this one
 * selector; none builds raw Grok ACP arguments or starts a second process of its own.
 */
export const GROK_ROUTE_CONTRACT = 'grok-route-contract/v1';

export type GrokRoute = 'acp-stdio' | 'native-headless';

/** The ACP subcommand. Agent options would precede `stdio`; none is qualified yet. */
export const GROK_ACP_ARGS: readonly string[] = Object.freeze(['agent', 'stdio']);

/**
 * What this checkout's ACP port implements, independent of any peer advertisement. An
 * advertised capability the port cannot carry is still missing: `startGrokAcpTurn` takes
 * no attachments and has no SSH owner. Native commands run only as a validated intent
 * (`startGrokAcpTurn` `nativeCommand`), revalidated against the new process's catalog.
 */
export const GROK_ACP_PORT_SUPPORT = Object.freeze({
	images: false,
	remote: false,
	nativeCommands: true,
	/** No in-progress input operation is pinned; see `grokSteeringAvailability`. */
	steering: false,
});

/**
 * Observed facts of the selected executable, account and host. Never credentials or raw
 * environment: `configGeneration` is an opaque endpoint/config fingerprint the host owns.
 */
export interface GrokRouteSnapshot {
	executable: { path: string; sha256?: string };
	/** Reported version of that exact executable; null when not observed. */
	agentVersion: string | null;
	/** `${platform}-${arch}` of the executing host. */
	platform: string;
	account: string;
	host: string;
	configGeneration: string;
	target: 'local' | 'remote';
	/** Version-scoped evidence that the native headless route applies to this executable. */
	native: { qualified: boolean };
	/** Negotiated `initialize` facts from an admitted discovery; absent when not negotiated. */
	acp?: {
		protocolVersion: number;
		agentVersion: string;
		loadSession: boolean;
		images: boolean;
		commands: boolean;
	};
}

export interface GrokRouteRequirements {
	/** An explicit route is honored or refused, never substituted. */
	requested?: GrokRoute;
	permissionMode: LaunchPermissionMode;
	/**
	 * Who answers a pre-effect permission request: a person through a live surface, a
	 * managed effect authority, or nobody (an unattended consumer that must never wait).
	 */
	consent: 'interactive' | 'authority' | 'none';
	/** Provider ask-back questions must reach a person. */
	questions?: boolean;
	nativeCommand?: boolean;
	imageCount?: number;
	resume?: boolean;
	/** User-supplied native argv. It has no meaning on the ACP route. */
	customArgs?: boolean;
}

export type GrokRouteGap =
	| 'native-unqualified'
	| 'permission-round-trip'
	| 'ask-back'
	| 'native-command'
	| 'consent-port'
	| 'question-port'
	| 'acp-unadvertised'
	| 'acp-protocol-version'
	| 'acp-version-unbound'
	| 'acp-remote-route'
	| 'acp-images'
	| 'acp-load-session'
	| 'acp-custom-args';

const GAP_ROWS: Record<GrokRouteGap, readonly string[]> = {
	'native-unqualified': ['P02', 'REG-MANAGED-ROUTES'],
	'permission-round-trip': ['P34', 'C-supportsStandardPermissionMode'],
	'ask-back': ['P34'],
	'native-command': ['P18', 'C-supportsSlashCommands'],
	'consent-port': ['P34', 'P33'],
	'question-port': ['P34'],
	'acp-unadvertised': ['P09', 'REG-MANAGED-ROUTES'],
	'acp-protocol-version': ['P09', 'P02'],
	'acp-version-unbound': ['P02', 'P09'],
	'acp-remote-route': ['P15', 'P39'],
	'acp-images': ['P08', 'C-supportsImageInput'],
	'acp-load-session': ['P14', 'C-supportsResume'],
	'acp-custom-args': ['P09'],
};

export type GrokRouteReason =
	| 'requested'
	| 'permission-round-trip'
	| 'ask-back'
	| 'native-command'
	| 'headless-default';

export interface GrokRouteDecision {
	ok: true;
	contract: typeof GROK_ROUTE_CONTRACT;
	route: GrokRoute;
	reason: GrokRouteReason;
	permissionMode: LaunchPermissionMode;
	/** Binds the decision to the observed snapshot; any change invalidates it. */
	snapshotKey: string;
	facts: Readonly<
		Pick<GrokRouteSnapshot, 'agentVersion' | 'account' | 'host' | 'target' | 'configGeneration'>
	>;
}

export interface GrokRouteRefusal {
	ok: false;
	reason: 'grok-route-refused';
	route: GrokRoute;
	missing: readonly GrokRouteGap[];
	parityRows: readonly string[];
	message: string;
}

export type GrokRouteResult = GrokRouteDecision | GrokRouteRefusal;

/** Canonical identity of everything a decision depends on. */
export function grokRouteSnapshotKey(snapshot: GrokRouteSnapshot): string {
	return canonicalJson({ contract: GROK_ROUTE_CONTRACT, snapshot });
}

/** False after any binary, version, account, host, config, target or advertisement change. */
export function isGrokRouteDecisionCurrent(
	decision: GrokRouteDecision,
	snapshot: GrokRouteSnapshot
): boolean {
	return decision.snapshotKey === grokRouteSnapshotKey(snapshot);
}

function gapsFor(
	route: GrokRoute,
	req: GrokRouteRequirements,
	snapshot: GrokRouteSnapshot
): GrokRouteGap[] {
	const gaps: GrokRouteGap[] = [];
	const roundTrip = req.permissionMode === 'standard';
	if (roundTrip && req.consent === 'none') gaps.push('consent-port');
	if (req.questions && req.consent !== 'interactive') gaps.push('question-port');
	if (route === 'native-headless') {
		// Native headless resolves permission prompts internally and has no reply channel.
		if (!snapshot.native.qualified) gaps.push('native-unqualified');
		if (roundTrip) gaps.push('permission-round-trip');
		if (req.questions) gaps.push('ask-back');
		if (req.nativeCommand) gaps.push('native-command');
		return gaps;
	}
	const acp = snapshot.acp;
	if (!acp) return [...gaps, 'acp-unadvertised'];
	if (acp.protocolVersion !== GROK_ACP_PROTOCOL_VERSION) gaps.push('acp-protocol-version');
	// An unknown binary is unqualified; a negotiation from another version proves nothing here.
	if (!snapshot.agentVersion || acp.agentVersion !== snapshot.agentVersion)
		gaps.push('acp-version-unbound');
	if (snapshot.target !== 'local' && !GROK_ACP_PORT_SUPPORT.remote) gaps.push('acp-remote-route');
	if ((req.imageCount ?? 0) > 0 && !(acp.images && GROK_ACP_PORT_SUPPORT.images))
		gaps.push('acp-images');
	if (req.resume && !acp.loadSession) gaps.push('acp-load-session');
	if (req.nativeCommand && !(acp.commands && GROK_ACP_PORT_SUPPORT.nativeCommands))
		gaps.push('native-command');
	if (req.customArgs) gaps.push('acp-custom-args');
	return gaps;
}

/**
 * Choose negotiated ACP when the turn needs a host round trip (standard-mode permission
 * requests, ask-back questions, native commands), otherwise the verified headless route.
 * No route is substituted for another: a missing requirement is a structured refusal, so a
 * turn needing approval can never run on output-only headless execution.
 */
export function selectGrokRoute(
	req: GrokRouteRequirements,
	snapshot: GrokRouteSnapshot
): GrokRouteResult {
	const reason: GrokRouteReason = req.requested
		? 'requested'
		: req.permissionMode === 'standard'
			? 'permission-round-trip'
			: req.questions
				? 'ask-back'
				: req.nativeCommand
					? 'native-command'
					: 'headless-default';
	const route: GrokRoute =
		req.requested ?? (reason === 'headless-default' ? 'native-headless' : 'acp-stdio');
	const missing = gapsFor(route, req, snapshot);
	if (missing.length) {
		const parityRows = [...new Set(missing.flatMap((gap) => GAP_ROWS[gap]))].sort();
		return {
			ok: false,
			reason: 'grok-route-refused',
			route,
			missing,
			parityRows,
			message: `Grok cannot run this turn on the ${route} route: ${missing.join(', ')}.`,
		};
	}
	return {
		ok: true,
		contract: GROK_ROUTE_CONTRACT,
		route,
		reason,
		permissionMode: req.permissionMode,
		snapshotKey: grokRouteSnapshotKey(snapshot),
		facts: Object.freeze({
			agentVersion: snapshot.agentVersion,
			account: snapshot.account,
			host: snapshot.host,
			target: snapshot.target,
			configGeneration: snapshot.configGeneration,
		}),
	};
}

/**
 * An ACP route that qualifies on everything except the peer's own advertisement, which
 * only its `initialize` can supply. The process may start to negotiate; no prompt may be
 * dispatched until `completeGrokAcpNegotiation` accepts the negotiated facts.
 */
export interface GrokAcpNegotiation {
	ok: true;
	contract: typeof GROK_ROUTE_CONTRACT;
	pending: 'acp-initialize';
	route: 'acp-stdio';
	permissionMode: LaunchPermissionMode;
	requirements: Readonly<GrokRouteRequirements>;
	/** The advertisement-free snapshot; any other change before completion makes it stale. */
	snapshot: Readonly<Omit<GrokRouteSnapshot, 'acp'>>;
	snapshotKey: string;
	facts: GrokRouteDecision['facts'];
}

function withoutAcp(snapshot: GrokRouteSnapshot): Omit<GrokRouteSnapshot, 'acp'> {
	const { acp: _acp, ...rest } = snapshot;
	return rest;
}

/**
 * Begin a negotiate-then-prompt ACP route for a consumer with no admitted discovery: the
 * selector's answer, unless its only gap is the missing advertisement, in which case a
 * pending negotiation. Every other gap (consent, remote, images, custom argv) still refuses.
 */
export function beginGrokAcpNegotiation(
	req: GrokRouteRequirements,
	snapshot: GrokRouteSnapshot
): GrokRouteResult | GrokAcpNegotiation {
	const result = selectGrokRoute(req, snapshot);
	if (result.ok || result.route !== 'acp-stdio' || snapshot.acp) return result;
	// Gaps no advertisement could close (consent, remote, port support, custom argv),
	// judged against the most permissive one; only the advertisement is left pending.
	const version = snapshot.agentVersion ?? 'pending-negotiation';
	const probe = selectGrokRoute(req, {
		...snapshot,
		agentVersion: version,
		acp: {
			protocolVersion: GROK_ACP_PROTOCOL_VERSION,
			agentVersion: version,
			loadSession: true,
			images: true,
			commands: true,
		},
	});
	if (!probe.ok) return probe;
	const base = structuredClone(withoutAcp(snapshot));
	return {
		ok: true,
		contract: GROK_ROUTE_CONTRACT,
		pending: 'acp-initialize',
		route: 'acp-stdio',
		permissionMode: req.permissionMode,
		requirements: Object.freeze({ ...req }),
		snapshot: Object.freeze(base),
		snapshotKey: grokRouteSnapshotKey(base),
		facts: Object.freeze({
			agentVersion: base.agentVersion,
			account: base.account,
			host: base.host,
			target: base.target,
			configGeneration: base.configGeneration,
		}),
	};
}

/**
 * The decision for a pending negotiation once the started process answered `initialize`.
 * The version the process reported binds the snapshot when none was observed beforehand;
 * a different previously observed version is unbound. The result is the selector's own.
 */
export function completeGrokAcpNegotiation(
	negotiation: GrokAcpNegotiation,
	acp: NonNullable<GrokRouteSnapshot['acp']>
): GrokRouteResult {
	return selectGrokRoute(negotiation.requirements, {
		...structuredClone(negotiation.snapshot),
		agentVersion: negotiation.snapshot.agentVersion ?? acp.agentVersion,
		acp: { ...acp },
	});
}

export class GrokRouteError extends Error {
	constructor(readonly code: 'not-acp' | 'stale' | 'plan-mismatch') {
		super(
			code === 'not-acp'
				? 'This Grok turn was not routed to ACP.'
				: code === 'stale'
					? 'The Grok route snapshot changed after selection.'
					: 'The launch plan does not match the selected Grok route.'
		);
		this.name = 'GrokRouteError';
	}
}

/**
 * The ACP process for an accepted local decision (or a pending negotiation, whose prompt
 * still waits on `completeGrokAcpNegotiation`), from the same final launch plan the
 * headless route would use: its executable, cwd and complete environment (selected account,
 * attribution, scoped homes) are kept, and only the argv changes. Model, effort, cwd and
 * resume travel over the protocol (`grokAcpRouteOptions`), the prompt over RPC; no prompt
 * artifact, stdin script or headless batch flag reaches the ACP process.
 */
export function grokAcpProcessSpec(
	decision: GrokRouteResult | GrokAcpNegotiation,
	plan: Pick<LocalLaunchPlan, 'command' | 'cwd' | 'env' | 'target' | 'permission'>,
	current: GrokRouteSnapshot,
	options: WindowsShellRulesOptions = {}
): TurnProcessSpec {
	if (!decision.ok || decision.route !== 'acp-stdio') throw new GrokRouteError('not-acp');
	const currentKey =
		'pending' in decision
			? grokRouteSnapshotKey(withoutAcp(current))
			: grokRouteSnapshotKey(current);
	if (decision.snapshotKey !== currentKey) throw new GrokRouteError('stale');
	if (
		plan.target.kind !== 'local' ||
		decision.facts.target !== 'local' ||
		plan.permission.requested !== decision.permissionMode
	)
		throw new GrokRouteError('plan-mismatch');
	return {
		...applyWindowsShellRules(
			{ command: plan.command, args: [...GROK_ACP_ARGS], cwd: plan.cwd, env: { ...plan.env } },
			options
		),
		transport: 'acp-stdio',
	};
}

/** The decision's account/host references and version binding for `startGrokAcpTurn`. */
export function grokAcpRouteOptions(
	decision: GrokRouteDecision
): Pick<GrokAcpTurnOptions, 'account' | 'host'> & { agentVersion: string | null } {
	if (decision.route !== 'acp-stdio') throw new GrokRouteError('not-acp');
	return {
		account: decision.facts.account,
		host: decision.facts.host,
		agentVersion: decision.facts.agentVersion,
	};
}

/**
 * Why a steer into a Grok turn cannot be delivered:
 * - `steering-not-owned` the turn is not the active owner of its process key (stopped,
 *   finished, superseded, or the key now holds another process);
 * - `native-steering` the native headless route has no input channel into a running turn;
 * - `acp-steering` the ACP route has no advertised in-progress input operation.
 */
export type GrokSteeringGap = 'steering-not-owned' | 'native-steering' | 'acp-steering';

/** What a steering host observed of the turn a steer names. */
export interface GrokSteeringFacts {
	/** The route the registered process runs on. */
	route: GrokRoute;
	/** True only for the active, current owner of the steered process key. */
	owned: boolean;
}

/**
 * The negotiated steering answer. Only a refusal is reachable today: the pinned ACP wire 1
 * (schema 0.11.4) and the Grok extensions this checkout pins advertise no operation that
 * adds input to a running turn (`session/prompt` starts a turn and the session refuses a
 * concurrent one; `session/cancel` ends one), and the port implements none
 * (`GROK_ACP_PORT_SUPPORT.steering`). Parity S21 therefore stays a required blocker.
 */
export interface GrokSteeringRefusal {
	ok: false;
	reason: 'grok-steering-refused';
	route: GrokRoute;
	missing: readonly GrokSteeringGap[];
	parityRows: readonly string[];
	/** The established steering-refusal detail (`this turn is not steerable - ...`). */
	detail: string;
}

const STEERING_GAP_DETAIL: Record<GrokSteeringGap, string> = {
	'steering-not-owned': 'this turn is not steerable - it is no longer the active Grok turn',
	'native-steering':
		'this turn is not steerable - the Grok headless route has no input channel into a running turn',
	'acp-steering':
		'this turn is not steerable - Grok advertises no in-progress input operation on this route',
};

/**
 * Decide whether a steer may reach a Grok turn. Never sends, queues, cancels or restarts
 * anything: a refused steer leaves the message with its caller. Grok input never travels
 * the maestro-p steering channel, which belongs to Claude TUI turns alone.
 */
export function grokSteeringAvailability(facts: GrokSteeringFacts): GrokSteeringRefusal {
	// An owned ACP turn is still refused: there is no advertised operation to negotiate, and
	// a port that grows one must grow its delivery here, with this answer, in the same change.
	const gap: GrokSteeringGap = !facts.owned
		? 'steering-not-owned'
		: facts.route === 'native-headless'
			? 'native-steering'
			: 'acp-steering';
	return {
		ok: false,
		reason: 'grok-steering-refused',
		route: facts.route,
		missing: [gap],
		parityRows: ['P10', 'S21'],
		detail: STEERING_GAP_DETAIL[gap],
	};
}

/** Silence budget of one ACP turn (reset by any output, including setup). */
export const GROK_ACP_TURN_IDLE_MS = 30 * 60_000;
/** Hard ceiling of one ACP prompt. */
export const GROK_ACP_TURN_MAX_MS = 12 * 60 * 60_000;

/** Native flags the launch builders generate; anything else is user argv. */
const GENERATED_VALUE_FLAGS = new Set([
	'--output-format',
	'--prompt-file',
	'-p',
	'--cwd',
	'--resume',
	'-m',
	'--reasoning-effort',
]);
const GENERATED_BOOLEAN_FLAGS = new Set(['--always-approve']);

/** The planned native argv read back into protocol options. */
export interface GrokNativeArgsReading {
	model?: string;
	effort?: string;
	/** `-p` value, when the prompt rode in argv rather than a prompt file. */
	prompt?: string;
	/** Any argv the launch builders do not generate. It has no meaning on ACP. */
	customArgs: boolean;
}

/**
 * Read the generated native argv of a final launch plan back into protocol options, so the
 * ACP route carries exactly the model and effort the planner resolved. Unknown argv is
 * custom, which the selector refuses (`acp-custom-args`) rather than drop.
 */
export function parseGrokNativeArgs(args: readonly string[]): GrokNativeArgsReading {
	const parsed: GrokNativeArgsReading = { customArgs: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (GENERATED_BOOLEAN_FLAGS.has(arg)) continue;
		if (!GENERATED_VALUE_FLAGS.has(arg) || i + 1 >= args.length) {
			parsed.customArgs = true;
			continue;
		}
		const value = args[++i];
		if (arg === '-m') parsed.model = value;
		else if (arg === '--reasoning-effort') parsed.effort = value;
		else if (arg === '-p') parsed.prompt = value;
	}
	return parsed;
}

/**
 * Text and image count of a planned prompt: the planner's ACP prompt artifact when there
 * is one (its text blocks concatenated, each image block counted), else the plain text.
 * An unreadable artifact or an unknown block is null; the caller refuses, never guesses.
 */
export function grokAcpPromptOf(
	planned: {
		prompt?: string;
		promptArtifact?: { content: string };
		images?: readonly unknown[];
	},
	argvPrompt?: string
): { text: string; imageCount: number } | null {
	const images = planned.images?.length ?? 0;
	const artifact = planned.promptArtifact;
	if (!artifact) {
		const text = planned.prompt ?? argvPrompt;
		return typeof text === 'string' ? { text, imageCount: images } : null;
	}
	let blocks: unknown;
	try {
		const value: unknown = JSON.parse(artifact.content);
		blocks =
			value && typeof value === 'object' && !Array.isArray(value)
				? (value as { type?: unknown; content?: unknown }).type === 'acp'
					? (value as { content?: unknown }).content
					: undefined
				: value;
	} catch {
		return null;
	}
	if (!Array.isArray(blocks)) return null;
	let text = '';
	let imageCount = images;
	for (const block of blocks as { type?: unknown; text?: unknown }[]) {
		if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
		else if (block?.type === 'image') imageCount += 1;
		else return null;
	}
	return { text, imageCount };
}

/**
 * Opaque fingerprint of everything an ACP launch depends on: the executable, cwd, the
 * effective launch environment without Maestro's own per-spawn facts (the `MAESTRO_`
 * namespace, which differs between two turns of one tab and configures nothing of the
 * provider), and the bound account/host scope. Never persisted or shown; it is the
 * `configGeneration` of a route snapshot, so any user, provider or inherited change moves it.
 */
export function grokAcpConfigGeneration(launch: {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	scope: unknown;
}): string {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(launch.env)) {
		if (value === undefined || key.toUpperCase().startsWith('MAESTRO_')) continue;
		env[key] = value;
	}
	return createHash('sha256')
		.update(canonicalJson({ command: launch.command, cwd: launch.cwd, env, scope: launch.scope }))
		.digest('hex');
}
