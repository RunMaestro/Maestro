// What `maestro-cli s1 yes | pick | rate | ask | rank | batch | cost` reads from
// its command line: the state, the questions, the candidates of a rank and the
// rows of a batch.
//
// The grammar is the `jev` CLI's, on purpose: an agent that knows one knows the
// other.
//
//   State      -s/--state TEXT (`@path` reads a file, `-` reads standard input),
//              --state-file PATH, --state-json JSON, --field key=value (the
//              value may be `@path` or JSON; repeatable; with --state the text
//              becomes the field `text`), or text piped on standard input.
//   Questions  --noul ID INSTRUCTIONS [true=...] [false=...]
//              --choice ID INSTRUCTIONS OPTION[=description] OPTION[=description] ...
//              --score ID INSTRUCTIONS LEVEL LEVEL ...   (low to high)
//              each repeatable, in any mix. `ID=INSTRUCTIONS` in one word is
//              read the same way. Or --questions-file / --questions-json.
//
// Everything a caller typed wrong is a `SystemOneInputError`, which a verb
// turns into the usage exit code. Nothing here talks to the desktop.

import * as fs from 'fs';
import * as path from 'path';

import {
	SYSTEM_ONE_MAX_SCORE_LEVELS,
	SYSTEM_ONE_MIN_SCORE_LEVELS,
	choice,
	isSystemOneText,
	noul,
	score,
	type SystemOneJson,
	type SystemOneQuestions,
	type SystemOneText,
} from '../../shared/local-models/system-one';
import type {
	SystemOneBatchRow,
	SystemOneRankCandidate,
} from '../../shared/local-models/system-one-agent';
import { resolveCliPath } from '../utils/parse';
import { readStdinIfReady, readStdinText } from './stdin';

/** A command line that cannot be read. Its message is written for the person who typed it. */
export class SystemOneInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SystemOneInputError';
	}
}

