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
import { logger } from '../utils/logger';
import { flushSessionPersistenceNow } from './sessionPersistenceFlush';

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
	const running = run(target);
	// What the command wrote before its first wait (the `/skills` row, "Generating history
	// synopsis..."), then what it wrote at the end, reach the client at once, as a headless host's do.
	announceTranscriptChanged(target);
	void running.then(
		() => announceTranscriptChanged(target),
		() => announceTranscriptChanged(target)
	);
	return true;
}

/**
 * Tell this Maestro's Federation clients that `target`'s transcript grew outside a turn, so the
 * client that sent the command draws its rows now instead of at the tab's next turn. A client reads
 * the stored tab, so the store is flushed first.
 */
function announceTranscriptChanged(target: BuiltinCommandTarget): void {
	void flushSessionPersistenceNow()
		.then(() =>
			window.maestro?.process?.broadcastTranscriptChanged?.(target.sessionId, target.tabId)
		)
		.catch((error: unknown) => {
			// The rows are written either way: a client that misses this reads them at the next turn.
			logger.warn('[runMaestroBuiltinCommand] could not tell clients the tab changed', undefined, {
				error: error instanceof Error ? error.message : String(error),
			});
		});
}
