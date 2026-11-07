// `maestro-cli s1 yes|pick|rate|ask|rank|batch` - the verbs an agent asks System
// One with. A typed question about a state, answered with a typed judgment in a
// fraction of a second.
//
//   yes    "<question>" -s TEXT              P(yes); exit 0 for yes, 1 for no
//   pick   "<question>" a=desc b=desc -s TEXT    one option, each option's
//                                            probability, and confidence
//   rate   "<question>" "low" "high" -s TEXT a position on a rubric
//   ask    --noul/--choice/--score ... -s TEXT   several questions, one request
//   rank   --query Q --candidates-file F     rank or filter many items
//   batch  --input rows.jsonl --noul ...     the same questions over many rows
//
// The flag grammar is the `jev` CLI's (see `../services/system-one-input.ts`),
// so an agent that knows one knows the other.
//
// Every verb sends ONE request over the WS bridge to the function an agent's
// request is answered by (`runAgentSystemOneRequest`). The engine's key stays
// in the desktop: this process is handed typed answers, the engine's name and
// the spend, and nothing it could ask an engine with by itself. The caller's
// agent and tab are read from its environment and sent along, so the request is
// counted against that agent's budget and filed under it in the ledger.
//
// Exit codes, so a verb can sit in a shell `if`:
//
//   0  yes; or an answer at or above --min-confidence; or a job that judged
//      everything it was given
//   1  `yes`: no, or uncertain inside --band. `pick`, `rate`: an answer under
//      --min-confidence. Never an error.
//   2  the command line or the request is wrong
//   3, 4, 5  the desktop app: not running, too old, or not answering in time
//   6  refused: System One is off, or today's budget is spent. Go on without it.
//   7  no answer: the engine failed, or a `rank` or `batch` is INCOMPLETE

import * as fs from 'fs';

import type { Command } from 'commander';

import { callerMessageFields, readCallerIdentity } from '../../shared/agentDelegation';
import {
	noul,
	choice,
	score,
	estimateSystemOneTokens,
	JEV_MAX_STATE_AND_QUESTION_TOKENS,
	type SystemOneQuestions,
	type SystemOneState,
	type SystemOneText,
} from '../../shared/local-models/system-one';
import {
	parseSystemOneAgentRequest,
	systemOneAgentWaitMs,
	type SystemOneAgentAnswerMeta,
	type SystemOneAgentAskRequest,
	type SystemOneAgentBatchRequest,
	type SystemOneAgentRankRequest,
	type SystemOneAgentRefusal,
	type SystemOneAgentRequest,
	type SystemOneAgentResponse,
	type SystemOneAgentResult,
} from '../../shared/local-models/system-one-agent';
import { ExitCode, NEGATIVE_ANSWER_EXIT_CODE, exitCodeForError, exitWith } from '../exit-codes';
import {
	describeSystemOneLevel,
	formatSystemOneAnswer,
	formatSystemOneAnswerMeta,
	formatSystemOneProbabilities,
	formatSystemOneRankRow,
	nearestSystemOneLevel,
} from '../output/system-one-answers';
import { CommandTimeoutError, withMaestroClient } from '../services/maestro-client';
import { readStdinIfReady, readStdinText } from '../services/stdin';
import {
	SystemOneInputError,
	buildQuestions,
	collectQuestionFlags,
	hasStateFlags,
	parseCliText,
	parseKeyedOptions,
	questionFlagsProblem,
	readBatchRows,
	readInputFile,
	readRankCandidates,
	readState,
	type QuestionFlagKind,
	type StateFlags,
} from '../services/system-one-input';
import { resolveCliPath } from '../utils/parse';
import {} from './system-one';
import { systemOneExamples, systemOneGuide } from './system-one-guide';
import { systemOneCost, systemOneUsage } from './system-one-spend';
import { failCommand } from '../services/session-command';

/** The id of the one question `yes`, `pick` and `rate` ask. It is not sent to the engine. */
const QUESTION_ID = 'q';

interface CommonOptions {
	json?: boolean;
	/** False for `--no-cache`. */
	cache?: boolean;
	/** Seconds to wait for the desktop app. */
	timeout?: string;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** Run what reads the command line; what the caller typed wrong exits as a usage error. */
async function readInput<T>(json: boolean | undefined, read: () => T | Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		if (error instanceof SystemOneInputError)
			failCommand(error.message, json, ExitCode.InvalidUsage);
		throw error;
	}
}

