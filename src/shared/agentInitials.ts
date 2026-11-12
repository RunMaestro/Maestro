/**
 * Two-character labels for agents, for surfaces too narrow to print a name
 * (the collapsed Left Bar).
 *
 * The labels are chosen for a SET of agents, not one name at a time: two agents
 * that would both read "Ma" are worse than no label at all, because the label
 * is the only thing telling them apart. `buildAgentInitials` therefore hands
 * every agent a ranked list of candidates and resolves collisions across the
 * whole list.
 *
 * Distinct from `abbreviateGroupName` (`formatters.ts`), which shortens ONE
 * name to a variable-length badge and has no notion of its neighbors.
 */

export interface AgentInitialsInput {
	id: string;
	name: string;
}

/** Shown for an agent whose name has nothing printable in it. */
const EMPTY_NAME_LABEL = '?';

/**
 * One word per match: an acronym run ("HTTP" in "HTTPServer"), a capitalized or
 * lowercase word ("Ped" and "Cast" in "PedCast"), an all-caps word, a digit
 * run, or a run of caseless letters (CJK). Punctuation and emoji never match,
 * so they act as separators.
 */
const WORD_PATTERN = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+|\p{L}+/gu;

/** "[ARP] Auditoria": the user already wrote their own short form. */
const TAG_PATTERN = /^\s*\[([^\]]+)\]/;

const HAS_LETTER = /\p{L}/u;
const IS_NUMBER = /^\p{N}+$/u;

/** Uppercase one character, unless uppercasing would grow it ("ß" -> "SS"). */
function upper(char: string): string {
	const result = char.toUpperCase();
	return Array.from(result).length === 1 ? result : char;
}

function splitWords(text: string): string[][] {
	// An apostrophe joins a word rather than ending one ("Pedram's" is one word,
	// not "Pedram" + "s").
	const matches =
		text
			.normalize('NFC')
			.replace(/['\u2019]/g, '')
			.match(WORD_PATTERN) ?? [];
	return matches.map((word) => Array.from(word));
}

/**
 * The label for a name with no letters or digits in it (emoji, symbols). Two
 * code points rather than two graphemes: enough for a flag or a skin-toned
 * emoji to survive whole, and a longer sequence degrades to its base glyph.
 */
function leadingSymbols(name: string): string {
	const symbols = Array.from(name).filter((char) => char.trim());
	return symbols.slice(0, 2).join('') || EMPTY_NAME_LABEL;
}

/**
 * Every label an agent name could carry, best first. The first entry is what
 * the agent shows when nobody else wants it; the rest exist to break ties.
 *
 *   1. A bracketed tag the user wrote ("[ARP] Auditoria" -> "AR").
 *   2. Word initials, first word with each later word ("Maestro RC" -> "MR",
 *      "PedCast" -> "PC", "Agent 2" -> "A2").
 *   3. The first word's own letters ("Maestro" -> "Ma", then "Me", "Ms", ...).
 *      The second letter keeps its typed case, so "Ma" reads as one word and
 *      "MR" as two.
 *   4. The first letter with a letter from deeper in a later word ("Mr Robot"
 *      -> "Mo"), once the first word is used up.
 *   5. The first letter with a digit ("M2".."M9"), for agents whose names are
 *      identical and have nothing else to tell them apart.
 *
 * Leading numbering drops out ("[1] Maestro" and "2 - Maestro" both start at
 * "Ma"), matching how `abbreviateGroupName` treats it.
 */
export function agentInitialCandidates(name: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const add = (label: string) => {
		const key = label.toUpperCase();
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(label);
	};

	const tag = name.match(TAG_PATTERN)?.[1];
	if (tag && HAS_LETTER.test(tag)) {
		const tagChars = splitWords(tag).flat();
		if (tagChars.length >= 2) add(upper(tagChars[0]) + upper(tagChars[1]));
	}

	let words = splitWords(name);
	// Numbering in front of a real name is an ordinal, not the name.
	const firstNamed = words.findIndex((word) => !IS_NUMBER.test(word.join('')));
	if (firstNamed > 0) words = words.slice(firstNamed);

	if (words.length === 0) {
		add(leadingSymbols(name));
		return candidates;
	}

	const [first, ...rest] = words;
	const lead = upper(first[0]);

	for (const word of rest) add(lead + upper(word[0]));
	for (const char of first.slice(1)) add(lead + char);
	for (const word of rest) for (const char of word.slice(1)) add(lead + char);
	// A one-character name has no second letter to offer.
	if (candidates.length === 0) add(lead);
	for (let digit = 2; digit <= 9; digit++) add(lead + String(digit));

	return candidates;
}

/**
 * Assign each agent a label, unique across the list wherever the names allow.
 *
 * Two passes, so a collision never costs an innocent bystander its label: an
 * agent whose first choice nobody else wants keeps it outright, and only the
 * agents that actually collide fall back through their candidates. Within a
 * collision the agent listed first wins the contested label.
 *
 * Labels are compared case-insensitively ("Ma" and "MA" are the same label to
 * a reader). When an agent runs out of candidates it shares its first choice
 * rather than going unlabeled.
 */
export function buildAgentInitials(agents: readonly AgentInitialsInput[]): Map<string, string> {
	const ranked = agents.map((agent) => ({
		id: agent.id,
		candidates: agentInitialCandidates(agent.name),
	}));

	const demand = new Map<string, number>();
	for (const { candidates } of ranked) {
		const key = candidates[0].toUpperCase();
		demand.set(key, (demand.get(key) ?? 0) + 1);
	}

	const labels = new Map<string, string>();
	const claimed = new Set<string>();
	const contested: typeof ranked = [];

	for (const entry of ranked) {
		const key = entry.candidates[0].toUpperCase();
		if (demand.get(key) === 1) {
			labels.set(entry.id, entry.candidates[0]);
			claimed.add(key);
		} else {
			contested.push(entry);
		}
	}

	for (const { id, candidates } of contested) {
		const free = candidates.find((label) => !claimed.has(label.toUpperCase()));
		const label = free ?? candidates[0];
		labels.set(id, label);
		claimed.add(label.toUpperCase());
	}

	return labels;
}
