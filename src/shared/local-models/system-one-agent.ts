/**
 * System One for agents: what `maestro-cli s1 yes | pick | rate | ask | rank |
 * batch` sends to the desktop, what comes back, and the rules that turn a long
 * job into requests an engine will take.
 *
 * Until this module, only Maestro's own tasks asked System One
 * (`runSystemOneTask`). An agent asks through the CLI: the CLI builds one of
 * the requests below, the desktop answers it (`runAgentSystemOneRequest` in
 * `src/main/local-models/system-one/agent-service.ts`), and the agent's own
 * environment gets nothing new. The key stays in the main process.
 *
 * Rules written down here so the service, the CLI and their tests read them
 * one way:
 *
 *   1. **A caller is untrusted.** A request is checked whole before anything is
 *      asked ({@link parseSystemOneAgentRequest}), and its size is bounded
 *      ({@link SYSTEM_ONE_AGENT_MAX_ITEMS}).
 *   2. **An item is keyed, never indexed.** `rank` puts each candidate INSIDE
 *      its own question. Jev mis-locates `candidates[i]` in a long array
 *      (measured on the `jev` CLI: 86 of 320 wrong at 150 items a request, 0 of
 *      320 with the item embedded), so no request here ever points at a
 *      position.
 *   3. **A long job is split under the token limit**
 *      ({@link chunkSystemOneQuestions}), and says whether it finished
 *      ({@link SystemOneCompleteness}). An item that was not judged is UNKNOWN,
 *      and the marker says so in words an agent reading cut-off output can act
 *      on.
 *   4. **Every answer names its engine** and whether its numbers are
 *      calibrated. A local judge's number is never handed over as a
 *      probability Jev gave.
 *   5. **A refusal is a result with a name**, never a silent pass: off, over
 *      budget, or the engine's own failure code. It tells the agent to go on
 *      without System One.
 *
 * Everything here is pure and bundle-safe.
 */

import { formatCost } from '../formatters';
import { modelsSettingsLocation } from './settings-location';
import { SYSTEM_ONE_MAX_TIMEOUT_MS, type SystemOneEngineChoice } from './system-one-settings';
import {
	LOCAL_JUDGE_DEFAULT_TIMEOUT_MS,
	SYSTEM_ONE_MAX_SCORE_LEVELS,
	SYSTEM_ONE_MIN_SCORE_LEVELS,
	estimateSystemOneTokens,
	isSystemOneJson,
	isSystemOneText,
	noul,
	score,
	systemOneQuestionsProblem,
	systemOneStateProblem,
	type SystemOneAnswers,
	type SystemOneEngineId,
	type SystemOneErrorCode,
	type SystemOneJson,
	type SystemOneQuestion,
	type SystemOneQuestions,
	type SystemOneState,
	type SystemOneText,
	type SystemOneUsage,
} from './system-one';

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

/** The verbs that ask an engine. `guide`, `examples`, `usage` and `cost` ask nothing. */
export const SYSTEM_ONE_AGENT_VERBS = ['yes', 'pick', 'rate', 'ask', 'rank', 'batch'] as const;

export type SystemOneAgentVerb = (typeof SYSTEM_ONE_AGENT_VERBS)[number];

/** The verbs that are one request: a state and its questions. */
export const SYSTEM_ONE_ASK_VERBS = ['yes', 'pick', 'rate', 'ask'] as const;

export type SystemOneAskVerb = (typeof SYSTEM_ONE_ASK_VERBS)[number];

/**
 * What an agent's request is filed under in the decision ledger, in the column
 * a task's run is filed under its task id: `agent:rank`. The prefix is what
 * separates the two, and what a day's agent spend is summed by.
 */
export const SYSTEM_ONE_AGENT_SOURCE_PREFIX = 'agent:';

export type SystemOneAgentSourceId = `agent:${SystemOneAgentVerb}`;

export function systemOneAgentSourceId(verb: SystemOneAgentVerb): SystemOneAgentSourceId {
	return `${SYSTEM_ONE_AGENT_SOURCE_PREFIX}${verb}`;
}

export function isSystemOneAgentSourceId(value: unknown): value is SystemOneAgentSourceId {
	return (
		typeof value === 'string' &&
		value.startsWith(SYSTEM_ONE_AGENT_SOURCE_PREFIX) &&
		(SYSTEM_ONE_AGENT_VERBS as readonly string[]).includes(
			value.slice(SYSTEM_ONE_AGENT_SOURCE_PREFIX.length)
		)
	);
}

