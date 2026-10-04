/**
 * Configuring an Auto Run (AR-4, AR-5), as pure state. The screen that draws it
 * (`LaunchView.tsx`) and the App's key handling read this file. Both kinds of run
 * share one small form: a spec-driven run gets loop, reset, and the per-run model
 * and effort; a goal-driven run gets the goal, its exit criteria, and an
 * iteration cap. Checking the values goes through the library's validators, so a
 * mistake shows beside the form and the host sees the same rules a second time.
 */

import {
	DEFAULT_GOAL_MAX_ITERATIONS,
	resolveAutoRunFolder,
	validateAutoRunLaunch,
	validateGoalRunLaunch,
	type AgentRecord,
	type AutoRunLaunchInput,
	type ClientResult,
	type GoalRunLaunchInput,
	type MaestroClient,
} from '../../shared/maestro-lib';
import { providerEffortOptions } from '../agents/form';

export type LaunchMode = 'spec' | 'goal';

export type LaunchFieldId =
	| 'loop'
	| 'maxLoops'
	| 'reset'
	| 'goal'
	| 'exitCriteria'
	| 'maxIterations'
	| 'model'
	| 'effort';

export type LaunchFieldKind = 'toggle' | 'number' | 'text' | 'choice';

export interface LaunchField {
	id: LaunchFieldId;
	label: string;
	kind: LaunchFieldKind;
	/** Dim text after the value: what an empty box means. */
	hint?: string;
	/** For a choice: every value, `''` first for "the agent's own". */
	options?: readonly string[];
}

/** A document in the run, in the order it runs. */
export interface LaunchDocument {
	name: string;
	file: string;
}

export interface LaunchValues {
	loop: boolean;
	maxLoops: string;
	reset: boolean;
	goal: string;
	exitCriteria: string;
	maxIterations: string;
	model: string;
	effort: string;
}

export interface LaunchFormState {
	mode: LaunchMode;
	agentId: string;
	/** The documents of a spec-driven run, in run order. Empty for a goal run. */
	documents: readonly LaunchDocument[];
	values: LaunchValues;
	focus: LaunchFieldId;
}

/** What the form reads off the host while it is open. */
export interface LaunchLookups {
	/** The agent's provider's model ids. Empty before it answers, or when it reports none. */
	models: readonly string[];
}

export const EMPTY_LAUNCH_LOOKUPS: LaunchLookups = { models: [] };

export function initialLaunchForm(
	mode: LaunchMode,
	agent: AgentRecord,
	documents: readonly LaunchDocument[] = []
): LaunchFormState {
	return {
		mode,
		agentId: agent.id,
		documents: mode === 'spec' ? documents : [],
		values: {
			loop: false,
			maxLoops: '',
			reset: false,
			goal: '',
			exitCriteria: '',
			maxIterations: String(DEFAULT_GOAL_MAX_ITERATIONS),
			model: '',
			effort: '',
		},
		focus: mode === 'goal' ? 'goal' : 'loop',
	};
}

/** The fields in the order the cursor walks them. Loop count only matters while looping. */
export function launchFields(
	form: LaunchFormState,
	agent: AgentRecord,
	lookups: LaunchLookups
): LaunchField[] {
	const efforts = providerEffortOptions(agent.toolType);
	const model: LaunchField =
		lookups.models.length > 0
			? { id: 'model', label: 'Model', kind: 'choice', options: ['', ...lookups.models] }
			: { id: 'model', label: 'Model', kind: 'text', hint: "empty uses the agent's model" };
	const effort: LaunchField =
		efforts.length > 0
			? { id: 'effort', label: 'Effort', kind: 'choice', options: ['', ...efforts] }
			: { id: 'effort', label: 'Effort', kind: 'text', hint: "empty uses the agent's effort" };
	if (form.mode === 'goal') {
		return [
			{ id: 'goal', label: 'Goal', kind: 'text' },
			{ id: 'exitCriteria', label: 'Done when', kind: 'text', hint: 'optional' },
			{
				id: 'maxIterations',
				label: 'Iteration cap',
				kind: 'number',
				hint: 'empty runs until done, stuck, or stalled',
			},
			model,
			effort,
		];
	}
	return [
		{ id: 'loop', label: 'Loop', kind: 'toggle', hint: 'run the documents again when they finish' },
		...(form.values.loop
			? [
					{
						id: 'maxLoops',
						label: 'Max loops',
						kind: 'number',
						hint: 'empty loops until stopped',
					} as const,
				]
			: []),
		{ id: 'reset', label: 'Reset', kind: 'toggle', hint: 'untick each document when it finishes' },
		model,
		effort,
	];
}

function focusedField(
	fields: readonly LaunchField[],
	form: LaunchFormState
): LaunchField | undefined {
	return fields.find((field) => field.id === form.focus) ?? fields[0];
}

export function moveLaunchFocus(
	form: LaunchFormState,
	fields: readonly LaunchField[],
	delta: number
): LaunchFormState {
	const at = Math.max(
		0,
		fields.findIndex((field) => field.id === form.focus)
	);
	const next = fields[Math.min(Math.max(0, at + delta), fields.length - 1)];
	return next ? { ...form, focus: next.id } : form;
}

const textKeyFor = (
	id: LaunchFieldId
): 'goal' | 'exitCriteria' | 'model' | 'effort' | 'maxLoops' | 'maxIterations' | undefined =>
	id === 'goal' ||
	id === 'exitCriteria' ||
	id === 'model' ||
	id === 'effort' ||
	id === 'maxLoops' ||
	id === 'maxIterations'
		? id
		: undefined;

