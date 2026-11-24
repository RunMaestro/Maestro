/**
 * Local Models tasks: the named housekeeping jobs a local model can do, and
 * which source the user assigned to each.
 *
 * A task is a JOB (name a tab, draft a commit message, screen untrusted text),
 * never a model. Every consumer asks the task router (`src/main/local-models/
 * task-router.ts`) to run its task by id, and the router reads the assignment
 * stored here to decide where the work goes. That is the rule that keeps the
 * choice of "which model does this" in one setting rather than one per feature.
 *
 * Assignments persist under the `localModelAssignments` setting as a SPARSE
 * record: a task with no stored entry uses its registry `defaultAssignment`.
 * Storing only what the user changed means a task added in a later build, or a
 * default that moves, reaches existing installs without a write.
 *
 * Everything here is pure so the renderer, the main process, and the CLI read
 * and validate an assignment by the same rules.
 */

import {
	voiceRoutingSystemOneRequest,
	type VoiceRoutingSystemOneInput,
} from '../acappella/voice-routing-system-one';
import { cueGateSystemOneRequest, type CueGateInput } from '../cue/gate';
import {
	cueInjectionSystemOneRequest,
	type CueInjectionSystemOneInput,
} from '../cue/injection-screen';
import { secretScreenSystemOneRequest, type SecretScreenSystemOneInput } from '../secretScan';
import { tabCleanupSystemOneRequest, type TabCleanupSystemOneInput } from '../tabCleanup';
import type { LocalModelEndpoint } from './endpoints';
import { QWEN3_1_7B_ID, getLocalModel } from './model-catalog';
import { modelRoutingSystemOneRequest, type ModelRoutingInput } from './model-routing-task';
import { MODEL_SERVER_ENDPOINT_ID, MODEL_SERVER_NAME } from './model-server';
import type { SystemOneFailPolicy, SystemOneTaskRequest } from './system-one';
import type { LocalModelKind } from './types';

/** What a task asks its assigned source to do. A subset of {@link LocalModelKind}. */
export type LocalModelTaskNeed = Extract<
	LocalModelKind,
	'text-gen' | 'embedding' | 'classifier' | 'stt' | 'tts'
>;

/**
 * Where a task's work goes.
 *
 * - `off`: the task does not run. A consumer with no model-free fallback hides
 *   its affordance.
 * - `utility-agent`: inherit the shared `utilitySource` setting. A local model
 *   or endpoint runs through the task router. The provider choice uses
 *   `utilityAgentId` / `utilityModelId`, or the session's provider when unset.
 *   The router never spawns a provider: it hands that path back to the caller.
 *   Only tasks that HAVE such a path accept it
 *   ({@link LocalModelTaskDefinition.allowsUtilityAgent}).
 * - `local`: a catalog model run on this machine.
 * - `endpoint`: a model served by one of the user's `localModelEndpoints`.
 * - `system-one`: the System One engine in force (Jev, an OpenJev server or the
 *   local judge; Settings > Models > System One) answers the task's typed
 *   questions. It names no engine: the engine is one choice for every task, so
 *   changing it moves them all. Only a task that declares its questions accepts
 *   it ({@link taskAcceptsSystemOne}), and it runs through `runSystemOneTask`.
 */
export type LocalModelAssignment =
	| { type: 'off' }
	| { type: 'utility-agent' }
	| { type: 'local'; modelId: string; language?: string }
	| { type: 'endpoint'; endpointId: string; model: string }
	| { type: 'system-one' };

export type LocalModelAssignmentType = LocalModelAssignment['type'];

/** Shared source inherited by tasks assigned to `utility-agent`. The provider
 * path retains the existing utilityAgentId / utilityModelId settings. */
export type UtilitySource = Extract<
	LocalModelAssignment,
	{ type: 'utility-agent' | 'local' | 'endpoint' }
>;

/**
 * The needs a user-run model server can serve. Endpoints speak chat
 * completions, embeddings, and speech-to-text (`/v1/audio/transcriptions`) in
 * `endpoint-client.ts`; no server runs a sequence classifier or synthesizes
 * speech through those, so an endpoint assignment for any other need is
 * refused when saved and reported by readiness, rather than accepted and then
 * failing on every run.
 *
 * Speech-to-text is the one need not EVERY endpoint serves: a chat-only server
 * has no transcription route. Which servers do is not written down here (a
 * shipped list would rot as servers gain the route); readiness checks that the
 * endpoint lists the assigned model, and a call to a server without the route
 * is reported as exactly that.
 */
export const ENDPOINT_SERVED_NEEDS: readonly LocalModelTaskNeed[] = Object.freeze([
	'text-gen',
	'embedding',
	'stt',
]);

/** Whether an endpoint can serve a task with this need. */
export function endpointServesNeed(need: LocalModelTaskNeed): boolean {
	return ENDPOINT_SERVED_NEEDS.includes(need);
}