/** A flag that is a number from 0 to 1, or its default. */
function fraction(
	value: string | undefined,
	flag: string,
	fallback: number,
	json: boolean | undefined
): number {
	if (value === undefined) return fallback;
	const number = Number(value);
	if (value.trim() === '' || !(number >= 0) || number > 1) {
		failCommand(
			`${flag} is a number from 0 to 1, and got "${value}".`,
			json,
			ExitCode.InvalidUsage
		);
	}
	return number;
}

/** `--band LOW HIGH`, or `--band LOW,HIGH`: under LOW is no, HIGH and over is yes. */
function readBand(words: string[] | undefined, json: boolean | undefined): [number, number] | null {
	if (!words) return null;
	const parts = words.flatMap((word) => word.split(','));
	if (parts.length !== 2) {
		failCommand(
			'--band takes two numbers, LOW and HIGH. Put it after the question, so the question is not read as one of them.',
			json,
			ExitCode.InvalidUsage
		);
	}
	const low = fraction(parts[0], '--band LOW', 0, json);
	const high = fraction(parts[1], '--band HIGH', 1, json);
	if (low > high) failCommand('--band takes LOW first, then HIGH.', json, ExitCode.InvalidUsage);
	return [low, high];
}

function noCache(options: CommonOptions): { noCache?: true } {
	return options.cache === false ? { noCache: true } : {};
}

/**
 * One request about one state, as it is typed. The state and the questions are
 * whatever the command line held: `askDesktop` puts the request through the
 * shared validator before it is sent, and that is what says they are sound.
 */
function askRequest(
	verb: SystemOneAgentAskRequest['verb'],
	state: unknown,
	questions: unknown,
	options: CommonOptions
): SystemOneAgentAskRequest {
	return {
		kind: 'ask',
		verb,
		state: state as SystemOneState,
		questions: questions as SystemOneQuestions,
		...noCache(options),
	};
}

/** Say so when a state is past what one request holds, before the engine does. */
function warnOnLargeState(state: SystemOneState, json: boolean | undefined): void {
	const tokens = estimateSystemOneTokens(state);
	if (json || tokens <= JEV_MAX_STATE_AND_QUESTION_TOKENS) return;
	console.error(
		`Warning: the state is about ${tokens.toLocaleString('en-US')} tokens, and one request holds ${JEV_MAX_STATE_AND_QUESTION_TOKENS.toLocaleString('en-US')} for the state and its longest question. Filter it first, or use rank or batch, which split a job into requests.`
	);
}

/** The command line as it was typed: the question flags are read from it in order. */
function commandLine(command: Command): readonly string[] {
	let root = command;
	while (root.parent) root = root.parent;
	return (root as Command & { rawArgs?: string[] }).rawArgs ?? process.argv;
}

type QuestionFlagOptions = Partial<Record<QuestionFlagKind, string[]>> & {
	questionsFile?: string;
	questionsJson?: string;
};

/** The questions of `ask` and `batch`, from the question flags as typed and the option parser's reading of them. */
function readQuestions(options: QuestionFlagOptions, argv: readonly string[]): SystemOneQuestions {
	const flags = collectQuestionFlags(argv);
	const problem = questionFlagsProblem(flags, options);
	if (problem) throw new SystemOneInputError(problem);
	return buildQuestions(flags, options);
}

// ---------------------------------------------------------------------------
// The desktop
// ---------------------------------------------------------------------------

type AgentReply = { success: boolean; error?: string; response?: SystemOneAgentResponse };

/** Print a refusal and exit with the code that says what kind it is. */
function refused(refusal: SystemOneAgentRefusal, json: boolean | undefined): never {
	const code =
		refusal.code === 'invalid'
			? ExitCode.InvalidUsage
			: refusal.code === 'off' || refusal.code === 'budget'
				? ExitCode.Refused
				: ExitCode.NoAnswer;
	if (json) {
		const { ok: _ok, message, ...rest } = refusal;
		console.log(JSON.stringify({ success: false, error: message, ...rest }));
		return exitWith(code);
	}
	return failCommand(refusal.message, false, code);
}

/** How long to wait for the desktop: what the caller asked for, or what the request can take. */
function waitMs(
	request: SystemOneAgentRequest,
	options: CommonOptions,
	json: boolean | undefined
): number {
	if (options.timeout === undefined) return systemOneAgentWaitMs(request);
	const seconds = Number(options.timeout);
	if (options.timeout.trim() === '' || !(seconds > 0)) {
		failCommand(
			`--timeout is a number of seconds, and got "${options.timeout}".`,
			json,
			ExitCode.InvalidUsage
		);
	}
	return Math.round(seconds * 1000);
}