function refuse(message: string): never {
	throw new SystemOneInputError(message);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Read a file the caller named, or say which file could not be read. */
export function readInputFile(input: string): { file: string; text: string } {
	const file = resolveCliPath(input);
	try {
		return { file, text: fs.readFileSync(file, 'utf-8') };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') refuse(`File not found: ${file}`);
		return refuse(
			`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

function parseJson(text: string, where: string): SystemOneJson {
	try {
		return JSON.parse(text) as SystemOneJson;
	} catch (error) {
		return refuse(`${where}: not JSON (${error instanceof Error ? error.message : String(error)})`);
	}
}

/** The non-blank lines of a text, each with its line number, counted from 1. */
function numberedLines(text: string): Array<{ line: number; text: string }> {
	return text
		.split(/\r?\n/)
		.map((value, index) => ({ line: index + 1, text: value }))
		.filter((entry) => entry.text.trim() !== '');
}

/**
 * A file as a value: `.json` is parsed, `.jsonl` is a list of its rows, and
 * anything else is its text.
 */
export function readValueFile(input: string): SystemOneJson {
	const { file, text } = readInputFile(input);
	const extension = path.extname(file).toLowerCase();
	if (extension === '.json') return parseJson(text, file);
	if (extension === '.jsonl') {
		return numberedLines(text).map((row) => parseJson(row.text, `${file} line ${row.line}`));
	}
	return text;
}

/**
 * A value as the caller typed it: `@path` reads a file, text that is a JSON
 * object, a JSON list, `true`, `false` or `null` is parsed, and anything else
 * is the text itself.
 */
export function parseCliValue(value: string): SystemOneJson {
	if (value.startsWith('@')) return readValueFile(value.slice(1));
	const text = value.trim();
	const looksLikeJson =
		text.startsWith('{') ||
		text.startsWith('[') ||
		text === 'true' ||
		text === 'false' ||
		text === 'null';
	if (looksLikeJson) {
		try {
			return JSON.parse(text) as SystemOneJson;
		} catch {
			// Text that only looks like JSON is text.
		}
	}
	return value;
}

/**
 * Instructions, a criteria entry or a rubric level: text, or JSON with
 * structure. A word such as `true` stays a word here, because a level named
 * "true" is a level, not a boolean.
 */
export function parseCliText(value: string): SystemOneText {
	const parsed = parseCliValue(value);
	return isSystemOneText(parsed) ? parsed : value;
}

/**
 * `NAME` or `NAME=description`, as a choice's options and a noul's criteria
 * are typed: `['billing=Charges', 'other']` is `{ billing: 'Charges', other:
 * null }`.
 */
export function parseKeyedOptions(items: readonly string[]): Record<string, SystemOneText | null> {
	const options: Record<string, SystemOneText | null> = {};
	for (const item of items) {
		const at = item.indexOf('=');
		const name = (at === -1 ? item : item.slice(0, at)).trim();
		if (name === '') refuse(`"${item}" has no name. Write NAME or NAME=description.`);
		if (name in options) refuse(`"${name}" is given twice.`);
		const described = at === -1 ? '' : item.slice(at + 1);
		options[name] = described === '' ? null : parseCliText(described);
	}
	return options;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface StateFlags {
	state?: string;
	stateFile?: string;
	stateJson?: string;
	field?: string[];
}

/** True when a flag names the state, so standard input is not read for it. */
export function hasStateFlags(flags: StateFlags): boolean {
	return (
		flags.state !== undefined ||
		flags.stateFile !== undefined ||
		flags.stateJson !== undefined ||
		(flags.field?.length ?? 0) > 0
	);
}

const NO_STATE =
	'No state. Use -s/--state TEXT, --state-file PATH, --state-json JSON, --field key=value, or pipe text on standard input.';

/**
 * The state a verb judges, from its flags, or from standard input when no flag
 * names one. The value is not checked here: the request it goes into is.
 */
export async function readState(flags: StateFlags): Promise<SystemOneJson> {
	const named = [
		flags.state !== undefined ? '--state' : null,
		flags.stateFile !== undefined ? '--state-file' : null,
		flags.stateJson !== undefined ? '--state-json' : null,
	].filter((name): name is string => name !== null);
	if (named.length > 1) {
		refuse(
			`Give the state one way: ${named.join(' and ')} were both given. --field may be added to any of them, and the state then becomes the field "text".`
		);
	}

	let state: SystemOneJson | undefined;
	if (flags.state !== undefined) {
		state =
			flags.state === '-'
				? readStdinText()
				: flags.state.startsWith('@')
					? readValueFile(flags.state.slice(1))
					: flags.state;
	} else if (flags.stateFile !== undefined) {
		state = readValueFile(flags.stateFile);
	} else if (flags.stateJson !== undefined) {
		state = parseJson(flags.stateJson, '--state-json');
	}

	if (flags.field && flags.field.length > 0) {
		const fields: { [key: string]: SystemOneJson } = {};
		if (state !== undefined) fields.text = state;
		for (const entry of flags.field) {
			const at = entry.indexOf('=');
			const key = at === -1 ? '' : entry.slice(0, at).trim();
			if (key === '') refuse(`--field expects key=value, and got "${entry}".`);
			fields[key] = parseCliValue(entry.slice(at + 1));
		}
		return fields;
	}

	if (state !== undefined) return state;
	const piped = await readStdinIfReady();
	if (!piped || piped.trim() === '') refuse(NO_STATE);
	return piped;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export type QuestionFlagKind = 'noul' | 'choice' | 'score';

/** One `--noul`, `--choice` or `--score` and the words that followed it. */
export interface QuestionFlag {
	kind: QuestionFlagKind;
	values: string[];
}

const QUESTION_FLAG_KINDS: Record<string, QuestionFlagKind> = {
	'--noul': 'noul',
	'--choice': 'choice',
	'--score': 'score',
};

/** The rule the option parser ends a flag's words by: a word that starts with a dash is a flag. */
function looksLikeFlag(word: string): boolean {
	return word.length > 1 && word.startsWith('-');
}

/**
 * The question flags of a command line, each with its own words, in the order
 * they were typed.
 *
 * The option parser cannot give this: it hands every `--noul` back as one flat
 * list, so `--noul a "Q1" --noul b "Q2"` loses where one question ends and the
 * next begins. This reads the same words by the same rule, and
 * {@link questionFlagsProblem} checks the two readings agree before anything is
 * built from them.
 */
export function collectQuestionFlags(argv: readonly string[]): QuestionFlag[] {
	const flags: QuestionFlag[] = [];
	let open: QuestionFlag | null = null;
	for (const word of argv) {
		if (word === '--') break;
		const at = word.startsWith('--') ? word.indexOf('=') : -1;
		const kind = QUESTION_FLAG_KINDS[at === -1 ? word : word.slice(0, at)];
		if (kind) {
			open = { kind, values: at === -1 ? [] : [word.slice(at + 1)] };
			flags.push(open);
		} else if (open && !looksLikeFlag(word)) {
			open.values.push(word);
		} else {
			open = null;
		}
	}
	return flags;
}

/**
 * Why the question flags cannot be trusted, or `null` when they can: the words
 * read here must be the words the option parser read. They differ when a word
 * starts with a dash, or when `--noul` was typed as another flag's value.
 */
export function questionFlagsProblem(
	flags: readonly QuestionFlag[],
	parsed: Partial<Record<QuestionFlagKind, string[]>>
): string | null {
	for (const kind of Object.values(QUESTION_FLAG_KINDS)) {
		const read = flags.filter((flag) => flag.kind === kind).flatMap((flag) => flag.values);
		const expected = parsed[kind] ?? [];
		if (read.length !== expected.length || read.some((word, index) => word !== expected[index])) {
			return `Could not tell the --${kind} questions apart. A word that starts with a dash cannot follow a question flag: pass the questions with --questions-json or --questions-file.`;
		}
	}
	return null;
}

/** An id typed with its instructions in one word: `urgent=Does it say so?`. */
const INLINE_ID = /^[\w.:-]+$/;

const QUESTION_FLAG_USAGE: Record<QuestionFlagKind, string> = {
	noul: '--noul ID INSTRUCTIONS [true=...] [false=...]',
	choice: '--choice ID INSTRUCTIONS OPTION[=description] OPTION[=description] ...',
	score: '--score ID INSTRUCTIONS LEVEL LEVEL ... (low to high)',
};

/** Split a flag's words into its id, its instructions and the rest. */
function questionHead(flag: QuestionFlag): { id: string; instructions: string; rest: string[] } {
	const [first = '', ...rest] = flag.values;
	const at = first.indexOf('=');
	if (at > 0 && INLINE_ID.test(first.slice(0, at))) {
		return { id: first.slice(0, at), instructions: first.slice(at + 1), rest };
	}
	const [instructions, ...after] = rest;
	if (first.trim() === '' || instructions === undefined) {
		refuse(`A question needs an id and its instructions: ${QUESTION_FLAG_USAGE[flag.kind]}`);
	}
	return { id: first.trim(), instructions, rest: after };
}

function questionsObject(value: SystemOneJson, where: string): SystemOneQuestions {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		refuse(`${where} must hold a JSON object of id to question.`);
	}
	return value as unknown as SystemOneQuestions;
}

export interface QuestionSources {
	questionsFile?: string;
	questionsJson?: string;
}

/**
 * The questions of a request: a file, inline JSON and the question flags,
 * together. An id used twice is refused, because the second would silently
 * replace the first. The questions' shapes are checked with the request.
 */
export function buildQuestions(
	flags: readonly QuestionFlag[],
	sources: QuestionSources = {}
): SystemOneQuestions {
	const questions: SystemOneQuestions = {};
	const add = (id: string, question: SystemOneQuestions[string]) => {
		if (id in questions) refuse(`Two questions share the id "${id}". An id names one question.`);
		questions[id] = question;
	};

	if (sources.questionsFile !== undefined) {
		const held = questionsObject(readValueFile(sources.questionsFile), '--questions-file');
		for (const [id, question] of Object.entries(held)) add(id, question);
	}
	if (sources.questionsJson !== undefined) {
		const held = questionsObject(
			parseJson(sources.questionsJson, '--questions-json'),
			'--questions-json'
		);
		for (const [id, question] of Object.entries(held)) add(id, question);
	}

	for (const flag of flags) {
		const { id, instructions, rest } = questionHead(flag);
		const asked = parseCliText(instructions);
		if (flag.kind === 'noul') {
			const criteria = parseKeyedOptions(rest);
			const extra = Object.keys(criteria).filter((key) => key !== 'true' && key !== 'false');
			if (extra.length > 0 || Object.values(criteria).some((entry) => entry === null)) {
				refuse(
					`--noul ${id}: after the instructions only true=... and false=... may follow, to say what yes and no mean.`
				);
			}
			add(id, noul(asked, criteria as { true?: SystemOneText; false?: SystemOneText }));
		} else if (flag.kind === 'choice') {
			if (rest.length < 2) {
				refuse(`--choice ${id}: give at least 2 options, as NAME or NAME=description.`);
			}
			add(id, choice(asked, parseKeyedOptions(rest)));
		} else {
			if (rest.length < SYSTEM_ONE_MIN_SCORE_LEVELS || rest.length > SYSTEM_ONE_MAX_SCORE_LEVELS) {
				refuse(
					`--score ${id}: give ${SYSTEM_ONE_MIN_SCORE_LEVELS} to ${SYSTEM_ONE_MAX_SCORE_LEVELS} levels, low to high.`
				);
			}
			add(id, score(asked, rest.map(parseCliText)));
		}
	}

	if (Object.keys(questions).length === 0) {
		refuse(
			'No questions. Use --noul, --choice or --score, or pass them with --questions-file or --questions-json.'
		);
	}
	return questions;
}

// ---------------------------------------------------------------------------
// Rank: candidates, each under a key
// ---------------------------------------------------------------------------

export interface CandidateSources {
	/** Candidates typed as arguments. */
	candidates?: string[];
	/** One candidate per line, or a `.json` list, or `.jsonl` rows. */
	candidatesFile?: string;
	/** The field of a JSON candidate that names it. */
	idKey?: string;
}

/** The field a JSON candidate or a batch row is named by, unless the caller says otherwise. */
export const DEFAULT_ID_KEY = 'id';

function ownId(item: SystemOneJson, idKey: string): string | null {
	if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
	const id = item[idKey];
	if (typeof id === 'number' && Number.isFinite(id)) return String(id);
	return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
}

/** Key a list of items: by their own id when every one has one, else by their place, counted from 1. */
function keyItems(items: readonly SystemOneJson[], idKey: string): SystemOneRankCandidate[] {
	const ids = items.map((item) => ownId(item, idKey));
	const named = ids.every((id) => id !== null);
	return items.map((item, index) => ({
		key: named ? (ids[index] as string) : String(index + 1),
		item,
	}));
}

/**
 * The candidates of a rank, each under the key its answer comes back with.
 *
 * A line of a file is keyed by its LINE NUMBER, counted from 1 with blank
 * lines counted, so a key points at the line in the file. A JSON candidate is
 * keyed by its own id (`--id-key`, default `id`) when every candidate has one,
 * else by its place in the list, counted from 1. No candidate is ever addressed
 * by its position in what is sent: each travels inside its own question.
 */
export async function readRankCandidates(
	sources: CandidateSources
): Promise<SystemOneRankCandidate[]> {
	const idKey = sources.idKey ?? DEFAULT_ID_KEY;
	const typed = sources.candidates ?? [];
	if (sources.candidatesFile !== undefined && typed.length > 0) {
		refuse('Give the candidates one way: as arguments, or with --candidates-file.');
	}
	const fromLines = (text: string): SystemOneRankCandidate[] =>
		numberedLines(text).map((entry) => ({ key: String(entry.line), item: entry.text }));

	if (sources.candidatesFile !== undefined) {
		const held = readValueFile(sources.candidatesFile);
		if (Array.isArray(held)) return keyItems(held, idKey);
		if (typeof held === 'string') return fromLines(held);
		return refuse('--candidates-file must hold one candidate per line, or a JSON list.');
	}
	if (typed.length > 0) return keyItems(typed, idKey);

	const piped = await readStdinIfReady();
	const candidates = piped ? fromLines(piped) : [];
	if (candidates.length === 0) {
		refuse(
			'No candidates. Give them as arguments, with --candidates-file (one per line, or a JSON list), or on standard input.'
		);
	}
	return candidates;
}

// ---------------------------------------------------------------------------
// Batch: one state per row
// ---------------------------------------------------------------------------

export interface BatchRowFlags {
	/** The field of each JSON row that is the state. Without it, the row is. */
	stateKey?: string;
	/** The field of each JSON row echoed back as `id`. */
	idKey?: string;
	/** Read every line as text, even one that is JSON. */
	textLines?: boolean;
}

/**
 * The rows of a batch, from JSONL or plain text. A row keeps its LINE NUMBER,
 * counted from 1 with blank lines counted, so an answer points at the line it
 * came from. A line that is not a JSON object or list is a row of text.
 */
export function readBatchRows(text: string, flags: BatchRowFlags = {}): SystemOneBatchRow[] {
	const idKey = flags.idKey ?? DEFAULT_ID_KEY;
	const rows: SystemOneBatchRow[] = [];
	for (const entry of numberedLines(text)) {
		let parsed: unknown;
		if (!flags.textLines) {
			try {
				parsed = JSON.parse(entry.text);
			} catch {
				parsed = undefined;
			}
		}
		if (typeof parsed !== 'object' || parsed === null) {
			rows.push({ line: entry.line, state: entry.text });
			continue;
		}
		const row = parsed as SystemOneJson[] | { [key: string]: SystemOneJson };
		if (Array.isArray(row)) {
			rows.push({ line: entry.line, state: row });
			continue;
		}
		const id = row[idKey];
		const named = typeof id === 'string' || typeof id === 'number' ? { id } : {};
		if (flags.stateKey === undefined) {
			rows.push({ line: entry.line, ...named, state: row });
			continue;
		}
		const state = row[flags.stateKey];
		if (state === undefined) refuse(`Line ${entry.line}: no field "${flags.stateKey}".`);
		// The request's own check says why a state that is not text or JSON cannot be judged.
		rows.push({ line: entry.line, ...named, state: state as SystemOneBatchRow['state'] });
	}
	if (rows.length === 0) refuse('No rows. The input has no line that is not blank.');
	return rows;
}
