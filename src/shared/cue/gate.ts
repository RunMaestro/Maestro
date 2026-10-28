/**
 * Cue gate: shared, process-agnostic pieces.
 *
 * A subscription may carry a `gate`: a condition in plain language, such as
 * "the comment asks for a code change or reports a bug". Before Cue starts a
 * run for an event, the `cue-gate` Local Models task answers yes or no against
 * the event payload. A "no" skips the run and records why.
 *
 * The point is COST. Most Cue events do not need a cloud turn, and a small
 * local model can tell which ones do. A gate is NOT a security control: the
 * event payload is untrusted text and can argue its way past a yes/no model.
 * The prompt-injection screen is the control for hostile text.
 *
 * Failure policy: a gate whose model cannot answer fails OPEN. The run starts,
 * and the user is warned, because a missing gate model must not silently stop
 * automation the user depends on. `gate_on_unavailable: skip` turns that into
 * fail closed for a subscription whose runs are not worth an unchecked turn.
 *
 * The task can also be assigned to System One, which answers one typed yes or
 * no question about the event ({@link cueGateSystemOneRequest}) instead of
 * writing a reply. Its engine giving no answer is the same `unavailable`, and
 * the Cue gate task's own fail policy (Settings > Models > System One) decides
 * for a subscription that states no `gate_on_unavailable`.
 *
 * Everything here is pure, with no Electron, Node, or DOM dependency: the
 * reply contract, the caps that keep an event inside a small model context,
 * the policy, and the record stamped on the event. The model call is
 * main-process only (`src/main/local-models/cue-gate.ts`), and the dispatch
 * service (`src/main/cue/cue-dispatch-service.ts`) is the one place a gate is
 * applied.
 */

import { noul, type SystemOneAnswers, type SystemOneTaskRequest } from '../local-models/system-one';
import type { CueEvent } from './contracts';

/** What a gate does when its model cannot answer. */
export const CUE_GATE_ON_UNAVAILABLE = ['run', 'skip'] as const;
export type CueGateOnUnavailable = (typeof CUE_GATE_ON_UNAVAILABLE)[number];

/** Fail open: see the failure policy in the module comment. */
export const DEFAULT_CUE_GATE_ON_UNAVAILABLE: CueGateOnUnavailable = 'run';

/** Longest gate condition accepted from cue.yaml. A condition is one sentence. */
export const CUE_GATE_MAX_CONDITION_LENGTH = 1000;

/** Longest reason kept from a model reply. */
export const CUE_GATE_MAX_REASON_LENGTH = 240;

/**
 * A gate as a person sets it: the condition and what to do when no model can
 * answer. The shape every authoring surface speaks (the trigger panel, the
 * Scheduled Task form, `maestro-cli cue gate`, `cue schedule --gate`), so a
 * gate set by clicking and one set from the CLI are the same two keys on disk.
 */
export interface CueGateSetting {
	condition: string;
	/** Absent means {@link DEFAULT_CUE_GATE_ON_UNAVAILABLE}. */
	onUnavailable?: CueGateOnUnavailable;
}

/** What a gate write reports. `updated` names every subscription it changed. */
export type CueGateWriteResult = { ok: true; updated: string[] } | { ok: false; error: string };

/** Narrow a value from the CLI, the bridge, or a form to a policy. */
export function parseCueGateOnUnavailable(value: unknown): CueGateOnUnavailable | null {
	return typeof value === 'string' && (CUE_GATE_ON_UNAVAILABLE as readonly string[]).includes(value)
		? (value as CueGateOnUnavailable)
		: null;
}

/**
 * Why a condition cannot be saved, or `null` when it can. The same two rules
 * the cue.yaml validator applies, so a surface refuses a gate when it is
 * typed instead of writing a file the engine then rejects.
 */
export function cueGateConditionProblem(condition: string): string | null {
	if (condition.trim().length === 0) {
		return 'A gate needs a condition the event must meet, in plain language.';
	}
	if (condition.trim().length > CUE_GATE_MAX_CONDITION_LENGTH) {
		return `A gate condition is at most ${CUE_GATE_MAX_CONDITION_LENGTH} characters. One sentence is enough.`;
	}
	return null;
}

