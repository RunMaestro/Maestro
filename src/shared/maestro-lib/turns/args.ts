/**
 * The argument list of a turn, and where Maestro's system prompt goes in it.
 *
 * This is the part of `handleProcessSpawn` that decides arguments from nothing but its
 * inputs: the provider's own arguments, the permission and resume flags, the provider
 * config options and custom arguments, and the system prompt delivery. The desktop calls
 * it; so does `assembleTurn`, which is how a TUI turn gets the argument list a desktop
 * turn gets. What stays in the desktop is everything with a side effect or a dependency
 * on the app: the MCP plugin bridge, the permission relay, the maestro-p swap, and SSH
 * wrapping.
 *
 * The one side effect kept here is the system prompt's realization (`deliverSystemPrompt`):
 * the Windows temp file, its cleanup, and the logging. Every spawn that carries a system
 * prompt, on the desktop and in the headless runtime, delivers it through that one function.
 */

import { randomUUID } from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { embedSystemPromptInPrompt } from '../../embeddedSystemPrompt';
import { isWindows } from '../../platformDetection';
import type { AdditionalDirectory } from '../../types';
import { captureException, logger } from '../host';
import {
	applyAgentConfigOverrides,
	buildAgentArgs,
	type AgentConfigResolution,
} from '../launch/agent-args';
import { resolveSystemPromptDelivery, type SystemPromptDelivery } from '../launch/prompt-delivery';
import type { AgentConfig } from '../providers/definitions';

export interface TurnArgsInput {
	/** Null for a tool type no provider is registered for: the base arguments pass through. */
	provider: AgentConfig | null | undefined;
	/**
	 * The provider's arguments to start from. A read-only turn passes them through
	 * `filterYoloArgs` first: a bypass flag in the base would undo the mode.
	 */
	baseArgs: string[];
	/**
	 * The user prompt as it stands BEFORE the system prompt is folded in. Its presence is
	 * what tells the provider's batch-mode arguments to apply.
	 */
	prompt?: string;
	cwd: string;
	readOnly?: boolean;
	permissionMode?: 'full' | 'standard' | 'readonly';
	/** Chat never sets these two; the desktop's spawn handler still accepts them. */
	modelId?: string;
	yoloMode?: boolean;
	resumeSessionId?: string;
	additionalDirectories?: AdditionalDirectory[];
	/** `maestro-agent-configs.json` `configs[toolType]`. */
	providerConfig: Readonly<Record<string, unknown>>;
	sessionCustomModel?: string;
	sessionCustomEffort?: string;
	sessionCustomArgs?: string;
	sessionCustomEnvVars?: Record<string, string>;
}

export interface TurnArgs {
	args: string[];
	/** Where the model, custom arguments and environment came from (agent or provider level). */
	resolution: AgentConfigResolution;
}

/**
 * The provider's arguments for a turn: its mode and permission flags and resume
 * arguments (`buildAgentArgs`), then every config option and the custom arguments
 * (`applyAgentConfigOverrides`), in that order.
 *
 * `readOnlyMode` is deliberately NOT handed to the overrides, as on the desktop: a
 * config option or custom argument that repeats a read-only flag lands after it and
 * wins (F10). Fixing that is one change for both surfaces, not a difference here.
 */
export function buildTurnArgs(input: TurnArgsInput): TurnArgs {
	const built = buildAgentArgs(input.provider, {
		baseArgs: input.baseArgs,
		prompt: input.prompt,
		cwd: input.cwd,
		readOnlyMode: input.readOnly,
		modelId: input.modelId,
		yoloMode: input.yoloMode,
		permissionMode: input.permissionMode,
		agentSessionId: input.resumeSessionId,
		additionalDirectories: input.additionalDirectories,
	});
	const resolution = applyAgentConfigOverrides(input.provider, built, {
		agentConfigValues: input.providerConfig as Record<string, unknown>,
		sessionCustomModel: input.sessionCustomModel,
		sessionCustomEffort: input.sessionCustomEffort,
		sessionCustomArgs: input.sessionCustomArgs,
		sessionCustomEnvVars: input.sessionCustomEnvVars,
	});
	return { args: resolution.args, resolution };
}

