// src/main/process-manager/spawners/GrokAcpSpawner.ts

/**
 * Runs a desktop Grok turn that needs a host round trip (a standard-mode permission
 * request) on the shared ACP driver (`startGrokAcpTurn`), never on the output-only
 * headless CLI, which answers every native permission prompt by itself.
 *
 * The route is the negotiated selector's (`grok/route.ts`): before anything starts,
 * `beginGrokAcpNegotiation` must qualify every requirement except the peer's own
 * advertisement (consent port, local target, no images, no custom argv, a known
 * account and host); the process then negotiates `initialize` and allocates its session,
 * and the driver's `qualify` gate runs `completeGrokAcpNegotiation` over what it proved
 * BEFORE any prompt is dispatched. A gap at either step is a structured refusal reported
 * to the tab. There is no fallback in either direction.
 *
 * Like the Codex app-server spawner it registers a `ManagedProcess` with an
 * `sdkController` (so ProcessManager.write() never types into the JSON-RPC stream) and
 * reuses `StdoutHandler` / `ExitHandler`: the driver's normalized events go through
 * `StdoutHandler.handleNormalizedEvent`, so streamed answer, thoughts, tools, late
 * native session IDs and usage reach the renderer by the path a parsed line takes.
 *
 * Permission requests are asked of the person: the permission relay's consent session
 * surfaces each request on the existing permission prompt for the turn's own agent and tab, and only an explicit Allow answers the
 * request's `allow_once` option. Deny, timeout, Stop, the process exiting and a lost
 * connection all deny; nothing is auto-approved. With no tab or no prompt surface there
 * is no consent port, and the selector refuses the turn (`consent-port`).
 *
 * A spawn carrying a native command (`grokNativeCommand`) always comes here. Everything
 * this host already knows is checked before any process (provider, standard plan, exact
 * prompt text, tab, cwd, account, host, model/effort, resumed session, current config
 * generation); the selector then requires native command support, and the
 * driver revalidates the intent against the new process's own catalog immediately before
 * submission. Any refusal is final: never an ordinary prompt, never the headless CLI.
 *
 * It is also the one owner of a live Grok ACP advertisement on this host: the discovery
 * handoff (`ProcessManager.grokCommandObservation`, read by `agents:discoverSlashCommands`)
 * is answered from `GrokAcpRunningTurn.commands()` of a current turn that this spawner
 * started for the exact selection, never from a probe, a cache or the disk.
 */

import type { EventEmitter } from 'events';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { createOutputParser } from '../../parsers';
import {
	runsOnGrokAcpRoute,
	type AgentError,
	type ManagedProcess,
	type ProcessConfig,
	type SpawnResult,
} from '../types';
import type { SteeringResultFrame } from '../../../shared/chatSteering';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import {
	buildAgentEnvironment,
	buildChildProcessEnv,
	collectMaestroEnvVars,
} from '../utils/envBuilder';
import type {
	GrokCommandObservation,
	GrokCommandObservationReader,
} from '../../agents/grok-skills';
import { isSupersededGeneration, nextSpawnGeneration } from '../generation';
import { DEFAULT_QUERY_SOURCE } from '../../../shared/querySource';
import { INTERACTIVE_STOP_GRACE_MS } from '../../../shared/maestro-lib/control/termination';
import type {
	GrokEffectActor,
	GrokEffectAuthority,
} from '../../../shared/maestro-lib/grok/host-seams';
import {
	permissionRelayServer,
	type RelayConsentSession,
} from '../../permission-relay/PermissionRelayServer';
import { RELAY_DECISION_TIMEOUT_MS, type RelaySpawnBinding } from '../../permission-relay/types';
import {
	beginGrokAcpNegotiation,
	completeGrokAcpNegotiation,
	grokAcpConfigGeneration,
	grokAcpProcessSpec,
	grokAcpPromptOf,
	grokSteeringAvailability,
	parseGrokNativeArgs,
	GROK_ACP_TURN_IDLE_MS,
	GROK_ACP_TURN_MAX_MS,
	type GrokAcpNegotiation,
	type GrokRouteRefusal,
	type GrokRouteSnapshot,
} from '../../../shared/maestro-lib/grok/route';
import {
	grokQuestionGapMessage,
	grokQuestionGapOf,
	startGrokAcpTurn,
	validateGrokNativeCommand,
	type GrokAcpNativeCommandIntent,
	type GrokAcpRunningTurn,
	type GrokNativeCommandRefusal,
} from '../../../shared/maestro-lib/grok/acp-turn';
import type { GrokAcpQuestionSettlement } from '../../../shared/maestro-lib/grok/acp-requests';