/**
 * Send one request to the desktop and answer with its result. A request the
 * shared validator refuses exits before anything is sent; a refusal from the
 * desktop exits with its reason. This never exits with 1, which `yes` keeps for
 * "no".
 */
async function askDesktop<K extends SystemOneAgentResult['kind']>(
	kind: K,
	raw: SystemOneAgentRequest,
	options: CommonOptions
): Promise<Extract<SystemOneAgentResult, { kind: K }>> {
	const { json } = options;
	const parsed = parseSystemOneAgentRequest(raw);
	if (!parsed.ok) failCommand(parsed.message, json, ExitCode.InvalidUsage);
	const { request } = parsed;
	if (request.kind === 'ask') warnOnLargeState(request.state, json);
	const timeoutMs = waitMs(request, options, json);

	let reply: AgentReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<AgentReply>(
				{
					type: 'system_one_agent_request',
					request,
					...callerMessageFields(readCallerIdentity(process.env)),
				},
				'system_one_agent_result',
				timeoutMs
			)
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = exitCodeForError(error);
		const resumable = error instanceof CommandTimeoutError && request.kind !== 'ask';
		failCommand(
			resumable
				? `${message} The desktop app goes on with the job, and what it answers is cached: run the same command again to collect it at no cost, or pass --timeout <seconds> to wait longer.`
				: message,
			json,
			code === ExitCode.GeneralError ? ExitCode.NoAnswer : code
		);
	}
	if (!reply.success || !reply.response) {
		failCommand(reply.error || 'The desktop app sent no answer.', json, ExitCode.NoAnswer);
	}
	const { response } = reply;
	if (!response.ok) refused(response, json);
	if (response.kind !== kind) {
		failCommand('The desktop app answered a different request.', json, ExitCode.NoAnswer);
	}
	return response as Extract<SystemOneAgentResult, { kind: K }>;
}

/** What every answer says about itself, for `--json`. */
function metaJson(meta: SystemOneAgentAnswerMeta): SystemOneAgentAnswerMeta {
	return {
		engine: meta.engine,
		engineLabel: meta.engineLabel,
		calibrated: meta.calibrated,
		model: meta.model,
		cached: meta.cached,
		latencyMs: meta.latencyMs,
		tokens: meta.tokens,
		costUsd: meta.costUsd,
		redacted: meta.redacted,
		budget: meta.budget,
	};
}

/** A whole result as `--json` prints it: `success` in place of `ok`, as every other verb spells it. */
function resultJson(result: SystemOneAgentResult, success = true): Record<string, unknown> {
	const { ok: _ok, ...rest } = result;
	return { success, ...rest };
}

/** The one answer of `yes`, `pick` or `rate`, or an exit: an engine that did not answer the question asked. */
function oneAnswer<T extends 'noul' | 'choice' | 'score'>(
	result: Extract<SystemOneAgentResult, { kind: 'ask' }>,
	type: T,
	json: boolean | undefined
): Extract<(typeof result.answers)[string], { type: T }> {
	const answer = result.answers[QUESTION_ID];
	if (!answer || answer.type !== type) {
		failCommand(`${result.engineLabel} gave no ${type} answer.`, json, ExitCode.NoAnswer);
	}
	return answer as Extract<(typeof result.answers)[string], { type: T }>;
}

// ---------------------------------------------------------------------------
// yes, pick, rate: one question
// ---------------------------------------------------------------------------

interface YesOptions extends CommonOptions, StateFlags {
	true?: string;
	false?: string;
	threshold?: string;
	band?: string[];
}

export async function systemOneYes(question: string, options: YesOptions): Promise<void> {
	const { json } = options;
	const threshold = fraction(options.threshold, '--threshold', 0.5, json);
	const band = readBand(options.band, json);
	const request = await readInput(json, async () => {
		const criteria = {
			...(options.true !== undefined ? { true: parseCliText(options.true) } : {}),
			...(options.false !== undefined ? { false: parseCliText(options.false) } : {}),
		};
		const questions = { [QUESTION_ID]: noul(parseCliText(question), criteria) };
		return askRequest('yes', await readState(options), questions, options);
	});

	const result = await askDesktop('ask', request, options);
	const p = oneAnswer(result, 'noul', json).probability;
	const [low, high] = band ?? [threshold, threshold];
	const verdict = p >= high ? 'yes' : p < low ? 'no' : 'uncertain';
	if (json) {
		console.log(
			JSON.stringify({
				success: true,
				probability: p,
				verdict,
				threshold,
				band,
				...metaJson(result),
			})
		);
	} else {
		console.log(`${p.toFixed(3)} ${verdict}`);
		console.error(formatSystemOneAnswerMeta(result));
	}
	if (verdict !== 'yes') exitWith(NEGATIVE_ANSWER_EXIT_CODE);
}

