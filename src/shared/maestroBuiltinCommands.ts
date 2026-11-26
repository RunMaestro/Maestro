/**
 * Maestro's own slash commands: the ones Maestro runs itself instead of sending to the provider.
 *
 * The composer runs each one where the agent's turns run. For a local or SSH agent that is this
 * Maestro; for a hosted agent it is the Federation host, which receives the text as a send and
 * runs the same command for that tab: a desktop host through `runMaestroBuiltinCommand()` in the
 * renderer, a headless host through its runtime (`createRuntimeBuiltinCommands()`). A command
 * neither can run from a remote send (`/wizard`, which draws in the typing window's composer) is
 * refused, never handed to the provider as a message.
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

/**
 * Whether `command` is one a send from outside the composer runs for its tab (`/history`,
 * `/skills`), wherever the agent runs: a desktop host, or a headless host. `/wizard` and `/btw`
 * need the composer of the window that typed them.
 */
export function runsOutsideComposer(command: MaestroBuiltinCommand): boolean {
	return command.name === '/history' || command.name === '/skills';
}
