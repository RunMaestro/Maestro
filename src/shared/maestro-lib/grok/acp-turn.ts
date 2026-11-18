import { canonicalJson } from '../../canonicalJson';
import { sha256Hex } from './host-seams';
import type { AgentErrorType, UsageStats } from '../../types';
import { generateUUID } from '../../uuid';
import { guardTurn } from '../control/turn-guard';
import { GrokOutputParser } from '../parsers/grok-output-parser';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import type { CompletedTurn, RunningTurn } from '../run/run-to-completion';
import {
	startTurn,
	type StartTurnOptions,
	type TurnHandle,
	type TurnExit,
	type TurnHandlers,
	type TurnProcessSpec,
} from '../run/start-turn';
import { TurnCapture } from '../run/turn-capture';
import { resolveTurnOutcome, type TurnTerminal } from '../streaming/turn-outcome';
import { parsedUsageToStats } from '../streaming/usage-totals';
import { GrokAcpEventAdapter } from './acp-events';
import { GROK_ACP_PROTOCOL_VERSION, GrokAcpTransportError } from './acp-protocol';
import {
	GrokAcpRequestAdapter,
	type GrokAcpPermissionTurn,
	type GrokAcpQuestionEvent,
	type GrokAcpQuestionSettlement,
	type GrokAcpRequestOptions,
} from './acp-requests';
import {
	GrokAcpSession,
	GrokAcpSessionError,
	type GrokAcpCommandCatalog,
	type GrokAcpModelState,
	type GrokAcpSessionOptions,
} from './acp-session';

export interface GrokAcpTurnOptions
	extends
		Pick<
			GrokAcpSessionOptions,
			| 'cwd'
			| 'account'
			| 'host'
			| 'model'
			| 'effort'
			| 'resumeSessionId'
			| 'idleTimeoutMs'
			| 'maxTurnMs'
			| 'cancelGraceMs'
			| 'requestTimeoutMs'
			| 'maxFrameBytes'
			| 'extensions'
		>,
		Pick<StartTurnOptions, 'stopGraceMs' | 'signal'> {
	/** Unique host dispatch and process identities, never substituted for native IDs. */
	turnId: string;
	processGeneration: string;
	/** Already assembled system/user text. This port does not accept attachments. */
	prompt: string;
	/** Explicit discovery qualification for this selected account/host and exact binary version. */
	modelDiscovery?: Pick<GrokAcpSessionOptions, 'account' | 'host'> & { agentVersion: string };
	permission?: Pick<GrokAcpPermissionTurn, 'authority' | 'binding'>;
	/**
	 * Pre-dispatch route check over what this process negotiated (`completeGrokAcpNegotiation`).
	 * A returned reason refuses the turn before any prompt is sent; so does a throw.
	 */
	qualify?: (negotiated: GrokAcpNegotiatedFacts) => string | undefined;
	/**
	 * Submit one ACP-advertised native command instead of a chat prompt. `prompt` must be the
	 * exact command text the intent names. The driver waits (bounded) for this process's
	 * catalog, then runs `validateGrokNativeCommand()` in the same tick as submission; any
	 * refusal settles `refused/admission`, `not-dispatched`, never an ordinary prompt.
	 */
	nativeCommand?: {
		intent: GrokAcpNativeCommandIntent;
		/** Host facts: the turn's tab and the current config generation. */
		tabId: string;
		configGeneration: string;
		/** Bound on waiting for the advertisement; defaults to 5 seconds. */
		catalogWaitMs?: number;
	};
}

/** What a started process proved during `initialize` and session allocation. */
export interface GrokAcpNegotiatedFacts {
	/** `initialize` rejects any other protocol version before this point. */
	protocolVersion: typeof GROK_ACP_PROTOCOL_VERSION;
	/** The peer's `_meta.agentVersion`; undefined when it reported none. */
	agentVersion: string | undefined;
	/** True only when a requested `session/load` succeeded on an advertised `loadSession`. */
	loadSession: boolean;
	sessionId: string;
}

/** Detached pre-dispatch facts; never a provider-wide capability or persistence record. */
export interface GrokAcpConfigurationObservation extends Pick<
	GrokAcpTurnOptions,
	'account' | 'host' | 'cwd' | 'processGeneration'