/** The verb an agent ledger source names. */
export function systemOneAgentSourceVerb(source: SystemOneAgentSourceId): SystemOneAgentVerb {
	return source.slice(SYSTEM_ONE_AGENT_SOURCE_PREFIX.length) as SystemOneAgentVerb;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The most candidates one `rank`, or rows one `batch`, may carry. It bounds the
 * work one call can start; a larger job is run in parts, and the answer cache
 * makes a part that was already judged free.
 */
export const SYSTEM_ONE_AGENT_MAX_ITEMS = 5_000;

/**
 * The most questions one request carries. The `jev` CLI's default, measured:
 * 320 keyed questions in one request came back in 0.4 s with none mis-located.
 */
export const SYSTEM_ONE_AGENT_MAX_QUESTIONS = 250;

/**
 * The tokens one request is packed to: the state and every question in it.
 * Under Jev's budget for a state and its longest question (32,388), so a
 * request packed to this fits both of Jev's limits with room for an estimate
 * that runs low.
 */
export const SYSTEM_ONE_AGENT_REQUEST_TOKENS = 30_000;

/** Longest candidate key or row id kept. A key names an item; it is not the item. */
export const SYSTEM_ONE_AGENT_MAX_KEY_CHARS = 200;

/** How much one request may hold on an engine. */
export interface SystemOneRequestLimits {
	maxQuestions: number;
	maxTokens: number;
}

/**
 * How much one request may hold on an engine.
 *
 * The local judge answers one question per generation, and a request's budget
 * covers all of them, so a request there carries ONE question: a slow answer
 * then costs one item, not a chunk of them. Its own context limit is checked
 * by the judge, which refuses a question that cannot fit.
 */
export function systemOneAgentRequestLimits(engine: SystemOneEngineId): SystemOneRequestLimits {
	return engine === 'local-judge'
		? { maxQuestions: 1, maxTokens: Number.POSITIVE_INFINITY }
		: {
				maxQuestions: SYSTEM_ONE_AGENT_MAX_QUESTIONS,
				maxTokens: SYSTEM_ONE_AGENT_REQUEST_TOKENS,
			};
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** One request: a state and typed questions about it (`yes`, `pick`, `rate`, `ask`). */
export interface SystemOneAgentAskRequest {
	kind: 'ask';
	/** The verb the caller typed. Kept on the ledger record. */
	verb: SystemOneAskVerb;
	state: SystemOneState;
	questions: SystemOneQuestions;
	/** Ask the engine even when the answer cache holds this request. */
	noCache?: boolean;
}

/** One thing to rank, under the name the answer comes back with. */
export interface SystemOneRankCandidate {
	/** Unique in the request: a line number, a file path, the item's own id. */
	key: string;
	/** The candidate itself: text, or JSON. */
	item: SystemOneJson;
}

/** Grade every candidate against a query, one question per candidate. */
export interface SystemOneAgentRankRequest {
	kind: 'rank';
	/** What is looked for. The question calls it `query`. */
	query: SystemOneText;
	/** Shared background, when the candidates need it. The question calls it `context`. */
	context?: SystemOneText;
	candidates: SystemOneRankCandidate[];
	/** The question, naming the item `candidate` and the query `query`. Defaults to relevance. */
	instructions?: string;
	/** What yes and no mean. Not with `levels`. */
	criteria?: { true?: SystemOneText; false?: SystemOneText };
	/** Grade on a rubric, low to high, instead of yes or no. */
	levels?: SystemOneText[];
	/** Keep the best N. */
	top?: number;
	/** Keep results at or above this, from 0 to 1. */
	min?: number;
	noCache?: boolean;
}

/** One row of a batch: a state, and where it came from. */
export interface SystemOneBatchRow {
	/** The row's line in the caller's input, unique in the request. Echoed back. */
	line: number;
	/** The row's own id, when it has one. Echoed back. */
	id?: string | number;
	state: SystemOneState;
}

/** Ask the same questions of every row, one request per row. */
export interface SystemOneAgentBatchRequest {
	kind: 'batch';
	rows: SystemOneBatchRow[];
	questions: SystemOneQuestions;
	noCache?: boolean;
}

export type SystemOneAgentRequest =
	| SystemOneAgentAskRequest
	| SystemOneAgentRankRequest
	| SystemOneAgentBatchRequest;

export type SystemOneAgentRequestKind = SystemOneAgentRequest['kind'];

/** The verb a request is filed under. */
export function systemOneAgentRequestVerb(request: SystemOneAgentRequest): SystemOneAgentVerb {
	return request.kind === 'ask' ? request.verb : request.kind;
}

export type SystemOneAgentRequestParse =
	| { ok: true; request: SystemOneAgentRequest }
	| { ok: false; message: string };

function refuse(message: string): { ok: false; message: string } {
	return { ok: false, message };
}

/** Why a state cannot be sent, or `null` when it can. */
function stateProblem(state: unknown): string | null {
	const problem = systemOneStateProblem(state);
	if (problem) return problem;
	return isSystemOneJson(state)
		? null
		: 'The state must be JSON: text, numbers, lists and objects.';
}

/** Why a set of questions cannot be sent in one request, or `null` when it can. */
function questionsProblem(questions: unknown): string | null {
	const problem = systemOneQuestionsProblem(questions);
	if (problem) return problem;
	if (!isSystemOneJson(questions)) return 'The questions must be JSON.';
	const count = Object.keys(questions as object).length;
	if (count > SYSTEM_ONE_AGENT_MAX_QUESTIONS) {
		return `One request takes at most ${SYSTEM_ONE_AGENT_MAX_QUESTIONS} questions, and this has ${count}. Use rank for many items against one query, or batch for the same questions over many rows.`;
	}
	return null;
}

function noCacheProblem(value: unknown): string | null {
	return value === undefined || typeof value === 'boolean' ? null : 'noCache is true or false.';
}

function parseAsk(record: Record<string, unknown>): SystemOneAgentRequestParse {
	const verb = record.verb ?? 'ask';
	if (!(SYSTEM_ONE_ASK_VERBS as readonly unknown[]).includes(verb)) {
		return refuse(`"${String(verb)}" is not a verb. Use ${SYSTEM_ONE_ASK_VERBS.join(', ')}.`);
	}
	const problem =
		stateProblem(record.state) ??
		questionsProblem(record.questions) ??
		noCacheProblem(record.noCache);
	if (problem) return refuse(problem);
	return {
		ok: true,
		request: {
			kind: 'ask',
			verb: verb as SystemOneAskVerb,
			state: record.state as SystemOneState,
			questions: record.questions as SystemOneQuestions,
			...(record.noCache === true ? { noCache: true } : {}),
		},
	};
}

/** Why a list of items cannot be taken, or `null` when it can. */
function itemCountProblem(value: unknown, what: string): string | null {
	if (!Array.isArray(value) || value.length === 0) return `Give at least one ${what}.`;
	if (value.length > SYSTEM_ONE_AGENT_MAX_ITEMS) {
		return `One call takes at most ${SYSTEM_ONE_AGENT_MAX_ITEMS.toLocaleString('en-US')} ${what}s, and this has ${value.length.toLocaleString('en-US')}. Run it in parts.`;
	}
	return null;
}

function isBlankItem(item: unknown): boolean {
	return item === null || (typeof item === 'string' && item.trim() === '');
}

function parseRank(record: Record<string, unknown>): SystemOneAgentRequestParse {
	if (!isSystemOneText(record.query) || !isSystemOneJson(record.query)) {
		return refuse('Give the query: what the candidates are ranked against.');
	}
	if (
		record.context !== undefined &&
		(!isSystemOneText(record.context) || !isSystemOneJson(record.context))
	) {
		return refuse('The context must be text or JSON.');
	}
	const countProblem = itemCountProblem(record.candidates, 'candidate');
	if (countProblem) return refuse(countProblem);

	const candidates: SystemOneRankCandidate[] = [];
	const seen = new Set<string>();
	for (const [position, entry] of (record.candidates as unknown[]).entries()) {
		const candidate = isPlainObject(entry) ? entry : {};
		const key = typeof candidate.key === 'string' ? candidate.key.trim() : '';
		if (key === '' || key.length > SYSTEM_ONE_AGENT_MAX_KEY_CHARS) {
			return refuse(
				`Candidate ${position + 1} needs a key of 1 to ${SYSTEM_ONE_AGENT_MAX_KEY_CHARS} characters.`
			);
		}
		if (seen.has(key))
			return refuse(`Two candidates share the key "${key}". A key names one item.`);
		seen.add(key);
		if (isBlankItem(candidate.item) || !isSystemOneJson(candidate.item)) {
			return refuse(`Candidate "${key}" is empty or is not JSON.`);
		}
		candidates.push({ key, item: candidate.item });
	}

	if (
		record.instructions !== undefined &&
		(typeof record.instructions !== 'string' || record.instructions.trim() === '')
	) {
		return refuse('The question must be text.');
	}

	let levels: SystemOneText[] | undefined;
	if (record.levels !== undefined) {
		if (
			!Array.isArray(record.levels) ||
			record.levels.length < SYSTEM_ONE_MIN_SCORE_LEVELS ||
			record.levels.length > SYSTEM_ONE_MAX_SCORE_LEVELS ||
			!record.levels.every((level) => isSystemOneText(level) && isSystemOneJson(level))
		) {
			return refuse(
				`A rubric needs ${SYSTEM_ONE_MIN_SCORE_LEVELS} to ${SYSTEM_ONE_MAX_SCORE_LEVELS} levels, low to high.`
			);
		}
		levels = record.levels as SystemOneText[];
	}

	let criteria: { true?: SystemOneText; false?: SystemOneText } | undefined;
	if (record.criteria !== undefined) {
		if (levels) return refuse('Give a rubric or what yes and no mean, not both.');
		const stated = record.criteria;
		if (
			!isPlainObject(stated) ||
			Object.keys(stated).some((key) => key !== 'true' && key !== 'false') ||
			!Object.values(stated).every((value) => isSystemOneText(value) && isSystemOneJson(value))
		) {
			return refuse('The criteria may only say what "true" and "false" mean.');
		}
		criteria = stated as { true?: SystemOneText; false?: SystemOneText };
	}

	if (
		record.top !== undefined &&
		(typeof record.top !== 'number' || !Number.isInteger(record.top) || record.top < 1)
	) {
		return refuse('top is a whole number, 1 or more.');
	}
	if (
		record.min !== undefined &&
		(typeof record.min !== 'number' || !(record.min >= 0) || record.min > 1)
	) {
		return refuse('min is a number from 0 to 1.');
	}
	const cacheProblem = noCacheProblem(record.noCache);
	if (cacheProblem) return refuse(cacheProblem);

	return {
		ok: true,
		request: {
			kind: 'rank',
			query: record.query,
			...(record.context !== undefined ? { context: record.context as SystemOneText } : {}),
			candidates,
			...(record.instructions !== undefined
				? { instructions: (record.instructions as string).trim() }
				: {}),
			...(criteria ? { criteria } : {}),
			...(levels ? { levels } : {}),
			...(record.top !== undefined ? { top: record.top as number } : {}),
			...(record.min !== undefined ? { min: record.min as number } : {}),
			...(record.noCache === true ? { noCache: true } : {}),
		},
	};
}

function parseBatch(record: Record<string, unknown>): SystemOneAgentRequestParse {
	const countProblem = itemCountProblem(record.rows, 'row');
	if (countProblem) return refuse(countProblem);

	const rows: SystemOneBatchRow[] = [];
	const seen = new Set<number>();
	for (const [position, entry] of (record.rows as unknown[]).entries()) {
		const row = isPlainObject(entry) ? entry : {};
		const { line, id } = row;
		if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
			return refuse(`Row ${position + 1} needs its line: a whole number, 0 or more.`);
		}
		if (seen.has(line)) return refuse(`Two rows share line ${line}. A line names one row.`);
		seen.add(line);
		if (
			id !== undefined &&
			!(typeof id === 'number' && Number.isFinite(id)) &&
			!(typeof id === 'string' && id.length <= SYSTEM_ONE_AGENT_MAX_KEY_CHARS)
		) {
			return refuse(
				`Row at line ${line}: an id is a number, or text of at most ${SYSTEM_ONE_AGENT_MAX_KEY_CHARS} characters.`
			);
		}
		const problem = stateProblem(row.state);
		if (problem) return refuse(`Row at line ${line}: ${problem}`);
		rows.push({
			line,
			...(id !== undefined ? { id: id as string | number } : {}),
			state: row.state as SystemOneState,
		});
	}

	const problem = questionsProblem(record.questions) ?? noCacheProblem(record.noCache);
	if (problem) return refuse(problem);
	return {
		ok: true,
		request: {
			kind: 'batch',
			rows,
			questions: record.questions as SystemOneQuestions,
			...(record.noCache === true ? { noCache: true } : {}),
		},
	};
}

/**
 * Read a request as the CLI sends it, or say why it cannot be read. This is the
 * one validator: nothing is asked, cached, counted or recorded for a request it
 * refuses. The request it returns holds only the fields it checked.
 */
export function parseSystemOneAgentRequest(raw: unknown): SystemOneAgentRequestParse {
	if (!isPlainObject(raw)) return refuse('A System One request must be an object.');
	switch (raw.kind) {
		case 'ask':
			return parseAsk(raw);
		case 'rank':
			return parseRank(raw);
		case 'batch':
			return parseBatch(raw);
		default:
			return refuse(`"${String(raw.kind)}" is not a kind of request. Use ask, rank or batch.`);
	}
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * The budget one agent request gets on Jev or OpenJev, unless the user set a
 * longer one. The stored budget is sized for a gate: one question, about a
 * second. An agent's request can carry 250 questions, so it gets what the `jev`
 * CLI gives a request.
 */
export const SYSTEM_ONE_AGENT_TIMEOUT_MS = 30_000;

/** The most one request to the local judge may take, however many questions it carries. */
export const SYSTEM_ONE_AGENT_JUDGE_MAX_TIMEOUT_MS = 300_000;

/**
 * What a `rank` or a `batch` is allowed per item, on top of one request's
 * budget, before the CLI stops waiting. Far above a remote engine's pace (a
 * request every 60 ms) and about what a local judge takes to answer one
 * question on a warm model.
 */
export const SYSTEM_ONE_AGENT_WAIT_PER_ITEM_MS = 1_000;

/** What the round trip adds around the engine's own budget: the bridge, the cache, the ledger. */
const SYSTEM_ONE_AGENT_WAIT_MARGIN_MS = 15_000;

/**
 * How long the CLI waits for the desktop to answer a request before it gives
 * up. The CLI does not know which engine is in force, so this is the longest
 * budget any of them gives one request, plus {@link
 * SYSTEM_ONE_AGENT_WAIT_PER_ITEM_MS} for every item of a long job. A job that
 * outlasts it is not lost: the desktop goes on, and what it answered is in the
 * answer cache for the next run.
 */
export function systemOneAgentWaitMs(request: SystemOneAgentRequest): number {
	const questions = request.kind === 'rank' ? 1 : Object.keys(request.questions).length;
	const oneRequest = Math.max(
		SYSTEM_ONE_MAX_TIMEOUT_MS,
		SYSTEM_ONE_AGENT_TIMEOUT_MS,
		Math.min(LOCAL_JUDGE_DEFAULT_TIMEOUT_MS * questions, SYSTEM_ONE_AGENT_JUDGE_MAX_TIMEOUT_MS)
	);
	const items =
		request.kind === 'ask'
			? 0
			: request.kind === 'rank'
				? request.candidates.length
				: request.rows.length;
	return oneRequest + items * SYSTEM_ONE_AGENT_WAIT_PER_ITEM_MS + SYSTEM_ONE_AGENT_WAIT_MARGIN_MS;
}

// ---------------------------------------------------------------------------
// Rank: one question per candidate, the candidate inside it
// ---------------------------------------------------------------------------

/** The default yes or no question of a rank. */
export const SYSTEM_ONE_RANK_QUESTION = 'Is `candidate` relevant to `query`?';

/** The default question of a rank on a rubric. */
export const SYSTEM_ONE_RANK_RUBRIC_QUESTION = 'How well does `candidate` match `query`?';

/** The state every request of a rank shares: the query, and the context when there is one. */
export function systemOneRankState(
	request: Pick<SystemOneAgentRankRequest, 'query' | 'context'>
): SystemOneState {
	return {
		query: request.query,
		...(request.context !== undefined ? { context: request.context } : {}),
	};
}

/**
 * The question one candidate is judged by. The candidate travels INSIDE the
 * question, beside the question's text, so the engine never has to find it in a
 * list.
 */
export function systemOneRankQuestion(
	request: Pick<SystemOneAgentRankRequest, 'instructions' | 'criteria' | 'levels'>,
	item: SystemOneJson
): SystemOneQuestion {
	const question =
		request.instructions ??
		(request.levels ? SYSTEM_ONE_RANK_RUBRIC_QUESTION : SYSTEM_ONE_RANK_QUESTION);
	const instructions = { question, candidate: item };
	return request.levels
		? score(instructions, request.levels)
		: noul(instructions, request.criteria);
}

/**
 * The id of a candidate's question: its place in the caller's list, which no
 * engine ever sees (a question's id is not sent to the model). The service maps
 * it back to the candidate's key by lookup.
 */
export function systemOneRankQuestionId(ordinal: number): string {
	return `c${ordinal}`;
}

/**
 * What to tell a caller whose question points at a position, or `null`. The
 * candidate is in the question; a positional reference has nothing to point at.
 */
export function systemOneRankQuestionWarning(instructions: string | undefined): string | null {
	if (!instructions || !/candidates\[|\{i\}/.test(instructions)) return null;
	return 'Refer to the item as `candidate`: each question carries its own item. A positional reference such as `candidates[i]` has nothing to point at, and Jev mis-locates items by position in a long list.';
}

// ---------------------------------------------------------------------------
// Splitting a job into requests
// ---------------------------------------------------------------------------

/**
 * Pack questions that share one state into as few requests as the limits
 * allow, in order. A question too large to share a request goes alone: the
 * engine has the last word on whether it fits (`too-large`), not this estimate.
 */
export function chunkSystemOneQuestions(
	state: SystemOneState,
	questions: ReadonlyArray<readonly [id: string, question: SystemOneQuestion]>,
	limits: SystemOneRequestLimits
): SystemOneQuestions[] {
	const stateTokens = estimateSystemOneTokens(state);
	const chunks: SystemOneQuestions[] = [];
	let current: SystemOneQuestions = {};
	let count = 0;
	let tokens = stateTokens;
	for (const [id, question] of questions) {
		const cost = estimateSystemOneTokens(question as unknown as SystemOneJson);
		if (count > 0 && (count >= limits.maxQuestions || tokens + cost > limits.maxTokens)) {
			chunks.push(current);
			current = {};
			count = 0;
			tokens = stateTokens;
		}
		current[id] = question;
		count += 1;
		tokens += cost;
	}
	if (count > 0) chunks.push(current);
	return chunks;
}

// ---------------------------------------------------------------------------
// Access: the switches, and the budget
// ---------------------------------------------------------------------------

/**
 * The switch that refused an agent's request.
 *
 *   - `engine-off`       - no engine is chosen.
 *   - `agents-off`       - "Let agents use System One" is switched off.
 *   - `agent-opted-out`  - this agent is switched off in its own settings.
 *   - `engine-not-ready` - the engine cannot answer as it is set up (no key, no
 *                          URL, no judge model).
 *   - `engine-untested`  - the engine has not passed its Test as it is set up.
 *   - `budget-day`       - today's budget across all agents is spent.
 *   - `budget-agent`     - this agent's own budget for today is spent.
 */
export type SystemOneAgentGate =
	| 'engine-off'
	| 'agents-off'
	| 'agent-opted-out'
	| 'engine-not-ready'
	| 'engine-untested'
	| 'budget-day'
	| 'budget-agent';

/** What an agent's spend today is, against what it may be. US dollars. */
export interface SystemOneAgentBudget {
	/** Epoch ms of the local midnight the count started at. */
	dayStartedAt: number;
	dailyBudgetUsd: number;
	/** What all agents have spent today. */
	spentTodayUsd: number;
	remainingTodayUsd: number;
	/** The caller's own count. Absent for a request that names no agent. */
	agent?: {
		agentId: string;
		/** This agent's own cap, or null when it has none. */
		budgetUsd: number | null;
		spentTodayUsd: number;
		remainingTodayUsd: number | null;
	};
}

/** The sentence that ends every refusal: the agent has work to do either way. */
export const SYSTEM_ONE_CONTINUE_WITHOUT = 'Continue without System One.';

/**
 * Why a request was refused by a switch, in words for the agent that sent it
 * and the person who reads its transcript. Every one starts by saying System
 * One is off or spent, names the switch, and ends with
 * {@link SYSTEM_ONE_CONTINUE_WITHOUT}.
 */
export function systemOneAgentGateMessage(
	gate: SystemOneAgentGate,
	detail: SystemOneAgentGateDetail = {}
): string {
	return `${systemOneAgentGateReason(gate, detail)} ${SYSTEM_ONE_CONTINUE_WITHOUT}`;
}

/** What a gate's sentence is worded from. */
export interface SystemOneAgentGateDetail {
	engineLabel?: string;
	problem?: string | null;
	budget?: SystemOneAgentBudget;
}

/**
 * Which switch refuses, as one sentence for a person: what a settings surface
 * shows beside the control. {@link systemOneAgentGateMessage} is this sentence
 * with the instruction to the agent after it.
 */
export function systemOneAgentGateReason(
	gate: SystemOneAgentGate,
	detail: SystemOneAgentGateDetail = {}
): string {
	const where = modelsSettingsLocation('system-one');
	switch (gate) {
		case 'engine-off':
			return `System One is off: no engine is chosen in ${where}.`;
		case 'agents-off':
			return `System One is off for agents: "Let agents use System One" is switched off in ${where}.`;
		case 'agent-opted-out':
			return "System One is off for this agent: it is switched off on the Models tab of the agent's settings.";
		case 'engine-not-ready':
			return `System One is off: ${detail.problem ?? `${detail.engineLabel ?? 'the engine'} is not set up. See ${where}.`}`;
		case 'engine-untested':
			return `System One is off: ${detail.engineLabel ?? 'the engine'} has not passed its Test as it is set up now. Run the Test in ${where}, or \`maestro-cli s1 test\`.`;
		case 'budget-day': {
			const budget = detail.budget;
			const spent = budget
				? ` (${formatCost(budget.spentTodayUsd)} of ${formatCost(budget.dailyBudgetUsd)} across all agents)`
				: '';
			return `System One's budget for today is spent${spent}. It resets at midnight.`;
		}
		case 'budget-agent': {
			const own = detail.budget?.agent;
			const spent =
				own && own.budgetUsd !== null
					? ` (${formatCost(own.spentTodayUsd)} of ${formatCost(own.budgetUsd)})`
					: '';
			return `This agent's System One budget for today is spent${spent}. It resets at midnight.`;
		}
	}
}

/**
 * Whether an agent's request would be answered right now, and by what. What the
 * system prompt's System One section is built from, and what a status surface
 * shows. Read from the settings and the day's count; nothing is sent.
 */
export interface SystemOneAgentAccess {
	allowed: boolean;
	/** The switch that refuses, or null when a request would be answered. */
	gate: SystemOneAgentGate | null;
	/** {@link systemOneAgentGateMessage} for the gate. Null when allowed. */
	message: string | null;
	/** {@link systemOneAgentGateReason} for the gate: the same sentence for a person. Null when allowed. */
	reason: string | null;
	engine: SystemOneEngineChoice;
	engineLabel: string;
	/** Whether the engine's numbers are calibrated. Null when off. */
	calibrated: boolean | null;
	budget: SystemOneAgentBudget;
}

/** The agent settings field that opts one agent out. Read with {@link isSystemOneOptedOut}. */
export const SYSTEM_ONE_OPT_OUT_FIELD = 'systemOneOptOut';

/** True when a stored agent record switches System One off for that agent. */
export type SystemOneOptOutEdit =
	| { ok: true; optOut: true | undefined }
	| { ok: false; error: string };

/**
 * Read an opt-out as a writer sends it. `true` switches System One off for the
 * agent. `false`, `null` and an absent value all mean the agent follows "Let
 * agents use System One", which is stored as NO field: an agent is never
 * recorded as opted in, so a default that moves later still reaches it. The one
 * validator for the Models tab switch and `update-agent --system-one`.
 */
export function parseSystemOneOptOutEdit(value: unknown): SystemOneOptOutEdit {
	if (value === true) return { ok: true, optOut: true };
	if (value === false || value === null || value === undefined) {
		return { ok: true, optOut: undefined };
	}
	return { ok: false, error: `${SYSTEM_ONE_OPT_OUT_FIELD} must be true, false or null.` };
}

/** What the per-agent switch means in each position, for the Models tab and the CLI. */
export const SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS: Readonly<Record<'on' | 'off', string>> =
	Object.freeze({
		on: 'This agent follows "Let agents use System One".',
		off: 'This agent cannot ask System One, and its system prompt leaves it out from its next start.',
	});

export function isSystemOneOptedOut(record: Record<string, unknown> | null | undefined): boolean {
	return record?.[SYSTEM_ONE_OPT_OUT_FIELD] === true;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * Why a request has no answer: a switch (`off`), the budget, or the engine's
 * own failure code. `invalid` is also what a request that cannot be read gets.
 */
export type SystemOneAgentRefusalCode = SystemOneErrorCode | 'off' | 'budget';

/** A request that was not answered. It names why, and never names another engine. */
export interface SystemOneAgentRefusal {
	ok: false;
	code: SystemOneAgentRefusalCode;
	/** The switch that refused, for `off` and `budget`. */
	gate?: SystemOneAgentGate;
	/** Written for the agent and the person reading its transcript. */
	message: string;
	/** The engine that was asked, when the request reached one. */
	engine?: SystemOneEngineId;
	engineLabel?: string;
	budget?: SystemOneAgentBudget;
}

/** What every answer says about itself. */
export interface SystemOneAgentAnswerMeta {
	/** The engine that answered. */
	engine: SystemOneEngineId;
	/** The engine as a person reads it. A local judge's says "not calibrated". */
	engineLabel: string;
	/** False for the local judge: its numbers are not probabilities to set a threshold by. */
	calibrated: boolean;
	/** The model the engine says answered. Empty when no request was answered. */
	model: string;
	/** True when every answer came from the answer cache: nothing was sent, nothing spent. */
	cached: boolean;
	/** Wall time of the call, in the main process. 0 for a cached answer. */
	latencyMs: number;
	/** What the engine counted for the requests that were sent. */
	tokens: SystemOneUsage;
	costUsd: number;
	/** True when a secret-shaped span was removed from the request before it was sent. */
	redacted: boolean;
	/** The spend after this call. */
	budget: SystemOneAgentBudget;
}

export interface SystemOneAgentAskResult extends SystemOneAgentAnswerMeta {
	ok: true;
	kind: 'ask';
	verb: SystemOneAskVerb;
	answers: SystemOneAnswers;
}

/** One reason part of a job has no answer, with how many requests it took out. */
export interface SystemOneCompletenessError {
	code: SystemOneAgentRefusalCode;
	message: string;
	requests: number;
}

/**
 * Whether a `rank` or a `batch` judged everything it was given.
 *
 * `marker` is one line, for the END of the output: an agent whose shell output
 * was cut off can tell "nothing else matched" from "the list was cut". An item
 * with no answer is UNKNOWN. It is never reported as a low score.
 */
export interface SystemOneCompleteness {
	complete: boolean;
	/** Candidates or rows given. */
	total: number;
	/** The ones that have an answer. */
	judged: number;
	/** Requests the job was split into. */
	requests: number;
	/** Requests an engine was asked and did not answer. */
	failedRequests: number;
	/** Requests never sent: the budget ran out, the key was refused, or the call was cancelled. */
	skippedRequests: number;
	errors: SystemOneCompletenessError[];
	marker: string;
}

/** Longest error text quoted into a marker. The whole message is in `errors`. */
const MARKER_ERROR_CHARS = 160;

/**
 * Build the completeness record of a job. `shown` is what a rank returns after
 * its `top` and `min` are applied.
 */
export function buildSystemOneCompleteness(
	kind: 'rank' | 'batch',
	counts: Pick<
		SystemOneCompleteness,
		'total' | 'judged' | 'requests' | 'failedRequests' | 'skippedRequests' | 'errors'
	>,
	shown?: number
): SystemOneCompleteness {
	const complete = counts.judged === counts.total;
	const [items, done] = kind === 'rank' ? ['candidates', 'judged'] : ['rows', 'answered'];
	const tally = `${counts.judged}/${counts.total} ${items} ${done}`;
	let marker: string;
	if (complete) {
		const tail = kind === 'rank' && shown !== undefined ? `; ${shown} shown` : '';
		marker = `End s1 ${kind}: ${tally} in ${counts.requests} request(s)${tail}.`;
	} else {
		const first = counts.errors[0]?.message ?? 'no reason given';
		const why =
			first.length > MARKER_ERROR_CHARS ? `${first.slice(0, MARKER_ERROR_CHARS)}...` : first;
		const unsent =
			counts.skippedRequests > 0 ? `, ${counts.skippedRequests} request(s) not sent` : '';
		const unknown =
			kind === 'rank'
				? 'Unjudged candidates are UNKNOWN, not irrelevant.'
				: 'A row with no answer is UNKNOWN, not a no.';
		marker = `INCOMPLETE s1 ${kind}: ${tally}; ${counts.failedRequests} request(s) failed${unsent} (${why}) ${unknown}`;
	}
	return { ...counts, complete, marker };
}

/** One ranked candidate. */
export interface SystemOneRankResult {
	key: string;
	/** 0 to 1: P(yes), or the rubric position over its top level. */
	p: number;
	/** The rubric position, for a rank on a rubric. */
	score?: number;
	/** How peaked the engine's distribution is, when it reports one. */
	confidence?: number;
}

export interface SystemOneAgentRankResult extends SystemOneAgentAnswerMeta {
	ok: true;
	kind: 'rank';
	/** Best first, after `top` and `min`. */
	results: SystemOneRankResult[];
	/** Keys of the candidates with no answer. UNKNOWN, not irrelevant. */
	unjudged: string[];
	completeness: SystemOneCompleteness;
	/** How many requests were answered from the cache. */
	cachedRequests: number;
	warnings: string[];
}

/** One row of a batch: its answers, or why it has none. */
export type SystemOneBatchResultRow = {
	line: number;
	id?: string | number;
} & (
	| { answers: SystemOneAnswers; cached: boolean }
	| { error: { code: SystemOneAgentRefusalCode; message: string } }
);

export interface SystemOneAgentBatchResult extends SystemOneAgentAnswerMeta {
	ok: true;
	kind: 'batch';
	/** In the order the rows were given. */
	rows: SystemOneBatchResultRow[];
	completeness: SystemOneCompleteness;
	cachedRequests: number;
}

export type SystemOneAgentResult =
	| SystemOneAgentAskResult
	| SystemOneAgentRankResult
	| SystemOneAgentBatchResult;

/** What `runAgentSystemOneRequest` answers with: typed answers, or a named refusal. */
export type SystemOneAgentResponse = SystemOneAgentResult | SystemOneAgentRefusal;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
