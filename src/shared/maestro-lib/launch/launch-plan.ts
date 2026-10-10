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
 * Pure apart from reading `process.env` (through `buildAgentEnvironment`): no
 * spawning, no I/O. A plan for an SSH remote describes the remote invocation;
 * the caller hands it to the SSH wrapper, which owns building the ssh command.
 */

import { isWindows } from '../../platformDetection';
import type { QuerySource } from '../../querySource';
import type { AgentSshRemoteConfig, SshRemoteConfig } from '../../types';
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
	/** Bare binary name, run on an SSH remote where local paths mean nothing. */
	binaryName?: string;
	defaultEnvVars?: Record<string, string>;
	batchModeEnvVars?: Record<string, string>;
	readOnlyEnvOverrides?: Record<string, string>;
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
	isResuming?: boolean;
	querySource?: QuerySource;
	/** Local only: directories to put in front of PATH. */
	extraPathDirs?: string[];

	/** The agent's SSH setting, and where to look its remote up. */
	sshRemoteConfig?: AgentSshRemoteConfig | null;
	sshStore?: SshRemoteSettingsStore;

	/** Defaults to the real host. Injected by tests. */
	isWindowsHost?: boolean;
}

interface LaunchPlanCommon {
	/** Command and args to hand the process launcher (or the SSH wrapper, for a remote). */
	command: string;
	args: string[];
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
			reason: Extract<SshLaunchTarget, { kind: 'unresolved' }>['reason'];
			error: string;
	  };

/**
 * Plan an agent launch. Fails, before anything is spawned, when SSH is on and
 * no usable remote is configured; never falls back to running locally.
 */
export function buildAgentLaunchPlan(input: AgentLaunchInput): AgentLaunchPlanResult {
	const target = resolveSshLaunchTarget(input.sshStore, input.sshRemoteConfig);
	if (target.kind === 'unresolved') {
		return { ok: false, reason: target.reason, error: target.message };
	}

	const agent = input.agent;
	const layers = {
		defaultEnvVars: agent?.defaultEnvVars,
		batchModeEnvVars: input.batchMode ? agent?.batchModeEnvVars : undefined,
		globalShellEnvVars: input.globalShellEnvVars,
		agentCustomEnvVars: input.agentCustomEnvVars,
		sessionCustomEnvVars: input.sessionCustomEnvVars,
		readOnlyEnvOverrides: input.readOnlyMode ? agent?.readOnlyEnvOverrides : undefined,
	};
	const layered = resolveAgentEnvVars(layers);
	const envVars =
		layered || input.maestroEnvVars
			? { ...(layered ?? {}), ...(input.maestroEnvVars ?? {}) }
			: undefined;

	const prompt = resolvePromptDelivery({
		agent,
		prompt: input.prompt,
		// Only desktop moves a Windows prompt to stdin. The CLI and Cue have
		// always put it on the command line, on every host.
		isWindowsHost: input.surface === 'desktop' && (input.isWindowsHost ?? isWindows()),
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
				args: [...input.args],
				cwd: input.cwd,
				prompt,
				stdin: undefined,
				envVars,
				env: undefined,
			},
		};
	}

	const args =
		prompt.via === 'argv' || prompt.via === 'stdin'
			? [...input.args, ...prompt.args]
			: [...input.args];
	return {
		ok: true,
		plan: {
			target,
			command: input.command,
			args,
			cwd: input.cwd,
			prompt,
			stdin: prompt.via === 'stdin' && prompt.format === 'raw' ? input.prompt : undefined,
			envVars,
			env: buildAgentEnvironment({
				...layers,
				surface: input.surface,
				maestroEnvVars: input.maestroEnvVars,
				isResuming: input.isResuming,
				querySource: input.querySource,
				extraPathDirs: input.extraPathDirs,
			}),
		},
	};
}