> {
	sessionId: string;
	observedAt: number;
	configuration: GrokAcpSession['configuration'];
	/** Undefined means unavailable; an empty availableModels array is authoritative. */
	models?: GrokAcpModelState;
}

/** Process-bound native advertisement. Hosts add their launch and config receipts. */
export interface GrokAcpCommandObservation extends GrokAcpCommandCatalog {
	readonly processGeneration: string;
}

/**
 * A person's request to run one ACP-advertised native command, carried from the catalog they
 * picked from to the next turn. It authorizes nothing by itself: ACP owns one process per
 * turn, so the newly admitted (resumed) process must advertise the same entry under the same
 * scope, checked by `validateGrokNativeCommand()` immediately before prompt submission.
 */
export interface GrokAcpNativeCommandIntent {
	/** Only an entry advertised over ACP; TUI and CLI-only actions have no such source. */
	source: 'acp-advertised';
	/** Exact advertised invocation name, without the leading slash. */
	name: string;
	/** Raw argument text; empty when none. Never reinterpreted or reflowed. */
	arguments: string;
	/** `grokNativeCommandEntryDigest()` of the entry the person picked. */
	entryDigest: string;
	binding: {
		target: 'local' | 'remote';
		account: string;
		host: string;
		cwd: string;
		tabId: string;
		/** The native session whose catalog was shown; the turn must resume it. */
		sessionId: string;
		/** Requested selection, as the catalog's `selection` reports it. */
		model?: string;
		effort?: string;
		agentVersion: string;
		/** Host-owned auth/endpoint/project revision the catalog was read under. */
		configGeneration: string;
		/** Informational: the earlier process and catalog the person saw. Never matched. */
		processGeneration?: string;
		catalogRevision?: number;
	};
}

/** Host facts about the turn about to run, never supplied by the intent's sender. */
export interface GrokAcpNativeCommandContext {
	tabId: string;
	configGeneration: string;
	processGeneration: string;
	/** The resumed native session this process was started on. */
	resumeSessionId?: string;
	cancelled: boolean;
}

export type GrokNativeCommandRefusal =
	| 'invalid-intent'
	| 'canceled'
	| 'remote-unqualified'
	| 'resume-required'
	| 'catalog-unavailable'
	| 'scope-mismatch'
	| 'session-mismatch'
	| 'selection-mismatch'
	| 'version-mismatch'
	| 'process-mismatch'
	| 'config-changed'
	| 'invalid-catalog'
	| 'absent'
	| 'changed'
	| 'arguments-unsupported'
	| 'invalid-arguments';

export type GrokNativeCommandValidation =
	| { ok: true; text: string; catalogRevision: number }
	| { ok: false; reason: GrokNativeCommandRefusal };

const NATIVE_COMMAND_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_NATIVE_COMMAND_ARGUMENTS = 8192;
// C0 controls and DEL would let arguments carry a second line past the command boundary.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function isNativeCommandName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		NATIVE_COMMAND_NAME.test(value) &&
		value.split(':').every((part) => part && !part.startsWith('.'))
	);
}

/**
 * Digest of one raw advertised entry (canonical JSON, so key order is irrelevant), or
 * undefined when it is not a well-formed entry. Any change of name, description, input hint
 * or native provenance (`_meta`) is a different command.
 */
export function grokNativeCommandEntryDigest(entry: unknown): string | undefined {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
	const { name, description, input, _meta: meta } = entry as Record<string, unknown>;
	if (
		!isNativeCommandName(name) ||
		typeof description !== 'string' ||
		(input != null &&
			(typeof input !== 'object' ||
				Array.isArray(input) ||
				typeof (input as Record<string, unknown>).hint !== 'string')) ||
		(meta != null && (typeof meta !== 'object' || Array.isArray(meta)))
	)
		return;
	try {
		return sha256Hex(canonicalJson(entry));
	} catch {
		return;
	}
}

/**
 * Bind a native command intent to the live catalog of the newly admitted process. Pure and
 * synchronous: call it with `GrokAcpRunningTurn.commands()` (or the driver's own read) in
 * the same tick as prompt submission. Success yields the exact prompt text to submit.
 */