interface ConfidenceOptions extends CommonOptions, StateFlags {
	minConfidence?: string;
}

/**
 * Whether an answer is at or above the confidence the caller asked for. An
 * engine that reports no confidence (the local judge) cannot meet one: a number
 * it did not give is never taken as given.
 */
function meetsConfidence(confidence: number | undefined, least: number): boolean {
	return least === 0 || (confidence !== undefined && confidence >= least);
}

function confidenceNote(confidence: number | undefined, least: number): string {
	return confidence === undefined
		? 'this engine reports no confidence, so --min-confidence cannot be met'
		: `conf=${confidence.toFixed(2)} < ${least}`;
}

export async function systemOnePick(
	question: string,
	optionWords: string[],
	options: ConfidenceOptions
): Promise<void> {
	const { json } = options;
	const least = fraction(options.minConfidence, '--min-confidence', 0, json);
	const request = await readInput(json, async () => {
		const picked = parseKeyedOptions(optionWords);
		if (Object.keys(picked).length < 2) {
			throw new SystemOneInputError('pick needs at least 2 options, as NAME or NAME=description.');
		}
		const questions = { [QUESTION_ID]: choice(parseCliText(question), picked) };
		return askRequest('pick', await readState(options), questions, options);
	});

	const result = await askDesktop('ask', request, options);
	const answer = oneAnswer(result, 'choice', json);
	const ok = meetsConfidence(answer.confidence, least);
	if (json) {
		console.log(
			JSON.stringify({
				success: true,
				choice: answer.choice,
				confidence: answer.confidence ?? null,
				probabilities: answer.probabilities ?? null,
				verdict: ok ? 'ok' : 'uncertain',
				minConfidence: least,
				...metaJson(result),
			})
		);
	} else {
		const ranked = formatSystemOneProbabilities(answer.probabilities);
		const spread = ranked ? `  [${ranked}]` : '';
		console.log(
			ok
				? `${answer.choice}${answer.confidence === undefined ? '' : `  conf=${answer.confidence.toFixed(2)}`}${spread}`
				: `uncertain  best=${answer.choice}  ${confidenceNote(answer.confidence, least)}${spread}`
		);
		console.error(formatSystemOneAnswerMeta(result));
	}
	if (!ok) exitWith(NEGATIVE_ANSWER_EXIT_CODE);
}

export async function systemOneRate(
	question: string,
	levelWords: string[],
	options: ConfidenceOptions
): Promise<void> {
	const { json } = options;
	const least = fraction(options.minConfidence, '--min-confidence', 0, json);
	let levels: SystemOneText[] = [];
	const request = await readInput(json, async () => {
		levels = levelWords.map(parseCliText);
		const questions = { [QUESTION_ID]: score(parseCliText(question), levels) };
		return askRequest('rate', await readState(options), questions, options);
	});

	const result = await askDesktop('ask', request, options);
	const answer = oneAnswer(result, 'score', json);
	const top = levels.length - 1;
	const nearest = nearestSystemOneLevel(answer.score, levels.length);
	const ok = meetsConfidence(answer.confidence, least);
	if (json) {
		console.log(
			JSON.stringify({
				success: true,
				score: answer.score,
				top,
				normalized: answer.score / top,
				nearestLevel: nearest,
				nearest: describeSystemOneLevel(levels[nearest]),
				confidence: answer.confidence ?? null,
				probabilities: answer.probabilities ?? null,
				verdict: ok ? 'ok' : 'uncertain',
				minConfidence: least,
				...metaJson(result),
			})
		);
	} else {
		console.log(
			[
				`${answer.score.toFixed(2)}/${top}`,
				...(answer.confidence === undefined ? [] : [`conf=${answer.confidence.toFixed(2)}`]),
				`≈ ${describeSystemOneLevel(levels[nearest])}`,
				...(ok ? [] : [`uncertain (${confidenceNote(answer.confidence, least)})`]),
			].join('  ')
		);
		console.error(formatSystemOneAnswerMeta(result));
	}
	if (!ok) exitWith(NEGATIVE_ANSWER_EXIT_CODE);
}

