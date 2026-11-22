/**
 * The local judge: System One's third engine. It answers the same typed
 * questions as Jev, on a text model the user chose, through the task router.
 *
 * The model is the `local-judge` task's assignment (a catalog model or a model
 * on an endpoint). There is no second place a judge model is stored.
 *
 * A task that offers a text model as one of its own sources is judged the same
 * way on THAT task's assignment (`AskLocalJudgeOptions.taskId`): model routing
 * assigned a text model asks its two questions here, on its own model, without
 * System One being on at all.
 *
 * Each question is one generation, constrained to a JSON schema built for it:
 *
 *   - `noul`   - `{ "answer": "yes" | "no", "confidence": 0..1 }`, read as P(yes).
 *   - `choice` - `{ "choice": "<option id>" }`, an enum of the question's options.
 *   - `score`  - `{ "level": N }`, an enum of the rubric's level numbers.
 *
 * One generation per question, not one for the whole request: a Jev answer does
 * not depend on the questions asked beside it, and a model that wrote every
 * answer in one reply would read its earlier answers while writing the later
 * ones.
 *
 * What holds for every caller:
 *
 *   1. **Never calibrated.** A model's stated confidence is not a measured
 *      probability. Every result says `calibrated: false`, and a choice or a
 *      score carries no distribution, because the model was not asked for one
 *      and must not be shown to have given one.
 *   2. **Redacted like any other engine.** The assigned source can be an
 *      endpoint on another machine, so the request goes through
 *      `redactSystemOneRequest` on the way out.
 *   3. **All the answers or none.** The first question that cannot be answered
 *      fails the request; a task applies its fail policy to the whole of it.
 *   4. **Every failure is a `SystemOneError`** for the engine `local-judge`.
 *      Nothing here asks Jev, or a different model, instead.
 */

import { taskAssignmentLocation } from '../../../shared/local-models/settings-location';
import {
	LOCAL_JUDGE_DEFAULT_TIMEOUT_MS,
	isSystemOneEngineCalibrated,
	redactSystemOneRequest,
	systemOneCostUsd,
	systemOneEngineLabel,
	systemOneQuestionsProblem,
	systemOneStateProblem,
	type SystemOneAnswer,
	type SystemOneAnswers,
	type SystemOneErrorCode,
	type SystemOneQuestion,
	type SystemOneQuestions,
	type SystemOneResult,
	type SystemOneState,
	type SystemOneText,
} from '../../../shared/local-models/system-one';
import {
	LOCAL_JUDGE_TASK_ID,
	LOCAL_MODEL_TASKS,
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
	type LocalModelTaskId,
} from '../../../shared/local-models/tasks';
import { getPrompt } from '../../prompt-manager';
import { getConfiguredLocalModelEndpoints } from '../endpoint-service';
import { SystemOneError } from '../errors';
import {
	localModelSourceKey,
	readLocalModelAssignments,
	sourceForAssignment,
	type LocalModelSource,
} from '../sources';
import { runLocalTask } from '../task-router';
import { LOCAL_TEXT_CONTEXT_TOKENS } from '../text-gen';

const ENGINE_ID = 'local-judge';

const PROMPT_ID = 'system-one-judge-local';

