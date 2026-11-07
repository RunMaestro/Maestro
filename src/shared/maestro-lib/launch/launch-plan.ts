import * as path from 'node:path';
import { resolveUserDataDir } from '../paths/userDataDir';
import { getAgentDefinition } from '../providers/definitions';
import {
	bindTranslationKnowledge,
	resolveTranslationKnowledgeBinding,
} from '../translation/knowledge-binding';
/**
 * The launch plan: one answer to "what exactly do we start for this agent?",
 * shared by desktop chat, Cue and the CLI.
 *
 * Each surface still builds its own argument list (desktop's interactive
 * Claude modes, Cue's forced batch mode and the CLI's per-provider shapes are
 * genuinely different), but everything AFTER the arguments is decided here,
 * once: where the process runs, which command it execs, what environment it
 * gets, and how the prompt reaches it.
 *
 * One place does not mean one behavior. Desktop, the CLI and Cue layer an
 * agent's environment differently and deliver its prompt differently, and have
 * since before this module existed. The plan reproduces each surface as it was
 * (`surface`); it does not make them agree. The one thing it does change is an
 * SSH remote that cannot be resolved: that fails on every surface, where
 * desktop and Cue used to run the agent LOCALLY against the remote's path.
 *
 * An agent's Local Models gateway is applied here too, the same way on every
 * surface: its base-URL variable is set unless the agent's own vars already
 * set it, and a gateway that cannot work (a loopback URL for an SSH remote, a
 * provider with no base-URL variable) fails the launch by name rather than
 * sending the turn to another endpoint.
 *
 * So is an agent's Run on target (`resolveRunOnLaunch`): the variables and root
 * arguments that point the harness at the source, and the model, which takes
 * the place of the agent's own in its model flag. A target that cannot run
 * fails the launch by name; it never runs the turn on the provider's model. A
 * Run on target takes the gateway's place: the gateway routes to the provider's
 * cloud, which is not where the turn is going, so the plan skips it and says so
 * (`runOn.skippedGatewayUrl`).
 *
 * No spawning. Reads include process env, local translated knowledge and,
 * for CLI/Cue agents declaring `requiredSecrets`, secret files. An SSH plan
 * validates the knowledge host binding without reading remote files; the SSH
 * wrapper reads the remote index before building the invocation.
 */

import { isWindows } from '../../platformDetection';
import type { QuerySource } from '../../querySource';
import type { AgentSshRemoteConfig, SshRemoteConfig } from '../../types';
import { resolveAgentGateway, type AgentGatewayRefusalCode } from '../../local-models/gateway';
import {
	resolveRunOnLaunch,
	type ResolvedRunOn,
	type RunOnLaunchResolution,
	type RunOnRefusalCode,
} from '../../local-models/run-on';
import { buildAdditionalDirArgs, placeSubcommandArgs, replaceModelArg } from './agent-args';
import {
	describeSecretProblem,
	resolveSecrets,
	type SecretLookupOptions,
	type SecretProblem,
	type SecretSource,
} from '../../serverSecrets';
import { buildAgentEnvironment, resolveAgentEnvVars, type AgentEnvSurface } from './env';
import {
	resolvePromptDelivery,
	type PromptDelivery,
	type PromptDeliveryAgent,
} from './prompt-delivery';
import {
	resolveSshLaunchTarget,
	type SshLaunchTarget,
	type SshRemoteSettingsStore,
} from './ssh-remote-resolver';

/** The parts of a provider definition a launch plan reads. */
export interface LaunchPlanAgent extends PromptDeliveryAgent {
	id?: string;
	/** Bare binary name, run on an SSH remote where local paths mean nothing. */
	binaryName?: string;
	defaultEnvVars?: Record<string, string>;
	batchModeEnvVars?: Record<string, string>;
	readOnlyEnvOverrides?: Record<string, string>;
	/** The provider's model flag, which a Run on target's model goes through. */
	modelArgs?: (modelId: string) => string[];
	/** The provider's batch subcommand, which a Run on target's own arguments follow. */
	batchModePrefix?: string[];
}

