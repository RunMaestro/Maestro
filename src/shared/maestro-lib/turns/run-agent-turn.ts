/**
 * `runAgentTurn`: start an assembled turn, stream it, and say how it ended.
 *
 * `assembleTurn` decides what a turn IS (prompt, arguments, environment); this is everything
 * that has a side effect. It plans the launch (`buildAgentLaunchPlan`, with the SSH remote
 * looked up in the stored settings), refuses what the runtime cannot deliver, starts the
 * process through the library run layer (`runTurn` over `startTurn`), and hands back the turn
 * as an event stream plus a promise of how it ended.
 *
 * Refusals come BEFORE anything is started (a Windows system prompt file written by then is
 * removed with the refusal), and none of them falls back to something else:
 *
 * - An SSH remote that cannot be resolved (decision D1c). The turn never runs on this machine
 *   in its place.
 * - Images without an explicit file route and admitted, resolved content blocks (PA12).
 *   Missing bytes or support refuse in the planner, never falling back to tool-read files.
 *   A Grok turn's images are resolved here and handed to the planner as ordered ACP blocks
 *   under the caller's `embeddedImageSupport`; an image that cannot be read refuses first.
 * - Standard permission mode on a Claude Code API turn (PA11). The permission relay lives in
 *   the desktop; without it Claude aborts on the first tool call.
 * - A standard-mode Grok turn the negotiated route selector (`grok/route.ts`) cannot carry.
 *   Such a turn needs a host round trip for every permission request, so it runs on the shared
 *   ACP driver (`startGrokAcpTurn`), the same route the desktop's `GrokAcpSpawner` takes, or not
 *   at all; it never falls back to output-only headless execution, which answers native
 *   permission prompts by itself. This runtime has no consent port, so such a turn is refused
 *   (`consent-port`). Full-access and read-only Grok turns keep the headless CLI.
 *
 * Completion is the caller's policy (decision D2): the exit facts go through
 * `resolveTurnOutcome`, and the session id is the first one the provider announced (D4).
 *
 * What the desktop's spawner and `ProcessManager` do around a running turn is done here too: a
 * resumed Claude session's cost is primed so the turn records its own share, the stdio close
 * watchdog makes sure the turn settles, Stop reaches an SSH agent on its remote host
 * (`guardTurn`), and an effort the provider refused is noted for the process.
 */

import * as os from 'os';
import { observeGrokLaunchScope, type GrokLaunchScopePorts } from '../../agentAccountDir';
import { canonicalJson } from '../../canonicalJson';
import { matchesNativeSessionBinding, type NativeSessionBinding } from '../agents/providerSwap';
import { grokLaunchArgsProblem } from '../launch/agent-args';
import { readClaudeTurnBaseline, type ClaudeCostState } from '../../claudeCostTracker';
import { getClaudeTokenMode, type ClaudeTokenSourceFields } from '../../claudeTokenMode';
import {
	describeEffortRejection,
	noteEffortRejection,
	parseEffortRejection,
	type EffortRejection,
} from '../../effortRejection';
import { logger } from '../host';
import { INTERACTIVE_STOP_GRACE_MS } from '../control/termination';
import { guardTurn, recordRemoteAgent, type RemoteAgentTarget } from '../control/turn-guard';
import {
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
	createStandaloneClaudeSpawnCoreDeps,
	resolveClaudeSpawnModeCore,
	type ClaudeSpawnCoreDeps,
} from '../launch/interactive-mode';
import { buildAgentLaunchPlan } from '../launch/launch-plan';
import { parseDataUrl, type AcpPromptBlock, type EmbeddedImageSupport } from '../launch/image-refs';
import { resolveSshLaunchTarget, type SshRemoteSettingsStore } from '../launch/ssh-remote-resolver';
import { newRemotePromptFileDestination } from '../launch/ssh-command-builder';
import {
	sshUnresolvedRemoteMessage,
	wrapSpawnWithSsh,
	type SshSpawnWrapConfig,
	type SshSpawnWrapResult,
} from '../launch/ssh-spawn-wrapper';
import type { AgentOutputParser, ParsedEvent } from '../parsers/agent-output-parser';
import { createOutputParser } from '../parsers/parser-factory';
import { removeTempFiles } from '../run/pipe-spawn';
import { generateUUID } from '../../uuid';
import { startGrokAcpTurn } from '../grok/acp-turn';
import {
	beginGrokAcpNegotiation,
	completeGrokAcpNegotiation,
	grokAcpConfigGeneration,
	grokAcpProcessSpec,
	grokAcpPromptOf,
	parseGrokNativeArgs,
	GROK_ACP_TURN_IDLE_MS,
	GROK_ACP_TURN_MAX_MS,
	type GrokAcpNegotiation,
	type GrokRouteRequirements,
	type GrokRouteSnapshot,
} from '../grok/route';
import {
	runTurn,
	UnknownProviderError,
	type CompletedTurn,
	type RunningTurn,
} from '../run/run-to-completion';
import { turnProcessSpecFromPlan, type TurnProcessSpec } from '../run/start-turn';
import type { ResolveTurnOutcomeOptions } from '../streaming/turn-outcome';
import { writeSystemPromptFile } from './args';
import type { AssembledTurn } from './assemble';