/** The gate a subscription (or a raw cue.yaml record) carries, when it has one. */
export function readCueGateSetting(sub: {
	gate?: unknown;
	gate_on_unavailable?: unknown;
}): CueGateSetting | null {
	if (typeof sub.gate !== 'string' || sub.gate.trim().length === 0) return null;
	const onUnavailable = parseCueGateOnUnavailable(sub.gate_on_unavailable);
	return { condition: sub.gate.trim(), ...(onUnavailable ? { onUnavailable } : {}) };
}

/**
 * Set or remove the gate on one raw cue.yaml subscription record, in place.
 * The one place the two keys are written by a patch, so every writer agrees:
 * `null` removes both, the condition is trimmed, and the policy is written
 * only when it is not the default. A policy alone means nothing, and a
 * spelled-out default would make two otherwise identical triggers differ
 * (`triggerGroupKey` compares the keys as written).
 *
 * Throws on a condition that cannot be saved; check with
 * {@link cueGateConditionProblem} first to report it without a throw.
 */
export function writeCueGateFields(
	record: Record<string, unknown>,
	gate: CueGateSetting | null
): void {
	if (gate === null) {
		delete record.gate;
		delete record.gate_on_unavailable;
		return;
	}
	const problem = cueGateConditionProblem(gate.condition);
	if (problem) throw new Error(problem);
	record.gate = gate.condition.trim();
	if (gate.onUnavailable && gate.onUnavailable !== DEFAULT_CUE_GATE_ON_UNAVAILABLE) {
		record.gate_on_unavailable = gate.onUnavailable;
	} else {
		delete record.gate_on_unavailable;
	}
}

/**
 * Caps on the event handed to the model. A local model's whole context is a
 * few thousand tokens, and one issue body can be longer than that. Each string
 * is cut first, so a long body cannot push every later field out, and the
 * whole document is cut last. At the caps the event is roughly 1,500 tokens,
 * which leaves a 4,096 token context room for the instructions and the reply.
 */
export const CUE_GATE_EVENT_CAPS: CueGateEventCaps = Object.freeze({
	maxStringChars: 1500,
	maxArrayItems: 20,
	maxDepth: 4,
	maxTotalChars: 6000,
});

export interface CueGateEventCaps {
	maxStringChars: number;
	maxArrayItems: number;
	maxDepth: number;
	maxTotalChars: number;
}

/**
 * The reply shape `cue-gate-local.md` asks for. `reason` comes first so the
 * model states what it saw before it commits to a verdict.
 */
export const CUE_GATE_REPLY_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		reason: { type: 'string', maxLength: CUE_GATE_MAX_REASON_LENGTH },
		pass: { type: 'boolean' },
	},
	required: ['reason', 'pass'],
	additionalProperties: false,
};

/** A parsed model verdict. */
export interface CueGateReply {
	pass: boolean;
	reason: string;
}

/**
 * Read a model reply. Returns `null` for anything that is not a verdict: the
 * caller treats that as "the model could not answer", never as a pass or a
 * fail, so a model that replies with prose cannot decide the run by accident.
 */
export function parseCueGateReply(value: unknown): CueGateReply | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.pass !== 'boolean') return null;
	const reason = typeof record.reason === 'string' ? clampCueGateReason(record.reason) : '';
	return { pass: record.pass, reason };
}

/** One line, bounded: a reason is shown in a table row and stored on every gated event. */
export function clampCueGateReason(reason: string): string {
	const oneLine = reason.replace(/\s+/g, ' ').trim();
	if (oneLine.length <= CUE_GATE_MAX_REASON_LENGTH) return oneLine;
	return `${oneLine.slice(0, CUE_GATE_MAX_REASON_LENGTH - 3)}...`;
}

function compactValue(value: unknown, caps: CueGateEventCaps, depth: number): unknown {
	if (typeof value === 'string') {
		if (value.length <= caps.maxStringChars) return value;
		const dropped = value.length - caps.maxStringChars;
		return `${value.slice(0, caps.maxStringChars)} ...[${dropped} more characters not shown]`;
	}
	if (value === null || typeof value !== 'object') return value;
	if (depth >= caps.maxDepth)
		return Array.isArray(value) ? '[list not shown]' : '[object not shown]';
	if (Array.isArray(value)) {
		const shown = value
			.slice(0, caps.maxArrayItems)
			.map((item) => compactValue(item, caps, depth + 1));
		if (value.length > caps.maxArrayItems) {
			shown.push(`...[${value.length - caps.maxArrayItems} more items not shown]`);
		}
		return shown;
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		// The gate's own record is bookkeeping, not part of what happened.
		if (depth === 0 && key === CUE_GATE_PAYLOAD_KEY) continue;
		out[key] = compactValue(item, caps, depth + 1);
	}
	return out;
}

