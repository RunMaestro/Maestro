import type { AgentConfig, AgentDefinition } from '../providers/definitions';
import type { AdditionalDirectory } from '../../types';
import { logger } from '../host';

/** Fields applyAgentConfigOverrides actually reads. Accepting this narrower
 * shape lets CLI callers pass AgentDefinition (no capabilities/available). */
type AgentConfigOverridable = Pick<
	AgentConfig,
	| 'configOptions'
	| 'defaultEnvVars'
	| 'readOnlyArgs'
	| 'resumeArgs'
	| 'batchModePrefix'
	| 'id'
	| 'yoloModeArgs'
>;

const LOG_CONTEXT = '[AgentArgs]';

export type BuildAgentArgsOptions = {
	baseArgs: string[];
	prompt?: string;
	cwd?: string;
	readOnlyMode?: boolean;
	modelId?: string;
	yoloMode?: boolean;
	permissionMode?: 'full' | 'standard' | 'readonly';
	agentSessionId?: string;
	/**
	 * The session's Additional Directories. Providers that declare
	 * `supportsAdditionalDirectories` turn these into native grant flags; the rest
	 * ignore them here and rely on the system-prompt block instead.
	 */
	additionalDirectories?: AdditionalDirectory[];
	/**
	 * Force the agent's batch-mode args (batchModePrefix / batchModeArgs /
	 * jsonOutputArgs) to be applied even when `prompt` is an empty string. The
	 * default behavior gates these on `options.prompt` being truthy so that a
	 * bare interactive launch (no prompt) doesn't accidentally enable batch
	 * mode. Callers that NEVER launch interactive mode - e.g. Cue, which spawns
	 * with `stdio: ['ignore', 'pipe', 'pipe']` and no TTY - must set this so an
	 * empty-after-substitution prompt (e.g. `{{CUE_SOURCE_OUTPUT}}` resolving
	 * to `""` when the upstream run produced no parseable stdout) doesn't
	 * silently fall back to interactive mode and fail with
	 * "stdin is not a terminal".
	 */
	forceBatchMode?: boolean;
};

type AgentConfigOverrides = {
	agentConfigValues?: Record<string, any>;
	sessionCustomModel?: string;
	sessionCustomEffort?: string;
	sessionCustomArgs?: string;
	sessionCustomEnvVars?: Record<string, string>;
	/**
	 * Whether this spawn is read-only (plan mode). Config options are appended
	 * AFTER `buildAgentArgs()` has already emitted `readOnlyArgs`, so a config
	 * option or custom arg repeating one of those flags would win on the CLI and
	 * silently undo read-only enforcement (e.g. OpenCode's `--agent plan`
	 * followed by a user's `--agent build`). When set, those args are dropped.
	 */
	readOnlyMode?: boolean;
};

export type AgentConfigResolution = {
	args: string[];
	effectiveCustomEnvVars?: Record<string, string>;
	customArgsSource: 'session' | 'agent' | 'none';
	customEnvSource: 'session' | 'agent' | 'none';
	modelSource: 'session' | 'agent' | 'default';
};

/** Parse a space-separated custom args string into an array, respecting quoted segments. */
function parseCustomArgs(customArgs?: string): string[] {
	if (!customArgs || typeof customArgs !== 'string') {
		return [];
	}

	const customArgsArray = customArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
	return customArgsArray.map((arg) => {
		if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
			return arg.slice(1, -1);
		}
		return arg;
	});
}

/**
 * Split an agent's `readOnlyArgs` into the flag names it pins and, separately,
 * which of those flags actually take a value within that array (e.g.
 * `--sandbox` in `['--sandbox', 'read-only']`) versus boolean switches with
 * nothing after them there (e.g. `--skip-git-repo-check` at the end, or
 * immediately followed by another flag). `stripFlags` needs this distinction:
 * treating every pinned flag as value-taking makes it eat whatever unrelated
 * argument happens to follow a boolean switch in the user's own custom args.
 */
function classifyReadOnlyFlags(readOnlyArgs: string[]): {
	flags: Set<string>;
	valueTakingFlags: Set<string>;
} {
	const flags = new Set<string>();
	const valueTakingFlags = new Set<string>();
	for (let i = 0; i < readOnlyArgs.length; i++) {
		const arg = readOnlyArgs[i];
		if (!arg.startsWith('-')) continue;
		flags.add(arg);
		const next = readOnlyArgs[i + 1];
		if (next !== undefined && !next.startsWith('-')) {
			valueTakingFlags.add(arg);
		}
	}
	return { flags, valueTakingFlags };
}