export const LOCAL_MODEL_ASSIGNMENT_TYPES: readonly LocalModelAssignmentType[] = Object.freeze([
	'off',
	'utility-agent',
	'local',
	'endpoint',
	'system-one',
]);

export const OFF_ASSIGNMENT: LocalModelAssignment = Object.freeze({ type: 'off' });
export const UTILITY_AGENT_ASSIGNMENT: UtilitySource = Object.freeze({
	type: 'utility-agent',
});
export const SYSTEM_ONE_ASSIGNMENT: LocalModelAssignment = Object.freeze({ type: 'system-one' });

export const LOCAL_MODEL_TASK_IDS = [
	'tab-naming',
	'tab-summary',
	'tab-cleanup',
	'ai-command',
	'git-drafts',
	'semantic-search',
	'cue-gate',
	'injection-screen',
	'secret-screen',
	'dictation',
	'dictation-cleanup',
	'spoken-notices',
	'voice-routing',
	'model-routing',
	'token-proxy',
	'history-digests',
	'local-judge',
] as const;

export type LocalModelTaskId = (typeof LOCAL_MODEL_TASK_IDS)[number];

/**
 * The task whose assignment is the model System One's local judge runs on
 * (`src/main/local-models/system-one/local-judge.ts`). The judge has no model
 * setting of its own: like every other "which model does this" choice, it is
 * this task's assignment.
 */
export const LOCAL_JUDGE_TASK_ID = 'local-judge' satisfies LocalModelTaskId;

/**
 * Which half of the Models settings a task belongs to. System One tasks
 * return a judgment (a decision, label, score, vector or transcript). System
 * Two tasks write text for someone to read or run.
 */
export type LocalModelSystem = 'one' | 'two';

export const LOCAL_MODEL_SYSTEMS: readonly LocalModelSystem[] = Object.freeze(['one', 'two']);

/**
 * What each task that runs on System One hands its question builder, by task
 * id. A task joins by declaring `systemOneQuestions` in the registry and its
 * input here, so `runSystemOneTask(taskId, input)` checks the input at the call.
 */
export interface SystemOneTaskInputs {
	'tab-cleanup': TabCleanupSystemOneInput;
	'cue-gate': CueGateInput;
	'injection-screen': CueInjectionSystemOneInput;
	'secret-screen': SecretScreenSystemOneInput;
	'voice-routing': VoiceRoutingSystemOneInput;
	'model-routing': ModelRoutingInput;
}

export type SystemOneTaskId = keyof SystemOneTaskInputs;

export interface LocalModelTaskDefinition {
	readonly id: LocalModelTaskId;
	/** What the task is called in front of a person. */
	readonly label: string;
	/** One sentence: what the task does and what changes when it is assigned. */
	readonly description: string;
	/**
	 * The kind of model the assignment picks. A source picker offers only local
	 * models and endpoint models of this kind.
	 */
	readonly needs: LocalModelTaskNeed;
	/**
	 * Other kinds of CATALOG model the assignment may name, for a task that does
	 * its job a different way on each. Model routing is the one today: an
	 * embedding model votes by the labeled prompts a prompt resembles, a text
	 * model answers as a judge. The task reads the assigned model's kind and
	 * picks the way; {@link taskAcceptsLocalKind} is the one check.
	 *
	 * An endpoint does not report a model's kind, so an endpoint assignment is
	 * always read as `needs`.
	 */
	readonly alsoAcceptsLocal?: readonly LocalModelTaskNeed[];
	/**
	 * True for a task that works fully on this machine and treats System One as
	 * one option among several. Its source picker lists local models and
	 * endpoints BEFORE System One, and says beside every source whether its
	 * answer is calibrated.
	 */
	readonly localFirst?: boolean;
	/**
	 * System One when the output is a judgment (a decision, label, score, vector
	 * or transcript), System Two when it is text written for someone to read or
	 * run. Required, so a new task cannot skip the choice.
	 */
	readonly system: LocalModelSystem;
	/**
	 * Capabilities the task also uses that this assignment does NOT choose, so a
	 * readiness check can name them. Spoken notices write the summary with the
	 * assigned text model and speak it with a local voice (the A Cappella
	 * Text-to-Speech choice when it is local, the system voice otherwise).
	 */
	readonly alsoNeeds?: readonly LocalModelTaskNeed[];
	/** Whether `utility-agent` is a valid assignment: only tasks with an existing agent path. */
	readonly allowsUtilityAgent: boolean;
	/** The assignment a task has until the user picks one. */
	readonly defaultAssignment: LocalModelAssignment;
	/**
	 * Catalog models of the right kind that a picker must NOT offer for this
	 * task, each with the measured reason, keyed by model id.
	 *
	 * A model is the right KIND for a task long before it is good at it, and the
	 * picker cannot tell the two apart from the catalog. This is where a failed
	 * check is written down, so the model stays installable for the tasks it
	 * does well instead of being hidden from all of them. An assignment made
	 * anyway (from the CLI, or before the entry existed) is still honored: the
	 * entry removes an invitation, it does not break a choice.
	 */
	readonly unofferedLocalModels?: Readonly<Record<string, string>>;
	/**
	 * What the task does when a System One engine gives it no answer, until the
	 * user changes it: `open` lets the work go ahead unchecked, `closed` stops
	 * it. Only a task that GATES something has one; a task whose output is a
	 * vector or a transcript has nothing to let through or hold back. The
	 * effective value is `resolveSystemOneFailPolicy` in `system-one-settings.ts`.
	 */
	readonly failPolicy?: SystemOneFailPolicy;
	/**
	 * Turns the task's input into a System One request: the state to judge and
	 * the typed questions about it. Declaring it is what makes `system-one` a
	 * valid assignment for the task ({@link taskAcceptsSystemOne}); a System Two
	 * task cannot, because an engine returns a judgment and never text.
	 *
	 * The parameter is `never` so each builder keeps its own input type in one
	 * registry. {@link buildSystemOneTaskRequest} is the one caller, and
	 * {@link SystemOneTaskInputs} is where that input type is written down.
	 */
	readonly systemOneQuestions?: (input: never) => SystemOneTaskRequest;
}