// ---------------------------------------------------------------------------
// ask: several questions, one request
// ---------------------------------------------------------------------------

interface AskOptions extends CommonOptions, StateFlags, QuestionFlagOptions {
	/** A whole request as JSON: a file, or `-` for standard input. */
	request?: string;
}

const NOT_A_REQUEST = 'must be a JSON object with "state" and "questions".';

/** A whole request typed as JSON: `{ "state": ..., "questions": { ... } }`. */
function requestBody(text: string, where: string): { state: unknown; questions: unknown } {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new SystemOneInputError(`${where} ${NOT_A_REQUEST}`);
	}
	if (
		typeof body !== 'object' ||
		body === null ||
		Array.isArray(body) ||
		!('state' in body) ||
		!('questions' in body)
	) {
		throw new SystemOneInputError(`${where} ${NOT_A_REQUEST}`);
	}
	return body as { state: unknown; questions: unknown };
}

export async function systemOneAsk(options: AskOptions, argv: readonly string[]): Promise<void> {
	const { json } = options;
	const request = await readInput(json, async () => {
		const asksByFlag =
			options.noul !== undefined ||
			options.choice !== undefined ||
			options.score !== undefined ||
			options.questionsFile !== undefined ||
			options.questionsJson !== undefined;
		let body: { state: unknown; questions: unknown };
		if (options.request !== undefined) {
			if (asksByFlag || hasStateFlags(options)) {
				throw new SystemOneInputError(
					'--request holds the whole request. Do not add a state or questions to it.'
				);
			}
			body =
				options.request === '-'
					? requestBody(readStdinText(), 'Standard input')
					: requestBody(readInputFile(options.request).text, '--request');
		} else if (!asksByFlag && !hasStateFlags(options)) {
			// No flag at all: a whole request piped in is the one thing left to read.
			const piped = await readStdinIfReady();
			if (!piped || piped.trim() === '') {
				throw new SystemOneInputError(
					'No questions. Use --noul, --choice or --score with a state (-s TEXT, or text on standard input), or pipe a whole request as JSON.'
				);
			}
			body = requestBody(piped, 'With no flags, standard input');
		} else {
			const questions = readQuestions(options, argv);
			body = { state: await readState(options), questions };
		}
		return askRequest('ask', body.state, body.questions, options);
	});

	const result = await askDesktop('ask', request, options);
	if (json) {
		console.log(JSON.stringify(resultJson(result)));
		return;
	}
	const questions: Partial<SystemOneQuestions> =
		typeof request.questions === 'object' && request.questions !== null ? request.questions : {};
	const width = Math.max(...Object.keys(result.answers).map((id) => id.length), 1);
	for (const [id, answer] of Object.entries(result.answers)) {
		console.log(formatSystemOneAnswer(id, answer, questions[id], width));
	}
	console.error(formatSystemOneAnswerMeta(result));
}

// ---------------------------------------------------------------------------
// rank: many candidates against one query
// ---------------------------------------------------------------------------

interface RankOptions extends CommonOptions {
	query: string;
	candidatesFile?: string;
	idKey?: string;
	instructions?: string;
	true?: string;
	false?: string;
	levels?: string[];
	context?: string;
	top?: string;
	min?: string;
	width?: string;
	echo?: boolean;
}

/** Longest candidate text printed on a row, unless `--width` says otherwise. */
const RANK_ROW_WIDTH = 110;

/** Most unjudged keys named on the terminal. `--json` carries all of them. */
const UNJUDGED_SHOWN = 20;

/** A flag that is a whole number, 1 or more. */
function wholeNumber(
	value: string | undefined,
	flag: string,
	json: boolean | undefined
): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1) {
		failCommand(
			`${flag} is a whole number, 1 or more, and got "${value}".`,
			json,
			ExitCode.InvalidUsage
		);
	}
	return number;
}