export interface SystemPromptPlacementInput {
	systemPrompt: string | undefined;
	/** The provider's own arguments so far. */
	args: string[];
	/** The user prompt, before the system prompt is folded in. */
	prompt: string | undefined;
	supportsAppendSystemPrompt: boolean;
	isResume: boolean;
	isWindowsHost: boolean;
	/** The turn runs on an SSH remote: no command-line limit, so never a file. */
	sshRemote: boolean;
}

export interface SystemPromptPlacement {
	args: string[];
	prompt: string | undefined;
	delivery: SystemPromptDelivery;
}

/**
 * Put Maestro's system prompt where the provider takes it.
 *
 * - `flag`: `--append-system-prompt <text>` on the command line, every turn (the flag is
 *   not kept in the provider's transcript, so a resumed turn needs it again).
 * - `file`: a Windows host cannot hold a large inline prompt. The caller writes the text
 *   to a temp file and appends `--append-system-prompt-file <path>`; nothing changes here.
 * - `embed`: a provider with no flag gets the prompt at the top of its FIRST user turn
 *   (`embedSystemPromptInPrompt`, a wire format the transcript reader takes apart again).
 * - `skip-on-resume`: that first turn is already in the transcript, so a resume sends nothing.
 * - `as-prompt`: nothing to embed into, so the system prompt IS the prompt.
 */
export function applySystemPromptDelivery(
	input: SystemPromptPlacementInput
): SystemPromptPlacement {
	const delivery = resolveSystemPromptDelivery({
		systemPrompt: input.systemPrompt,
		supportsAppendSystemPrompt: input.supportsAppendSystemPrompt,
		isWindowsHost: input.isWindowsHost,
		sshRemote: input.sshRemote,
		isResume: input.isResume,
		hasUserPrompt: !!input.prompt,
	});
	const systemPrompt = input.systemPrompt as string;
	switch (delivery.via) {
		case 'flag':
			return {
				args: [...input.args, '--append-system-prompt', systemPrompt],
				prompt: input.prompt,
				delivery,
			};
		case 'embed':
			return {
				args: input.args,
				prompt: embedSystemPromptInPrompt(systemPrompt, input.prompt as string),
				delivery,
			};
		case 'as-prompt':
			return { args: input.args, prompt: systemPrompt, delivery };
		case 'file':
		case 'skip-on-resume':
		case 'none':
			return { args: input.args, prompt: input.prompt, delivery };
	}
}

/** How long a Windows temp prompt file lives; the agent reads it at startup. */
export const SYSTEM_PROMPT_TEMP_FILE_TTL_MS = 30_000;

/**
 * What happened to the system prompt.
 * - `file`: `--append-system-prompt-file <tmp>` (Windows local)
 * - `cli-arg`: `--append-system-prompt <text>`
 * - `embedded`: wrapped into the user prompt
 * - `skipped-resume`: not re-sent; already in the resumed transcript
 * - `sole-prompt`: no user prompt, so the system prompt was sent as the prompt
 */
export type DeliveredSystemPrompt =
	| 'file'
	| 'cli-arg'
	| 'embedded'
	| 'skipped-resume'
	| 'sole-prompt';

export interface SystemPromptDeliveryInput {
	/** Agent args so far; the flag (when used) is appended. */
	args: string[];
	/** The user prompt, if any. */
	prompt: string | undefined;
	/** The assembled Maestro system prompt. Nothing happens when empty. */
	systemPrompt: string | undefined;
	/** `capabilities.supportsAppendSystemPrompt` for this agent. */
	supportsAppendSystemPrompt: boolean;
	/** True when this spawn resumes an existing provider session. */
	isResume: boolean;
	/** True when the spawn is wrapped for an SSH remote (never uses a temp file). */
	isSshSession: boolean;
	/** Used in the temp file name so concurrent spawns never collide. */
	sessionId: string;
	/** For debug logs only. */
	agentId?: string;
	/** Logger context of the caller. */
	logContext?: string;
	/** Where a failed temp file cleanup is reported. Default: the library host's reporter. */
	captureException?: SystemPromptCleanupReporter;
}

