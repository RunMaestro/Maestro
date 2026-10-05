/**
 * The text of a turn: what the user prompt and the system prompt are made of.
 *
 * These layers used to be written out inside the composer (`useInputProcessing`), the
 * queue drain (`agentStore.processQueuedItem`), and the spawn helper
 * (`prepareMaestroSystemPrompt`). The TUI needs the same text, so the pure rules live
 * here and each of those calls them. Every function reproduces the desktop byte for
 * byte, quirks included: a rule that looks wrong here is wrong in both places, and is
 * fixed in one change for both (see `Plans/maestro-tui-prompt-assembly.md`, F1 to F13).
 */

import { prependNewSessionMessage } from '../../newSessionMessage';
import { substituteTemplateVariables, type TemplateSessionInfo } from '../../templateVariables';

/** The rule between two layers of a prompt. */
export const PROMPT_LAYER_SEPARATOR = '\n\n---\n\n';

/**
 * Appended to a read-only turn. A plan-mode agent otherwise writes its plan to a file
 * the user never asked for; this asks for it in the reply instead.
 */
export const READ_ONLY_PLAN_INSTRUCTION =
	'\n\n---\n\nIMPORTANT: You are in read-only/plan mode. Do NOT write a plan file. Instead, return your plan directly to the user in beautiful markdown formatting.';

/**
 * The agent's nudge: standing text sent after every interactive AI message and never
 * shown in the transcript. A truthy check, as on the desktop: a nudge that is only
 * whitespace is still appended.
 */
export function appendNudgeMessage(text: string, nudgeMessage?: string): string {
	return nudgeMessage ? `${text}${PROMPT_LAYER_SEPARATOR}${nudgeMessage}` : text;
}

export interface MessagePromptInput {
	/** The typed text, with the nudge already appended (`appendNudgeMessage`). */
	text: string;
	hasImages: boolean;
	/** The prompt an image-only message is sent as (`image-only-default`). */
	imageOnlyDefault: string;
	/** The tab already has a provider session. The new-session message rides the first turn only. */
	hasProviderSession: boolean;
	newSessionMessage?: string;
	readOnly: boolean;
}

/**
 * The composer's layering of one message:
 *
 * 1. An image-only message becomes the default prompt. The test sees the text AFTER the
 *    nudge, so with a nudge set an image-only message is just the nudge (F5).
 * 2. The first turn of a provider session gets the new-session message in front.
 * 3. A read-only turn gets the plan instruction behind.
 */
export function buildMessagePrompt(input: MessagePromptInput): string {
	let prompt = input.hasImages && !input.text.trim() ? input.imageOnlyDefault : input.text;
	if (!input.hasProviderSession) {
		prompt = prependNewSessionMessage(prompt, input.newSessionMessage);
	}
	if (input.readOnly) {
		prompt += READ_ONLY_PLAN_INSTRUCTION;
	}
	return prompt;
}

/**
 * Put a tab's pending merged context (merge, Send to Agent, session recovery) in front
 * of the prompt. The caller clears the field: this only builds the text.
 */
export function prependMergedContext(prompt: string, context?: string): string {
	return context ? `${context}${PROMPT_LAYER_SEPARATOR}${prompt}` : prompt;
}

/**
 * Expand a Maestro command's prompt with the arguments typed after it. Every
 * `$ARGUMENTS` is replaced; with no placeholder the arguments follow the prompt; with
 * no arguments the placeholder is removed.
 */
export function expandCommandArguments(prompt: string, args?: string): string {
	if (args) {
		if (/\$ARGUMENTS/.test(prompt)) {
			return prompt.replace(/\$ARGUMENTS/g, args);
		}
		return `${prompt}\n\n${args}`;
	}
	return prompt.replace(/\$ARGUMENTS/g, '');
}

/** A Maestro command: a name and the prompt it expands to. */
export interface TurnCommand {
	command: string;
	description?: string;
	prompt: string;
}

/** A command the text named, with what followed it. */
export interface ResolvedCommand extends TurnCommand {
	args: string;
}

/**
 * Whether `text` names a Maestro command, as the composer decides it: the first word
 * against the custom AI commands, then against the commands the agent discovered that
 * carry a prompt. No match is plain text, so an unmatched `/x` goes to the provider.
 */
export function resolveSlashCommand(
	text: string,
	commands: readonly TurnCommand[],
	agentCommands: readonly { command: string; description?: string; prompt?: string }[] = []
): ResolvedCommand | undefined {
	const commandText = text.trim();
	if (!commandText.startsWith('/')) return undefined;

	const firstSpaceIndex = commandText.indexOf(' ');
	const baseCommand =
		firstSpaceIndex === -1 ? commandText : commandText.substring(0, firstSpaceIndex);
	const args = firstSpaceIndex === -1 ? '' : commandText.substring(firstSpaceIndex + 1).trim();

	const custom = commands.find((cmd) => cmd.command === baseCommand);
	if (custom) {
		return {
			command: custom.command,
			description: custom.description,
			prompt: custom.prompt,
			args,
		};
	}
	const discovered = agentCommands.find((cmd) => cmd.command === baseCommand && cmd.prompt);
	if (discovered) {
		return {
			command: discovered.command,
			description: discovered.description,
			prompt: discovered.prompt!,
			args,
		};
	}
	return undefined;
}

export interface MaestroSystemPromptInput {
	/** The `maestro-system-prompt` template, directives resolved. */
	template: string;
	session: TemplateSessionInfo;
	gitBranch?: string;
	groupId?: string;
	activeTabId?: string;
	/** The agent's history file, when it exists and the agent runs on this machine. */
	historyFilePath?: string;
	conductorProfile?: string;
	/** The `maestro-cli.js` script `{{MAESTRO_CLI_PATH}}` names. Absent: the host's default. */
	maestroCliPath?: string;
	now?: Date;
	/** The Pianola manager instructions, appended for the pinned manager agent. */
	pianolaPrompt?: string;
}

/**
 * Maestro's system prompt for one turn: the template with its variables filled in. The
 * pinned Pianola manager agent gets its manager instructions appended, which is what
 * turns a plain chat into Maestro's orchestrator. The CLI path and the agent's own id
 * reach that agent as env vars, so its prompt names them as shell variables.
 */
export function buildMaestroSystemPrompt(input: MaestroSystemPromptInput): string {
	const base = substituteTemplateVariables(input.template, {
		session: input.session,
		gitBranch: input.gitBranch,
		groupId: input.groupId,
		activeTabId: input.activeTabId,
		historyFilePath: input.historyFilePath,
		conductorProfile: input.conductorProfile,
		maestroCliPath: input.maestroCliPath,
		now: input.now,
	});
	return input.pianolaPrompt ? `${base}${PROMPT_LAYER_SEPARATOR}${input.pianolaPrompt}` : base;
}