export async function systemOneRank(candidateWords: string[], options: RankOptions): Promise<void> {
	const { json } = options;
	const top = wholeNumber(options.top, '--top', json);
	const width = wholeNumber(options.width, '--width', json) ?? RANK_ROW_WIDTH;
	const min = options.min === undefined ? undefined : fraction(options.min, '--min', 0, json);

	const request = await readInput(json, async (): Promise<SystemOneAgentRankRequest> => {
		const criteria = {
			...(options.true !== undefined ? { true: parseCliText(options.true) } : {}),
			...(options.false !== undefined ? { false: parseCliText(options.false) } : {}),
		};
		return {
			kind: 'rank',
			query: parseCliText(options.query),
			...(options.context !== undefined ? { context: parseCliText(options.context) } : {}),
			candidates: await readRankCandidates({
				candidates: candidateWords,
				...(options.candidatesFile !== undefined ? { candidatesFile: options.candidatesFile } : {}),
				...(options.idKey !== undefined ? { idKey: options.idKey } : {}),
			}),
			...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
			...(Object.keys(criteria).length > 0 ? { criteria } : {}),
			...(options.levels ? { levels: options.levels.map(parseCliText) } : {}),
			...(top !== undefined ? { top } : {}),
			...(min !== undefined ? { min } : {}),
			...noCache(options),
		};
	});
	const items = new Map(request.candidates.map((entry) => [entry.key, entry.item]));

	const result = await askDesktop('rank', request, options);
	const { completeness } = result;
	if (json) {
		const results = options.echo
			? result.results.map((row) => ({ ...row, candidate: items.get(row.key) ?? null }))
			: result.results;
		console.log(JSON.stringify({ ...resultJson(result, completeness.complete), results }));
	} else {
		const keyWidth = Math.max(...result.results.map((row) => row.key.length), 1);
		for (const row of result.results) {
			console.log(formatSystemOneRankRow(row, items.get(row.key), keyWidth, width));
		}
		for (const warning of result.warnings) console.error(`Warning: ${warning}`);
		if (result.unjudged.length > 0) {
			const more = result.unjudged.length - UNJUDGED_SHOWN;
			console.error(
				`Unjudged, so UNKNOWN: ${result.unjudged.slice(0, UNJUDGED_SHOWN).join(', ')}${more > 0 ? ` and ${more} more (--json lists them)` : ''}`
			);
		}
		console.error(formatSystemOneAnswerMeta(result));
		// The marker is the LAST line of standard output, so an agent reading
		// cut-off output can tell "nothing else matched" from "the list was cut".
		console.log(completeness.marker);
	}
	if (!completeness.complete) exitWith(ExitCode.NoAnswer);
}

// ---------------------------------------------------------------------------
// batch: the same questions over many rows
// ---------------------------------------------------------------------------

interface BatchOptions extends CommonOptions, QuestionFlagOptions {
	input: string;
	stateKey?: string;
	idKey?: string;
	textLines?: boolean;
	echo?: boolean;
	out?: string;
}