const LOG_CONTEXT = '[RunAgentTurn]';

const CLAUDE_CODE_ID = 'claude-code';

export type RunAgentTurnRefusal =
	/** The agent is on an SSH remote that is not usable. The turn did not run. */
	| 'ssh-unresolved'
	/** Grok's model/effort selection was refused before dispatch. Nothing was started. */
	| 'grok-model-effort-refused'
	/** Grok cannot honor the configured directory grants. Nothing was started. */
	| 'grok-directory-grants-refused'
	/** Native resume ownership or selectors could not be verified. Nothing was started. */
	| 'grok-native-session-refused'
	/**
	 * The negotiated Grok route selector cannot carry this turn (a consent port, a remote
	 * target, images, custom argv, unbound ownership). Nothing was started, and no other
	 * route was tried in its place.
	 */
	| 'grok-route-refused'
	/** The prompt cannot be delivered as requested. Nothing was started. */
	| 'prompt-delivery-refused'
	/** The turn carries images without an explicit file route (CH-8). */
	| 'images-unsupported'
	/** Claude Code in Standard permission mode, with no relay to answer its prompts (PA11). */
	| 'standard-mode-unsupported'
	/** The provider has no output parser, so its answer could not be read. */
	| 'no-parser'
	/** The process could not be created. */
	| 'launch';

export type RunAgentTurnStart =
	| { ok: true; run: AgentTurnRun }
	| { ok: false; reason: RunAgentTurnRefusal; message: string };

/** What `runAgentTurn` reaches outside its inputs for. Every field has a working default. */
export interface RunAgentTurnDeps {
	/** The environment an SSH wrapper process runs in. Default: this process's. */
	env?: NodeJS.ProcessEnv;
	/** Test seam for the SSH command builder. */
	wrapSpawnWithSsh?: (
		config: SshSpawnWrapConfig,
		sshConfig: NonNullable<AssembledTurn['launch']['sshRemoteConfig']>,
		store: SshRemoteSettingsStore
	) => Promise<SshSpawnWrapResult>;
	/** Where the Windows system prompt file goes. Default: the OS temp directory. */
	tempDir?: string;
}

export interface RunAgentTurnOptions {
	/** Production host observations, independent of optional process test seams. */
	grokLaunchScope?: GrokLaunchScopePorts;
	/** Retained tab ownership, captured before the caller awaits context loading. */
	retainedNativeSessionBinding?: NativeSessionBinding;
	/** Recheck the original tab/provider selection across the asynchronous launch checks. */
	recheckNativeSelection?(): boolean;
	/**
	 * The host-admitted image bounds for this route, model and fresh or resumed turn (MIME
	 * types, count, bytes per image and in total). A Grok turn's attachments go into its ACP
	 * prompt file as ordered embedded blocks checked against these bounds; absent, a Grok turn
	 * with images is refused before anything is written or started. Caller policy, never a
	 * grant of tools, files or permissions.
	 */
	embeddedImageSupport?: EmbeddedImageSupport;
	/**
	 * Names the turn to the outcome resolver (`<agent id>-ai-<tab id>`), which exempts a few
	 * session shapes from its empty-answer rule by name.
	 */
	sessionId: string;
	/** The stored SSH remotes (`sshRemotes` in the settings file). Absent: no remote resolves. */
	sshStore?: SshRemoteSettingsStore;
	/** The agent's Claude token source (API, TUI, Dynamic). Unconfigured is API, as on the CLI. */
	claudeTokenSource?: ClaudeTokenSourceFields;
	/**
	 * The collaborators for the Claude token source decision. Default: the standalone set, with
	 * `maestroPBinPath` as the maestro-p script (none: Claude runs `--print`).
	 */
	claudeSpawnDeps?: ClaudeSpawnCoreDeps;
	maestroPBinPath?: string | null;
	/**
	 * The turn runs in the agent's own working directory, so a TUI turn may accept claude's
	 * folder-trust prompt there (#1872). Leave unset for any other folder.
	 */
	acceptWorkspaceTrust?: boolean;
	/** Aborting stops the turn, from the terminate stage. */
	signal?: AbortSignal;
	/** How long each stop stage gets. Default: `INTERACTIVE_STOP_GRACE_MS`. */
	stopGraceMs?: number;
	/** The caller's completion policy, passed to `resolveTurnOutcome` as given. */
	outcome?: ResolveTurnOutcomeOptions;
	deps?: RunAgentTurnDeps;
}