/** What an agent's Run on target did to a launch. */
export interface LaunchPlanRunOn {
	/** The model the harness was told to use, in place of the agent's own. */
	model: string;
	/** The context size the harness was told it has. */
	contextTokens: number;
	/** The root arguments that point the harness at the source (Codex). */
	args: string[];
	/** The arguments added after the provider's batch subcommand (OpenCode). */
	subcommandArgs: string[];
	/**
	 * The NAMES of the variables set for it, a variable it added to
	 * (`envVarMerges`) included. Never the values: one is a key.
	 */
	envVarNames: string[];
	/** Recipe variables the agent sets itself, which were left alone. */
	userOverrides: string[];
	/** The provider's own key variables, set blank so they do not reach the source. */
	clearedEnvVars: string[];
	/** The agent's stored gateway, which this launch did not go through. */
	skippedGatewayUrl?: string;
}

/**
 * Turn a resolved Run on target into what a launch carries: its arguments, and
 * the record of what was done. The arguments get the target's root arguments in
 * front, where a CLI reads a global option, its subcommand arguments after the
 * provider's batch subcommand (`placeSubcommandArgs`), and its model in the
 * provider's own flag in place of the agent's (`replaceModelArg`). Shared by
 * the plan and by the spawns that build none (`applyAgentRunOnToSpawn`), so
 * both refuse the same way.
 */
export function applyRunOnToLaunch(input: {
	agent: Pick<LaunchPlanAgent, 'modelArgs' | 'batchModePrefix'> | null | undefined;
	toolType: string;
	args: readonly string[];
	runOn: Extract<RunOnLaunchResolution, { kind: 'inject' }>;
	/** The agent's stored gateway, which a Run on target takes the place of. */
	gatewayUrl?: string | null;
}):
	| { ok: true; args: string[]; runOn: LaunchPlanRunOn }
	| { ok: false; reason: RunOnRefusalCode; error: string } {
	const { runOn } = input;
	const withModel = replaceModelArg(input.agent, input.args, runOn.harnessModel);
	if (!withModel) {
		// A recipe with no model flag to carry its model: the harness would ask
		// the source for whatever model the agent names on its own.
		return {
			ok: false,
			reason: 'run-on-unsupported-provider',
			error: `This agent is set to run on ${runOn.model}, but Maestro has no model flag for "${input.toolType}" to name it with. Set Run on to Provider to run the agent.`,
		};
	}
	const skippedGatewayUrl = input.gatewayUrl?.trim();
	return {
		ok: true,
		args: [...runOn.args, ...placeSubcommandArgs(input.agent, withModel, runOn.subcommandArgs)],
		runOn: {
			model: runOn.model,
			contextTokens: runOn.contextTokens,
			args: runOn.args,
			subcommandArgs: runOn.subcommandArgs,
			envVarNames: [...Object.keys(runOn.envVars), ...Object.keys(runOn.envVarMerges)],
			userOverrides: runOn.userOverrides,
			clearedEnvVars: runOn.clearedEnvVars,
			...(skippedGatewayUrl ? { skippedGatewayUrl } : {}),
		},
	};
}

export interface AgentLaunchInput {
	/**
	 * Who is launching. Decides the environment order (see `AgentEnvSurface`)
	 * and whether a Windows host moves the prompt to stdin: desktop does, for an
	 * agent that reads it there; the CLI and Cue keep it on the command line.
	 */
	surface: AgentEnvSurface;
	agent: LaunchPlanAgent | null | undefined;
	/** The command to exec locally (a resolved path, ideally). */
	command: string;
	/**
	 * The command to run on an SSH remote. Defaults to the agent's `binaryName`,
	 * then `command`; a path resolved on THIS machine names nothing over there.
	 */
	remoteCommand?: string;
	/** Every argument except the prompt. */
	args: string[];
	cwd: string;
	/** The user prompt, already final (system prompt embedded if that applies). */
	prompt?: string;
	hasImages?: boolean;