/**
 * Drop every occurrence of `flags` (and, for flags in `valueTakingFlags`, the
 * value each one consumes) from an argument list. Handles both `--flag value`
 * and `--flag=value` spellings for value-taking flags. Used to keep read-only
 * args from being overridden by a later duplicate.
 */
function stripFlags(args: string[], flags: Set<string>, valueTakingFlags: Set<string>): string[] {
	if (flags.size === 0) {
		return args;
	}

	const kept: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const equalsIndex = arg.indexOf('=');
		const flagName = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;

		if (!flags.has(flagName)) {
			kept.push(arg);
			continue;
		}

		// `--flag=value` carries its value inline. `--flag value` only eats the
		// next token when this specific flag is known to take one - a boolean
		// switch must never consume an unrelated following argument.
		if (
			equalsIndex === -1 &&
			valueTakingFlags.has(flagName) &&
			i + 1 < args.length &&
			!args[i + 1].startsWith('-')
		) {
			i++;
		}
	}
	return kept;
}

/** Check whether jsonOutputArgs (exact sequence or flag key) are already present in the args list. */
function hasJsonOutputFlag(haystack: string[], jsonOutputArgs: string[]): boolean {
	if (jsonOutputArgs.length === 0) return true;

	// Check if the exact arg sequence is already present
	for (let i = 0; i <= haystack.length - jsonOutputArgs.length; i++) {
		let match = true;
		for (let j = 0; j < jsonOutputArgs.length; j++) {
			if (haystack[i + j] !== jsonOutputArgs[j]) {
				match = false;
				break;
			}
		}
		if (match) return true;
	}

	// Also check if the flag key (e.g., --format, --output-format) is already
	// present with a different value - avoid appending a conflicting duplicate
	// that the dedup step would mangle.
	const flagKey = jsonOutputArgs[0];
	if (flagKey?.startsWith('-') && jsonOutputArgs.length > 1) {
		return haystack.includes(flagKey);
	}

	return false;
}