export interface AskLocalJudgeOptions {
	/** Budget for the whole request, every question included. */
	timeoutMs?: number;
	/** Caller cancellation, composed with the budget. */
	signal?: AbortSignal;
	/**
	 * The task whose assignment is the judge's model, and under which its
	 * generations are recorded. Defaults to the Local judge task: the model the
	 * System One engine runs on.
	 */
	taskId?: LocalModelTaskId;
	/** The agent the request is for, kept on each generation's run record. */
	agentId?: string;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Ask the local judge typed questions about a state.
 *
 * Resolves with one typed answer per question id, or rejects with a
 * `SystemOneError`. The answers are a model's own estimate: compare them
 * against a threshold tuned for that model, never against one tuned for Jev.
 */
export async function askLocalJudge(
	state: SystemOneState,
	questions: SystemOneQuestions,
	options: AskLocalJudgeOptions = {}
): Promise<SystemOneResult> {
	const invalid = systemOneStateProblem(state) ?? systemOneQuestionsProblem(questions);
	if (invalid) throw judgeError('invalid', invalid);

	const taskId = options.taskId ?? LOCAL_JUDGE_TASK_ID;
	const source = assignedSource(taskId);
	const label = describeJudge(source);
	const request = redactSystemOneRequest(state, questions);
	const system = getPrompt(PROMPT_ID);
	const turns = Object.entries(request.questions).map(([id, question]) => ({
		id,
		question,
		prompt: formatLocalJudgeInput(request.state, question),
		maxTokens: replyTokenBudget(question),
	}));

	// Checked for every question before the first one runs, so a request that
	// cannot be answered in full costs no generation at all.
	if (source.type === 'local') {
		for (const turn of turns) refuseIfTooLarge(label, system, turn.prompt, turn.maxTokens);
	}

	const timeoutMs = options.timeoutMs ?? LOCAL_JUDGE_DEFAULT_TIMEOUT_MS;
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

	const started = performance.now();
	const answers: SystemOneAnswers = {};
	let answeredBy = source;
	let inputTokens = 0;
	let outputTokens = 0;

	for (const turn of turns) {
		const verdict = await runLocalTask(taskId, {
			system,
			prompt: turn.prompt,
			maxTokens: turn.maxTokens,
			jsonSchema: localJudgeReplySchema(turn.question),
			signal,
			...(options.agentId ? { agentId: options.agentId } : {}),
		});

		switch (verdict.status) {
			case 'off':
			case 'use-utility-agent':
				// The assignment was read a moment ago; this is one that changed since.
				throw noModelError(taskId);
			case 'cancelled':
				if (options.signal?.aborted) {
					throw judgeError('cancelled', `${label}: the request was cancelled.`);
				}
				throw judgeError('timeout', `${label}: no answer within ${timeoutMs} ms.`);
			case 'unavailable':
				throw judgeError(
					unavailableCode(verdict.code),
					`${label}: could not answer. ${verdict.reason}`
				);
			case 'ok': {
				const parsed = parseLocalJudgeReply(turn.question, verdict.json);
				if (typeof parsed === 'string') {
					throw judgeError(
						'unavailable',
						`${label}: an unreadable answer to question "${turn.id}" (${parsed}). Assign a larger model if this repeats.`
					);
				}
				answers[turn.id] = parsed;
				answeredBy = verdict.source;
				inputTokens += verdict.tokensIn ?? 0;
				outputTokens += verdict.tokensOut ?? 0;
			}
		}
	}

	return {
		engine: ENGINE_ID,
		model: localModelSourceKey(answeredBy),
		answers,
		usage: { inputTokens, outputTokens },
		costUsd: systemOneCostUsd(ENGINE_ID, inputTokens),
		latencyMs: Math.round(performance.now() - started),
		calibrated: isSystemOneEngineCalibrated(ENGINE_ID),
		redacted: request.redacted,
	};
}

// ---------------------------------------------------------------------------
// The wire: one question to a schema, a prompt, and back to a typed answer
// ---------------------------------------------------------------------------

/**
 * The confidence values a noul may state. An enum, not a bare number: a model
 * held to the schema then cannot answer 85 for "85 percent", and a stated
 * confidence carries no more than one decimal of information anyway.
 */
const NOUL_CONFIDENCE_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

const NOUL_REPLY_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		answer: { type: 'string', enum: ['yes', 'no'] },
		confidence: { type: 'number', enum: NOUL_CONFIDENCE_STEPS },
	},
	required: ['answer', 'confidence'],
	additionalProperties: false,
};

/**
 * The JSON Schema one question's reply must satisfy. A local model is
 * grammar-constrained to it, so it cannot name an option that does not exist
 * or a level off the rubric; an endpoint is sent it as a response format, and
 * {@link parseLocalJudgeReply} checks what came back either way.
 */