const LOG_CONTEXT = 'GrokAcpSpawner';

/** Silence budget of a desktop ACP turn (reset by any output, including setup). */
export const GROK_ACP_DESKTOP_IDLE_MS = GROK_ACP_TURN_IDLE_MS;
/** Hard ceiling of one desktop ACP prompt. */
export const GROK_ACP_DESKTOP_MAX_TURN_MS = GROK_ACP_TURN_MAX_MS;

/** Where a turn's consent sessions come from (the permission relay). */
export interface GrokConsentPort {
	openConsentSession(binding: RelaySpawnBinding): RelayConsentSession | null;
}

/** The person at this desktop, the actor of a consent binding. */
const DESKTOP_PERSON: GrokEffectActor = Object.freeze({ kind: 'human', id: 'desktop-user' });

/** What the permission prompt shows of one ACP permission request: its tool and input. */
export function describeGrokPermission(request: unknown): {
	toolName: string;
	input: Record<string, unknown>;
} {
	const tool =
		request && typeof request === 'object'
			? (request as { toolCall?: unknown }).toolCall
			: undefined;
	const call = tool && typeof tool === 'object' ? (tool as Record<string, unknown>) : {};
	const name = [call.title, call.kind].find((v) => typeof v === 'string' && v.trim());
	const raw = call.rawInput;
	return {
		toolName: typeof name === 'string' ? name : 'Grok tool',
		input:
			raw && typeof raw === 'object' && !Array.isArray(raw)
				? { ...(raw as Record<string, unknown>) }
				: { toolCallId: call.toolCallId },
	};
}

/**
 * The effect authority of a desktop turn: each permission request is asked of the
 * person through the consent session. Only `allow` from the person grants (the driver
 * then selects the request's `allow_once` option); an Allow that edits the input is not
 * the request the person was shown and denies, and so does every other effect kind.
 */
export function grokConsentAuthority(session: RelayConsentSession): GrokEffectAuthority {
	return {
		authorityId: 'desktop-person-consent',
		decide: async (effect, _binding, signal) => {
			if (effect.kind !== 'permissions')
				return { decision: 'deny', reason: 'Only permission requests are asked of the person.' };
			const { toolName, input } = describeGrokPermission(effect.permissions.request);
			const answer = await session.request(toolName, input, signal);
			if (answer.behavior !== 'allow') return { decision: 'deny', reason: answer.message };
			if (answer.updatedInput !== undefined)
				return { decision: 'deny', reason: 'An edited tool input cannot be approved for Grok.' };
			return { decision: 'allow' };
		},
	};
}

/**
 * A desktop Grok turn whose launch plan asked for the provider's own prompting, or any
 * spawn carrying a native command: only this spawner submits one, and it refuses every
 * native command it cannot carry, so none can reach another spawner as an ordinary prompt.
 * The rule itself is `runsOnGrokAcpRoute` in the process types.
 */
export function wantsGrokAcp(config: ProcessConfig): boolean {
	return runsOnGrokAcpRoute(config);
}

/** Pre-process refusals of a forwarded native command (the driver adds the live catalog). */
export type GrokNativeCommandSpawnProblem =
	| GrokNativeCommandRefusal
	| 'not-grok'
	| 'route-unavailable'
	| 'prompt-mismatch';

/**
 * Everything a forwarded native command can be refused on before any process starts: the
 * provider and plan (only a standard-mode turn runs on ACP), the exact prompt text, and
 * `validateGrokNativeCommand()` without a catalog against this host's own facts (tab,
 * current config generation, resumed session), plus the bound account, host,
 * cwd and requested model/effort the new process will be started with. Undefined when
 * only the new process's advertisement is left to check.
 */