export function validateGrokNativeCommand(
	intent: GrokAcpNativeCommandIntent,
	catalog: GrokAcpCommandObservation | undefined,
	context: GrokAcpNativeCommandContext
): GrokNativeCommandValidation {
	const refuse = (reason: GrokNativeCommandRefusal): GrokNativeCommandValidation => ({
		ok: false,
		reason,
	});
	const binding = intent?.binding;
	if (
		!intent ||
		intent.source !== 'acp-advertised' ||
		!isNativeCommandName(intent.name) ||
		typeof intent.arguments !== 'string' ||
		typeof intent.entryDigest !== 'string' ||
		!/^[0-9a-f]{64}$/.test(intent.entryDigest) ||
		!binding ||
		[
			binding.account,
			binding.host,
			binding.cwd,
			binding.tabId,
			binding.sessionId,
			binding.agentVersion,
			binding.configGeneration,
		].some((value) => typeof value !== 'string' || !value.trim()) ||
		[binding.model, binding.effort].some(
			(value) => value !== undefined && (typeof value !== 'string' || !value.trim())
		)
	)
		return refuse('invalid-intent');
	if (context.cancelled) return refuse('canceled');
	if (binding.target !== 'local') return refuse('remote-unqualified');
	if (context.resumeSessionId !== binding.sessionId) return refuse('resume-required');
	if (context.configGeneration !== binding.configGeneration) return refuse('config-changed');
	if (!catalog) return refuse('catalog-unavailable');
	if (catalog.processGeneration !== context.processGeneration) return refuse('process-mismatch');
	if (
		catalog.account !== binding.account ||
		catalog.host !== binding.host ||
		catalog.cwd !== binding.cwd ||
		context.tabId !== binding.tabId
	)
		return refuse('scope-mismatch');
	if (catalog.sessionId !== binding.sessionId) return refuse('session-mismatch');
	if (catalog.selection.model !== binding.model || catalog.selection.effort !== binding.effort)
		return refuse('selection-mismatch');
	if (catalog.agentVersion !== binding.agentVersion) return refuse('version-mismatch');
	if (!Array.isArray(catalog.commands) || catalog.commands.length > 256)
		return refuse('invalid-catalog');
	const matches = catalog.commands.filter(
		(entry) =>
			!!entry &&
			typeof entry === 'object' &&
			(entry as Record<string, unknown>).name === intent.name
	);
	if (matches.length === 0) return refuse('absent');
	if (matches.length > 1) return refuse('invalid-catalog');
	const digest = grokNativeCommandEntryDigest(matches[0]);
	if (!digest) return refuse('invalid-catalog');
	if (digest !== intent.entryDigest) return refuse('changed');
	const args = intent.arguments;
	if (args && (matches[0] as Record<string, unknown>).input == null)
		return refuse('arguments-unsupported');
	if (
		args.length > MAX_NATIVE_COMMAND_ARGUMENTS ||
		CONTROL_CHARACTER.test(args) ||
		args !== args.trim()
	)
		return refuse('invalid-arguments');
	return {
		ok: true,
		text: args ? `/${intent.name} ${args}` : `/${intent.name}`,
		catalogRevision: catalog.catalogRevision,
	};
}

/**
 * The question this turn owned and could not put to a person, when one ended it. A
 * question is never a permission: the driver answers it with the method's own cancel
 * outcome (no tool authorized, no policy changed), and this only decides what the tab
 * is told. The pinned peer advertises no ask-back capability, so the driver settles
 * every question at once (`unavailable`) and no answer path exists to wait on; a
 * pending event would need a negotiated contract and a surface, neither of which any
 * host has (desktop, browser, Lite or a headless caller), so it is not treated as a
 * question this turn can show and no answer path is ever waited on. A request for
 * another session or turn (stale, `turnId` null) belongs to no turn and is ignored.
 */
export function grokQuestionGapOf(
	event: GrokAcpQuestionEvent,
	turnId: string
): GrokAcpQuestionSettlement | undefined {
	if (event.state !== 'settled') return undefined;
	const { settlement } = event;
	return settlement.turnId === turnId && settlement.reason !== 'stale-request'
		? settlement
		: undefined;
}

/**
 * What a caller reads when Grok answered the prompt with its own JSON-RPC error. Fixed words
 * keyed by the classified type only; the provider's message is never interpolated.
 */