export function localJudgeReplySchema(question: SystemOneQuestion): Record<string, unknown> {
	if (question.type === 'noul') return NOUL_REPLY_SCHEMA;
	if (question.type === 'choice') {
		return oneFieldSchema('choice', { type: 'string', enum: Object.keys(question.criteria) });
	}
	return oneFieldSchema('level', {
		type: 'integer',
		enum: question.criteria.map((_, level) => level),
	});
}

function oneFieldSchema(field: string, value: Record<string, unknown>): Record<string, unknown> {
	return {
		type: 'object',
		properties: { [field]: value },
		required: [field],
		additionalProperties: false,
	};
}

/**
 * The user turn for one question (the instructions are the
 * `system-one-judge-local` prompt, sent as the system turn).
 *
 * The state comes first and the question last. Every question of a request
 * then shares the state as a prefix, which a server that caches prompts
 * evaluates once, and the question is the last thing the model reads.
 */
export function formatLocalJudgeInput(state: SystemOneState, question: SystemOneQuestion): string {
	const lines = [
		'<state>',
		judgeText(state),
		'</state>',
		'',
		`Question type: ${question.type}`,
		`Question: ${judgeText(question.instructions)}`,
	];
	if (question.type === 'noul') {
		const { criteria } = question;
		if (criteria?.true !== undefined) lines.push(`Yes means: ${judgeText(criteria.true)}`);
		if (criteria?.false !== undefined) lines.push(`No means: ${judgeText(criteria.false)}`);
	} else if (question.type === 'choice') {
		lines.push('Options:');
		for (const [id, description] of Object.entries(question.criteria)) {
			// Quoted as JSON, so an id with a space or a colon in it is still one id.
			const quoted = JSON.stringify(id);
			lines.push(description === null ? `- ${quoted}` : `- ${quoted}: ${judgeText(description)}`);
		}
	} else {
		lines.push('Levels, low to high:');
		question.criteria.forEach((level, index) => lines.push(`${index}: ${judgeText(level)}`));
	}
	return lines.join('\n');
}

/**
 * The typed answer in a reply, or what is wrong with the reply.
 *
 * Strict, like the Jev client: a gate must not act on a guess at what a model
 * meant. An answer that is not one of the options, a level off the rubric, or a
 * confidence outside 0 to 1 is no answer.
 *
 * A noul's P(yes) is the stated confidence on the side the model chose. A
 * confidence under 0.5 in its own answer is read as 0.5 (undecided), so the
 * probability never says the opposite of the yes or no beside it.
 */
export function parseLocalJudgeReply(
	question: SystemOneQuestion,
	reply: unknown
): SystemOneAnswer | string {
	if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return 'no JSON object';
	const record = reply as Record<string, unknown>;

	if (question.type === 'noul') {
		const answer = typeof record.answer === 'string' ? record.answer.trim().toLowerCase() : null;
		if (answer !== 'yes' && answer !== 'no') return 'no yes or no';
		const { confidence } = record;
		if (
			typeof confidence !== 'number' ||
			!Number.isFinite(confidence) ||
			confidence < 0 ||
			confidence > 1
		) {
			return 'no confidence from 0 to 1';
		}
		const sure = Math.max(confidence, 0.5);
		return { type: 'noul', probability: answer === 'yes' ? sure : 1 - sure };
	}

	if (question.type === 'choice') {
		const { choice } = record;
		if (typeof choice !== 'string' || !Object.keys(question.criteria).includes(choice)) {
			return 'a choice that is not one of the options';
		}
		return { type: 'choice', choice };
	}

	const top = question.criteria.length - 1;
	const { level } = record;
	if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > top) {
		return `no level from 0 to ${top}`;
	}
	return { type: 'score', score: level };
}