/**
 * The event payload as compact JSON, cut to fit a small model context.
 * Deterministic: the same payload always produces the same text.
 */
export function compactCueGateEvent(
	payload: Record<string, unknown>,
	caps: CueGateEventCaps = CUE_GATE_EVENT_CAPS
): string {
	let json: string;
	try {
		json = JSON.stringify(compactValue(payload, caps, 0)) ?? '{}';
	} catch {
		// A payload that cannot be serialized (a cycle) carries nothing the
		// model can read. The gate still runs on the event type alone.
		json = '{}';
	}
	if (json.length <= caps.maxTotalChars) return json;
	const dropped = json.length - caps.maxTotalChars;
	return `${json.slice(0, caps.maxTotalChars)} ...[${dropped} more characters not shown]`;
}

/** What a gate is checked against: the condition, and the event it is asked about. */
export interface CueGateInput {
	condition: string;
	event: Pick<CueEvent, 'type' | 'payload'>;
}

/** The event as the model reads it: its type, then its payload as compact JSON. */
function formatCueGateEvent(event: CueGateInput['event']): string {
	return [`Event type: ${event.type}`, 'Event:', compactCueGateEvent(event.payload)].join('\n');
}

/**
 * The user turn for the `cue-gate` task (the instructions are the
 * `cue-gate-local` prompt, sent as the system turn).
 */
export function formatCueGateInput(input: CueGateInput): string {
	return [`Condition: ${input.condition.trim()}`, '', formatCueGateEvent(input.event)].join('\n');
}

/** The id of the one question a gate asks a System One engine. */
export const CUE_GATE_QUESTION_ID = 'proceed';

/**
 * P(yes) at or above which a System One answer passes the gate. The midpoint:
 * a gate is a cost control, and the local model path is told to pass an event
 * that does not say enough to decide, so an undecided answer passes here too.
 */
export const CUE_GATE_PASS_PROBABILITY = 0.5;

/**
 * The gate as a System One request: the event is the state, and the condition
 * is one yes or no question about it. The same event text the local model
 * path reads, under the same caps, so an engine with a small context (the local
 * judge) is handed no more than a local model is.
 */
export function cueGateSystemOneRequest(input: CueGateInput): SystemOneTaskRequest {
	return {
		state: formatCueGateEvent(input.event),
		questions: {
			[CUE_GATE_QUESTION_ID]: noul(
				`Should this run proceed? It proceeds when the event in the state meets this condition: ${input.condition.trim()}`,
				{
					true: 'The event meets the condition, or the event does not say enough to decide.',
					false: 'The event shows that it does not meet the condition.',
				}
			),
		},
	};
}

/**
 * Read a System One answer as a gate check. `engineLabel` names the engine that
 * answered, so the reason kept on the event says who decided. Returns `null`
 * when the answers hold no yes or no for the gate's question: the caller treats
 * that as "could not answer", never as a pass or a fail.
 */
export function cueGateCheckFromSystemOne(
	answers: SystemOneAnswers,
	engineLabel: string
): CueGateCheck | null {
	const answer = answers[CUE_GATE_QUESTION_ID];
	if (answer?.type !== 'noul') return null;
	const pass = answer.probability >= CUE_GATE_PASS_PROBABILITY;
	const percent = Math.round(answer.probability * 100);
	return {
		status: pass ? 'pass' : 'fail',
		reason: clampCueGateReason(
			`${engineLabel}: ${pass ? 'yes' : 'no'}, ${percent}% that the run should proceed.`
		),
	};
}

/**
 * What the gate check found. `unavailable` covers every way a model failed to
 * give a verdict: the task is off, the model is not installed, the server is
 * down, the reply was not a verdict, or the runner cannot reach Local Models.
 */