function defineTask(task: LocalModelTaskDefinition): LocalModelTaskDefinition {
	if (task.defaultAssignment.type === 'utility-agent' && !task.allowsUtilityAgent) {
		throw new Error(`Task "${task.id}" defaults to the Utility Agent but does not allow it.`);
	}
	if (task.systemOneQuestions && task.system !== 'one') {
		throw new Error(
			`Task "${task.id}" declares System One questions but is not a System One task.`
		);
	}
	return Object.freeze({
		...task,
		...(task.alsoNeeds ? { alsoNeeds: Object.freeze([...task.alsoNeeds]) } : {}),
		...(task.alsoAcceptsLocal
			? { alsoAcceptsLocal: Object.freeze([...task.alsoAcceptsLocal]) }
			: {}),
		...(task.unofferedLocalModels
			? { unofferedLocalModels: Object.freeze({ ...task.unofferedLocalModels }) }
			: {}),
	});
}

/**
 * Every task, keyed by id. Tasks that already run through an agent today
 * (tab naming, summaries, AI command mode) default to `utility-agent`, so
 * nothing changes until the user opts in to a local model; every task that is
 * new with Local Models defaults to `off`.
 */
export const LOCAL_MODEL_TASKS: Readonly<Record<LocalModelTaskId, LocalModelTaskDefinition>> =
	Object.freeze({
		'tab-naming': defineTask({
			id: 'tab-naming',
			system: 'two',
			label: 'Tab naming',
			description: 'Names a new AI tab from the first message sent in it.',
			needs: 'text-gen',
			allowsUtilityAgent: true,
			defaultAssignment: UTILITY_AGENT_ASSIGNMENT,
		}),
		'tab-summary': defineTask({
			id: 'tab-summary',
			system: 'two',
			label: 'Summaries',
			description:
				'Writes context summaries for Summarize & Continue and the group chat participant summary.',
			needs: 'text-gen',
			allowsUtilityAgent: true,
			defaultAssignment: UTILITY_AGENT_ASSIGNMENT,
		}),
		'tab-cleanup': defineTask({
			id: 'tab-cleanup',
			system: 'one',
			label: 'Tab cleanup suggestions',
			description:
				'Suggests tabs to close, snooze, or bring back from snooze. Every action still needs your confirmation.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
			// No fail policy: a list of suggestions gates nothing, so a run with no
			// answer is reported as that.
			systemOneQuestions: tabCleanupSystemOneRequest,
		}),
		'ai-command': defineTask({
			id: 'ai-command',
			system: 'two',
			label: 'AI command mode',
			description: 'Turns a plain-English request in command mode into a shell command.',
			needs: 'text-gen',
			allowsUtilityAgent: true,
			defaultAssignment: UTILITY_AGENT_ASSIGNMENT,
			// Measured on 2026-10-11 and again, on eight requests, on 2026-10-12
			// (`llama-housekeeping-e2e.test.ts`, recorded in
			// docs/architecture/local-models.md): Qwen3 1.7B wrote one command of
			// eight that does what was asked, and for "find which process is
			// listening on port 8080" it wrote `lsof ... | xargs kill -9`, lifted from
			// the prompt's own example. The user reviews a command before it runs, but
			// a model that turns "find" into "kill" is not one to invite. Qwen3.5 4B
			// wrote eight correct commands of eight, so it is offered.
			unofferedLocalModels: {
				[QWEN3_1_7B_ID]:
					'It wrote one correct command for eight plain requests, and a command that kills a process for a request to find it, so it is not offered for shell commands.',
			},
		}),
		'git-drafts': defineTask({
			id: 'git-drafts',
			system: 'two',
			label: 'Git drafts',
			description:
				'Drafts a pull request title and description from the branch commits and changed files. Fills the fields, never submits.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'semantic-search': defineTask({
			id: 'semantic-search',
			system: 'one',
			label: 'Semantic search',
			description: 'Finds history, transcripts, and documents by meaning rather than exact words.',
			needs: 'embedding',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'cue-gate': defineTask({
			id: 'cue-gate',
			system: 'one',
			label: 'Cue gate',
			description:
				'Checks a Cue subscription gate condition against the event before an agent is started.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
			// A model that is down must not silently stop automation the user
			// depends on (the same default as `gate_on_unavailable`).
			failPolicy: 'open',
			systemOneQuestions: cueGateSystemOneRequest,
		}),
		'injection-screen': defineTask({
			id: 'injection-screen',
			system: 'one',
			label: 'Prompt-injection screen',
			description: 'Scores untrusted text for prompt injection before Cue passes it to an agent.',
			needs: 'classifier',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
			// The screen exists to keep unscreened text out of a run.
			failPolicy: 'closed',
			systemOneQuestions: cueInjectionSystemOneRequest,
		}),
		'secret-screen': defineTask({
			id: 'secret-screen',
			system: 'one',
			label: 'Secret screen',
			description:
				'Extra model coverage when scanning content for secrets before it is published. Pattern detection always runs.',
			needs: 'classifier',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
			// No fail policy: this pass is extra coverage, so it can neither stop a
			// publish nor let one through. The pattern scan has already decided.
			systemOneQuestions: secretScreenSystemOneRequest,
		}),
		dictation: defineTask({
			id: 'dictation',
			system: 'one',
			label: 'Dictation',
			description: 'Transcribes speech into any text box without starting a voice session.',
			needs: 'stt',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'dictation-cleanup': defineTask({
			id: 'dictation-cleanup',
			system: 'one',
			label: 'Dictation vocabulary correction',
			description:
				'Corrects misheard agent names and custom vocabulary after speech recognition. Uses only dictionary replacements, keeps the original on failure, and adds a bounded pass before sending. Off preserves the recognizer output.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'spoken-notices': defineTask({
			id: 'spoken-notices',
			system: 'two',
			label: 'Spoken notices',
			description:
				'Writes the short summary a spoken notice adds when an agent finishes a turn. Off speaks the agent name alone. Turn notices on in Settings > Notifications.',
			needs: 'text-gen',
			alsoNeeds: ['tts'],
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'voice-routing': defineTask({
			id: 'voice-routing',
			system: 'one',
			label: 'Voice routing',
			description:
				'Decides which agent and tab a spoken request is for. Off keeps the voice brain chosen in A Cappella settings. On System One the engine picks the agent and tab, and that voice brain still writes what is spoken.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
			// No fail policy: a request with no route is refused out loud, by name.
			systemOneQuestions: voiceRoutingSystemOneRequest,
			// Measured on 2026-10-11 (docs/architecture/local-models.md, "Result:
			// routing only"): asked to route six utterances under seven shapes of the
			// reply schema, Qwen3 1.7B sent every request that named an agent to the
			// Conductor under six of them. The rest of each decision was right, so
			// this is the model's choice, not a malformed reply. Qwen3.5 4B sent four
			// of four to the agent they named (2026-10-12), so it is offered.
			unofferedLocalModels: {
				[QWEN3_1_7B_ID]:
					'It sends requests that name an agent to the Conductor, so it is not offered for voice routing.',
			},
		}),
		'model-routing': defineTask({
			id: 'model-routing',
			system: 'one',
			label: 'Model routing',
			description:
				'Judges how much model and effort a turn needs, for an agent whose model is Auto. An embedding model decides by the labeled prompts a prompt resembles; a text model answers as a local judge. Off runs an Auto agent at its default tier.',
			// The endpoint reading: an endpoint model is always the judge.
			needs: 'text-gen',
			alsoAcceptsLocal: ['embedding'],
			localFirst: true,
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
			// No fail policy: a turn with no decision runs at the agent's default
			// tier, which is neither letting unchecked work through nor stopping it.
			systemOneQuestions: modelRoutingSystemOneRequest,
			// Measured on 2026-10-12 (`model-routing-eval-e2e.test.ts`, recorded in
			// docs/architecture/local-models.md, "Model routing on real hardware"):
			// as a local judge, Qwen3 1.7B answered `high` on both questions for all
			// 40 report prompts, "what port does the dev server listen on?" included,
			// in-process and on the model server alike. A router that always says
			// the most model is Auto with no routing, at the highest price. Qwen3.5
			// 4B told the tiers apart (22 to 25 of 40), so it is offered.
			unofferedLocalModels: {
				[QWEN3_1_7B_ID]:
					'It rated every one of 40 test requests, lookups included, as needing the most model and the most effort, so it is not offered for model routing.',
			},
		}),
		'token-proxy': defineTask({
			id: 'token-proxy',
			system: 'two',
			label: 'Token proxy',
			description: 'Summarizes large tool output for the token-conservation proxy.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'history-digests': defineTask({
			id: 'history-digests',
			system: 'two',
			label: 'Computer History digests',
			description:
				'Writes the 15-minute digests and 6-hour roll-ups of Computer History. Used while the digest source in the Computer History settings is the local model.',
			needs: 'text-gen',
			// The other writer is the digest AGENT, chosen in the Computer History
			// settings (`digests.source`), not the Utility Agent.
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
		'local-judge': defineTask({
			id: 'local-judge',
			system: 'one',
			label: 'Local judge',
			description:
				'The text model the System One local judge answers on: yes or no, pick one, or rate on a rubric. Its answers are not calibrated.',
			needs: 'text-gen',
			allowsUtilityAgent: false,
			defaultAssignment: OFF_ASSIGNMENT,
		}),
	});

/** The persisted `localModelAssignments` setting: only the tasks the user changed. */
export type LocalModelAssignments = Partial<Record<LocalModelTaskId, LocalModelAssignment>>;

export function isLocalModelTaskId(value: unknown): value is LocalModelTaskId {
	return (
		typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCAL_MODEL_TASKS, value)
	);
}

/** The kinds of catalog model a task's assignment may name: `needs` first. */
export function taskLocalModelKinds(
	task: Pick<LocalModelTaskDefinition, 'needs' | 'alsoAcceptsLocal'>
): readonly LocalModelTaskNeed[] {
	return [task.needs, ...(task.alsoAcceptsLocal ?? [])];
}

/** Whether a catalog model of this kind is one the task can be assigned. */
export function taskAcceptsLocalKind(
	task: Pick<LocalModelTaskDefinition, 'needs' | 'alsoAcceptsLocal'>,
	kind: LocalModelKind
): boolean {
	return (taskLocalModelKinds(task) as readonly LocalModelKind[]).includes(kind);
}

/**
 * Whether a task can be assigned to System One: it is a System One task and it
 * declares the typed questions an engine answers for it.
 */
export function taskAcceptsSystemOne(
	task: Pick<LocalModelTaskDefinition, 'system' | 'systemOneQuestions'>
): boolean {
	return task.system === 'one' && task.systemOneQuestions !== undefined;
}

/**
 * The System One request for one run of a task, built by the task's own
 * `systemOneQuestions`. Throws for a task that declares none: no assignment can
 * send such a task here, so reaching this is a caller bug.
 */
export function buildSystemOneTaskRequest<T extends SystemOneTaskId>(
	taskId: T,
	input: SystemOneTaskInputs[T]
): SystemOneTaskRequest {
	const task = LOCAL_MODEL_TASKS[taskId];
	const build = task.systemOneQuestions as
		| ((input: SystemOneTaskInputs[T]) => SystemOneTaskRequest)
		| undefined;
	if (!build || !taskAcceptsSystemOne(task)) {
		throw new Error(`${task.label} declares no System One questions.`);
	}
	return build(input);
}

function nonEmptyString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

/**
 * Read one stored assignment for a task, or `null` when it is not a usable
 * shape for that task. Only the SHAPE is checked: a model id that is no longer
 * in the catalog, or an endpoint that was removed, is kept, so the router can
 * report that exact model or endpoint as unavailable instead of the task
 * silently reverting to its default.
 */
export function parseLocalModelAssignment(
	taskId: LocalModelTaskId,
	value: unknown
): LocalModelAssignment | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	switch (record.type) {
		case 'off':
			return OFF_ASSIGNMENT;
		case 'utility-agent':
			return LOCAL_MODEL_TASKS[taskId].allowsUtilityAgent ? UTILITY_AGENT_ASSIGNMENT : null;
		case 'local': {
			const modelId = nonEmptyString(record.modelId);
			const language = nonEmptyString(record.language);
			return modelId ? { type: 'local', modelId, ...(language ? { language } : {}) } : null;
		}
		case 'endpoint': {
			const endpointId = nonEmptyString(record.endpointId);
			const model = nonEmptyString(record.model);
			return endpointId && model ? { type: 'endpoint', endpointId, model } : null;
		}
		case 'system-one':
			return taskAcceptsSystemOne(LOCAL_MODEL_TASKS[taskId]) ? SYSTEM_ONE_ASSIGNMENT : null;
		default:
			return null;
	}
}

/**
 * Read the persisted `localModelAssignments` setting. This is also the settings
 * migration: it runs on every load, so there is no one-shot write to miss.
 *
 * - Anything that is not a plain object reads as empty, so an install from
 *   before Local Models (no setting at all) gets every default. Because the
 *   tasks that already ran through an agent default to `utility-agent`, a user
 *   who set `utilityAgentId` / `utilityModelId` keeps exactly the behavior they
 *   configured: `utilitySource` defaults to the existing provider path.
 * - Unknown task ids (a task a later build dropped) and unusable entries (a
 *   malformed record, `utility-agent` on a task that has no agent path, or
 *   `system-one` on a task with no typed questions) are dropped, which leaves
 *   that task on its default.
 * - An entry equal to its task's default is dropped too, so the stored record
 *   stays sparse and a default that moves in a later build still reaches it.
 */
export function parseLocalModelAssignments(value: unknown): LocalModelAssignments {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
	const assignments: LocalModelAssignments = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!isLocalModelTaskId(key)) continue;
		const assignment = parseLocalModelAssignment(key, entry);
		if (!assignment) continue;
		if (isSameLocalModelAssignment(assignment, LOCAL_MODEL_TASKS[key].defaultAssignment)) continue;
		assignments[key] = assignment;
	}
	return assignments;
}

/** Older installs retain their provider choice. Missing models and endpoints
 * remain selected so readiness reports them instead of choosing a provider. */
export function parseUtilitySource(value: unknown): UtilitySource {
	const assignment = parseLocalModelAssignment('tab-naming', value);
	return assignment &&
		(assignment.type === 'utility-agent' ||
			assignment.type === 'local' ||
			assignment.type === 'endpoint')
		? assignment
		: UTILITY_AGENT_ASSIGNMENT;
}

/** Provider settings belong to the shared source only while it is on the
 * provider path. A parked provider choice cannot override a local source. */
export function resolveUtilityProvider(
	settings: { utilitySource?: unknown; utilityAgentId?: unknown; utilityModelId?: unknown },
	sessionProvider: string
) {
	const provider =
		parseUtilitySource(settings.utilitySource).type === 'utility-agent'
			? nonEmptyString(settings.utilityAgentId)
			: null;
	return {
		agentType: provider ?? sessionProvider,
		modelId: provider ? (nonEmptyString(settings.utilityModelId) ?? undefined) : undefined,
		usesUtilityProvider: provider !== null,
		changesProvider: provider !== null && provider !== sessionProvider,
	};
}

export function isSameLocalModelAssignment(
	a: LocalModelAssignment,
	b: LocalModelAssignment
): boolean {
	if (a.type !== b.type) return false;
	if (a.type === 'local' && b.type === 'local')
		return a.modelId === b.modelId && a.language === b.language;
	if (a.type === 'endpoint' && b.type === 'endpoint') {
		return a.endpointId === b.endpointId && a.model === b.model;
	}
	return true;
}

/** The stored task choice, else its default. Passing the shared utility source
 * resolves inheritance; omitting it preserves the choice shown by task pickers. */
export function resolveLocalModelAssignment(
	assignments: LocalModelAssignments | undefined,
	taskId: LocalModelTaskId,
	utilitySource?: UtilitySource
): LocalModelAssignment {
	const stored = assignments?.[taskId];
	const parsed = stored === undefined ? null : parseLocalModelAssignment(taskId, stored);
	const assignment = parsed ?? LOCAL_MODEL_TASKS[taskId].defaultAssignment;
	return assignment.type === 'utility-agent' ? (utilitySource ?? assignment) : assignment;
}

/** Every task's effective assignment, for a surface that lists them all. */
export function resolveLocalModelAssignments(
	assignments: LocalModelAssignments | undefined,
	utilitySource?: UtilitySource
): Record<LocalModelTaskId, LocalModelAssignment> {
	const resolved = {} as Record<LocalModelTaskId, LocalModelAssignment>;
	for (const taskId of LOCAL_MODEL_TASK_IDS) {
		resolved[taskId] = resolveLocalModelAssignment(assignments, taskId, utilitySource);
	}
	return resolved;
}

/**
 * Why an assignment the user is about to SAVE does not fit a task, or `null`
 * when it does. Stricter than {@link parseLocalModelAssignment}: a local model
 * must be in the catalog and of a kind the task accepts, because picking a
 * text model for an embedding task is a mistake to refuse at the picker, not a
 * failure to discover at run time. An endpoint is refused for a need no server
 * serves ({@link endpointServesNeed}); otherwise its models are discovered at
 * run time, so only their shape is checked here and readiness reports a wrong
 * one.
 */
export function localModelAssignmentProblem(
	taskId: LocalModelTaskId,
	value: unknown
): string | null {
	const task = LOCAL_MODEL_TASKS[taskId];
	const assignment = parseLocalModelAssignment(taskId, value);
	if (!assignment) {
		const type =
			typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined;
		if (type === 'utility-agent') {
			return `${task.label} has no Utility Agent path. Choose off, a local model, or an endpoint.`;
		}
		if (type === 'system-one') {
			const why =
				task.system === 'one'
					? 'it has no typed questions for an engine to answer'
					: 'it writes text, and System One answers typed questions only';
			return `${task.label} cannot run on System One: ${why}. Choose ${otherSourceChoices(task)}.`;
		}
		if (type === 'local') return 'A local assignment needs a model id.';
		if (type === 'endpoint') return 'An endpoint assignment needs an endpoint id and a model name.';
		return `Assignment type must be one of: ${LOCAL_MODEL_ASSIGNMENT_TYPES.join(', ')}.`;
	}
	if (assignment.type === 'local') {
		const model = getLocalModel(assignment.modelId);
		if (!model) return `"${assignment.modelId}" is not a known local model.`;
		if (
			assignment.language !== undefined &&
			(model.kind !== 'stt' || !model.speechToText?.languages.includes(assignment.language))
		) {
			return `${model.displayName} does not support transcription language "${assignment.language}".`;
		}
		if (!taskAcceptsLocalKind(task, model.kind)) {
			return `${model.displayName} is a ${model.kind} model, but ${task.label} needs a ${taskLocalModelKinds(task).join(' or ')} model.`;
		}
	}
	if (assignment.type === 'endpoint' && !endpointServesNeed(task.needs)) {
		return `${task.label} needs a ${task.needs} model, which an endpoint cannot serve. Choose off or a local model.`;
	}
	return null;
}

/** The sources a task takes besides System One, for a refusal that names them. */
function otherSourceChoices(task: LocalModelTaskDefinition): string {
	const choices = ['off'];
	if (task.allowsUtilityAgent) choices.push('the Utility Agent');
	choices.push('a local model');
	if (endpointServesNeed(task.needs)) choices.push('an endpoint');
	return `${choices.slice(0, -1).join(', ')} or ${choices[choices.length - 1]}`;
}

/**
 * Why a VALID assignment is one this task does not recommend, or `null`. A
 * caution is not a refusal: the assignment saves and runs. Every surface that
 * lets a user make the choice says this next to it (the picker's label, the
 * CLI's reply), so a model that is known to do the job badly is never picked
 * without the reason on screen.
 */
export function localModelAssignmentCaution(
	taskId: LocalModelTaskId,
	assignment: LocalModelAssignment
): string | null {
	if (assignment.type !== 'local') return null;
	return LOCAL_MODEL_TASKS[taskId].unofferedLocalModels?.[assignment.modelId] ?? null;
}

/** Whether a picker should offer this catalog model for a task as a fresh choice. */
export function isLocalModelOfferedForTask(taskId: LocalModelTaskId, modelId: string): boolean {
	return LOCAL_MODEL_TASKS[taskId].unofferedLocalModels?.[modelId] === undefined;
}

/**
 * Store one task's assignment, returning the next persisted record. Choosing a
 * task's default removes its entry rather than writing the default down, which
 * keeps the record sparse (see {@link parseLocalModelAssignments}). The caller
 * validates with {@link localModelAssignmentProblem} first.
 */
export function withLocalModelAssignment(
	assignments: LocalModelAssignments,
	taskId: LocalModelTaskId,
	assignment: LocalModelAssignment
): LocalModelAssignments {
	const next: LocalModelAssignments = { ...assignments };
	if (isSameLocalModelAssignment(assignment, LOCAL_MODEL_TASKS[taskId].defaultAssignment)) {
		delete next[taskId];
	} else {
		next[taskId] = assignment;
	}
	return next;
}

/**
 * The tasks whose EFFECTIVE assignment runs a given local model, in registry
 * order. Reads defaults too, so a task that would run the model without a
 * stored entry still counts. This is the list a surface names before removing
 * the model, because removing it turns each of those tasks unavailable.
 */
export function tasksUsingLocalModel(
	assignments: LocalModelAssignments | undefined,
	modelId: string,
	utilitySource?: UtilitySource
): LocalModelTaskDefinition[] {
	return LOCAL_MODEL_TASK_IDS.filter((taskId) => {
		const assignment = resolveLocalModelAssignment(assignments, taskId, utilitySource);
		return assignment.type === 'local' && assignment.modelId === modelId;
	}).map((taskId) => LOCAL_MODEL_TASKS[taskId]);
}

/** The tasks that can be assigned a model of this kind, in registry order. */
export function tasksNeedingKind(kind: LocalModelKind): LocalModelTaskDefinition[] {
	return LOCAL_MODEL_TASK_IDS.map((taskId) => LOCAL_MODEL_TASKS[taskId]).filter((task) =>
		taskAcceptsLocalKind(task, kind)
	);
}

/** The tasks that belong to one half of the Models settings, in registry order. */
export function tasksForSystem(system: LocalModelSystem): LocalModelTaskDefinition[] {
	return LOCAL_MODEL_TASK_IDS.map((taskId) => LOCAL_MODEL_TASKS[taskId]).filter(
		(task) => task.system === system
	);
}

/**
 * The tasks whose EFFECTIVE assignment calls a given endpoint, in registry
 * order. The endpoint twin of {@link tasksUsingLocalModel}: removing or
 * disabling the endpoint turns each of these tasks unavailable, so a surface
 * names them first.
 */
export function tasksUsingEndpoint(
	assignments: LocalModelAssignments | undefined,
	endpointId: string,
	utilitySource?: UtilitySource
): LocalModelTaskDefinition[] {
	return LOCAL_MODEL_TASK_IDS.filter((taskId) => {
		const assignment = resolveLocalModelAssignment(assignments, taskId, utilitySource);
		return assignment.type === 'endpoint' && assignment.endpointId === endpointId;
	}).map((taskId) => LOCAL_MODEL_TASKS[taskId]);
}

/**
 * What a person calls the model a `local` or `endpoint` assignment runs on: the
 * catalog display name, or `<model> on <endpoint name>`. `null` for `off` and
 * `utility-agent`, which name no model of their own, and for `system-one`,
 * whose name depends on the engine in force (`systemOneAssignmentLabel` in
 * `system-one-settings.ts`).
 *
 * A source the build no longer knows (a model dropped from the catalog, an
 * endpoint that was removed) is still named by its id, so a surface never
 * shows a blank where the user's choice was. A task router source has the same
 * shape as its assignment, so it is labeled through this too.
 */
export function localModelAssignmentSourceLabel(
	assignment: LocalModelAssignment,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[]
): string | null {
	if (assignment.type === 'local') {
		return getLocalModel(assignment.modelId)?.displayName ?? assignment.modelId;
	}
	if (assignment.type === 'endpoint') {
		// The Maestro model server is built in, so no saved list carries it.
		if (assignment.endpointId === MODEL_SERVER_ENDPOINT_ID) {
			return `${getLocalModel(assignment.model)?.displayName ?? assignment.model} on ${MODEL_SERVER_NAME}`;
		}
		const endpoint = endpoints.find((candidate) => candidate.id === assignment.endpointId);
		return endpoint ? `${assignment.model} on ${endpoint.name}` : assignment.model;
	}
	return null;
}

/**
 * The one-string spelling of an assignment: `off`, `utility-agent`,
 * `system-one`, `local:<model-id>`, or `endpoint:<endpoint-id>:<model>`. The
 * settings picker
 * uses it as an option value and `maestro-cli models assign` takes it as an
 * argument, so the two cannot disagree about what a choice means. Endpoint ids
 * are UUIDs and never contain a colon, so everything after the second colon is
 * the model, which keeps an Ollama tag (`qwen3:latest`) intact.
 */
export function formatLocalModelAssignmentSpec(assignment: LocalModelAssignment): string {
	switch (assignment.type) {
		case 'off':
		case 'utility-agent':
		case 'system-one':
			return assignment.type;
		case 'local':
			return `local:${assignment.modelId}${assignment.language ? `?language=${encodeURIComponent(assignment.language)}` : ''}`;
		case 'endpoint':
			return `endpoint:${assignment.endpointId}:${assignment.model}`;
	}
}

/**
 * Read a spelling written by {@link formatLocalModelAssignmentSpec}, or `null`
 * when it is not one. Only the SHAPE is checked; whether it fits a task is
 * {@link localModelAssignmentProblem}.
 */
export function parseLocalModelAssignmentSpec(spec: string): LocalModelAssignment | null {
	const trimmed = spec.trim();
	if (trimmed === 'off') return OFF_ASSIGNMENT;
	if (trimmed === 'utility-agent') return UTILITY_AGENT_ASSIGNMENT;
	if (trimmed === 'system-one') return SYSTEM_ONE_ASSIGNMENT;
	if (trimmed.startsWith('local:')) {
		const rest = trimmed.slice('local:'.length);
		const separator = rest.indexOf('?language=');
		const modelId = nonEmptyString(separator < 0 ? rest : rest.slice(0, separator));
		if (!modelId) return null;
		if (separator < 0) return { type: 'local', modelId };
		try {
			const language = nonEmptyString(
				decodeURIComponent(rest.slice(separator + '?language='.length))
			);
			return language ? { type: 'local', modelId, language } : null;
		} catch {
			return null;
		}
	}
	if (trimmed.startsWith('endpoint:')) {
		const rest = trimmed.slice('endpoint:'.length);
		const separator = rest.indexOf(':');
		if (separator < 0) return null;
		const endpointId = nonEmptyString(rest.slice(0, separator));
		const model = nonEmptyString(rest.slice(separator + 1));
		return endpointId && model ? { type: 'endpoint', endpointId, model } : null;
	}
	return null;
}