export function grokNativeCommandSpawnProblem(
	config: ProcessConfig,
	intent: GrokAcpNativeCommandIntent,
	facts: {
		promptText: string;
		configGeneration: string;
		account: string;
		host: string;
		model?: string;
		effort?: string;
	}
): GrokNativeCommandSpawnProblem | undefined {
	if (config.toolType !== 'grok') return 'not-grok';
	if (config.permission?.requested !== 'standard') return 'route-unavailable';
	const checked = validateGrokNativeCommand(intent, undefined, {
		tabId: config.tabId ?? '',
		configGeneration: facts.configGeneration,
		processGeneration: '',
		resumeSessionId: config.agentSessionId,
		cancelled: false,
	});
	if (checked.ok) return 'invalid-intent';
	if (checked.reason !== 'catalog-unavailable') return checked.reason;
	const { binding } = intent;
	if (
		!config.tabId ||
		config.tabId !== binding.tabId ||
		config.cwd !== binding.cwd ||
		facts.account !== binding.account ||
		facts.host !== binding.host
	)
		return 'scope-mismatch';
	if (facts.model !== binding.model || facts.effort !== binding.effort) return 'selection-mismatch';
	const text = intent.arguments ? `/${intent.name} ${intent.arguments}` : `/${intent.name}`;
	if (facts.promptText !== text) return 'prompt-mismatch';
	return undefined;
}

function grokAcpDesktopEnv(config: ProcessConfig): NodeJS.ProcessEnv {
	return buildChildProcessEnv(
		config.customEnvVars,
		!!config.agentSessionId,
		config.shellEnvVars,
		config.extraPathDirs,
		config.querySource
	);
}

/**
 * Opaque fingerprint of everything a desktop ACP launch depends on (executable, cwd, the
 * effective launch environment, bound account/host scope; `grokAcpConfigGeneration`);
 * never persisted or shown. A native
 * command intent must carry the generation of the launch it will run under, so a catalog
 * projection stamps this same value, and any change refuses `config-changed`. Hashing the
 * projection (not the raw environment) is what lets a catalog read on one turn bind the
 * resumed turn after it, while any user, provider or inherited change still moves it.
 */
export function grokAcpDesktopConfigGeneration(
	config: ProcessConfig,
	env: NodeJS.ProcessEnv = grokAcpDesktopEnv(config)
): string {
	return grokAcpConfigGeneration({
		command: config.command,
		cwd: config.cwd,
		env,
		scope: config.nativeSessionScope,
	});
}

/** What `agents:discoverSlashCommands` asks the route owner for. */
export type GrokCommandObservationSelection = Parameters<GrokCommandObservationReader>[0];

interface SpawnerContext {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	stdoutHandler: StdoutHandler;
	exitHandler: ExitHandler;
	consent: GrokConsentPort;
	/** Turns started and not yet finished, stopped or superseded: the advertisement owners. */
	liveTurns: Set<GrokAcpDesktopTurn>;
}

export class GrokAcpSpawner {
	private readonly ctx: SpawnerContext;

	constructor(
		processes: Map<string, ManagedProcess>,
		emitter: EventEmitter,
		bufferManager: DataBufferManager,
		options: {
			/** Defaults to the permission relay, the one consent path of the desktop. */
			consent?: GrokConsentPort;
		} = {}
	) {
		this.ctx = {
			processes,
			emitter,
			stdoutHandler: new StdoutHandler({ processes, emitter, bufferManager }),
			exitHandler: new ExitHandler({ processes, emitter, bufferManager }),
			consent: options.consent ?? permissionRelayServer,
			liveTurns: new Set(),
		};
	}

	/**
	 * The live native advertisement for one discovery selection, or undefined. Read only: no
	 * process, RPC, probe, cache or disk read. The answer comes from `commands()` of the one
	 * current turn whose own launch matches the selection (see
	 * `GrokAcpDesktopTurn.observeCommands`); two live owners of one native session prove
	 * nothing and answer undefined. Exit, Stop, a newer spawn on the process key, a native
	 * catalog reload and any selection or configuration change all read undefined.
	 */
	observeCommands(selection: GrokCommandObservationSelection): GrokCommandObservation | undefined {
		let observed: GrokCommandObservation | undefined;
		for (const turn of this.ctx.liveTurns) {
			const receipt = turn.observeCommands(selection);
			if (!receipt) continue;
			if (observed) return undefined;
			observed = receipt;
		}
		return observed;
	}