/** The turn as it runs: events as they are parsed, then how it ended. */
export interface AgentTurnRun {
	pid: number | undefined;
	/** Only an actual admitted process carries this; requested IDs are not allocations. */
	readonly nativeLaunchReceipt?: Readonly<{
		scope: Awaited<ReturnType<typeof observeGrokLaunchScope>>['scope'];
		requestedNativeSessionId?: string;
	}>;
	/**
	 * Every event the provider's parser understood, in order. One consumer: events that arrive
	 * before iteration starts are held, and the stream ends when the turn does.
	 */
	events: AsyncIterable<ParsedEvent>;
	/** How the turn ended. Never rejects: a failure is an outcome. */
	result: Promise<CompletedTurn>;
	/** Stop the way the Stop button does: interrupt, then terminate, then kill the tree. */
	interrupt(): void;
	/** Stop without the interrupt stage. */
	terminate(): void;
	/** Last resort for process exit: no grace, nothing awaited. */
	terminateNow(): void;
	stopRequested(): boolean;
}

/**
 * A single-consumer async queue. `push` never blocks; `close` ends the stream once what was
 * pushed has been read.
 */
class EventStream<T> implements AsyncIterable<T> {
	private readonly buffer: T[] = [];
	private waiting: ((result: IteratorResult<T>) => void) | undefined;
	private closed = false;

	push(value: T): void {
		if (this.closed) return;
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = undefined;
			resolve({ value, done: false });
		} else {
			this.buffer.push(value);
		}
	}

	close(): void {
		this.closed = true;
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = undefined;
			resolve({ value: undefined, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				if (this.buffer.length > 0) {
					return Promise.resolve({ value: this.buffer.shift() as T, done: false });
				}
				if (this.closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => {
					this.waiting = resolve;
				});
			},
		};
	}
}

function refuse(reason: RunAgentTurnRefusal, message: string): RunAgentTurnStart {
	return { ok: false, reason, message };
}

/** A resumed Claude Code session's cost tracker as a turn starts, for its parser. */
export interface ClaudeResumeBaseline {
	resumeSessionId: string;
	/** `null`: the session has no tracker yet. `undefined`: unknown (a remote transcript). */
	baseline: ClaudeCostState | null | undefined;
}

/**
 * Claude reports its cost and per-model usage as running SESSION totals. The session's total as a
 * resumed turn starts, read from the transcript it resumes, is what turns them into this turn's
 * (see src/shared/claudeCostTracker.ts). Undefined for any other turn. Read it before the process
 * starts, and hand it to the turn's parser with `primeClaudeResume`.
 */
export function readClaudeResumeBaseline(input: {
	providerId: string;
	resumeSessionId: string | undefined;
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** The agent runs on another host, whose transcript cannot be read here. */
	remote: boolean;
}): ClaudeResumeBaseline | undefined {
	const { resumeSessionId } = input;
	if (input.providerId !== CLAUDE_CODE_ID || !resumeSessionId) return undefined;
	return {
		resumeSessionId,
		baseline: readClaudeTurnBaseline({
			resumeSessionId,
			cwd: input.cwd,
			env: input.env,
			homeDir: os.homedir(),
			remote: input.remote,
		}),
	};
}

/** Prime a turn's parser with the baseline `readClaudeResumeBaseline` read. */
export function primeClaudeResume(
	parser: AgentOutputParser | null | undefined,
	resume: ClaudeResumeBaseline | undefined
): void {
	if (resume) parser?.primeResumedSession?.(resume.resumeSessionId, resume.baseline);
}

/**
 * The reasoning effort a failed turn was refused, if that is how it failed. The provider's own
 * words can be in the classified error, the answer, or only in the raw stream, so all of them are
 * read. Null for a turn that did not crash: one that finished, or one somebody stopped.
 */
export function effortRefusalOf(completed: CompletedTurn): EffortRejection | null {
	if (completed.outcome !== 'crashed') return null;
	return parseEffortRejection(
		[
			completed.error?.message,
			completed.answerText,
			completed.exit.stderrText,
			completed.exit.stdoutText,
		]
			.filter(Boolean)
			.join('\n')
	);
}

/**
 * Note an effort refusal for the process, as the desktop's error listener does for every agent
 * error, so `resolveEffortLevel` stops offering the value (see `shared/effortRejection.ts`).
 * Answers the refusal, for a caller that retries without the effort.
 */