/** A toggle flips and a choice steps; a text box does nothing. */
export function cycleLaunchField(
	form: LaunchFormState,
	fields: readonly LaunchField[],
	delta: number
): LaunchFormState {
	const field = focusedField(fields, form);
	if (!field) return form;
	if (field.kind === 'toggle' && (field.id === 'loop' || field.id === 'reset')) {
		return { ...form, values: { ...form.values, [field.id]: !form.values[field.id] } };
	}
	if (field.kind === 'choice' && field.options && (field.id === 'model' || field.id === 'effort')) {
		const at = Math.max(0, field.options.indexOf(form.values[field.id]));
		const next = field.options[(at + delta + field.options.length) % field.options.length];
		return { ...form, values: { ...form.values, [field.id]: next } };
	}
	return form;
}

/** Typed text goes into a text or number box; on a toggle or choice, a space steps it. */
export function typeIntoLaunch(
	form: LaunchFormState,
	fields: readonly LaunchField[],
	text: string
): LaunchFormState {
	const field = focusedField(fields, form);
	const key = field ? textKeyFor(field.id) : undefined;
	if (!field || !text) return form;
	if (field.kind === 'toggle' || field.kind === 'choice') {
		return text === ' ' ? cycleLaunchField(form, fields, 1) : form;
	}
	if (!key) return form;
	// A count is digits; anything else would only be refused later.
	const added = field.kind === 'number' ? text.replace(/\D/g, '') : text;
	return added ? { ...form, values: { ...form.values, [key]: form.values[key] + added } } : form;
}

export function backspaceLaunch(
	form: LaunchFormState,
	fields: readonly LaunchField[]
): LaunchFormState {
	const field = focusedField(fields, form);
	const key = field ? textKeyFor(field.id) : undefined;
	if (!key || (field?.kind !== 'text' && field?.kind !== 'number')) return form;
	return { ...form, values: { ...form.values, [key]: form.values[key].slice(0, -1) } };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseCount(text: string, label: string): Parsed<number | undefined> {
	const trimmed = text.trim();
	if (trimmed === '') return { ok: true, value: undefined };
	const value = Number(trimmed);
	return Number.isInteger(value)
		? { ok: true, value }
		: { ok: false, reason: `${label} must be a whole number.` };
}

export type LaunchRequest =
	| { mode: 'spec'; input: AutoRunLaunchInput }
	| { mode: 'goal'; input: GoalRunLaunchInput };

/** The form as a request the client takes, or the one line that says what to fix. */
export function launchRequestOf(form: LaunchFormState): Parsed<LaunchRequest> {
	const { values } = form;
	if (form.mode === 'goal') {
		const cap = parseCount(values.maxIterations, 'The iteration cap');
		if (!cap.ok) return cap;
		const checked = validateGoalRunLaunch({
			goal: values.goal,
			exitCriteria: values.exitCriteria,
			// Empty is a real answer: no cap.
			maxIterations: cap.value ?? null,
			model: values.model,
			effort: values.effort,
		});
		return checked.ok
			? { ok: true, value: { mode: 'goal', input: checked.value } }
			: { ok: false, reason: checked.reason };
	}
	const loops = parseCount(values.maxLoops, 'Max loops');
	if (!loops.ok) return loops;
	const checked = validateAutoRunLaunch({
		documents: form.documents.map((document) => ({
			file: document.file,
			...(values.reset ? { resetOnCompletion: true } : {}),
		})),
		loop: values.loop,
		maxLoops: loops.value,
		model: values.model,
		effort: values.effort,
	});
	return checked.ok
		? { ok: true, value: { mode: 'spec', input: checked.value } }
		: { ok: false, reason: checked.reason };
}

/** What a launch leaves on screen: one line, and it names where the run shows up. */
export interface LaunchDone {
	message: string;
}

/**
 * Starts the run on the host. The desktop works a spec-driven run's documents out
 * from the agent's own Auto Run folder, so an agent that never set one gets the
 * folder this TUI lists, written to it first: without that the host refuses with
 * "No Auto Run folder configured" for the very folder the person just picked from.
 */
export async function submitLaunch(
	client: MaestroClient,
	agent: AgentRecord,
	form: LaunchFormState
): Promise<ClientResult<LaunchDone>> {
	const request = launchRequestOf(form);
	if (!request.ok) {
		return {
			ok: false,
			error: { code: 'invalid', message: request.reason, method: 'autoRun.launch' },
		};
	}
	const { value } = request;
	if (value.mode === 'goal') {
		const started = await client.autoRun.launchGoal(agent.id, value.input);
		if (!started.ok) return started;
		return { ok: true, value: { message: `Started a goal run on ${agent.name}.` } };
	}

	const folder = resolveAutoRunFolder(agent);
	if (folder && typeof agent.autoRunFolderPath !== 'string') {
		const set = await client.agents.update(agent.id, { autoRunFolderPath: folder });
		if (!set.ok) return set;
	}
	const started = await client.autoRun.launch(agent.id, value.input);
	if (!started.ok) return started;
	const count = value.input.documents.length;
	return {
		ok: true,
		value: {
			message: `Started ${count} ${count === 1 ? 'document' : 'documents'} on ${agent.name}.`,
		},
	};
}