/** A state, instructions or a criteria entry as the model reads it. */
function judgeText(value: SystemOneState | SystemOneText): string {
	return typeof value === 'string' ? value.trim() : JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/** Room for the JSON around an answer: braces, the key, a confidence. */
const REPLY_TOKEN_FLOOR = 48;

/**
 * Tokens one reply may use. A reply held to its schema stops when the JSON
 * closes, so this is a ceiling, not a cost. A choice must have room to write
 * its longest option id, and an id of code or symbols can run a token a
 * character.
 */
function replyTokenBudget(question: SystemOneQuestion): number {
	if (question.type !== 'choice') return REPLY_TOKEN_FLOOR;
	const longestId = Math.max(...Object.keys(question.criteria).map((id) => id.length));
	return REPLY_TOKEN_FLOOR + longestId;
}

/**
 * Characters per token assumed when a request is checked against the
 * in-process context. Low on purpose (English prose runs near 4, JSON and code
 * nearer 3), because the check has to err toward refusing: a judgment on a
 * state the model read only part of is worse than no judgment.
 */
const JUDGE_CHARS_PER_TOKEN = 3;

/** The chat template's own tokens around a system and a user turn. */
const CHAT_TEMPLATE_TOKENS = 64;

/**
 * Refuse a question that cannot fit the in-process context with its state.
 *
 * Only a catalog model is checked. An endpoint's context is the server's own
 * setting, which nothing here can read, so there the server has the last word.
 */
function refuseIfTooLarge(label: string, system: string, prompt: string, maxTokens: number): void {
	const overhead = CHAT_TEMPLATE_TOKENS + maxTokens;
	const needed = Math.ceil((system.length + prompt.length) / JUDGE_CHARS_PER_TOKEN) + overhead;
	if (needed <= LOCAL_TEXT_CONTEXT_TOKENS) return;
	const room = (LOCAL_TEXT_CONTEXT_TOKENS - overhead).toLocaleString('en-US');
	const sent = (needed - overhead).toLocaleString('en-US');
	throw judgeError(
		'too-large',
		`${label}: the request is too large. The state and one question must fit in about ${room} tokens, and this is about ${sent}. Send less state.`
	);
}

// ---------------------------------------------------------------------------
// Naming and errors
// ---------------------------------------------------------------------------

/** The source the judge is assigned, or the refusal that names where to assign one. */
function assignedSource(taskId: LocalModelTaskId): LocalModelSource {
	const source = sourceForAssignment(
		resolveLocalModelAssignment(readLocalModelAssignments(), taskId)
	);
	if (!source) throw noModelError(taskId);
	return source;
}

/** "Local judge (Qwen3 1.7B), not calibrated", the way every message names the engine. */
function describeJudge(source: LocalModelSource): string {
	return systemOneEngineLabel(ENGINE_ID, {
		model: localModelAssignmentSourceLabel(source, getConfiguredLocalModelEndpoints()),
	});
}

/** Why the judge cannot answer with no model assigned. Also what `s1 status` reports. */
export function localJudgeNoModelMessage(taskId: LocalModelTaskId = LOCAL_JUDGE_TASK_ID): string {
	const task = LOCAL_MODEL_TASKS[taskId];
	return `${systemOneEngineLabel(ENGINE_ID)}: no model is assigned. Assign ${task.label} a local model or an endpoint in ${taskAssignmentLocation(taskId)}.`;
}

function noModelError(taskId: LocalModelTaskId): SystemOneError {
	return judgeError('unavailable', localJudgeNoModelMessage(taskId));
}

/**
 * The System One code for a source the task router could not run. An endpoint
 * that refused its key or ran out of time says so; everything else (a model
 * not downloaded, a runtime that will not load, a server that is down) is the
 * engine being unavailable, and the reason beside it names which.
 */
function unavailableCode(routerCode: string): SystemOneErrorCode {
	if (routerCode === 'auth' || routerCode === 'missing-key') return 'auth';
	if (routerCode === 'timeout') return 'timeout';
	return 'unavailable';
}

function judgeError(code: SystemOneErrorCode, message: string): SystemOneError {
	return new SystemOneError(message, { code, engine: ENGINE_ID });
}