export function noteEffortRefusal(
	providerId: string,
	completed: CompletedTurn
): EffortRejection | null {
	const rejection = effortRefusalOf(completed);
	if (rejection && noteEffortRejection(providerId, rejection)) {
		logger.warn(
			`${describeEffortRejection(providerId, rejection)} Turns that map to it now use the agent's own effort.`,
			LOG_CONTEXT,
			{ providerId, ...rejection }
		);
	}
	return rejection;
}

/**
 * Start one assembled turn. Resolves to a refusal (nothing was started) or to the running
 * turn. Never throws for a turn that merely cannot run.
 */
export async function runAgentTurn(
	turn: AssembledTurn,
	options: RunAgentTurnOptions
): Promise<RunAgentTurnStart> {
	const launch = turn.launch;
	const provider = turn.provider;
	const providerId = provider.id;
	const requestedNativeSessionId = turn.resumeSessionId;
	const retainedBinding = structuredClone(options.retainedNativeSessionBinding);
	// Private comparison only: environment values never leave the launch boundary.
	const selectionKey = () =>
		canonicalJson({
			id: turn.resumeSessionId,
			cwd: launch.cwd,
			args: launch.args,
			command: launch.command,
			remoteCommand: launch.remoteCommand,
			ssh: launch.sshRemoteConfig,
			global: launch.globalShellEnvVars,
			provider: launch.agentCustomEnvVars,
			session: launch.sessionCustomEnvVars,
			binding: options.retainedNativeSessionBinding,
		});
	const originalSelection = providerId === 'grok' ? selectionKey() : undefined;
	const selectionUnchanged = () =>
		selectionKey() === originalSelection && options.recheckNativeSelection?.() !== false;
	const sshConfig = launch.sshRemoteConfig;
	const sshEnabled = sshConfig?.enabled === true;
	const deps = options.deps ?? {};

	const hasImages = launch.hasImages || !!turn.entry.images?.length;
	if (hasImages && !launch.agent?.promptFile) {
		return refuse(
			'images-unsupported',
			'Images cannot be sent from here yet. Send the message without them, or use the desktop.'
		);
	}
	if (!createOutputParser(providerId)) {
		return refuse(
			'no-parser',
			`${provider.name ?? providerId} has no output parser, so its answer could not be read`
		);
	}

	// The Claude token source: `claude --print` (API) or the maestro-p TUI. Unconfigured is API;
	// an SSH agent has no remote probe here, so it is API too (PA15).
	const claudeDecision =
		providerId === CLAUDE_CODE_ID
			? resolveClaudeSpawnModeCore(
					{
						agent: {
							id: providerId,
							interactiveCommand: provider.interactiveCommand,
							interactiveModeArgs: provider.interactiveModeArgs,
							defaultEnvVars: provider.defaultEnvVars,
						},
						tokenMode: getClaudeTokenMode(options.claudeTokenSource),
						sshEnabled,
						sshRemoteId: sshConfig?.remoteId ?? undefined,
						command: launch.command,
						sessionCustomPath: undefined,
						sessionCustomEnvVars: launch.sessionCustomEnvVars,
						maestroPPath: options.claudeTokenSource?.maestroPPath,
						now: new Date(),
					},
					options.claudeSpawnDeps ??
						createStandaloneClaudeSpawnCoreDeps({
							getMaestroPBinPath: () => options.maestroPBinPath ?? null,
						})
				)
			: undefined;

	if (
		claudeDecision?.mode === 'api' &&
		turn.permissionMode === 'standard' &&
		providerId === CLAUDE_CODE_ID
	) {
		return refuse(
			'standard-mode-unsupported',
			'Standard permission mode is not available for Claude Code from here. ' +
				'Switch this tab to Full Access or Read-Only.'
		);
	}

	let args = launch.args;
	// Name remote preparation on the selected host. The planner retains precise
	// SSH refusals when resolution fails and validates any supplied destination.
	let promptFileDestination = launch.promptFileDestination;
	if (launch.agent?.promptFile && sshEnabled && !promptFileDestination) {
		const target = resolveSshLaunchTarget(options.sshStore, sshConfig);
		if (target.kind === 'remote') {
			promptFileDestination = newRemotePromptFileDestination(
				target.remote.id,
				launch.agent.promptFile.format
			);
		}
	}
	// A Grok turn's attachments reach its native route the one way phase02 qualified: ordered
	// ACP blocks (the composed text, then each image in attachment order) in the prompt file the
	// planner validates against the host-admitted bounds. Each image is resolved to bytes here,
	// before any artifact or process; one that cannot be read refuses the turn, never dropping it,
	// sending the text alone, or handing the model a path to read with a tool. The ACP route
	// counts these blocks and refuses them while its port carries no attachments.
	let promptBlocks: AcpPromptBlock[] | undefined;
	let embeddedImageSupport: EmbeddedImageSupport | undefined;
	if (providerId === 'grok' && turn.entry.images?.length) {
		promptBlocks = [];
		if (typeof launch.prompt === 'string' && launch.prompt.length > 0)
			promptBlocks.push({ type: 'text', text: launch.prompt });
		for (const image of turn.entry.images) {
			const resolved = typeof image === 'string' ? parseDataUrl(image) : null;
			if (!resolved)
				return refuse(
					'images-unsupported',
					'An attached image could not be read, so the turn was not started. Remove it and send again.'
				);
			promptBlocks.push({ type: 'image', data: resolved.base64, mimeType: resolved.mediaType });
		}
		const support = options.embeddedImageSupport;
		embeddedImageSupport = support
			? {
					mimeTypes: Array.isArray(support.mimeTypes) ? [...support.mimeTypes] : support.mimeTypes,
					maxCount: support.maxCount,
					maxBytesPerImage: support.maxBytesPerImage,
					maxTotalBytes: support.maxTotalBytes,
				}
			: undefined;
	}
	const planLaunch = () =>
		buildAgentLaunchPlan({
			...launch,
			...(promptBlocks ? { prompt: undefined, promptBlocks, embeddedImageSupport } : {}),
			args,
			hasImages,
			promptFileDestination,
			sshStore: options.sshStore,
		});
	// Grok's configuration refusals must precede every prompt artifact, including
	// a system-prompt file. Grant validation stays solely in the shared planner.
	let planned = providerId === 'grok' ? planLaunch() : undefined;

	// Windows hands a large system prompt to the agent in a file, through the realization every
	// spawn shares: owner-only, removed after its lifetime, and the inline flag when the write
	// fails. The flag goes into the arguments before the final plan places the prompt after them.
	let systemPromptFile: string | undefined;
	if ((!planned || planned.ok) && turn.systemPromptDelivery.via === 'file' && turn.systemPrompt) {
		const delivered = await writeSystemPromptFile({
			args,
			prompt: launch.prompt,
			systemPrompt: turn.systemPrompt,
			sessionId: options.sessionId,
			agentId: providerId,
			logContext: LOG_CONTEXT,
			tempDir: deps.tempDir,
		});
		args = delivered.args;
		systemPromptFile = delivered.tempFile;
		planned = undefined; // Plan again with the realized system-prompt arguments.
	}
	// A turn refused from here on leaves no file behind for its lifetime.
	const abandon = (reason: RunAgentTurnRefusal, message: string): RunAgentTurnStart => {
		if (systemPromptFile) removeTempFiles([systemPromptFile]);
		return refuse(reason, message);
	};

	planned ??= planLaunch();
	if (!planned.ok) {
		if (
			planned.reason === 'grok-model-effort-refused' ||
			planned.reason === 'grok-directory-grants-refused' ||
			planned.reason === 'prompt-delivery-refused'
		) {
			return abandon(planned.reason, planned.error);
		}
		return abandon('ssh-unresolved', planned.error);
	}
	const plan = providerId === 'grok' ? structuredClone(planned.plan) : planned.plan;
	// The known prompt tail is data, not native selectors (a prompt may itself say --resume).
	const nativeArgs =
		'args' in plan.prompt && (plan.target.kind === 'local' || plan.prompt.via === 'file')
			? plan.args.slice(0, plan.args.length - plan.prompt.args.length)
			: plan.args;
	if (providerId === 'grok') {
		const problem =
			typeof requestedNativeSessionId !== 'string' && requestedNativeSessionId !== undefined
				? 'Grok received an invalid retained native session ID.'
				: nativeArgs.includes('agent') && nativeArgs.includes('stdio')
					? 'Grok ACP routing is not qualified on this native launch path.'
					: grokLaunchArgsProblem(nativeArgs, requestedNativeSessionId, plan.cwd);
		if (problem || !selectionUnchanged())
			return abandon(
				'grok-native-session-refused',
				problem ?? 'The Grok launch selection changed.'
			);
	}

	// A Grok turn that asked for the provider's own prompting runs on the negotiated ACP route
	// or not at all. Every gap no advertisement could close (consent, remote target, images,
	// custom argv) refuses here, before any SSH wrap, observation or process.
	let grokAcp:
		| {
				requirements: GrokRouteRequirements;
				prompt: string;
				model?: string;
				effort?: string;
				negotiation?: GrokAcpNegotiation;
				snapshot?: GrokRouteSnapshot;
		  }
		| undefined;
	const grokPlatform = `${process.platform}-${process.arch}`;
	// The tab's resolved mode is the request: this launch input names none, so the plan's
	// own default reads `standard` for a Full Access tab too, whose argv approves natively.
	if (
		providerId === 'grok' &&
		turn.permissionMode === 'standard' &&
		plan.permission.requested === 'standard'
	) {
		const native = parseGrokNativeArgs(nativeArgs);
		const planned = grokAcpPromptOf(
			{
				prompt: plan.prompt.via === 'file' ? undefined : launch.prompt,
				promptArtifact: plan.prompt.via === 'file' ? plan.prompt.artifact : undefined,
				images: turn.entry.images,
			},
			native.prompt
		);
		if (!planned)
			return abandon('prompt-delivery-refused', 'The planned Grok prompt could not be read.');
		const requirements: GrokRouteRequirements = {
			permissionMode: 'standard',
			consent: 'none',
			imageCount: Math.max(planned.imageCount, hasImages ? 1 : 0),
			resume: requestedNativeSessionId !== undefined,
			customArgs: native.customArgs,
		};
		const preliminary = beginGrokAcpNegotiation(requirements, {
			executable: { path: plan.command },
			agentVersion: null,
			platform: grokPlatform,
			account: 'unobserved',
			host: 'unobserved',
			configGeneration: 'unobserved',
			target: plan.target.kind,
			native: { qualified: false },
		});
		if (!preliminary.ok)
			return abandon('grok-route-refused', `${preliminary.message} Nothing was started.`);
		grokAcp = { requirements, prompt: planned.text, model: native.model, effort: native.effort };
	}

	// The process to start.
	let spec: TurnProcessSpec;
	let remote: RemoteAgentTarget | undefined;
	if (plan.target.kind === 'remote' && sshConfig) {
		const plannedRemote = structuredClone(plan.target.remote);
		// A remote TUI turn runs maestro-p on the remote host instead of `claude`.
		const remoteInteractive = claudeDecision
			? buildRemoteInteractiveSpawn({
					decision: claudeDecision,
					interactiveModeArgs: provider.interactiveModeArgs,
					remoteClaudeBin: claudeDecision.claudeRealBinPath,
					acceptWorkspaceTrust: options.acceptWorkspaceTrust,
				})
			: null;
		const wrap = deps.wrapSpawnWithSsh ?? wrapSpawnWithSsh;
		const artifact = plan.prompt.via === 'file' ? plan.prompt.artifact : undefined;
		try {
			const wrapped = await wrap(
				{
					command: remoteInteractive ? remoteInteractive.command : plan.command,
					args: remoteInteractive ? [...remoteInteractive.prependArgs, ...plan.args] : plan.args,
					cwd: launch.cwd,
					prompt: artifact ? undefined : launch.prompt,
					...(artifact ? { promptArtifact: artifact } : {}),
					customEnvVars: remoteInteractive
						? { ...plan.envVars, ...remoteInteractive.env }
						: plan.envVars,
					agentBinaryName: remoteInteractive ? remoteInteractive.command : plan.command,
					promptArgs: provider.promptArgs,
					noPromptSeparator: provider.noPromptSeparator,
					querySource: launch.querySource,
				},
				sshConfig,
				providerId === 'grok'
					? { getSshRemotes: () => [structuredClone(plannedRemote)] }
					: (options.sshStore ?? { getSshRemotes: () => [] })
			);
			// The wrapper degrades to a local spawn when it cannot resolve the remote. Taking that
			// would run the agent here against the remote's path.
			if (!wrapped.sshRemoteUsed)
				return abandon('ssh-unresolved', sshUnresolvedRemoteMessage(sshConfig));
			if (
				providerId === 'grok' &&
				canonicalJson(wrapped.sshRemoteUsed) !== canonicalJson(plan.target.remote)
			)
				return abandon('grok-native-session-refused', 'The Grok SSH target changed during launch.');
			// The script records the remote agent's pid, so Stop reaches it and not only the ssh client.
			const recorded = recordRemoteAgent({
				command: wrapped.command,
				args: wrapped.args,
				sshStdinScript: wrapped.sshStdinScript,
				sessionId: options.sessionId,
				...(artifact ? { promptArtifactPath: artifact.path } : {}),
			});
			remote = recorded.remote;
			spec = {
				command: wrapped.command,
				args: wrapped.args,
				cwd: wrapped.cwd,
				env: { ...(deps.env ?? process.env) },
				stdin: recorded.sshStdinScript,
			};
		} catch (error) {
			if (artifact)
				return abandon('prompt-delivery-refused', 'Remote prompt preparation unavailable.');
			throw error;
		}
	} else if (plan.env === undefined) {
		return abandon('launch', 'The launch plan has no local environment');
	} else {
		spec = turnProcessSpecFromPlan({ ...plan, env: plan.env });
		if (claudeDecision?.mode === 'interactive' && claudeDecision.maestroPBinPath) {
			const applied = applyClaudeSpawnDecision({
				decision: claudeDecision,
				interactiveModeArgs: provider.interactiveModeArgs,
				command: plan.command,
				args: plan.args,
				customEnvVars: {},
				acceptWorkspaceTrust: options.acceptWorkspaceTrust,
			});
			// What maestro-p adds (MAESTRO_CLAUDE_BIN and friends) goes over the planned
			// environment, which already holds the user's variables.
			spec = {
				...spec,
				command: applied.command,
				args: applied.args,
				env: { ...spec.env, ...(applied.customEnvVars ?? {}) },
			};
		}
	}

	let nativeObservation: Awaited<ReturnType<typeof observeGrokLaunchScope>> | undefined;
	const nativeSelectionProblem = (): string | undefined => {
		if (!selectionUnchanged()) return 'The Grok launch selection changed before spawn.';
		if (plan.target.kind === 'remote') {
			const current = resolveSshLaunchTarget(options.sshStore, sshConfig);
			if (
				current.kind !== 'remote' ||
				canonicalJson(current.remote) !== canonicalJson(plan.target.remote)
			)
				return 'The Grok SSH endpoint configuration changed before spawn.';
		}
		if (
			requestedNativeSessionId !== undefined &&
			(nativeObservation?.scope.state !== 'bound' ||
				!matchesNativeSessionBinding(retainedBinding, {
					...nativeObservation.scope,
					nativeSessionId: requestedNativeSessionId,
				}))
		)
			return 'Grok resume ownership is unknown or differs from the selected account, host or directory. The original conversation was retained.';
		if (
			nativeObservation?.scope.state === 'bound' &&
			plan.target.kind === 'local' &&
			options.grokLaunchScope?.local.installationId() !== nativeObservation.scope.host.identity
		)
			return 'The Grok executing installation changed before spawn.';
		return undefined;
	};
	if (providerId === 'grok') {
		try {
			nativeObservation = options.grokLaunchScope
				? await observeGrokLaunchScope(
						{ cwd: plan.cwd },
						plan.target.kind === 'remote' ? structuredClone(plan.target.remote) : null,
						plan.target.kind === 'remote'
							? { ...plan.target.remote.remoteEnv, ...plan.envVars }
							: { ...spec.env },
						[...nativeArgs],
						options.grokLaunchScope
					)
				: { scope: { version: 1, state: 'unknown', reason: 'unobserved' } };
			const problem = nativeSelectionProblem();
			if (problem) return abandon('grok-native-session-refused', problem);
		} catch (error) {
			if (systemPromptFile) removeTempFiles([systemPromptFile]);
			throw error;
		}
	}
	if (grokAcp) {
		const scope = nativeObservation?.scope;
		if (scope?.state !== 'bound' || plan.target.kind !== 'local' || plan.env === undefined)
			return abandon(
				'grok-route-refused',
				'Grok account and host ownership is unknown, so the ACP route cannot bind this turn. Nothing was started.'
			);
		const snapshot: GrokRouteSnapshot = {
			executable: { path: plan.command },
			agentVersion: null,
			platform: grokPlatform,
			account: scope.accountRef,
			host: scope.host.identity,
			configGeneration: grokAcpConfigGeneration({
				command: plan.command,
				cwd: plan.cwd,
				env: plan.env,
				scope,
			}),
			target: scope.host.kind === 'local' ? 'local' : 'remote',
			native: { qualified: false },
		};
		const negotiation = beginGrokAcpNegotiation(grokAcp.requirements, snapshot);
		if (!negotiation.ok)
			return abandon('grok-route-refused', `${negotiation.message} Nothing was started.`);
		if (!('pending' in negotiation))
			return abandon(
				'grok-route-refused',
				'The Grok route selector returned no ACP negotiation. Nothing was started.'
			);
		try {
			// The same final plan's executable, cwd and complete environment; only the argv changes.
			spec = grokAcpProcessSpec(
				negotiation,
				{
					command: plan.command,
					cwd: plan.cwd,
					env: plan.env,
					target: plan.target,
					permission: plan.permission,
				},
				snapshot
			);
		} catch (error) {
			return abandon(
				'grok-route-refused',
				`${error instanceof Error ? error.message : String(error)} Nothing was started.`
			);
		}
		grokAcp = { ...grokAcp, negotiation, snapshot };
	}

	const claudeResume = readClaudeResumeBaseline({
		providerId,
		resumeSessionId: turn.resumeSessionId,
		cwd: launch.cwd,
		env: spec.env,
		remote: plan.target.kind === 'remote',
	});

	const stopGraceMs = options.stopGraceMs ?? INTERACTIVE_STOP_GRACE_MS;
	const stream = new EventStream<ParsedEvent>();
	let running: RunningTurn;
	// Set only for a routed Grok turn: protocol cancel first, then the driver's stop ladder.
	let acpCancel: (() => void) | undefined;
	let spawnAttempted = false;
	try {
		if (providerId === 'grok') {
			// Local observation stays synchronous right up to spawn. Remote checks must
			// finish before the final synchronous selection check.
			const checked = nativeObservation?.recheck?.();
			const stable = typeof checked === 'boolean' ? checked : await checked;
			const problem =
				nativeSelectionProblem() ??
				(stable === false
					? 'The Grok account or working directory changed before spawn.'
					: undefined);
			if (problem) return abandon('grok-native-session-refused', problem);
		}
		spawnAttempted = true;
		if (grokAcp?.negotiation && grokAcp.snapshot) {
			const { negotiation, snapshot } = grokAcp;
			const acp = startGrokAcpTurn(
				spec,
				{
					turnId: `${options.sessionId}:${generateUUID()}`,
					processGeneration: generateUUID(),
					prompt: grokAcp.prompt,
					cwd: plan.cwd,
					account: snapshot.account,
					host: snapshot.host,
					model: grokAcp.model,
					effort: grokAcp.effort,
					resumeSessionId: requestedNativeSessionId,
					idleTimeoutMs: GROK_ACP_TURN_IDLE_MS,
					maxTurnMs: GROK_ACP_TURN_MAX_MS,
					stopGraceMs,
					signal: options.signal,
					// No prompt before the process proves what it negotiated.
					qualify: (negotiated) => {
						if (!negotiated.agentVersion) return 'acp-version-unbound';
						const decision = completeGrokAcpNegotiation(negotiation, {
							protocolVersion: negotiated.protocolVersion,
							agentVersion: negotiated.agentVersion,
							loadSession: negotiated.loadSession,
							// The port carries no images or native commands here (GROK_ACP_PORT_SUPPORT).
							images: false,
							commands: false,
						});
						return decision.ok ? undefined : decision.missing.join(',');
					},
				},
				{ onEvent: (event) => stream.push(event) }
			);
			running = acp;
			acpCancel = () => acp.cancel();
		} else {
			running = runTurn(
				spec,
				{
					agentId: providerId,
					sessionId: options.sessionId,
					stopGraceMs,
					signal: options.signal,
					outcome: options.outcome,
				},
				{ onEvent: (event) => stream.push(event) }
			);
		}
	} catch (error) {
		if (!spawnAttempted) {
			if (systemPromptFile) removeTempFiles([systemPromptFile]);
			throw error;
		}
		if (error instanceof UnknownProviderError) return abandon('no-parser', error.message);
		return abandon(
			'launch',
			`Could not start ${provider.name ?? providerId}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	// Before the first line is read, which is on a later tick.
	primeClaudeResume(running.handle.parser, claudeResume);
	const stops = acpCancel
		? {
				interrupt: acpCancel,
				terminate: () => {
					acpCancel!();
					running.handle.terminate();
				},
				terminateNow: () => {
					acpCancel!();
					running.handle.terminateNow();
				},
			}
		: guardTurn(running.handle, {
				sessionId: options.sessionId,
				graceMs: stopGraceMs,
				remote,
				signal: options.signal,
			});

	const result = running.completed.then((completed) => {
		stream.close();
		// The file is only for the agent's first read. It goes when the turn does, or at the end of
		// its lifetime, whichever is first.
		if (systemPromptFile) removeTempFiles([systemPromptFile]);
		noteEffortRefusal(providerId, completed);
		return completed;
	});
	const scope = nativeObservation && structuredClone(nativeObservation.scope);
	if (scope?.state === 'bound') Object.freeze(scope.host);
	const nativeLaunchReceipt =
		scope &&
		typeof running.handle.pid === 'number' &&
		Number.isSafeInteger(running.handle.pid) &&
		running.handle.pid > 0
			? Object.freeze({ scope: Object.freeze(scope), requestedNativeSessionId })
			: undefined;

	const run: AgentTurnRun = {
		pid: running.handle.pid,
		events: stream,
		result,
		interrupt: stops.interrupt,
		terminate: stops.terminate,
		terminateNow: stops.terminateNow,
		stopRequested: () => running.handle.stopRequested(),
	};
	if (nativeLaunchReceipt)
		Object.defineProperty(run, 'nativeLaunchReceipt', {
			value: nativeLaunchReceipt,
			enumerable: true,
		});
	return { ok: true, run };
}