export type CueGateCheck =
	| { status: 'pass'; reason: string }
	| { status: 'fail'; reason: string }
	| {
			status: 'unavailable';
			reason: string;
			/**
			 * What the task's own fail policy says to do, when the evaluator applied
			 * one (a System One engine gave no answer). It decides only for a
			 * subscription that states no `gate_on_unavailable`.
			 */
			onUnavailable?: CueGateOnUnavailable;
	  };

/** What a dispatch service asks its gate evaluator. */
export interface CueGateRequest {
	condition: string;
	event: CueEvent;
	subscriptionName: string;
	/**
	 * The subscription's own `gate_on_unavailable`, when it states one. It is the
	 * more specific rule, so an evaluator that applies a fail policy applies this
	 * one instead of the task's.
	 */
	onUnavailable?: CueGateOnUnavailable;
	/** The agent that owns the subscription, for the record an evaluator keeps of its decision. */
	agentId?: string;
}

/** Answers a gate. Must resolve; a throw is treated as `unavailable`. */
export type CueGateEvaluator = (request: CueGateRequest) => Promise<CueGateCheck>;

/**
 * What happened to a gated dispatch, stamped on the event payload under
 * {@link CUE_GATE_PAYLOAD_KEY} so the activity list can say why a run started
 * or did not, including after a restart (the payload is what `cue_events`
 * keeps).
 *
 * - `passed`        - the model said the event meets the condition.
 * - `gated`         - the run was skipped: the model said no, or the model
 *                     could not answer and the subscription asked to skip.
 * - `ran-unchecked` - the model could not answer and the run started anyway
 *                     (fail open).
 */
export interface CueGateRecord {
	outcome: 'passed' | 'gated' | 'ran-unchecked';
	reason: string;
}

/** The event payload key the gate record is stored under. */
export const CUE_GATE_PAYLOAD_KEY = 'gate';

export interface CueGateDecision {
	/** Whether the run starts. */
	run: boolean;
	/** Whether the user must be told the gate did not check this event. */
	warn: boolean;
	record: CueGateRecord;
}

/**
 * Apply the failure policy to a gate check. The one place the policy lives:
 * a verdict is obeyed, and an unavailable gate runs (and warns) unless it is
 * told to skip. The subscription's `gate_on_unavailable` decides when it is
 * set; otherwise the policy the check carries (the Cue gate task's fail policy,
 * from a System One engine that gave no answer); otherwise fail open.
 */
export function resolveCueGateDecision(
	check: CueGateCheck,
	subscriptionRule?: CueGateOnUnavailable
): CueGateDecision {
	if (check.status === 'pass') {
		return {
			run: true,
			warn: false,
			record: { outcome: 'passed', reason: check.reason },
		};
	}
	if (check.status === 'fail') {
		return {
			run: false,
			warn: false,
			record: {
				outcome: 'gated',
				reason: check.reason || 'The event does not meet the gate condition.',
			},
		};
	}
	const onUnavailable = subscriptionRule ?? check.onUnavailable ?? DEFAULT_CUE_GATE_ON_UNAVAILABLE;
	if (onUnavailable === 'skip') {
		const why = subscriptionRule
			? 'gate_on_unavailable is "skip"'
			: 'the Cue gate task fails closed';
		return {
			run: false,
			warn: true,
			record: {
				outcome: 'gated',
				reason: `The gate could not be checked, and ${why}. ${check.reason}`,
			},
		};
	}
	return {
		run: true,
		warn: true,
		record: {
			outcome: 'ran-unchecked',
			reason: `The gate could not be checked, so the run started without it. ${check.reason}`,
		},
	};
}

/** A copy of the event carrying the gate record. The original is not changed. */
export function withCueGateRecord(event: CueEvent, record: CueGateRecord): CueEvent {
	return { ...event, payload: { ...event.payload, [CUE_GATE_PAYLOAD_KEY]: record } };
}

/** The gate record on an event payload, when a gate was applied to it. */
export function readCueGateRecord(
	payload: Record<string, unknown> | undefined
): CueGateRecord | null {
	const value = payload?.[CUE_GATE_PAYLOAD_KEY];
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		record.outcome !== 'passed' &&
		record.outcome !== 'gated' &&
		record.outcome !== 'ran-unchecked'
	) {
		return null;
	}
	return {
		outcome: record.outcome,
		reason: typeof record.reason === 'string' ? record.reason : '',
	};
}
