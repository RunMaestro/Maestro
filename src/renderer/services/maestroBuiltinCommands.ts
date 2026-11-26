/**
 * Running one of Maestro's own slash commands (`parseMaestroBuiltinCommand()`) for a given tab,
 * from outside the composer.
 *
 * The composer runs `/history` and `/skills` on the active tab. A send that arrives from elsewhere
 * (a Federation client sending to the agent this Maestro hosts, `maestro-cli dispatch --queue`)
 * names its own tab, and must run the same command there, so the hosted agent's user gets what a
 * local agent's user gets: the same transcript entries, the same History entry, written here and
 * mirrored back.
 *
 * The handlers live inside App's hook tree (`useWizardHandlers`), so App registers them once here.
 * `/wizard` and `/btw` are not run this way: each draws in the composer of the window that typed
 * it (the wizard panel, the side-question card), which a remote send has no access to.
 */

import {
	runsOutsideComposer,
	type MaestroBuiltinCommand,
} from '../../shared/maestroBuiltinCommands';

/** The tab a built-in runs for. */
export interface BuiltinCommandTarget {
	sessionId: string;
	tabId: string;
}

export interface MaestroBuiltinCommandHandlers {
	history: (target: BuiltinCommandTarget) => Promise<void>;
	skills: (target: BuiltinCommandTarget) => Promise<void>;
}

let handlers: MaestroBuiltinCommandHandlers | null = null;

/** Wire the handlers. Called once by App, and with `null` on teardown. */
export function registerMaestroBuiltinCommandHandlers(
	next: MaestroBuiltinCommandHandlers | null
): void {
	handlers = next;
}

/** Re-exported: the rule lives with the parser, so a headless host reads it too. */
export { runsOutsideComposer };

/**
 * Start `command` for `target`. Answers true when it started (the caller must not also send the
 * text as a message), false when this window cannot run it: no handlers yet, or a command that
 * needs the composer. A failure inside the command is written to the tab's transcript by the
 * handler, as the composer's run writes it.
 */
export function runMaestroBuiltinCommand(
	command: MaestroBuiltinCommand,
	target: BuiltinCommandTarget
): boolean {
	if (!handlers || !runsOutsideComposer(command)) return false;
	const run = command.name === '/history' ? handlers.history : handlers.skills;
	void run(target);
	return true;
}
