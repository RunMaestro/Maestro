/**
 * espeak-ng for Kokoro's front end, from the `phonemizer` package.
 *
 * `phonemizer` is espeak-ng compiled to plain JavaScript (an Emscripten
 * wasm2js build, with its voice data embedded): no native addon, no `.wasm`
 * file, no network and no file reads, so it loads the same way on every
 * platform Maestro ships on. English only, which is all the bundled Kokoro
 * voice speaks.
 *
 * **Loading it has one side effect that must be undone.** On import under Node
 * the bundle registers two process-wide handlers:
 *
 *     process.on('uncaughtException', (e) => { if (!(e instanceof ExitStatus)) throw e })
 *     process.on('unhandledRejection', (e) => { throw e })
 *
 * In a process that has its own handlers (Maestro's main process reports to
 * Sentry and keeps running) those two turn ANY later uncaught error, anywhere
 * in the app, into an exit with code 7. So the listeners present before the
 * load are recorded, and whatever the load added is removed. espeak works the
 * same without them: they exist for a command-line program, not a library.
 *
 * The package is Apache-2.0. The espeak-ng it embeds is GPL-3.0-or-later; see
 * THIRD-PARTY-NOTICES.md.
 */

import type { EspeakPhonemize } from './text';

interface PhonemizerModule {
	phonemize(text: string, language?: string): Promise<string[]>;
}

type ErrorEvent = 'uncaughtException' | 'unhandledRejection';
type ProcessListener = (...args: unknown[]) => void;

const SHIELDED_EVENTS: readonly ErrorEvent[] = ['uncaughtException', 'unhandledRejection'];

/** The listeners on one of the two error events, as plain functions. */
function listenersOf(event: ErrorEvent): ProcessListener[] {
	return (process as NodeJS.EventEmitter).listeners(event) as ProcessListener[];
}

/**
 * Run `load`, then remove every process listener it added for the two error
 * events. Exported for its test: the rule is easy to break and silent when
 * broken.
 */
export function withoutAddedErrorHandlers<T>(load: () => T): T {
	const before = SHIELDED_EVENTS.map((event) => new Set(listenersOf(event)));
	try {
		return load();
	} finally {
		SHIELDED_EVENTS.forEach((event, index) => {
			for (const listener of listenersOf(event)) {
				if (!before[index].has(listener)) {
					(process as NodeJS.EventEmitter).removeListener(event, listener);
				}
			}
		});
	}
}

let loaded: PhonemizerModule | null = null;

/** espeak-ng, loaded once. Throws when the package cannot be loaded. */
export function loadEspeak(): EspeakPhonemize {
	loaded ??= withoutAddedErrorHandlers(
		// Loaded on first use, not at startup: 1.3 MB of JavaScript nobody needs
		// until a Kokoro voice is about to speak.
		() => require('phonemizer') as PhonemizerModule
	);
	const module = loaded;
	return (text, language) => module.phonemize(text, language);
}