	/** Settings -> Environment. Applied on desktop only. */
	globalShellEnvVars?: Record<string, string>;
	/** Settings -> Agents, per provider. */
	agentCustomEnvVars?: Record<string, string>;
	/** The agent's own vars; replaces `agentCustomEnvVars` when present. */
	sessionCustomEnvVars?: Record<string, string>;
	/** Applies the provider's `readOnlyEnvOverrides` on top of every user layer. */
	readOnlyMode?: boolean;
	/** Adds the provider's `batchModeEnvVars` (CLI batch spawns only). */
	batchMode?: boolean;
	/** Vars Maestro states about this spawn (caller identity and the like). */
	maestroEnvVars?: Record<string, string>;
	/** Trusted host root for translated knowledge; defaults to Maestro's local data directory. */
	translationKnowledgeRoot?: string;
	isResuming?: boolean;
	querySource?: QuerySource;
	/** Local only: directories to put in front of PATH. */
	extraPathDirs?: string[];
	/**
	 * The agent's Local Models gateway: its provider and its stored URL. Omit
	 * (or leave the URL blank) for an agent with none.
	 */
	gateway?: { toolType: string; url?: string | null };
	/**
	 * The agent's Run on target with its source looked up (`prepareAgentRunOn`).
	 * Omit for an agent that runs on its provider's model.
	 */
	runOn?: ResolvedRunOn;
	/** Cue only: inherit just the server-mode allowlist (see `filterServerProcessEnv`). */
	isServerMode?: boolean;
	/**
	 * Secret names this agent needs (the agent record's `requiredSecrets`,
	 * written by bundle import). CLI and Cue resolve them from systemd
	 * credentials, `/run/secrets` or the environment and put the values in this
	 * launch's environment only; desktop never reads them. Local launches only:
	 * a value is never sent to an SSH remote.
	 */
	requiredSecrets?: readonly string[];
	/** Where secrets are looked up. Defaults to the real paths and `process.env`; tests inject. */
	secretLookup?: SecretLookupOptions;

	/** The agent's SSH setting, and where to look its remote up. */
	sshRemoteConfig?: AgentSshRemoteConfig | null;
	sshStore?: SshRemoteSettingsStore;

	/** Defaults to the real host. Injected by tests. */
	isWindowsHost?: boolean;
	/**
	 * The command will run through cmd.exe (a Windows `.cmd` shim, see
	 * `windowsShellReason`), which cannot carry a multi-line prompt. The prompt
	 * then goes over stdin on every surface, for a provider that reads it there.
	 */
	cmdShellLaunch?: boolean;
}

interface LaunchPlanCommon {
	/** Command and args to hand the process launcher (or the SSH wrapper, for a remote). */
	command: string;
	args: string[];
	/**
	 * `args` without the prompt: the caller's arguments with the gateway's root
	 * arguments, or the Run on target's root arguments and model, applied. For a
	 * caller that places the prompt itself (desktop), which must spawn from this
	 * list and not from the one it passed in.
	 */
	launchArgs: string[];
	cwd: string;
	prompt: PromptDelivery;
	/**
	 * Text to write to the child's stdin and then close it, for a stdin
	 * delivery. Undefined when the prompt travels any other way.
	 */
	stdin: string | undefined;
	/**
	 * The vars Maestro sets on top of the inherited environment, merged in tier
	 * order (see `resolveAgentEnvVars`). What crosses to an SSH remote, and what
	 * Process Details shows as "set by Maestro".
	 */
	envVars: Record<string, string> | undefined;
	/**
	 * The gateway this launch goes through, when `envVars` carries its base-URL
	 * variable. Undefined when the agent has none or sets the variable itself.
	 * `gateway.args` are the provider's config arguments for it (Codex), already
	 * placed at the FRONT of `args` and `launchArgs`.
	 */
	gateway: { envVar: string; url: string; args: string[] } | undefined;
	/**
	 * The Run on target this launch uses, when it has one: `envVars` carries its
	 * variables, and `args` and `launchArgs` already carry its root arguments
	 * and its model.
	 */
	runOn: LaunchPlanRunOn | undefined;
	/**
	 * What happened to `requiredSecrets`, by NAME only (safe to log). Absent
	 * when the agent declares none or the surface does not deliver them.
	 */
	secrets?: LaunchSecretsReport;
}

export interface LaunchSecretsReport {
	/** Names placed in the environment, with where each value came from. */
	injected: { name: string; source: SecretSource }[];
	/** Names set nowhere. */
	missing: string[];
	/** Names whose file exists but cannot be used. */
	unusable: { name: string; problem: SecretProblem; path?: string }[];
	/** Names not delivered because the agent runs on an SSH remote. */
	notDeliveredToRemote: string[];
}

export type AgentLaunchPlan =
	| (LaunchPlanCommon & {
			target: { kind: 'local' };
			/** The complete local process environment. */
			env: NodeJS.ProcessEnv;
	  })
	| (LaunchPlanCommon & {
			target: { kind: 'remote'; remote: SshRemoteConfig };
			/** No local environment: the remote host has its own, plus `envVars`. */
			env: undefined;
	  });