export async function systemOneBatch(
	options: BatchOptions,
	argv: readonly string[]
): Promise<void> {
	const { json } = options;
	const request = await readInput(json, (): SystemOneAgentBatchRequest => {
		const questions = readQuestions(options, argv);
		const text = options.input === '-' ? readStdinText() : readInputFile(options.input).text;
		const rows = readBatchRows(text, {
			...(options.stateKey !== undefined ? { stateKey: options.stateKey } : {}),
			...(options.idKey !== undefined ? { idKey: options.idKey } : {}),
			...(options.textLines ? { textLines: true } : {}),
		});
		return { kind: 'batch', rows, questions, ...noCache(options) };
	});
	const states = new Map(request.rows.map((row) => [row.line, row.state]));
	const out = options.out === undefined ? null : resolveCliPath(options.out);

	const result = await askDesktop('batch', request, options);
	const { completeness } = result;
	const rows = options.echo
		? result.rows.map((row) => ({ ...row, state: states.get(row.line) ?? null }))
		: result.rows;
	// The last row says whether the run finished: a file without it was cut off.
	const end = {
		_end: {
			rows: completeness.total,
			ok: completeness.judged,
			errors: completeness.total - completeness.judged,
			complete: completeness.complete,
			marker: completeness.marker,
		},
	};
	const jsonl = [...rows, end].map((row) => JSON.stringify(row)).join('\n');
	if (out !== null) {
		try {
			fs.writeFileSync(out, `${jsonl}\n`, 'utf-8');
		} catch (error) {
			failCommand(
				`Could not write ${out}: ${error instanceof Error ? error.message : String(error)}`,
				json,
				ExitCode.NoAnswer
			);
		}
	}

	if (json) {
		const { rows: _rows, ...summary } = resultJson(result, completeness.complete);
		console.log(JSON.stringify(out === null ? { ...summary, rows } : { ...summary, out }));
	} else {
		if (out === null) console.log(jsonl);
		console.error(formatSystemOneAnswerMeta(result));
		console.error(out === null ? completeness.marker : `${completeness.marker} Wrote ${out}`);
	}
	if (!completeness.complete) exitWith(ExitCode.NoAnswer);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Collect a repeatable flag into a list. */
function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/** The state flags, as every verb that judges one state takes them. */
function withStateFlags(command: Command): Command {
	return command
		.option('-s, --state <text>', 'The text to judge; @path reads a file; - reads standard input')
		.option('--state-file <path>', 'A file to judge (.json is parsed, anything else is text)')
		.option('--state-json <json>', 'The state as inline JSON')
		.option(
			'--field <key=value>',
			'Build an object state, one field per flag; the value may be @path or JSON; with --state the text becomes the field "text"',
			collect,
			[]
		);
}

/** The question flags of `ask` and `batch`. */
function withQuestionFlags(command: Command): Command {
	return command
		.option(
			'--noul <args...>',
			'A yes or no question: ID INSTRUCTIONS [true=...] [false=...] (repeatable)'
		)
		.option(
			'--choice <args...>',
			'Pick one option: ID INSTRUCTIONS OPTION[=description] OPTION[=description] ... (repeatable)'
		)
		.option(
			'--score <args...>',
			'Rate on a rubric: ID INSTRUCTIONS LEVEL LEVEL ... low to high, 2 to 10 levels (repeatable)'
		)
		.option('--questions-file <path>', 'A JSON file of id to question')
		.option('--questions-json <json>', 'Inline JSON of id to question');
}

/**
 * What every asking verb takes. A command line the option parser refuses (a
 * missing question, an unknown flag) exits as a usage error, never with the 1
 * the parser uses by default: `yes` keeps 1 for "no".
 */
function withCommonFlags(command: Command): Command {
	return command
		.exitOverride((error) =>
			exitWith(error.exitCode === 0 ? ExitCode.Success : ExitCode.InvalidUsage)
		)
		.option('--no-cache', 'Ask the engine even when the answer cache holds this request')
		.option(
			'--timeout <seconds>',
			'How long to wait for the desktop app (default: what the request can take)'
		)
		.option('--json', 'Output as JSON (for scripting)');
}

const IN_APP = '(requires the desktop app)';

/**
 * Add the verbs an agent asks System One with to `maestro-cli s1`, and the
 * guide that teaches them (`guide`, `examples`). The flag grammar lives here,
 * beside the handlers it feeds, so a test can drive both through the real
 * option parser, and the guide's own examples can be checked against it.
 */
export function registerSystemOneAgentCommands(systemOne: Command): void {
	withCommonFlags(
		withStateFlags(
			systemOne
				.command('yes <question>')
				.description(
					`Ask one yes or no question about a state: prints P(yes) and yes, no or uncertain; exits 0 for yes and 1 for no, so it works in a shell if ${IN_APP}`
				)
				.option('--true <text>', 'What a yes means, when the boundary is subtle')
				.option('--false <text>', 'What a no means')
				.option('--threshold <p>', 'P(yes) at or above this is yes (default 0.5)')
				.option(
					'--band <low_high...>',
					'LOW HIGH: under LOW is no, HIGH and over is yes, between them is uncertain'
				)
		)
	).action(systemOneYes);

	withCommonFlags(
		withStateFlags(
			systemOne
				.command('pick <question> <options...>')
				.description(
					`Pick one option, each as NAME or NAME=description: prints the option, the probability of each, and confidence; exits 1 under --min-confidence ${IN_APP}`
				)
				.option('--min-confidence <p>', 'Exit 1 when confidence is under this (default 0)')
		)
	).action(systemOnePick);

	withCommonFlags(
		withStateFlags(
			systemOne
				.command('rate <question> <levels...>')
				.description(
					`Rate a state on a rubric of 2 to 10 levels, low to high, each describing a situation: prints the position and confidence; exits 1 under --min-confidence ${IN_APP}`
				)
				.option('--min-confidence <p>', 'Exit 1 when confidence is under this (default 0)')
		)
	).action(systemOneRate);

	withCommonFlags(
		withQuestionFlags(
			withStateFlags(
				systemOne
					.command('ask')
					.description(
						`Ask several questions about one state in one request, in any mix of --noul, --choice and --score; or pass a whole request as JSON ${IN_APP}`
					)
					.option(
						'-f, --request <file>',
						'A whole request as JSON, { "state": ..., "questions": { ... } }; - reads standard input'
					)
			)
		)
	).action((options: AskOptions, command: Command) => systemOneAsk(options, commandLine(command)));

	withCommonFlags(
		systemOne
			.command('rank [candidates...]')
			.description(
				`Rank or filter many candidates against a query, one question per candidate; the last line says whether every candidate was judged, and an unjudged one is unknown ${IN_APP}`
			)
			.requiredOption('--query <query>', 'What is looked for: text, JSON, or @path')
			.option(
				'--candidates-file <path>',
				'One candidate per line (keyed by line number), or a .json list or .jsonl rows'
			)
			.option(
				'--id-key <field>',
				'The field of a JSON candidate that names it in the results (default id; else its place in the list)'
			)
			.option(
				'--instructions <text>',
				'The question, naming the item `candidate` and the query `query` (default: is it relevant)'
			)
			.option('--true <text>', 'What a yes means (not with --levels)')
			.option('--false <text>', 'What a no means (not with --levels)')
			.option('--levels <levels...>', 'Grade on a rubric, low to high, instead of yes or no')
			.option('--context <context>', 'Shared background for every judgment: text, JSON, or @path')
			.option('--top <n>', 'Keep the best N')
			.option('--min <p>', 'Keep results at or above this, 0 to 1')
			.option(
				'--width <n>',
				`Cut a candidate shown on a row at this length (default ${RANK_ROW_WIDTH})`
			)
			.option('--echo', 'With --json, include each candidate in its result')
	).action(systemOneRank);

	withCommonFlags(
		withQuestionFlags(
			systemOne
				.command('batch')
				.description(
					`Ask the same questions of every row of a file, one request per row: prints JSONL, one answer row per input row and a last row that says whether the run finished ${IN_APP}`
				)
				.requiredOption(
					'-i, --input <file>',
					'JSONL (a row is the state) or text lines; - reads standard input'
				)
				.option('--state-key <field>', 'The field of each JSON row that is the state')
				.option('--id-key <field>', 'The field of each JSON row echoed back as id (default id)')
				.option('--text-lines', 'Read every line as text, even one that is JSON')
				.option('--echo', 'Include the state in each output row')
				.option('-o, --out <file>', 'Write the JSONL here and print only the summary')
		)
	).action((options: BatchOptions, command: Command) =>
		systemOneBatch(options, commandLine(command))
	);

	systemOne
		.command('usage')
		.description(
			`What agents' own System One requests came to, per agent: requests, cached requests, tokens, cost and latency, with today's spend against the budget ${IN_APP}`
		)
		.option('--agent <id>', 'Only this agent (an id or the start of one)')
		.option('--since <time>', 'Start: 30m, 2h, 1d, 1w, ISO-8601, or epoch (default: 30 days)')
		.option('--json', 'Output as JSON (for scripting)')
		.action(systemOneUsage);

	withStateFlags(
		systemOne
			.command('cost [state]')
			.description(
				`Estimate a request or a job before it is run: its tokens against the request limit, its requests and its price. Nothing is sent to an engine ${IN_APP}`
			)
			.option('--questions <n>', 'Questions asked of each state (default 1)')
			.option(
				'--question-chars <n>',
				'Average characters of one question with its criteria (default 120)'
			)
			.option('--items <n>', 'Candidates of a rank, or rows of a batch')
			.option(
				'--per-item',
				'Each item is its own request with the whole state (a batch), not packed (a rank)'
			)
	)
		.option('--json', 'Output as JSON (for scripting)')
		.action(systemOneCost);

	systemOne
		.command('guide [topic]')
		.description(
			'The System One playbook for agents: when to reach for it, how to ask, how to read the answer. Read it once per session before the first request; name a topic for depth (works with Maestro closed)'
		)
		.option('--list', 'List the topics')
		.option('--json', 'Output as JSON (for scripting)')
		.action(systemOneGuide);

	systemOne
		.command('examples [name]')
		.description(
			'System One recipes ready to paste: gutcheck, triage, rank, verify, screen, dedupe. With no name, list them; all prints every one (works with Maestro closed)'
		)
		.option('--json', 'Output as JSON (for scripting)')
		.action(systemOneExamples);
}