	/**
	 * Answer a steer into a registered Grok process (parity S21). The route and
	 * ownership come from this host's own record: the ACP turn whose process record IS the
	 * registered one, active and current, or else the native headless route. Every answer is
	 * the established structured refusal (`grokSteeringAvailability`); nothing is written to
	 * the peer, no maestro-p channel is dialed, and no turn is queued, cancelled or restarted.
	 */
	steer(process: ManagedProcess, id: string): SteeringResultFrame {
		let owner: GrokAcpDesktopTurn | undefined;
		for (const turn of this.ctx.liveTurns) if (turn.runs(process)) owner = turn;
		const refusal = grokSteeringAvailability(
			owner
				? { route: 'acp-stdio', owned: owner.ownsSteering() }
				: { route: 'native-headless', owned: true }
		);
		return {
			type: 'steering',
			id,
			verdict: 'refused',
			refusal: 'not-running',
			detail: refusal.detail,
		};
	}

	spawn(config: ProcessConfig): SpawnResult {
		const nativeCommand = config.grokNativeCommand;
		if (nativeCommand !== undefined && config.toolType !== 'grok')
			return this.refuseNativeCommand(config, 'not-grok');
		const native = parseGrokNativeArgs(config.sshRemoteId ? [] : config.args);
		const prompt = grokAcpPromptOf(config, native.prompt);
		if (!prompt) return this.refuse(config, 'The planned Grok prompt could not be read.');
		const scope = config.nativeSessionScope;
		if (scope?.state !== 'bound')
			return this.refuse(
				config,
				'Grok account and host ownership is unknown, so the ACP route cannot bind this turn.'
			);
		const isResuming = !!config.agentSessionId;
		const env = grokAcpDesktopEnv(config);
		const snapshot: GrokRouteSnapshot = {
			executable: { path: config.command },
			agentVersion: null,
			platform: `${process.platform}-${process.arch}`,
			account: scope.accountRef,
			host: scope.host.identity,
			configGeneration: grokAcpDesktopConfigGeneration(config, env),
			target: config.sshRemoteId || scope.host.kind !== 'local' ? 'remote' : 'local',
			native: { qualified: false },
		};
		if (nativeCommand !== undefined) {
			const problem = grokNativeCommandSpawnProblem(config, nativeCommand, {
				promptText: prompt.text,
				configGeneration: snapshot.configGeneration,
				account: snapshot.account,
				host: snapshot.host,
				model: native.model,
				effort: native.effort,
			});
			if (problem) return this.refuseNativeCommand(config, problem);
		}
		// The turn asks the person on its own tab; without a tab or a prompt surface
		// there is nobody to ask, and the selector refuses (consent-port).
		const consentSession = config.tabId
			? this.ctx.consent.openConsentSession({ sessionId: config.sessionId, tabId: config.tabId })
			: null;
		const negotiation = beginGrokAcpNegotiation(
			{
				permissionMode: 'standard',
				consent: consentSession ? 'interactive' : 'none',
				imageCount: prompt.imageCount,
				resume: isResuming,
				customArgs: native.customArgs,
				nativeCommand: nativeCommand !== undefined,
			},
			snapshot
		);
		if (!negotiation.ok || !('pending' in negotiation)) {
			consentSession?.close();
			return negotiation.ok
				? this.refuse(config, 'The Grok route selector returned no ACP negotiation.')
				: this.refuse(config, negotiation.message, negotiation);
		}
		try {
			return new GrokAcpDesktopTurn(this.ctx, config, {
				negotiation,
				snapshot,
				env,
				prompt: prompt.text,
				model: native.model,
				effort: native.effort,
				consentSession,
				nativeCommand,
			}).start();
		} catch (error) {
			consentSession?.close();
			void captureException(error);
			return this.refuse(
				config,
				`Grok ACP turn could not start: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	private refuseNativeCommand(
		config: ProcessConfig,
		problem: GrokNativeCommandSpawnProblem
	): SpawnResult {
		return this.refuse(config, `Native Grok command refused (native-command-${problem}).`);
	}

	/** Nothing was started: the tab is told why, and the result says so. */
	private refuse(config: ProcessConfig, message: string, refusal?: GrokRouteRefusal): SpawnResult {
		logger.warn('[GrokAcpSpawner] Grok ACP turn refused', LOG_CONTEXT, {
			sessionId: config.sessionId,
			missing: refusal?.missing,
			parityRows: refusal?.parityRows,
		});
		const text = message.endsWith('Nothing was started.')
			? message
			: `${message} Nothing was started.`;
		this.ctx.emitter.emit('agent-error', config.sessionId, {
			type: 'permission_denied',
			message: text,
			recoverable: false,
			agentId: config.toolType,
			sessionId: config.sessionId,
			timestamp: Date.now(),
		} satisfies AgentError);
		return { pid: -1, success: false, error: text };
	}
}

interface DesktopTurnInput {
	negotiation: GrokAcpNegotiation;
	snapshot: GrokRouteSnapshot;
	env: NodeJS.ProcessEnv;
	prompt: string;
	model?: string;
	effort?: string;
	/** The person's consent session of this turn; closed when the turn ends. */
	consentSession: RelayConsentSession | null;
	/** A forwarded native command, revalidated by the driver against this process. */
	nativeCommand?: GrokAcpNativeCommandIntent;
}

/** One ACP process and the turn it runs. */
class GrokAcpDesktopTurn {
	private readonly managedProcess: ManagedProcess;
	private running!: GrokAcpRunningTurn;
	private routeRefusal: string | undefined;
	/** The first question this turn owned and could not put to a person (grokQuestionGapOf). */
	private questionGap: GrokAcpQuestionSettlement | undefined;
	private stopped = false;
	private finished = false;

	constructor(
		private readonly ctx: SpawnerContext,
		private readonly config: ProcessConfig,
		private readonly input: DesktopTurnInput
	) {
		this.managedProcess = {
			sessionId: config.sessionId,
			toolType: config.toolType,
			cwd: config.cwd,
			pid: -1,
			isTerminal: false,
			isBatchMode: true,
			isStreamJsonMode: true,
			jsonBuffer: '',
			startTime: Date.now(),
			outputParser: createOutputParser(config.toolType) || undefined,
			stderrBuffer: '',
			stdoutBuffer: '',
			contextWindow: config.contextWindow,
			command: config.command,
			args: [],
			querySource: config.querySource,
			tabId: config.tabId,
			projectPath: config.projectPath,
			agentSessionId: config.agentSessionId,
			sdkController: {
				interrupt: () => this.cancel(),
				kill: (options) => this.kill(options),
			},
		};
	}

	start(): SpawnResult {
		const { config, input, managedProcess } = this;
		managedProcess.maestroEnvVars = collectMaestroEnvVars(
			config.shellEnvVars,
			config.customEnvVars,
			!!config.agentSessionId,
			config.querySource ?? DEFAULT_QUERY_SOURCE
		);
		const spec = grokAcpProcessSpec(
			input.negotiation,
			{
				command: config.command,
				cwd: config.cwd,
				env: input.env,
				target: { kind: 'local' },
				permission: config.permission!,
			},
			input.snapshot
		);
		const generation = nextSpawnGeneration(config.sessionId);
		const turnId = `${config.sessionId}:${generation}`;
		this.running = startGrokAcpTurn(
			spec,
			{
				turnId,
				processGeneration: String(generation),
				prompt: input.prompt,
				cwd: config.cwd,
				account: input.snapshot.account,
				host: input.snapshot.host,
				model: input.model,
				effort: input.effort,
				resumeSessionId: config.agentSessionId,
				idleTimeoutMs: GROK_ACP_DESKTOP_IDLE_MS,
				maxTurnMs: GROK_ACP_DESKTOP_MAX_TURN_MS,
				stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
				// A person gets the relay's decision window, not the 30 s machine default; the
				// adapter's watchdog and the relay's timer both deny when it runs out. The same
				// value bounds this turn's setup requests; Stop still ends them at once.
				...(input.consentSession ? { requestTimeoutMs: RELAY_DECISION_TIMEOUT_MS } : {}),
				permission: input.consentSession
					? {
							authority: grokConsentAuthority(input.consentSession),
							// Not a lease: the driver joins each answer to this turn and process.
							binding: {
								actor: DESKTOP_PERSON,
								leaseId: `desktop-consent:${config.sessionId}:${generation}`,
							},
						}
					: undefined,
				qualify: (negotiated) => {
					if (!negotiated.agentVersion) {
						this.routeRefusal = 'Grok ACP reported no agent version to bind this turn to.';
						return 'acp-version-unbound';
					}
					const decision = completeGrokAcpNegotiation(input.negotiation, {
						protocolVersion: negotiated.protocolVersion,
						agentVersion: negotiated.agentVersion,
						loadSession: negotiated.loadSession,
						// The port carries no images yet (GROK_ACP_PORT_SUPPORT); never claimed.
						images: false,
						// ACP advertises commands by notification, not in `initialize`: the
						// driver proves this process's catalog before submission, and a turn
						// whose catalog never arrives is refused (catalog-unavailable).
						commands: input.nativeCommand !== undefined,
					});
					if (decision.ok) return undefined;
					this.routeRefusal = decision.message;
					return decision.missing.join(',');
				},
				...(input.nativeCommand
					? {
							nativeCommand: {
								intent: input.nativeCommand,
								tabId: config.tabId ?? '',
								configGeneration: input.snapshot.configGeneration,
							},
						}
					: {}),
			},
			{
				// Never answered here: the driver cancels each question itself, so an unattended
				// turn cannot wait on one. This only names the gap when one ends the turn.
				onQuestion: (event) => {
					this.questionGap ??= grokQuestionGapOf(event, turnId);
				},
				onEvent: (event) => {
					if (this.isCurrent()) {
						this.ctx.stdoutHandler.handleNormalizedEvent(config.sessionId, managedProcess, event);
						return;
					}
					// A kill removes the process from the map before the driver settles. Spend the
					// turn already incurred is still its own: only its usage (and the terminal that
					// marks it partial) is recorded, while no newer process holds the session.
					if (this.killedAwaitingSettlement() && (event.usage || event.terminal))
						this.ctx.stdoutHandler.handleNormalizedEvent(config.sessionId, managedProcess, {
							type: 'usage',
							sessionId: event.sessionId,
							usage: event.usage,
							terminal: event.terminal,
						});
				},
			}
		);
		managedProcess.pid = this.running.handle.pid ?? -1;
		managedProcess.spawnGeneration = generation;
		this.ctx.processes.set(config.sessionId, managedProcess);
		this.ctx.liveTurns.add(this);
		void this.running.completed.then(
			(completed) => this.settle(completed),
			(error: unknown) => {
				void captureException(error);
				this.emitAgentError(
					`Grok ACP turn failed: ${error instanceof Error ? error.message : String(error)}`
				);
				this.finish(1);
			}
		);
		logger.info('[GrokAcpSpawner] Started Grok ACP turn', LOG_CONTEXT, {
			sessionId: config.sessionId,
			pid: managedProcess.pid,
			resume: !!config.agentSessionId,
		});
		return { pid: managedProcess.pid, success: true };
	}

	private settle(completed: Awaited<GrokAcpRunningTurn['completed']>): void {
		const { terminal } = completed;
		if (completed.exit.spawnError) {
			this.emitAgentError(`Grok ACP could not start: ${completed.exit.spawnError.message}`);
			this.finish(1);
			return;
		}
		if (terminal.status === 'success') {
			this.finish(0);
			return;
		}
		if (this.routeRefusal) {
			this.emitAgentError(`${this.routeRefusal} No prompt was sent.`, 'permission_denied', false);
			this.finish(1);
			return;
		}
		// A stop the user asked for is not a crash.
		if (this.stopped && terminal.status === 'cancelled') {
			this.finish(0);
			return;
		}
		if (this.questionGap) {
			// Not permission_denied: nothing was asked of the consent surface, and the question
			// was not a tool approval. The tab reads the capability gap instead of a crash.
			this.emitAgentError(grokQuestionGapMessage(this.questionGap), 'unknown', false);
			this.finish(1);
			return;
		}
		// Grok answered the prompt with its own error: the driver's classified type and fixed
		// words (never the provider's message), not a crash of the connection.
		if (terminal.status === 'failed' && terminal.kind === 'provider' && completed.error) {
			this.emitAgentError(
				completed.error.message,
				completed.error.type,
				completed.error.recoverable
			);
			this.finish(1);
			return;
		}
		const unknown = terminal.dispatchState === 'unknown' ? ' The prompt may have run.' : '';
		this.emitAgentError(
			`Grok ACP turn ${terminal.status}${terminal.reason ? ` (${terminal.reason})` : ''}.${unknown}`,
			terminal.status === 'refused' ? 'permission_denied' : 'agent_crashed',
			terminal.dispatchState === 'not-dispatched'
		);
		this.finish(1);
	}

	private cancel(): void {
		this.stopped = true;
		this.running.cancel();
	}

	private kill(options: { sync?: boolean; shutdown?: boolean } = {}): void {
		this.stopped = true;
		this.running.cancel();
		if (options.shutdown || options.sync)
			this.running.handle.terminateNow({ blocking: options.sync });
		else this.running.handle.terminate();
	}

	/**
	 * This turn's live advertisement as a host receipt, when the discovery selection is the
	 * launch this turn actually runs: same native session (the catalog's own), cwd, requested
	 * model/effort, executable (the selection's custom path, when it names one), a local
	 * target, and the same config generation recomputed from the selection's
	 * environment layers over this executable. The launch environment returned is that
	 * recomputed projection's source, proven equal to this turn's by the generation; nothing
	 * of the raw child environment is retained or returned for it. Undefined otherwise.
	 */
	observeCommands(selection: GrokCommandObservationSelection): GrokCommandObservation | undefined {
		const { config, input } = this;
		if (
			this.stopped ||
			!this.isCurrent() ||
			config.sshRemoteId ||
			input.snapshot.target !== 'local' ||
			!path.isAbsolute(config.command)
		)
			return undefined;
		const catalog = this.running.commands();
		if (
			!catalog ||
			catalog.processGeneration !== String(this.managedProcess.spawnGeneration) ||
			catalog.sessionId !== selection.sessionId ||
			catalog.cwd !== config.cwd ||
			selection.cwd !== config.cwd ||
			catalog.account !== input.snapshot.account ||
			catalog.host !== input.snapshot.host ||
			catalog.selection.model !== input.model ||
			catalog.selection.effort !== input.effort ||
			selection.model !== input.model ||
			selection.effort !== input.effort ||
			(selection.customPath !== undefined && selection.customPath !== config.command)
		)
			return undefined;
		const env = buildAgentEnvironment({
			...selection.environment,
			extraPathDirs: [path.dirname(config.command), ...(selection.environment.extraPathDirs ?? [])],
		});
		const configGeneration = grokAcpDesktopConfigGeneration(config, env);
		if (configGeneration !== input.snapshot.configGeneration) return undefined;
		return {
			...catalog,
			target: 'local',
			configGeneration,
			selection: {
				customPath: selection.customPath,
				model: input.model,
				effort: input.effort,
			},
			launch: { command: config.command, cwd: config.cwd, env },
		};
	}

	/** Whether `process` is this turn's own process record (identity, not key). */
	runs(process: ManagedProcess): boolean {
		return process === this.managedProcess;
	}

	/** The active, current owner of its process key: not stopped, finished or superseded. */
	ownsSteering(): boolean {
		return !this.stopped && this.isCurrent();
	}

	private isCurrent(): boolean {
		return (
			!this.finished &&
			this.ctx.processes.get(this.config.sessionId) === this.managedProcess &&
			!isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration)
		);
	}

	/** Killed by this host, not yet settled, and the session not taken by a newer process. */
	private killedAwaitingSettlement(): boolean {
		return (
			this.stopped &&
			!this.finished &&
			!this.ctx.processes.has(this.config.sessionId) &&
			!isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration)
		);
	}

	private emitAgentError(
		message: string,
		type: AgentError['type'] = 'agent_crashed',
		recoverable = true
	): void {
		if (this.managedProcess.errorEmitted || !this.isCurrent()) return;
		this.managedProcess.errorEmitted = true;
		this.ctx.emitter.emit('agent-error', this.config.sessionId, {
			type,
			message,
			recoverable,
			agentId: this.config.toolType,
			sessionId: this.config.sessionId,
			timestamp: Date.now(),
		} satisfies AgentError);
	}

	/** Report the turn's exit through ExitHandler, exactly once. */
	private finish(code: number): void {
		this.ctx.liveTurns.delete(this);
		if (this.finished) return;
		// Every request still waiting on the person is denied; exit clears the prompt.
		this.input.consentSession?.close();
		if (isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration)) {
			this.finished = true;
			return;
		}
		this.finished = true;
		void this.ctx.exitHandler
			.handleExit(this.config.sessionId, code, this.managedProcess)
			.catch((error: unknown) => {
				logger.error('[GrokAcpSpawner] handleExit threw', LOG_CONTEXT, {
					sessionId: this.config.sessionId,
					error: String(error),
				});
			});
	}
}