/** Build the final CLI arguments for an agent process based on mode, config, and user options. */
export function buildAgentArgs(
	agent: AgentConfig | null | undefined,
	options: BuildAgentArgsOptions
): string[] {
	let finalArgs = [...options.baseArgs];

	if (!agent) {
		return finalArgs;
	}

	// Resolve effective permission level. permissionMode takes precedence over the
	// legacy readOnlyMode/yoloMode booleans when set explicitly.
	const isFullAccess =
		options.permissionMode === 'full' ||
		(options.permissionMode === undefined && options.yoloMode === true);
	const isReadOnly =
		options.permissionMode === 'readonly' ||
		(options.permissionMode === undefined && options.readOnlyMode === true);

	// Batch-mode gate: normally we infer "batch mode" from the presence of a
	// truthy prompt, so a bare interactive launch (no prompt) doesn't get batch
	// args it never asked for. Callers that never launch interactive mode pass
	// `forceBatchMode: true` so this path still fires when the prompt is an
	// empty string (e.g. a Cue template variable that resolved to nothing).
	const inBatchMode = Boolean(options.prompt) || options.forceBatchMode === true;

	if (agent.batchModePrefix && inBatchMode) {
		finalArgs = [...agent.batchModePrefix, ...finalArgs];
	}

	if (agent.batchModeArgs && inBatchMode) {
		// Skip batch mode args (e.g. -y, --dangerously-bypass-approvals-and-sandbox)
		// when in read-only mode. Batch mode args grant write/approval permissions
		// that conflict with read-only intent, regardless of whether the agent has
		// CLI-enforced read-only mode or prompt-only enforcement.
		if (!isReadOnly) {
			finalArgs = [...finalArgs, ...agent.batchModeArgs];
		}
	}

	// Only inject JSON output args when a prompt is provided (batch/non-interactive mode).
	// Interactive sessions must not receive these flags (e.g., Copilot rejects --output-format json
	// in interactive mode). Agents that need JSON output in interactive mode should include
	// the relevant flags in their base `args` or `batchModeArgs` instead.
	if (agent.jsonOutputArgs && inBatchMode && !hasJsonOutputFlag(finalArgs, agent.jsonOutputArgs)) {
		finalArgs = [...finalArgs, ...agent.jsonOutputArgs];
	}

	if (agent.workingDirArgs && options.cwd) {
		// Prepend so the directory flag lands before any subcommand (e.g. Codex
		// `exec`). Codex treats `-C` as a root-level global flag - placing it
		// after the subcommand makes it silently ignored (#959).
		finalArgs = [...agent.workingDirArgs(options.cwd), ...finalArgs];
	}

	if (isFullAccess) {
		// Prefer fullAccessArgs over the legacy yoloModeArgs alias.
		const fullArgs = agent.fullAccessArgs ?? agent.yoloModeArgs;
		if (fullArgs) {
			finalArgs = [...finalArgs, ...fullArgs];
		}
	} else if (isReadOnly) {
		if (agent.readOnlyArgs) {
			finalArgs = [...finalArgs, ...agent.readOnlyArgs];
		}
		if (agent.readOnlyCliEnforced === false) {
			logger.warn(
				`Agent ${agent.name}: read-only mode requested but no CLI-level enforcement available`,
				LOG_CONTEXT,
				{ agentId: agent.id }
			);
		}
	}
	// standard mode: no bypass args, no read-only args - agent uses its default permission model

	if (options.modelId && agent.modelArgs) {
		finalArgs = [...finalArgs, ...agent.modelArgs(options.modelId)];
	}

	// Deduplicate repeated flag-style arguments while preserving order.
	// Positional arguments (non-flags) are intentionally left untouched.
	const seenFlags = new Set<string>();
	const dedupe = (args: string[]): string[] =>
		args.filter((arg) => {
			if (!arg.startsWith('-')) return true;
			if (seenFlags.has(arg)) return false;
			seenFlags.add(arg);
			return true;
		});

	const dedupedArgs = dedupe(finalArgs);
	const resumeArgs =
		options.agentSessionId && agent.resumeArgs
			? dedupe(agent.resumeArgs(options.agentSessionId))
			: [];

	// Additional Directories skip the dedupe on purpose. Every provider expresses
	// a multi-directory grant by repeating its flag (`--add-dir a --add-dir b`),
	// and the dedupe above drops repeated flag tokens - it would keep the first
	// `--add-dir`, delete the second, and leave the orphaned path behind as a
	// stray positional that the CLI would read as the prompt.
	//
	// They go BEFORE the resume selector, never after it. Codex resumes with a
	// SUBCOMMAND (`exec ... resume <id>`), and a flag placed after a subcommand
	// belongs to that subcommand: `codex exec resume` has no `--add-dir`, so it
	// answered `unexpected argument '--add-dir' found` and exited 2 before doing
	// anything. A tab's first turn worked and every follow-up died in ~150ms.
	// The selector stays last so it is still ahead of the prompt, which callers
	// append after this function returns.
	return [
		...dedupedArgs,
		...buildAdditionalDirArgs(agent, options.additionalDirectories),
		...resumeArgs,
	];
}

/**
 * Translate the session's directory grants into provider-native CLI args.
 *
 * Returns [] for providers that have no native mechanism - they still receive
 * the grants through the `{{ADDITIONAL_DIRECTORIES}}` system-prompt block, which
 * is built independently of this path. Exported so the CLI spawner
 * (`src/cli/services/agent-spawner.ts`), which assembles args itself rather than
 * calling `buildAgentArgs`, produces byte-identical flags.
 */
export function buildAdditionalDirArgs(
	agent: Pick<AgentConfig, 'additionalDirArgs'> | AgentDefinition | null | undefined,
	dirs: AdditionalDirectory[] | undefined
): string[] {
	if (!agent?.additionalDirArgs || !dirs?.length) {
		return [];
	}
	return agent.additionalDirArgs(dirs);
}

/**
 * Move a SUBCOMMAND resume selector (Codex `resume <id>`) behind every other
 * argument, so nothing appended later lands inside the subcommand.
 *
 * A flag after a subcommand belongs to that subcommand, and `codex exec resume`
 * accepts only a subset of `exec`'s flags. `--add-dir`, `-s`, `--oss`, and
 * `-p` after it fail the turn with exit 2 before Codex does anything, so a
 * tab's first message works and every follow-up dies. Every `exec` flag is
 * honored ahead of `resume` (verified on codex-cli 0.162.1, including `-m`),
 * so the selector can always go last. Flag-style selectors (`--resume <id>`)
 * do not care about order and are returned untouched.
 */
