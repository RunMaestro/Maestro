import * as path from 'node:path';
import {
	bindTranslationKnowledge,
	TRANSLATION_KNOWLEDGE_ENV_VAR,
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
 * No spawning. Its only reads are `process.env` (through
 * `buildAgentEnvironment`) and, for a CLI or Cue launch of an agent that
 * declares `requiredSecrets`, those secrets' files (`serverSecrets.ts`). A
 * plan for an SSH remote describes the remote invocation; the caller hands it
 * to the SSH wrapper, which owns building the ssh command.
 */

import { isWindows } from '../../platformDetection';
import {
	dirsWithAnyAccess,
	dirsWithWriteAccess,
	normalizeAdditionalDirectories,
} from '../../additionalDirectories';
import {
	GrokModelEffortError,
	resolveGrokModelEffortArgs,
	type GrokEffortMenu,
} from './agent-args';
import type { QuerySource } from '../../querySource';
import type { AdditionalDirectory, AgentSshRemoteConfig, SshRemoteConfig } from '../../types';
import {
	describeSecretProblem,
	resolveSecrets,
	type SecretLookupOptions,
	type SecretProblem,
	type SecretSource,
} from '../../serverSecrets';
import {
	buildAgentEnvironment,
	resolveAgentEnvVars,
	type AgentEnvSurface,
	type LaunchPermissionMode,
} from './env';
import {
	resolvePromptDelivery,
	selectPromptFileDestination,
	type PromptDelivery,
	type PromptDeliveryAgent,
	type PromptFileDestination,
} from './prompt-delivery';
import type { AcpPromptBlock, EmbeddedImageSupport } from './image-refs';
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
	/** Host-scoped native wire menu; picker options are not validation evidence. */
	grokEffortMenu?: GrokEffortMenu;
	cwd: string;
	/**
	 * Explicit grants on the selected host, separate from cwd and prompt paths.
	 * Other providers retain their existing argument builders. Grok refuses active
	 * grants until a native mechanism is qualified; never expand remote roots here.
	 */
	additionalDirectories?: AdditionalDirectory[];
	/** The user prompt, already final (system prompt embedded if that applies). */
	prompt?: string;
	hasImages?: boolean;
	/** Ordered, resolved content, including composed instructions, instead of prompt text. */
	promptBlocks?: readonly AcpPromptBlock[];
	/** Executing host's admission for embedded images on this route/model/turn. */
	embeddedImageSupport?: EmbeddedImageSupport;
	/** Fresh executing-host path; the launch owner materializes and cleans the planned artifact. */
	promptFileDestination?: PromptFileDestination;

	/** Settings -> Environment. Applied on desktop only. */
	globalShellEnvVars?: Record<string, string>;
	/** Settings -> Agents, per provider. */
	agentCustomEnvVars?: Record<string, string>;
	/** The agent's own vars; replaces `agentCustomEnvVars` when present. */
	sessionCustomEnvVars?: Record<string, string>;
	/** Applies the provider's `readOnlyEnvOverrides` on top of every user layer. */
	readOnlyMode?: boolean;
	/**
	 * The permission mode this launch asks for, by the surface's own rule: the
	 * CLI's unattended default is `full`, the desktop's is what the request
	 * named. Absent derives `readonly` from `readOnlyMode` and `standard`
	 * otherwise, so a surface whose default is full access must say so.
	 * Reported back as `plan.permission`.
	 */
	permissionMode?: LaunchPermissionMode;
	/** Adds the provider's `batchModeEnvVars` (CLI batch spawns only). */
	batchMode?: boolean;
	/** Vars Maestro states about this spawn (caller identity and the like). */
	maestroEnvVars?: Record<string, string>;
	isResuming?: boolean;
	querySource?: QuerySource;
	/** Local only: directories to put in front of PATH. */
	extraPathDirs?: string[];
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

/** The permission mode a planned launch runs with, as the launch asked for it. */
export interface LaunchPermissionDecision {
	requested: LaunchPermissionMode;
}

/**
 * The mode a launch asks for when its surface names none: `readonly` when the
 * read-only layer is on, `standard` (the provider's own prompting) otherwise.
 * Never `full`: a surface whose default bypasses approvals names it.
 */
export function defaultLaunchPermissionMode(input: {
	permissionMode?: LaunchPermissionMode;
	readOnlyMode?: boolean;
}): LaunchPermissionMode {
	if (input.permissionMode) return input.permissionMode;
	return input.readOnlyMode ? 'readonly' : 'standard';
}

interface LaunchPlanCommon {
	/** Command and args to hand the process launcher (or the SSH wrapper, for a remote). */
	command: string;
	args: string[];
	cwd: string;
	prompt: Exclude<PromptDelivery, { via: 'refused' }>;
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
	 * What happened to `requiredSecrets`, by NAME only (safe to log). Absent
	 * when the agent declares none or the surface does not deliver them.
	 */
	secrets?: LaunchSecretsReport;
	/** The mode this launch runs with. */
	permission: LaunchPermissionDecision;
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
				| 'grok-model-effort-refused'
				| 'grok-directory-grants-refused'
				| 'prompt-delivery-refused';
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
	const requestedMode = defaultLaunchPermissionMode(input);
	let selectionArgs = [...input.args];
	if (agent?.id === 'grok') {
		// --add-dir belongs to other providers. Refuse both spellings even when
		// no typed grant was supplied, rather than forward a fabricated Grok flag.
		if (input.args.some((arg) => arg === '--add-dir' || arg.startsWith('--add-dir='))) {
			return {
				ok: false,
				reason: 'grok-directory-grants-refused',
				error: 'Grok CLI has no qualified --add-dir argument for additional-directory grants.',
			};
		}
		// Reuse saved-row semantics (blank/inert rows, last duplicate wins).
		// No local home, filesystem lookup or cwd substitution: these roots belong
		// to the selected host, including on a resumed turn.
		const grants = dirsWithAnyAccess(normalizeAdditionalDirectories(input.additionalDirectories));
		if (grants.length > 0) {
			const readOnly = input.readOnlyMode || requestedMode === 'readonly';
			if (readOnly && dirsWithWriteAccess(grants).length > 0) {
				return {
					ok: false,
					reason: 'grok-directory-grants-refused',
					error: "Grok CLI writable directory grants exceed this launch's read-only mode.",
				};
			}
			// Read grants are not writable roots. Neither has qualified native
			// support, so refusing the request is the only safe intersection today.
			// Plan mode, approval rules and paths in a prompt are not root grants.
			return {
				ok: false,
				reason: 'grok-directory-grants-refused',
				error:
					'Grok CLI additional-directory read and write grants have no qualified native mechanism. Remove the grants to run with the selected working directory.',
			};
		}
		try {
			// Validate before prompts or secret reads. Direct launch-plan callers
			// receive the same guard as config builders.
			selectionArgs = resolveGrokModelEffortArgs(selectionArgs, input.grokEffortMenu);
		} catch (error) {
			if (!(error instanceof GrokModelEffortError)) throw error;
			return { ok: false, reason: 'grok-model-effort-refused', error: error.message };
		}
	}
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

	// Declared secrets: CLI and Cue only, so the desktop never reads a secret
	// file, and never into `envVars`, which crosses to an SSH remote and is
	// shown in Process Details.
	const declaredSecrets =
		input.surface !== 'desktop' && input.requiredSecrets && input.requiredSecrets.length > 0
			? [...new Set(input.requiredSecrets)].sort()
			: undefined;

	const knowledgeDirectory = envVars?.[TRANSLATION_KNOWLEDGE_ENV_VAR];
	const launchArgs =
		target.kind === 'local' && agent?.id === 'claude-code' && knowledgeDirectory
			? [
					...selectionArgs,
					'--settings',
					JSON.stringify({ autoMemoryDirectory: path.join(knowledgeDirectory, 'memory') }),
				]
			: selectionArgs;
	const effectivePrompt =
		target.kind === 'local'
			? bindTranslationKnowledge(input.prompt, envVars?.[TRANSLATION_KNOWLEDGE_ENV_VAR])
			: input.prompt;
	let promptBlocks = input.promptBlocks;
	if (target.kind === 'local' && knowledgeDirectory && Array.isArray(promptBlocks)) {
		// Keep ordered content intact, binding staged instructions once to the
		// first nonempty text block just as the text-only path does. Empty text
		// retains the canonical binder's no-op behavior; never flatten images.
		const textIndex = promptBlocks.findIndex(
			(block) => block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0
		);
		if (textIndex < 0 && promptBlocks.some((block) => block?.type === 'image')) {
			return {
				ok: false,
				reason: 'prompt-delivery-refused',
				error:
					'Image-only content requires a composed text block for staged translation knowledge.',
			};
		}
		promptBlocks = promptBlocks.map((block, index) =>
			index === textIndex && block.type === 'text'
				? { ...block, text: bindTranslationKnowledge(block.text, knowledgeDirectory)! }
				: block
		);
	}
	const sshRemoteId = target.kind === 'remote' ? target.remote.id : undefined;
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
		sshRemoteId,
		hasImages: input.hasImages,
		promptBlocks,
		embeddedImageSupport: input.embeddedImageSupport,
		args: launchArgs,
		promptFileDestination:
			input.prompt !== undefined || promptBlocks !== undefined || input.hasImages
				? selectPromptFileDestination(agent, sshRemoteId, input.promptFileDestination)
				: input.promptFileDestination,
	});
	if (prompt.via === 'refused') {
		return { ok: false, reason: 'prompt-delivery-refused', error: prompt.error };
	}

	if (target.kind === 'remote') {
		return {
			ok: true,
			plan: {
				target,
				command: input.remoteCommand || agent?.binaryName || input.command,
				// A file source is final: the SSH wrapper must not append the prompt
				// again. Other deliveries retain the wrapper's script placement.
				args: prompt.via === 'file' ? [...launchArgs, ...prompt.args] : launchArgs,
				cwd: input.cwd,
				prompt,
				stdin: undefined,
				envVars,
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
				permission: { requested: requestedMode },
				env: undefined,
			},
		};
	}

	const resolved = declaredSecrets
		? resolveSecrets(declaredSecrets, input.secretLookup)
		: undefined;

	const args =
		prompt.via === 'argv' || prompt.via === 'stdin' || prompt.via === 'file'
			? [...launchArgs, ...prompt.args]
			: [...launchArgs];
	return {
		ok: true,
		plan: {
			target,
			command: input.command,
			args,
			cwd: input.cwd,
			prompt,
			stdin: prompt.via === 'stdin' && prompt.format === 'raw' ? effectivePrompt : undefined,
			envVars,
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
			permission: { requested: requestedMode },
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
