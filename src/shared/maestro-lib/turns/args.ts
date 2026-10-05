/**
 * The argument list of a turn, and where Maestro's system prompt goes in it.
 *
 * This is the part of `handleProcessSpawn` that decides arguments from nothing but its
 * inputs: the provider's own arguments, the permission and resume flags, the provider
 * config options and custom arguments, and the system prompt delivery. The desktop calls
 * it; so does `assembleTurn`, which is how a TUI turn gets the argument list a desktop
 * turn gets. What stays in the desktop is everything with a side effect or a dependency
 * on the app: the MCP plugin bridge, the permission relay, the Windows temp file, the
 * maestro-p swap, and SSH wrapping.
 */

import { embedSystemPromptInPrompt } from '../../embeddedSystemPrompt';
import type { AdditionalDirectory } from '../../types';
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
