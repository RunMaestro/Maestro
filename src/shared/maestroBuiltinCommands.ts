/**
 * Maestro's own slash commands: the ones Maestro runs itself instead of sending to the provider.
 *
 * The composer runs each one where the agent's turns run. For a local or SSH agent that is this
 * Maestro; for a hosted agent it is the Federation host, which receives the text as a send and
 * runs the same command for that tab (`runMaestroBuiltinCommand()` in the renderer). A headless
 * host has no command runner, so it refuses one instead of handing the literal text to the
 * provider as a message.
 *
 * One parser, so the composer, the host, and the headless host agree on what counts as one.
 */

import { parseSideQuestion } from './sideQuestion';
import type { ToolType } from './types';

export type MaestroBuiltinCommand =
	/** Write a History synopsis of the tab's conversation. */
	| { name: '/history' }
	/** List the Claude Code skills of the project. */
	| { name: '/skills' }
	/** Start the inline planning wizard, with optional opening text. */
	| { name: '/wizard'; args: string }
	/** Ask the tab's model a side question; '' when no question was given. */
	| { name: '/btw'; question: string };

/**
 * The Maestro built-in `text` names for an agent of `toolType`, or null when it is a message (or a
 * provider's own slash command, which goes to the provider as typed). `/skills` and `/btw` belong
 * to Claude Code only; for any other provider they are its own text.
 */
export function parseMaestroBuiltinCommand(
	text: string,
	toolType: ToolType | string | undefined
): MaestroBuiltinCommand | null {
	const command = text.trim();
	if (command === '/history') return { name: '/history' };
	if (command === '/wizard' || command.startsWith('/wizard ')) {
		return { name: '/wizard', args: command.slice('/wizard'.length).trim() };
	}
	if (toolType === 'claude-code') {
		if (command === '/skills') return { name: '/skills' };
		const question = parseSideQuestion(command);
		if (question !== null) return { name: '/btw', question };
	}
	return null;
}