export type AgentLaunchPlanResult =
	| { ok: true; plan: AgentLaunchPlan }
	| {
			ok: false;
			reason:
				| Extract<SshLaunchTarget, { kind: 'unresolved' }>['reason']
				| AgentGatewayRefusalCode
				| RunOnRefusalCode;
			error: string;
	  };

/**
 * Plan an agent launch. Fails, before anything is spawned, when SSH is on and
 * no usable remote is configured (it never falls back to running locally),
 * when the agent's gateway cannot be used (it never falls back to running
 * without it), and when its Run on target cannot run (it never falls back to
 * the provider's model).
 */
export function buildAgentLaunchPlan(input: AgentLaunchInput): AgentLaunchPlanResult {
	const target = resolveSshLaunchTarget(input.sshStore, input.sshRemoteConfig);
	if (target.kind === 'unresolved') {
		return { ok: false, reason: target.reason, error: target.message };
	}

	const agent = input.agent;
	// The same "own vars replace the provider-level set" rule the layers use.
	const userEnvVars = input.sessionCustomEnvVars ?? input.agentCustomEnvVars;
	const remote = target.kind === 'remote' ? { name: target.remote.name } : null;

	const runOn = resolveRunOnLaunch({
		...input.runOn,
		toolType: input.runOn?.toolType ?? '',
		userEnvVars,
		remote,
	});
	if (runOn.kind === 'refused') {
		return { ok: false, reason: runOn.code, error: runOn.message };
	}

	// A Run on target takes the gateway's place, so the gateway is not resolved
	// at all: one that could not be used must not refuse a launch that was never
	// going through it.
	const gateway =
		runOn.kind === 'inject'
			? ({ kind: 'none' } as const)
			: resolveAgentGateway({
					toolType: input.gateway?.toolType ?? '',
					gatewayUrl: input.gateway?.url,
					userEnvVars,
					remote,
				});
	if (gateway.kind === 'refused') {
		return { ok: false, reason: gateway.code, error: gateway.message };
	}
	const planGateway =
		gateway.kind === 'inject'
			? { envVar: gateway.envVar, url: gateway.url, args: gateway.args }
			: undefined;

	let launchArgs = input.args;
	let planRunOn: LaunchPlanRunOn | undefined;
	if (runOn.kind === 'inject') {
		const applied = applyRunOnToLaunch({
			agent,
			toolType: input.runOn?.toolType ?? '',
			args: input.args,
			runOn,
			gatewayUrl: input.gateway?.url,
		});
		if (!applied.ok) return applied;
		launchArgs = applied.args;
		planRunOn = applied.runOn;
	} else if (planGateway) {
		// A global option: ahead of the agent's own arguments, subcommand included.
		launchArgs = [...planGateway.args, ...input.args];
	}
	const layers = {
		defaultEnvVars: agent?.defaultEnvVars,
		batchModeEnvVars: input.batchMode ? agent?.batchModeEnvVars : undefined,
		globalShellEnvVars: input.globalShellEnvVars,
		agentCustomEnvVars: input.agentCustomEnvVars,
		sessionCustomEnvVars: input.sessionCustomEnvVars,
		gatewayEnvVars: gateway.kind === 'inject' ? gateway.envVars : undefined,
		runOnEnvVars: runOn.kind === 'inject' ? runOn.envVars : undefined,
		runOnEnvVarMerges: runOn.kind === 'inject' ? runOn.envVarMerges : undefined,
		readOnlyEnvOverrides: input.readOnlyMode ? agent?.readOnlyEnvOverrides : undefined,
	};
	const layered = resolveAgentEnvVars(layers);
	const envVars =
		layered || input.maestroEnvVars
			? { ...(layered ?? {}), ...(input.maestroEnvVars ?? {}) }
			: undefined;

	// Declared secrets: CLI and Cue only, so the desktop never reads a secret
	// file, and never into `envVars`, which crosses to an SSH remote and is
	// shown in Process Details.
	const declaredSecrets =
		input.surface !== 'desktop' && input.requiredSecrets && input.requiredSecrets.length > 0
			? [...new Set(input.requiredSecrets)].sort()
			: undefined;

	const knowledge = resolveTranslationKnowledgeBinding(
		envVars,
		input.translationKnowledgeRoot ?? path.join(resolveUserDataDir(), 'provider-knowledge'),
		target.kind === 'remote' ? target.remote : undefined
	);
	const knowledgeDirectory = knowledge?.directory;
	const nativePaths = target.kind === 'remote' ? path.posix : path;
	const effectivePrompt =
		target.kind === 'local' && knowledge
			? bindTranslationKnowledge(input.prompt, knowledge.directory, knowledge.root)
			: input.prompt;
	launchArgs =
		agent?.id === 'claude-code' && knowledgeDirectory
			? [
					...launchArgs,
					...buildAdditionalDirArgs(getAgentDefinition('claude-code'), [
						{ path: knowledgeDirectory, read: true, write: true },
					]),
					'--settings',
					JSON.stringify({ autoMemoryDirectory: nativePaths.join(knowledgeDirectory, 'memory') }),
				]
			: launchArgs;
	const prompt = resolvePromptDelivery({
		agent,
		prompt: effectivePrompt,
		// Only desktop moves a Windows prompt to stdin. The CLI and Cue have
		// always put it on the command line, on every host, unless the caller
		// says the launch goes through cmd.exe.
		isWindowsHost:
			(input.surface === 'desktop' && (input.isWindowsHost ?? isWindows())) ||
			input.cmdShellLaunch === true,
		// A prompt too long for this machine's command line still moves to
		// stdin on every surface: in argv the spawn could only fail.
		hostIsWindows: input.isWindowsHost ?? isWindows(),
		sshRemote: target.kind === 'remote',
		hasImages: input.hasImages,
	});

	if (target.kind === 'remote') {
		return {
			ok: true,
			plan: {
				target,
				command: input.remoteCommand || agent?.binaryName || input.command,
				// The SSH wrapper places the prompt itself (inline or via its script).
				args: launchArgs,
				launchArgs,
				cwd: input.cwd,
				prompt,
				stdin: undefined,
				envVars,
				gateway: planGateway,
				runOn: planRunOn,
				...(declaredSecrets
					? {
							secrets: {
								injected: [],
								missing: [],
								unusable: [],
								notDeliveredToRemote: declaredSecrets,
							},
						}
					: {}),
				env: undefined,
			},
		};
	}

	const resolved = declaredSecrets
		? resolveSecrets(declaredSecrets, input.secretLookup)
		: undefined;

	const args =
		prompt.via === 'argv' || prompt.via === 'stdin'
			? [...launchArgs, ...prompt.args]
			: [...launchArgs];
	return {
		ok: true,
		plan: {
			target,
			command: input.command,
			args,
			launchArgs,
			cwd: input.cwd,
			prompt,
			stdin: prompt.via === 'stdin' && prompt.format === 'raw' ? effectivePrompt : undefined,
			envVars,
			gateway: planGateway,
			runOn: planRunOn,
			...(resolved
				? {
						secrets: {
							injected: resolved.found,
							missing: resolved.missing,
							unusable: resolved.unusable,
							notDeliveredToRemote: [],
						},
					}
				: {}),
			env: buildAgentEnvironment({
				...layers,
				secretEnvVars: resolved?.values,
				surface: input.surface,
				maestroEnvVars: input.maestroEnvVars,
				isResuming: input.isResuming,
				querySource: input.querySource,
				extraPathDirs: input.extraPathDirs,
				isServerMode: input.isServerMode,
			}),
		},
	};
}

/**
 * One warning line for the secrets an agent declared but did not get, or
 * `undefined` when every one was delivered. Names, sources and paths only:
 * never a value, so it is safe in any log.
 */
export function describeUndeliveredSecrets(
	agentName: string,
	report: LaunchSecretsReport | undefined
): string | undefined {
	if (!report) return undefined;
	const parts: string[] = [];
	if (report.missing.length > 0) {
		parts.push(
			`not set: ${report.missing.join(', ')} (looked in $CREDENTIALS_DIRECTORY, /run/secrets and the environment)`
		);
	}
	if (report.unusable.length > 0) {
		parts.push(`unusable: ${report.unusable.map(describeSecretProblem).join('; ')}`);
	}
	if (report.notDeliveredToRemote.length > 0) {
		parts.push(
			`not sent to the SSH remote: ${report.notDeliveredToRemote.join(', ')} (set them on the remote host)`
		);
	}
	if (parts.length === 0) return undefined;
	return `Agent "${agentName}" requires secrets it did not receive - ${parts.join('; ')}`;
}