/** Reports a temp file cleanup that failed for a reason other than the file being gone. */
export type SystemPromptCleanupReporter = (
	error: unknown,
	extra?: Record<string, unknown>
) => Promise<void> | void;

export interface SystemPromptDeliveryResult {
	args: string[];
	prompt: string | undefined;
	/** Set when the prompt went to a Windows temp file (cleaned up after the TTL). */
	tempFile?: string;
	/** Undefined when there was no system prompt to deliver. */
	delivery?: DeliveredSystemPrompt;
}

/**
 * Temp file name for a Windows system prompt. The session id can carry a
 * user-typed agent name (Group Chat participant ids do: `feature/auth`, `a|b`,
 * `what?`), which Windows rejects in a file name, so it is reduced to a safe,
 * capped slug. The random suffix keeps two spawns in the same millisecond apart.
 */
export function systemPromptTempFileName(sessionId: string): string {
	const slug = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
	const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
	return `maestro-sysprompt-${slug}-${Date.now()}-${suffix}.txt`;
}

export interface SystemPromptFileInput {
	/** Agent args so far; the file flag is appended. */
	args: string[];
	prompt: string | undefined;
	systemPrompt: string;
	/** Used in the temp file name so concurrent spawns never collide. */
	sessionId: string;
	/** For debug logs only. */
	agentId?: string;
	/** Logger context of the caller. */
	logContext: string;
	/** Where the file goes. Default: the OS temp directory. */
	tempDir?: string;
	/** Where a failed cleanup is reported. Default: the library host's reporter. */
	captureException?: SystemPromptCleanupReporter;
}

/**
 * The `file` delivery: write the system prompt to an owner-only temp file and append
 * `--append-system-prompt-file <path>`, because a Windows host's command line cannot hold a
 * large inline prompt. A caller whose placement already chose the file (`assembleTurn`) calls
 * this directly; `deliverSystemPrompt` calls it for everyone else.
 */
export async function writeSystemPromptFile(
	input: SystemPromptFileInput
): Promise<SystemPromptDeliveryResult> {
	const { args, prompt, systemPrompt, agentId, logContext } = input;
	const reportCleanupError = input.captureException ?? captureException;
	// Windows local: write to temp file to avoid CLI length limits
	const tempFile = path.join(
		input.tempDir ?? os.tmpdir(),
		systemPromptTempFileName(input.sessionId)
	);
	try {
		// Owner-only: the prompt carries the user's own context.
		await fsp.writeFile(tempFile, systemPrompt, { encoding: 'utf-8', mode: 0o600 });
	} catch (writeErr) {
		// A failed write must not cost the agent its spawn. Inline is what every
		// non-Windows spawn does; only a very long prompt risks the CLI limit.
		logger.warn(
			'System prompt temp file write failed; falling back to inline --append-system-prompt',
			logContext,
			{
				agentId,
				tempFile,
				error: writeErr instanceof Error ? writeErr.message : String(writeErr),
			}
		);
		return {
			args: [...args, '--append-system-prompt', systemPrompt],
			prompt,
			delivery: 'cli-arg',
		};
	}
	// Schedule cleanup early so the file is removed even if spawn fails.
	// Fire-and-forget unlink mirrors process-manager/utils/imageUtils.cleanupTempFiles:
	// silence ENOENT (file already gone), capture other codes via Sentry.
	setTimeout(() => {
		fsp.unlink(tempFile).catch((cleanupErr: unknown) => {
			if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
				void reportCleanupError(
					cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr)),
					{
						context: 'systemPromptTempFile cleanup (safety)',
						file: tempFile,
					}
				);
			}
		});
	}, SYSTEM_PROMPT_TEMP_FILE_TTL_MS);
	logger.debug(
		'Using --append-system-prompt-file for system prompt delivery (Windows)',
		logContext,
		{ agentId, systemPromptLength: systemPrompt.length, tempFile }
	);
	return {
		args: [...args, '--append-system-prompt-file', tempFile],
		prompt,
		tempFile,
		delivery: 'file',
	};
}