export function grokAcpProviderErrorMessage(type: AgentErrorType): string {
	const what =
		type === 'rate_limited'
			? 'a rate limit'
			: type === 'auth_expired'
				? 'that authentication is required or has failed'
				: `an error (${type})`;
	return `Grok reported ${what} in answer to the prompt. The prompt was delivered and is not resent automatically.`;
}

/**
 * What a caller reads when a Grok question ended the turn: a capability gap, not a
 * denial and not a stop. The desktop tab, every browser and Lite client mirroring it, and
 * a headless caller of `startGrokAcpTurn` (the completed turn's `error`) read these words.
 */
export function grokQuestionGapMessage(settlement: GrokAcpQuestionSettlement): string {
	const kind =
		settlement.method === '_x.ai/mcp/elicit' ? 'an MCP elicitation' : 'a question for you';
	const why =
		settlement.reason === 'unavailable'
			? 'this Grok ACP connection advertises no ask-back capability, so Maestro has no way to show it or send an answer'
			: `the request could not be handled (${settlement.reason})`;
	return (
		`Grok asked ${kind} (${settlement.method}) that this turn could not answer: ${why}. ` +
		'The question was cancelled and the turn ended; no tool was authorized and no permission or policy changed. ' +
		'Reply in the chat to give Grok the answer in a new turn.'
	);
}

export interface GrokAcpTurnHandlers extends Pick<TurnHandlers, 'onStarted' | 'onEvent'> {
	/** Observation only: mutation/failure cannot affect the turn or its retained snapshot. */
	onConfiguration?: (observation: GrokAcpConfigurationObservation) => void;
	onQuestion?: GrokAcpRequestOptions['onQuestion'];
	onRequestSettlement?: GrokAcpRequestOptions['onSettlement'];
}

export interface GrokAcpRunningTurn extends Omit<RunningTurn, 'completed'> {
	completed: Promise<
		CompletedTurn & { terminal: TurnTerminal; usageReports: readonly UsageStats[] }
	>;
	/** Cancel the prompt before escalating through the session's bounded grace period. */
	cancel(): void;
	configuration: () => GrokAcpConfigurationObservation | undefined;
	/** Live read only; snapshots never authorize a later process or headless fallback. */
	commands: () => GrokAcpCommandObservation | undefined;
	/** Withhold host receipts during reload; invalidate before/after, then await a fresh update. */
	invalidateCommands: () => void;
	questionSupport: GrokAcpRequestAdapter['questionSupport'];
	answerQuestion: GrokAcpRequestAdapter['answerQuestion'];
}

/** A process exit as read when the only stop it saw was this driver's own cleanup. */
function ownedCleanupExit(exit: TurnExit): TurnExit {
	return { ...exit, interrupted: false };
}

/**
 * One ACP process per turn, resumed by passing its confirmed native session ID next time.
 * The host supplies the final local ACP process spec from its launch plan (including account
 * and attribution). Route selection and policy qualification stay
 * with that host. No argv rewriting, fallback, replay, transcript or usage persistence here.
 * CompletedTurn is handed to the host's existing recorder exactly once, after pipe cleanup.
 * SSH script delivery and remote stop ownership require the later SSH route consumer.
 */