export function placeResumeSelectorLast(
	agent: Pick<AgentConfig, 'resumeArgs' | 'batchModePrefix'> | null | undefined,
	args: string[]
): string[] {
	const template = agent?.resumeArgs?.('');
	const keyword = template?.[0];
	if (!template || !keyword || keyword.startsWith('-')) return args;

	// The subcommand comes after the batch-mode subcommand (`exec`), never in
	// front of it, so a path or value spelled like the keyword earlier on does
	// not match.
	const prefix = agent?.batchModePrefix ?? [];
	const searchFrom = prefix.length > 0 ? args.indexOf(prefix[prefix.length - 1]) + 1 : 0;
	const start = args.indexOf(keyword, searchFrom);
	const end = start + template.length;
	if (start < 0 || end > args.length || end === args.length) return args;

	return [...args.slice(0, start), ...args.slice(end), ...args.slice(start, end)];
}

/** Apply agent configuration overrides (custom args, env vars, model selection) to base args. */
export function applyAgentConfigOverrides(
	agent: AgentConfigOverridable | AgentDefinition | AgentConfig | null | undefined,
	baseArgs: string[],
	overrides: AgentConfigOverrides
): AgentConfigResolution {
	let finalArgs = [...baseArgs];
	const agentConfigValues = overrides.agentConfigValues ?? {};
	let modelSource: AgentConfigResolution['modelSource'] = 'default';

	// Flags that read-only mode pins (e.g. OpenCode's `--agent plan`). Config
	// options and custom args repeating one of these are dropped below so the
	// user's plan-mode intent isn't overridden later on the command line.
	const { flags: readOnlyPinnedFlags, valueTakingFlags: readOnlyValueTakingFlags } =
		overrides.readOnlyMode
			? classifyReadOnlyFlags(agent?.readOnlyArgs ?? [])
			: { flags: new Set<string>(), valueTakingFlags: new Set<string>() };
	// Codex's bypass flag defeats --sandbox read-only even when it is appended
	// by a custom override rather than the batch defaults.
	if (overrides.readOnlyMode && agent?.id === 'codex') {
		for (const flag of agent.yoloModeArgs ?? []) readOnlyPinnedFlags.add(flag);
		readOnlyPinnedFlags.add('--yolo');
		readOnlyPinnedFlags.add('--full-auto');
		// Codex also accepts -s as an alias for --sandbox.
		readOnlyPinnedFlags.add('-s');
		readOnlyValueTakingFlags.add('-s');
	}

	if (agent && agent.configOptions) {
		for (const option of agent.configOptions) {
			if (!option.argBuilder) {
				continue;
			}

			let value: any;
			if (option.key === 'model') {
				if (overrides.sessionCustomModel !== undefined && overrides.sessionCustomModel !== '') {
					value = overrides.sessionCustomModel;
					modelSource = 'session';
				} else if (agentConfigValues[option.key] !== undefined) {
					value = agentConfigValues[option.key];
					modelSource = 'agent';
				} else {
					value = option.default;
					modelSource = 'default';
				}
			} else if (
				(option.key === 'effort' || option.key === 'reasoningEffort') &&
				overrides.sessionCustomEffort !== undefined &&
				overrides.sessionCustomEffort !== ''
			) {
				// Empty means "cleared" and falls through to the agent-level config, the
				// same rule `model` uses above - and the same order the effort pill shows
				// (tab > agent override > agent config).
				value = overrides.sessionCustomEffort;
			} else {
				value =
					agentConfigValues[option.key] !== undefined
						? agentConfigValues[option.key]
						: option.default;
			}

			// Type assertion needed because AgentConfigOption is a discriminated union
			// and we're handling all types generically here
			const argBuilderFn = option.argBuilder as (value: unknown) => string[];
			const builtArgs = argBuilderFn(value);
			const optionArgs = stripFlags(builtArgs, readOnlyPinnedFlags, readOnlyValueTakingFlags);

			if (optionArgs.length !== builtArgs.length) {
				logger.debug(
					`Dropped config option "${option.key}" args that conflict with read-only mode`,
					LOG_CONTEXT
				);
			}

			finalArgs = [...finalArgs, ...optionArgs];
		}
	}

	const effectiveCustomArgs = overrides.sessionCustomArgs ?? agentConfigValues.customArgs;
	let customArgsSource: AgentConfigResolution['customArgsSource'] = overrides.sessionCustomArgs
		? 'session'
		: agentConfigValues.customArgs
			? 'agent'
			: 'none';

	const parsedCustomArgs = stripFlags(
		parseCustomArgs(effectiveCustomArgs),
		readOnlyPinnedFlags,
		readOnlyValueTakingFlags
	);
	if (parsedCustomArgs.length > 0) {
		finalArgs = [...finalArgs, ...parsedCustomArgs];
	} else {
		customArgsSource = 'none';
	}

	if (overrides.readOnlyMode && agent?.id === 'codex') {
		// Profiles and arbitrary TOML overrides can change the permission policy.
		// Only the existing model/effort/summary overrides are understood here.
		for (let i = 0; i < finalArgs.length; i++) {
			const arg = finalArgs[i];
			if (/^(?:--profile(?:=|$)|-p|-s.+)/.test(arg))
				throw new Error('CodexReadOnlyConfigUnsupported');
			let config: string | undefined;
			if (arg === '-c' || arg === '--config') config = finalArgs[++i] ?? '';
			else if (arg.startsWith('--config=')) config = arg.slice('--config='.length);
			else if (arg.startsWith('-c') && arg.length > 2) config = arg.slice(2).replace(/^=/, '');
			if (
				config !== undefined &&
				(!/^\s*(model|model_reasoning_effort|model_reasoning_summary)\s*=/.test(config) ||
					/[\r\n]/.test(config))
			)
				throw new Error('CodexReadOnlyConfigUnsupported');
		}
	}

	// Env vars: agent defaults (lowest), then ONE user-configured set on top. The
	// session's own vars REPLACE the provider-level set rather than layering over
	// it, so an agent that sets any var of its own receives none of the provider's.
	// Usage attribution follows the same rule (`effectiveAgentCustomEnvVars`).
	const userEnvVars =
		overrides.sessionCustomEnvVars ??
		(agentConfigValues.customEnvVars as Record<string, string> | undefined);
	const agentDefaultEnvVars = agent?.defaultEnvVars;

	// Start with agent defaults, then layer on user config
	let effectiveCustomEnvVars: Record<string, string> | undefined;
	if (agentDefaultEnvVars || userEnvVars) {
		effectiveCustomEnvVars = {
			...(agentDefaultEnvVars || {}),
			...(userEnvVars || {}),
		};
	}

	// Config options and custom args were appended after `buildAgentArgs()` put
	// the resume selector last; put it back behind them.
	finalArgs = placeResumeSelectorLast(agent, finalArgs);

	const hasEnvVars = effectiveCustomEnvVars && Object.keys(effectiveCustomEnvVars).length > 0;
	const customEnvSource: AgentConfigResolution['customEnvSource'] = overrides.sessionCustomEnvVars
		? 'session'
		: agentConfigValues.customEnvVars
			? 'agent'
			: 'none';

	return {
		args: finalArgs,
		effectiveCustomEnvVars: hasEnvVars ? effectiveCustomEnvVars : undefined,
		customArgsSource,
		customEnvSource: hasEnvVars ? customEnvSource : 'none',
		modelSource,
	};
}