/**
 * Deliver a system prompt to one spawn: place it (`applySystemPromptDelivery`, on this host's
 * platform), realize the Windows temp file when that is the placement, and log what happened.
 * Returns new values; the inputs are not mutated. Shared by the desktop `process:spawn` handler,
 * Cue, Group Chat and consults, and the headless runtime's background turns.
 */
export async function deliverSystemPrompt(
	input: SystemPromptDeliveryInput
): Promise<SystemPromptDeliveryResult> {
	const { args, prompt, systemPrompt, sessionId, agentId } = input;
	const logContext = input.logContext ?? '[SystemPromptDelivery]';
	const placed = applySystemPromptDelivery({
		systemPrompt,
		args,
		prompt,
		supportsAppendSystemPrompt: input.supportsAppendSystemPrompt,
		isResume: input.isResume,
		isWindowsHost: isWindows(),
		sshRemote: input.isSshSession,
	});
	if (!systemPrompt || placed.delivery.via === 'none') return { args, prompt };
	const placedValues = { args: placed.args, prompt: placed.prompt };

	switch (placed.delivery.via) {
		case 'file':
			return writeSystemPromptFile({
				args,
				prompt,
				systemPrompt,
				sessionId,
				agentId,
				logContext,
				captureException: input.captureException,
			});
		case 'flag':
			// Non-Windows or SSH: pass inline (no command-line length concern)
			logger.debug('Using --append-system-prompt for system prompt delivery', logContext, {
				agentId,
				systemPromptLength: systemPrompt.length,
			});
			return { ...placedValues, delivery: 'cli-arg' };
		case 'skip-on-resume':
			// The system prompt was embedded in the first user turn at initial spawn
			// and is preserved in the agent's session transcript.
			logger.debug(
				'Skipping system prompt re-injection on resume (already in transcript)',
				logContext,
				{
					agentId,
					systemPromptLength: systemPrompt.length,
				}
			);
			return { ...placedValues, delivery: 'skipped-resume' };
		case 'embed':
			// The envelope is built by the shared helper because the transcript
			// renderer has to take it back apart again when a tab is hydrated from
			// disk (see src/shared/embeddedSystemPrompt.ts).
			logger.debug('Embedding system prompt in user message (fallback)', logContext, {
				agentId,
				systemPromptLength: systemPrompt.length,
			});
			return { ...placedValues, delivery: 'embedded' };
		case 'as-prompt':
			logger.warn(
				'appendSystemPrompt provided without a user prompt; using as sole prompt',
				logContext,
				{
					agentId,
					systemPromptLength: systemPrompt.length,
				}
			);
			return { ...placedValues, delivery: 'sole-prompt' };
	}
}

/**
 * Copy of `args` with the inline system prompt replaced by its length, for
 * logging. The prompt can be large and carries user-specific context.
 */
export function redactSystemPromptArg(args: string[]): string[] {
	const idx = args.indexOf('--append-system-prompt');
	if (idx === -1) return args;
	return [
		...args.slice(0, idx + 1),
		`<${args[idx + 1]?.length ?? 0} chars>`,
		...args.slice(idx + 2),
	];
}

/**
 * Copilot-CLI's batch mode flips into autopilot, where the model ends a run by calling
 * `task_complete`, and its own prompt biases it toward doing that early. The remedy is a
 * preamble in the user prompt of EVERY turn (each spawn is a fresh process): it pushes
 * back on premature completion. The text is user-editable (`copilot-preamble`); a blank
 * one switches it off.
 */
export function applyCopilotPreamble(
	agentId: string,
	prompt: string | undefined,
	preamble: string | undefined
): string | undefined {
	if (agentId !== 'copilot-cli' || !prompt) return prompt;
	const text = (preamble ?? '').trim();
	return text ? `${text}\n\n${prompt}` : prompt;
}
