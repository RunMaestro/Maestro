/**
 * agentNameSuggestions.ts
 *
 * Fun names the wizard pre-fills its agent-name field with.
 *
 * The field used to open EMPTY and blocked Continue, which made naming the
 * agent read as the first real decision of setup rather than the throwaway
 * label it is. New users typed their PROJECT's name into it, and the next
 * screen then addressed them as the project (see issue #1225). A pre-filled
 * suggestion turns the field into something to skip past or re-roll, and the
 * name it lands on is obviously not a project name.
 *
 * Same shuffled-queue shape as `fillerPhrases.ts`: every name is offered once
 * before any repeats, so re-rolling a few times cannot hand back what is
 * already in the box.
 */

import { shuffle } from './shuffle';

/**
 * Computing pioneers, classic automatons, and machine-shop nouns. Deliberately
 * single words: the name is drawn in the Left Bar and as the speaker label on
 * every wizard bubble, both of which are narrow.
 */
const AGENT_NAME_SUGGESTIONS = [
	'Ada',
	'Turing',
	'Hopper',
	'Lovelace',
	'Babbage',
	'Shannon',
	'Hamming',
	'Knuth',
	'Ritchie',
	'Kernighan',
	'Dijkstra',
	'Backus',
	'Liskov',
	'Noether',
	'Robby',
	'Gort',
	'Talos',
	'Golem',
	'Automaton',
	'Clank',
	'Sprocket',
	'Rivet',
	'Solder',
	'Piston',
	'Flywheel',
	'Dynamo',
	'Solenoid',
	'Armature',
	'Servo',
	'Relay',
	'Chassis',
	'Turbine',
	'Filament',
	'Circuit',
	'Cipher',
	'Sentinel',
	'Beacon',
	'Echo',
	'Vector',
	'Nimbus',
	'Quasar',
	'Pulsar',
	'Zephyr',
	'Atlas',
	'Orion',
	'Vega',
	'Lyra',
	'Nova',
	'Halcyon',
	'Meridian',
];

/** Shuffled queue of suggestions for the current session. */
let suggestionQueue: string[] = [];

/**
 * Pick a name to pre-fill the wizard's agent-name field with.
 *
 * @param exclude - A name the caller already has on screen. Re-rolling must
 *   visibly change the field, so a queue that surfaces the current name is
 *   advanced past it rather than handed back.
 * @returns A suggested agent name.
 */
export function suggestAgentName(exclude?: string): string {
	for (let attempt = 0; attempt < 2; attempt++) {
		if (suggestionQueue.length === 0) {
			suggestionQueue = shuffle(AGENT_NAME_SUGGESTIONS);
		}
		const candidate = suggestionQueue.pop()!;
		if (candidate !== exclude) return candidate;
	}
	// Both draws matched `exclude`, which needs a reshuffle to have put the same
	// name on top twice. Refill and take whatever is next rather than looping.
	if (suggestionQueue.length === 0) {
		suggestionQueue = shuffle(AGENT_NAME_SUGGESTIONS);
	}
	return suggestionQueue.pop()!;
}

/** Every suggestion (for tests and display purposes). */
export function getAllAgentNameSuggestions(): readonly string[] {
	return AGENT_NAME_SUGGESTIONS;
}