export function startGrokAcpTurn(
	spec: TurnProcessSpec,
	options: GrokAcpTurnOptions,
	handlers: GrokAcpTurnHandlers = {}
): GrokAcpRunningTurn {
	if (spec.stdin !== undefined || spec.promptArtifact || typeof options.prompt !== 'string')
		throw new GrokAcpSessionError('invalid-options');
	if (!options.turnId?.trim()) throw new GrokAcpSessionError('invalid-options');
	const nativeCommand = options.nativeCommand && structuredClone(options.nativeCommand);
	if (
		nativeCommand &&
		(typeof nativeCommand.intent?.arguments !== 'string' ||
			options.prompt !==
				(nativeCommand.intent.arguments
					? `/${nativeCommand.intent.name} ${nativeCommand.intent.arguments}`
					: `/${nativeCommand.intent.name}`))
	)
		throw new GrokAcpSessionError('invalid-options');
	if (options.signal?.aborted) throw new GrokAcpSessionError('cancelled');
	// Freeze caller-owned launch data before any host code runs.
	spec = { ...spec, args: [...spec.args], env: { ...spec.env } };
	options = {
		...options,
		permission: options.permission && {
			...options.permission,
			binding: options.permission.binding && {
				...options.permission.binding,
				actor: { ...options.permission.binding.actor },
			},
		},
		extensions: options.extensions && { ...options.extensions },
		modelDiscovery: options.modelDiscovery && { ...options.modelDiscovery },
	};
	const controller = new AbortController();
	let session: GrokAcpSession | undefined;
	let configuration: GrokAcpConfigurationObservation | undefined;
	let events: GrokAcpEventAdapter | undefined;
	let capture: TurnCapture | undefined;
	let endRequests: (() => void) | undefined;
	let promptStarted = false;
	let promptSettled = false;
	let settled = false;
	let internalStop = false;
	/**
	 * A stop someone outside this driver asked for: the caller (cancel, interrupt, terminate,
	 * abort) or the authority (revocation). The driver's own cleanup after a lost transport or
	 * a settled prompt runs the same stop ladder, but it is no stop request and never reads as one.
	 */
	let requestedStop = false;
	let signalling = false;
	let failure: Exclude<TurnTerminal, { status: 'success' }> | undefined;
	let requestFailure: Exclude<TurnTerminal, { status: 'success' }> | undefined;
	/** The first question this turn owned and settled unanswered (grokQuestionGapOf). */
	let questionGap: GrokAcpQuestionSettlement | undefined;
	const parser = new GrokOutputParser();
	const fault = (): void => {
		if (settled) return;
		if (!session?.error && !promptSettled)
			failure ??= { status: 'failed', kind: 'transport', reason: 'acp-transport-fault' };
		requests.close();
		session?.transportLost();
	};
	const requests = new GrokAcpRequestAdapter({
		account: options.account,
		host: options.host,
		cwd: options.cwd,
		processGeneration: options.processGeneration,
		timeoutMs: options.requestTimeoutMs,
		onFault: fault,
		onQuestion: (event) => {
			questionGap ??= grokQuestionGapOf(event, options.turnId);
			handlers.onQuestion?.(event);
		},
		onSettlement: (value) => {
			if (value.turnId === options.turnId && value.terminal && value.terminal.status !== 'success')
				requestFailure ??= { ...value.terminal };
			handlers.onRequestSettlement?.(value);
		},
	});
	const stopOwnedProcess = (): void => {
		// Lifecycle failures close pending authority before any OS signal. The session's
		// rejection carries the real cause; cleanup must not relabel it as a user stop.
		requests.close();
		// Aborting authority work may synchronously fail a write inside the outer stop.
		// That stop already owns escalation; do not reenter its signal ladder.
		if (signalling) return;
		internalStop = true;
		try {
			stops.terminate();
		} finally {
			internalStop = false;
		}
	};
	const emit = (event: ParsedEvent): void => {
		capture?.handleEvent(event);
		try {
			// Raw ACP bodies stay on the event; never reserialize them into diagnostic lines.
			handlers.onEvent?.(event, '');
		} catch {
			fault();
		}
	};
	const refuseBeforeDispatch = (reason: string): never => {
		failure ??= {
			status: 'refused',
			origin: 'admission',
			reason,
			dispatchState: 'not-dispatched',
		};
		throw new GrokAcpSessionError('cancelled');
	};
	const cancel = (): void => {
		if (settled || controller.signal.aborted) return;
		requestedStop = true;
		if (!session?.error && !promptSettled)
			failure ??= { status: 'cancelled', origin: 'user', reason: 'host-cancelled' };
		controller.abort();
		if (promptStarted) session?.cancel();
		else session?.close();
	};
	const handle: TurnHandle = startTurn(
		spec,
		{
			onStdoutBytes: (bytes) => session?.feedStdout(bytes),
			onStderrBytes: (bytes) => session?.feedStderr(bytes),
			onStdinError: fault,
			onStopRequested: () => {
				if (internalStop) return;
				requestedStop = true;
				if (settled) return;
				if (!session?.error && !promptSettled)
					failure ??= { status: 'cancelled', origin: 'host', reason: 'process-stopped' };
				signalling = true;
				try {
					controller.abort();
				} finally {
					signalling = false;
				}
			},
		},
		{
			stopGraceMs: options.stopGraceMs,
			keepStdinOpen: true,
			trackDescendants: true,
			// No output-only parser, frame buffer or secret-bearing diagnostic tail.
			stdoutTailLimit: 0,
			stderrTailLimit: 0,
		}
	);
	const stops = guardTurn(handle, { sessionId: options.turnId, graceMs: options.stopGraceMs });

	const completed = (async (): GrokAcpRunningTurn['completed'] => {
		let response: Record<string, unknown> | undefined;
		let promptError: unknown;
		try {
			session = new GrokAcpSession({
				...options,
				child: handle.child,
				requestHandlers: requests.requestHandlers,
				terminate: stopOwnedProcess,
				write: (bytes) => {
					if (!handle.child.stdin?.writable) throw new GrokAcpTransportError('write');
					handle.child.stdin.write(bytes, (error) => {
						if (error) fault();
					});
				},
				onNotification: (message, context) => {
					if (!settled && context.turn === 1 && !context.replay && events)
						for (const event of events.notification(message, {
							replay: false,
							turnId: options.turnId,
						}))
							emit(event);
				},
			});
			handle.child.stdout?.on('error', fault);
			handle.child.stderr?.on('error', fault);
			handle.child.stdout?.on('end', fault);
			options.signal?.addEventListener('abort', cancel, { once: true });
			if (options.signal?.aborted || controller.signal.aborted) cancel();
			handlers.onStarted?.(handle.pid);
			if (failure) throw new GrokAcpSessionError('cancelled');
			await session.open();
			if (failure || controller.signal.aborted) throw new GrokAcpSessionError('cancelled');
			const sessionId = session.sessionId!;
			if (options.qualify) {
				let refusal: string | undefined;
				try {
					refusal = options.qualify({
						protocolVersion: GROK_ACP_PROTOCOL_VERSION,
						agentVersion: session.configuration.agentVersion,
						loadSession: options.resumeSessionId !== undefined,
						sessionId,
					});
				} catch {
					refusal = 'route-qualification-failed';
				}
				if (refusal !== undefined) refuseBeforeDispatch(refusal);
			}
			// The advertisement can follow allocation; a missing one is refused below.
			if (nativeCommand)
				await session.awaitCommands(nativeCommand.catalogWaitMs ?? 5_000, controller.signal);
			if (failure || controller.signal.aborted) throw new GrokAcpSessionError('cancelled');
			const qualification = options.modelDiscovery;
			const models =
				qualification &&
				qualification.account === options.account &&
				qualification.host === options.host &&
				qualification.agentVersion === session.configuration.agentVersion &&
				qualification.agentVersion === options.extensions?.agentVersion &&
				options.extensions?.modelsList === true
					? await session.discoverModels(controller.signal)
					: undefined;
			// A distinct native ID is useful only when actually sent on a qualified route.
			const promptId = session.supportsPromptId ? generateUUID() : undefined;
			const scopeId = canonicalJson([options.account, options.host]);
			const identity = {
				sessionId,
				turnId: options.turnId,
				scopeId,
				processGeneration: options.processGeneration,
				promptId,
			};
			events = new GrokAcpEventAdapter(identity);
			// Allocation and the native-session claim precede this observation. The
			// first nonzero ledger is a baseline, never evidence of a zero starting bill.
			const initialUsage = await session.processUsage(controller.signal);
			const initialEvents = initialUsage === undefined ? [] : events.processUsage(initialUsage);
			const baseline = initialEvents[0]?.usage;
			capture = new TurnCapture('grok', parser, {
				classifyInBandErrors: false,
				usageIdentity: { ...identity, route: 'acp', providerSessionId: sessionId },
				processSessionBaseline:
					baseline?.accounting?.completeness === 'complete'
						? parsedUsageToStats(baseline)
						: undefined,
			});
			// Incomplete baseline observations remain separate, non-additive facts.
			for (const event of initialEvents) emit(event);
			if (failure || controller.signal.aborted) throw new GrokAcpSessionError('cancelled');
			configuration = structuredClone({
				account: options.account,
				host: options.host,
				cwd: options.cwd,
				processGeneration: options.processGeneration,
				sessionId,
				observedAt: Date.now(),
				configuration: session.configuration,
				models,
			});
			try {
				void Promise.resolve(handlers.onConfiguration?.(structuredClone(configuration))).catch(
					() => {}
				);
			} catch {
				// Optional observers cannot fail a successfully acknowledged configuration.
			}
			if (failure || controller.signal.aborted) throw new GrokAcpSessionError('cancelled');
			endRequests = requests.beginTurn({
				...options.permission,
				sessionId,
				turnId: options.turnId,
				promptId,
				signal: controller.signal,
			});
			emit({ type: 'init', sessionId });
			if (failure || controller.signal.aborted) throw new GrokAcpSessionError('cancelled');
			let promptText = options.prompt;
			if (nativeCommand) {
				// Same tick as submission: prompt() reaches its write through microtasks only,
				// so no frame (and no catalog update) can be processed in between.
				const catalog = session.commands;
				const checked = validateGrokNativeCommand(
					nativeCommand.intent,
					catalog && { ...catalog, processGeneration: options.processGeneration },
					{
						tabId: nativeCommand.tabId,
						configGeneration: nativeCommand.configGeneration,
						processGeneration: options.processGeneration,
						resumeSessionId: options.resumeSessionId,
						cancelled: controller.signal.aborted,
					}
				);
				if (!checked.ok) refuseBeforeDispatch(`native-command-${checked.reason}`);
				else promptText = checked.text;
			}
			promptStarted = true;
			try {
				response = await session.prompt(promptText, controller.signal, promptId);
			} catch (error) {
				promptError = error;
				if (error instanceof GrokAcpSessionError) response = error.response;
			}
			promptSettled = response !== undefined;
			endRequests();
			endRequests = undefined;
			// Request after the prompt response, never concurrently with the prompt.
			// The shared accumulator replaces this provisional total with final usage once.
			if (response && !controller.signal.aborted && !session.isClosed) {
				try {
					const usage = await session.processUsage(controller.signal);
					if (usage !== undefined) for (const event of events.processUsage(usage)) emit(event);
				} catch (error) {
					// Optional accounting cannot rewrite the received protocol outcome. Owned
					// cleanup still runs and partial usage remains; unexpected faults propagate.
					if (!(error instanceof GrokAcpSessionError)) throw error;
				}
			}
			if (promptError) throw promptError;
		} catch (caught) {
			const error = promptError ?? session?.error ?? caught;
			if (error instanceof GrokAcpSessionError) response = error.response ?? response;
			const reason = error instanceof GrokAcpSessionError ? error.reason : 'transport-lost';
			// Provider cancellation is a protocol outcome: preserve its metadata and any
			// preceding permission refusal/timeout instead of relabeling it as a host stop.
			if (reason !== 'cancelled' || !response || (controller.signal.aborted && !promptSettled))
				failure ??= {
					...(reason === 'idle-timeout'
						? ({ status: 'timeout', kind: 'idle' } as const)
						: reason === 'turn-timeout' || reason === 'cancel-timeout'
							? ({ status: 'timeout', kind: 'deadline' } as const)
							: reason === 'cancelled'
								? ({ status: 'cancelled', origin: 'host' } as const)
								: ({
										status: 'failed',
										kind:
											reason === 'process-lost'
												? 'process'
												: reason === 'transport-lost'
													? 'transport'
													: reason === 'provider-error'
														? 'provider'
														: 'protocol',
									} as const)),
					reason,
					// Grok answered the prompt with its own error: it was delivered, never uncertain.
					dispatchState:
						reason === 'provider-error'
							? 'dispatched'
							: session?.promptDispatched ||
								  (error instanceof GrokAcpSessionError && error.dispatchMayHaveOccurred)
								? 'unknown'
								: 'not-dispatched',
				};
		} finally {
			endRequests?.();
			if (failure && failure.dispatchState === undefined)
				failure.dispatchState = session?.promptDispatched ? 'unknown' : 'not-dispatched';
			if (events)
				for (const event of events.settle(response, failure ?? requestFailure)) emit(event);
			else
				emit({
					type: 'error',
					text: 'Grok ACP turn did not start.',
					sessionId: session?.sessionId,
					terminal: failure,
				});
			settled = true;
			options.signal?.removeEventListener('abort', cancel);
			requests.close();
			if (session) session.close();
			else stopOwnedProcess();
		}
		const processExit = await handle.done;
		// The driver's own shutdown of a process it no longer needs is no stop the caller or the
		// authority asked for, so the exit carries no interrupted reading or stopper for it.
		const exit = requestedStop ? processExit : ownedCleanupExit(processExit);
		handle.child.stdout?.off('error', fault);
		handle.child.stderr?.off('error', fault);
		handle.child.stdout?.off('end', fault);
		const terminal: TurnTerminal = failure
			? { ...events?.terminal, ...failure }
			: (events?.terminal ?? {
					status: 'incomplete',
					kind: 'missing-terminal',
					dispatchState: 'unknown',
				});
		// A peer that went away with no stop requested (killed, crashed, or closed its pipes
		// before answering the prompt) is a crash naming the lost transport, taken from the
		// session's first owned failure. Protocol, timeout, refusal and cancel terminals keep
		// their own readings.
		const lostReason = session?.error?.reason;
		const transportLost =
			!requestedStop &&
			terminal.status === 'failed' &&
			(lostReason === 'closed' || lostReason === 'transport-lost' || lostReason === 'process-lost')
				? lostReason
				: undefined;
		// Grok's own JSON-RPC answer to the prompt, classified at the client boundary. Only the
		// type survives; the provider's message is never carried. A dispatched prompt is never
		// replayed on this reading (retryClassification refuses a dispatched Grok terminal).
		const providerErrorType =
			!requestedStop && terminal.status === 'failed' && lostReason === 'provider-error'
				? (session?.error?.errorType ?? 'unknown')
				: undefined;
		const resolved = resolveTurnOutcome(
			{
				// Protocol settlement precedes our intentional process shutdown. Its real exit
				// remains available below; that cleanup signal is not a second turn outcome.
				exitCode: null,
				signal: null,
				interrupted: false,
				stderrText: '',
				stdoutText: '',
				explicitError: transportLost
					? {
							type: 'agent_crashed',
							message: `The Grok ACP connection was lost before the turn finished (${transportLost}). No stop was requested; any partial answer is kept for display only.`,
							recoverable: true,
							agentId: 'grok',
							...(session?.sessionId ? { sessionId: session.sessionId } : {}),
							timestamp: Date.now(),
						}
					: providerErrorType
						? {
								type: providerErrorType,
								message: grokAcpProviderErrorMessage(providerErrorType),
								recoverable: true,
								agentId: 'grok',
								...(session?.sessionId ? { sessionId: session.sessionId } : {}),
								timestamp: Date.now(),
							}
						: undefined,
				capturedAnswerText: capture?.answerText,
				resultMessageSeen: capture?.resultMessageSeen ?? false,
				terminal,
			},
			parser,
			{ providerId: 'grok', sessionId: options.turnId }
		);
		// A question this turn could not put to anyone settled it (the cancelled terminal is
		// the question's own, not a later stop or failure). That is no stop a caller asked
		// for, so it never reads as interrupted: a headless caller gets the same capability
		// gap the desktop tab shows, and nobody waits on an answer. Nothing was approved.
		const unanswered =
			questionGap && !failure && terminal.reason === questionGap.terminal?.reason
				? questionGap
				: undefined;
		return {
			outcome: unanswered ? 'crashed' : resolved.outcome,
			terminal: resolved.terminal ?? terminal,
			answerText: capture?.answerText,
			sessionId: session?.sessionId,
			usage: capture?.usage,
			usageReports: capture?.usageReports ?? [],
			error: unanswered
				? {
						type: 'unknown',
						message: grokQuestionGapMessage(unanswered),
						recoverable: false,
						agentId: 'grok',
						...(session?.sessionId ? { sessionId: session.sessionId } : {}),
						timestamp: Date.now(),
					}
				: resolved.error,
			exit,
		};
	})();
	return {
		handle: {
			...handle,
			...stops,
			terminateNow: handle.terminateNow,
			// Only a requested stop counts; the driver's own cleanup ladder is not one.
			stopRequested: () => requestedStop && handle.stopRequested(),
		},
		completed,
		cancel,
		answerSoFar: () => capture?.answerText,
		configuration: () => configuration && structuredClone(configuration),
		commands: () => {
			if (settled || controller.signal.aborted || failure) return;
			const catalog = session?.commands;
			return catalog && { ...catalog, processGeneration: options.processGeneration };
		},
		invalidateCommands: () => session?.invalidateCommands(),
		questionSupport: requests.questionSupport,
		answerQuestion: requests.answerQuestion.bind(requests),
	};
}
