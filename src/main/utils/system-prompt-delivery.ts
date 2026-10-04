/**
 * How a Maestro system prompt reaches a spawned agent.
 *
 * Shared by the desktop `process:spawn` handler, Cue runs, and Group Chat (and
 * cross-agent consults, which spawn through Group Chat's helper), so every
 * main-process spawn delivers it the same way:
 *
 * - Agents with native support (`supportsAppendSystemPrompt`, e.g. Claude Code)
 *   get `--append-system-prompt <text>` on every invocation, resume included:
 *   the flag is metadata, not conversation content, and Claude Code does not
 *   persist it into the session transcript.
 * - On Windows local execution the text goes to a temp file passed with
 *   `--append-system-prompt-file`, so it cannot blow the ~32K CreateProcess
 *   command-line limit. SSH spawns are exempt (the command runs inside a stdin
 *   script, not the OS command line) and always pass it inline.
 * - Agents without native support get it embedded into the user prompt
 *   (`embedSystemPromptInPrompt`). That first turn is kept in the agent's own
 *   transcript, so a resumed turn skips re-embedding rather than repeating the
 *   whole system prompt in every message.
 * - With no user prompt to embed into, the system prompt becomes the prompt.
 *
 * The CLI (`src/cli/services/agent-spawner.ts`) keeps its own copy: it cannot
 * import main modules, and its temp-file lifecycle differs (it falls back to
 * inline on a write failure and cleans up when the child exits). The one piece
 * worth sharing, the embed envelope, already lives in `src/shared`.
 */

import * as os from 'os';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { isWindows } from '../../shared/platformDetection';
import { embedSystemPromptInPrompt } from '../../shared/embeddedSystemPrompt';
import { logger } from './logger';
import { captureException } from './sentry';

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
export type SystemPromptDelivery =
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
}

export interface SystemPromptDeliveryResult {
	args: string[];
	prompt: string | undefined;
	/** Set when the prompt went to a Windows temp file (cleaned up after the TTL). */
	tempFile?: string;
	/** Undefined when there was no system prompt to deliver. */
	delivery?: SystemPromptDelivery;
}

/**
 * Apply the system prompt to a spawn's args/prompt. Returns new values; the
 * inputs are not mutated.
 */
export async function applySystemPromptDelivery(
	input: SystemPromptDeliveryInput
): Promise<SystemPromptDeliveryResult> {
	const { args, prompt, systemPrompt, sessionId, agentId } = input;
	const logContext = input.logContext ?? '[SystemPromptDelivery]';
	if (!systemPrompt) return { args, prompt };

	if (input.supportsAppendSystemPrompt) {
		if (isWindows() && !input.isSshSession) {
			// Windows local: write to temp file to avoid CLI length limits
			const tempFile = path.join(os.tmpdir(), `maestro-sysprompt-${sessionId}-${Date.now()}.txt`);
			await fsp.writeFile(tempFile, systemPrompt, 'utf-8');
			// Schedule cleanup early so the file is removed even if spawn fails.
			// Fire-and-forget unlink mirrors process-manager/utils/imageUtils.cleanupTempFiles:
			// silence ENOENT (file already gone), capture other codes via Sentry.
			setTimeout(() => {
				fsp.unlink(tempFile).catch((cleanupErr: unknown) => {
					if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
						captureException(
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
		// Non-Windows or SSH: pass inline (no command-line length concern)
		logger.debug('Using --append-system-prompt for system prompt delivery', logContext, {
			agentId,
			systemPromptLength: systemPrompt.length,
		});
		return {
			args: [...args, '--append-system-prompt', systemPrompt],
			prompt,
			delivery: 'cli-arg',
		};
	}

	if (input.isResume) {
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
		return { args, prompt, delivery: 'skipped-resume' };
	}

	if (prompt) {
		// The envelope is built by the shared helper because the transcript
		// renderer has to take it back apart again when a tab is hydrated from
		// disk (see src/shared/embeddedSystemPrompt.ts).
		logger.debug('Embedding system prompt in user message (fallback)', logContext, {
			agentId,
			systemPromptLength: systemPrompt.length,
		});
		return { args, prompt: embedSystemPromptInPrompt(systemPrompt, prompt), delivery: 'embedded' };
	}

	logger.warn(
		'appendSystemPrompt provided without a user prompt; using as sole prompt',
		logContext,
		{
			agentId,
			systemPromptLength: systemPrompt.length,
		}
	);
	return { args, prompt: systemPrompt, delivery: 'sole-prompt' };
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