/** Resolve the effective context window size from session, agent config, or defaults. */
export function getContextWindowValue(
	agent: AgentConfig | null | undefined,
	agentConfigValues: Record<string, any>,
	sessionCustomContextWindow?: number
): number {
	// Session-level override takes priority
	if (typeof sessionCustomContextWindow === 'number' && sessionCustomContextWindow > 0) {
		return sessionCustomContextWindow;
	}
	// Fall back to agent-level config
	const contextWindowOption = agent?.configOptions?.find(
		(option) => option.key === 'contextWindow' && option.type === 'number'
	);
	// Extract default value, ensuring it's a number (contextWindow should always be a number config)
	const defaultValue = contextWindowOption?.default;
	const contextWindowDefault = typeof defaultValue === 'number' ? defaultValue : 0;
	return typeof agentConfigValues.contextWindow === 'number'
		? agentConfigValues.contextWindow
		: contextWindowDefault;
}

/**
 * Known YOLO/permission-bypass flags that should be filtered from base args
 * when running in read-only mode. Safety net for agents that embed these
 * flags in their base args without defining yoloModeArgs.
 */
const KNOWN_YOLO_FLAGS = new Set([
	'--dangerously-skip-permissions',
	'--dangerously-bypass-approvals-and-sandbox',
	'--skip-permissions-unsafe',
	'-y',
	'--allow-all',
]);

/**
 * Filters YOLO/permission-bypass flags from agent args for read-only mode.
 * Combines agent-specific yoloModeArgs with known static flags.
 */
export function filterYoloArgs(args: string[], agent: { yoloModeArgs?: string[] }): string[] {
	const yoloFlags = new Set(KNOWN_YOLO_FLAGS);
	if (agent.yoloModeArgs) {
		for (const flag of agent.yoloModeArgs) {
			yoloFlags.add(flag);
		}
	}
	return args.filter((arg) => !yoloFlags.has(arg));
}
