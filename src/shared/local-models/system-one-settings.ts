/**
 * System One settings: which engine answers, where it is, how long it gets, and
 * what a task does when it gives no answer.
 *
 * The vocabulary of the questions and answers is `system-one.ts`. This module is
 * what the user CONFIGURES, and what every surface that shows the configuration
 * reads: the engine picker in Settings > Models > System One, `maestro-cli s1
 * status`, and the main-process service that stores it
 * (`src/main/local-models/system-one/service.ts`).
 *
 * Four rules are written down here so no surface restates them differently:
 *
 *   1. **Off by default.** No engine is chosen until the user chooses one, and
 *      choosing the hosted Jev is choosing to send task text to TypeSafe. The
 *      picker says so in one sentence ({@link SYSTEM_ONE_ENGINE_DISCLOSURES}).
 *   2. **A key is never part of the settings.** The settings are plain values a
 *      report can carry. A key is sealed in the same file by the main process
 *      and no read ever returns it: a surface learns only where the key comes
 *      from ({@link SystemOneKeyInfo}).
 *   3. **A pinned model belongs to one engine.** A Jev version id means nothing
 *      to an OpenJev server, so each remote engine keeps its own pin. The local
 *      judge has none: its model is the Local judge task's assignment.
 *   4. **The request budget is for the remote engines.** The local judge loads a
 *      model on its first answer after an idle spell, which takes seconds, so
 *      it keeps its own budget ({@link systemOneRequestTimeoutMs}).
 *   5. **The ledger keeps no input unless the user says so.** A decision record
 *      holds question ids and answers. The state and the question text are kept
 *      only while `keepInputs` is on, and then redacted (`system-one-ledger.ts`).
 *   6. **Agents ask under a budget.** "Let agents use System One" is on by
 *      default and means nothing until the engine has passed its Test. What
 *      agents spend in a day is capped, across all of them and optionally per
 *      agent ({@link SystemOneAgentSettings}). The requests themselves are
 *      `system-one-agent.ts`.
 *
 * Everything here is pure and bundle-safe.
 */

import { describeSecretStorage, type SecretStorage } from '../secretStorage';
import { endpointBaseUrlProblem, normalizeEndpointBaseUrl } from './endpoints';
import {
	JEV_CLOUD_BASE_URL,
	LOCAL_JUDGE_DEFAULT_TIMEOUT_MS,
	SYSTEM_ONE_DEFAULT_TIMEOUT_MS,
	SYSTEM_ONE_ENGINE_IDS,
	isSystemOneFailPolicy,
	noul,
	systemOneEngineHost,
	systemOneEngineLabel,
	type SystemOneEngineId,
	type SystemOneErrorCode,
	type SystemOneFailPolicy,
	type SystemOneQuestions,
	type SystemOneRemoteEngineId,
	type SystemOneUsage,
} from './system-one';
import {
	LOCAL_MODEL_TASKS,
	LOCAL_MODEL_TASK_IDS,
	isLocalModelTaskId,
	type LocalModelTaskDefinition,
	type LocalModelTaskId,
} from './tasks';

// ---------------------------------------------------------------------------
// The engine choice
// ---------------------------------------------------------------------------

/** What the engine picker offers: no engine, or one of the three. */
export const SYSTEM_ONE_ENGINE_CHOICES = ['off', ...SYSTEM_ONE_ENGINE_IDS] as const;

export type SystemOneEngineChoice = (typeof SYSTEM_ONE_ENGINE_CHOICES)[number];

export function isSystemOneEngineChoice(value: unknown): value is SystemOneEngineChoice {
	return (SYSTEM_ONE_ENGINE_CHOICES as readonly unknown[]).includes(value);
}

/** The engines reached over HTTP: the ones with a URL, a key and a pinned model. */
export const SYSTEM_ONE_REMOTE_ENGINE_IDS: readonly SystemOneRemoteEngineId[] = Object.freeze([
	'jev-cloud',
	'openjev',
]);

export function isSystemOneRemoteEngineId(value: unknown): value is SystemOneRemoteEngineId {
	return (SYSTEM_ONE_REMOTE_ENGINE_IDS as readonly unknown[]).includes(value);
}

/** What a choice is called. An engine keeps the one name `systemOneEngineLabel` gives it. */
export function systemOneEngineChoiceLabel(
	choice: SystemOneEngineChoice,
	detail: { host?: string | null; model?: string | null } = {}
): string {
	return choice === 'off' ? 'Off' : systemOneEngineLabel(choice, detail);
}

const SYSTEM_ONE_ASSIGNMENT_LABELS: Readonly<Record<SystemOneEngineChoice, string>> = Object.freeze(
	{
		off: 'System One (no engine chosen)',
		'jev-cloud': 'System One (Jev)',
		openjev: 'System One (OpenJev)',
		'local-judge': 'System One (local judge)',
	}
);

/**
 * What the `system-one` assignment is called in a task's source picker. The
 * assignment names no engine, so the label says which one is in force: a task
 * on "System One (local judge)" is never read as running on Jev.
 */
export function systemOneAssignmentLabel(engine: SystemOneEngineChoice): string {
	return SYSTEM_ONE_ASSIGNMENT_LABELS[engine];
}

/**
 * The one sentence the picker shows under each choice: where the text of a task
 * goes. The hosted engine's sentence is the disclosure; it is not optional copy.
 */
export const SYSTEM_ONE_ENGINE_DISCLOSURES: Readonly<Record<SystemOneEngineChoice, string>> =
	Object.freeze({
		off: 'System One is off. No task text is sent to an engine.',
		'jev-cloud': `Choosing Jev sends the text of every System One request to TypeSafe (${new URL(JEV_CLOUD_BASE_URL).host}), after secrets are redacted.`,
		openjev:
			'Choosing OpenJev sends the text of every System One request to the server at the URL you give, after secrets are redacted.',
		'local-judge':
			'The local judge answers on the model assigned to the Local judge task. Its answers are not calibrated, and it is never shown as Jev.',
	});

// ---------------------------------------------------------------------------
// The settings
// ---------------------------------------------------------------------------

/** The shortest and longest request budget a user can set. */
export const SYSTEM_ONE_MIN_TIMEOUT_MS = 100;
export const SYSTEM_ONE_MAX_TIMEOUT_MS = 60_000;

/** Longest model name accepted as a pin. A guard against a pasted blob, not a format. */
export const SYSTEM_ONE_MAX_MODEL_CHARS = 200;

/** Longest key accepted. A real key is far shorter; this stops a pasted file. */
export const SYSTEM_ONE_MAX_KEY_CHARS = 4_096;

/** Per-task fail policies the user changed. Sparse: a task not listed uses its default. */
export type SystemOneFailPolicies = Partial<Record<LocalModelTaskId, SystemOneFailPolicy>>;

export interface SystemOneSettings {
	engine: SystemOneEngineChoice;
	/**
	 * The user's OpenJev server, normalized (no trailing slash), or null. Kept
	 * when another engine is chosen, so switching back does not ask for it again.
	 */
	openJevUrl: string | null;
	/** The request budget for Jev and OpenJev. See {@link systemOneRequestTimeoutMs}. */
	timeoutMs: number;
	/** The pinned model of each remote engine. An engine not listed has none. */
	models: Partial<Record<SystemOneRemoteEngineId, string>>;
	failPolicies: SystemOneFailPolicies;
	/**
	 * "Keep inputs in the ledger": whether a decision record keeps the state and
	 * the questions it was asked, redacted. Off by default. Switching it off stops
	 * keeping new inputs; the ones already kept stay until their records are pruned.
	 */
	keepInputs: boolean;
	/** What agents may do with System One, and how much they may spend. */
	agents: SystemOneAgentSettings;
}

/**
 * What agents may do with System One (`maestro-cli s1 yes | pick | rate | ask |
 * rank | batch`).
 *
 * `enabled` is "Let agents use System One". It is on by default, and it means
 * nothing until an engine is chosen and has passed its Test: the switch is what
 * the user turns OFF, not a consent that turns anything on by itself.
 *
 * The budgets are US dollars per local day. Only the hosted Jev has a price, so
 * on an OpenJev server or the local judge a budget above zero never binds. A
 * budget of zero refuses every agent request.
 */
export interface SystemOneAgentSettings {
	enabled: boolean;
	/** The most all agents together may spend in a day. */
	dailyBudgetUsd: number;
	/** The most one agent may spend in a day, or null for no cap of its own. */
	perAgentBudgetUsd: number | null;
}

/** A dollar a day buys about 23 million input tokens on the hosted Jev. */
export const SYSTEM_ONE_DEFAULT_DAILY_BUDGET_USD = 1;

/** The largest budget accepted. A guard against a mistyped number, not a recommendation. */
export const SYSTEM_ONE_MAX_DAILY_BUDGET_USD = 1_000;

export const DEFAULT_SYSTEM_ONE_AGENT_SETTINGS: SystemOneAgentSettings = Object.freeze({
	enabled: true,
	dailyBudgetUsd: SYSTEM_ONE_DEFAULT_DAILY_BUDGET_USD,
	perAgentBudgetUsd: null,
});

export const DEFAULT_SYSTEM_ONE_SETTINGS: SystemOneSettings = Object.freeze({
	engine: 'off',
	openJevUrl: null,
	timeoutMs: SYSTEM_ONE_DEFAULT_TIMEOUT_MS,
	models: Object.freeze({}),
	failPolicies: Object.freeze({}),
	keepInputs: false,
	agents: DEFAULT_SYSTEM_ONE_AGENT_SETTINGS,
});

/** Why a value is not a usable daily budget, or `null` when it is. */
export function systemOneBudgetProblem(value: unknown): string | null {
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > SYSTEM_ONE_MAX_DAILY_BUDGET_USD
	) {
		return `A budget is a number of US dollars a day, from 0 to ${SYSTEM_ONE_MAX_DAILY_BUDGET_USD}.`;
	}
	return null;
}

export type SystemOneBudgetTextParse = { ok: true; usd: number } | { ok: false; message: string };

/**
 * Read a budget as a person types it (`1`, `0.25`, `$2`), or say why it is not
 * one. The budget field in Settings and `maestro-cli s1 set budget` both read
 * through this, so the same text means the same number on both.
 */
export function parseSystemOneBudgetText(raw: string): SystemOneBudgetTextParse {
	const text = raw.trim().replace(/^\$/, '').trim();
	// `Number('')` is 0, which would read an empty field as "refuse everything".
	const usd = /^(\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : Number.NaN;
	const problem = systemOneBudgetProblem(usd);
	return problem ? { ok: false, message: problem } : { ok: true, usd };
}

/** What "Let agents use System One" means in each position, for the switch and the CLI. */
export const SYSTEM_ONE_AGENT_USE_DESCRIPTIONS: Readonly<Record<'on' | 'off', string>> =
	Object.freeze({
		on: 'Agents may ask System One with maestro-cli s1, and their system prompt says so, once the engine has passed its Test.',
		off: 'No agent may ask System One, and it is left out of every system prompt from the next start of an agent.',
	});

/**
 * Why agents cannot ask although "Let agents use System One" is on, read from
 * the report alone, or null when nothing in the setup stands in the way. One
 * sentence for the switch in Settings and for `maestro-cli s1 set agents on`.
 * An agent's own opt-out and the budget are not setup: `getSystemOneAgentAccess`
 * answers for one agent.
 */
export function systemOneAgentUseBlocker(
	report: Pick<SystemOneReport, 'settings' | 'problem' | 'testPassedAt'>
): string | null {
	if (report.settings.engine === 'off') return 'No engine is chosen, so no agent can ask.';
	if (report.problem) return 'The engine cannot answer as it is set up, so no agent can ask.';
	if (report.testPassedAt === null) {
		return 'Agents can ask once the engine passes its Test as it is set up now.';
	}
	return null;
}

/** Read stored agent settings. An unusable field reads as its default. */
function parseSystemOneAgentSettings(value: unknown): SystemOneAgentSettings {
	const record = isPlainObject(value) ? value : {};
	return {
		enabled: record.enabled !== false,
		dailyBudgetUsd:
			systemOneBudgetProblem(record.dailyBudgetUsd) === null
				? (record.dailyBudgetUsd as number)
				: SYSTEM_ONE_DEFAULT_DAILY_BUDGET_USD,
		perAgentBudgetUsd:
			systemOneBudgetProblem(record.perAgentBudgetUsd) === null
				? (record.perAgentBudgetUsd as number)
				: null,
	};
}

/** Why a value is not a usable request budget, or `null` when it is. */
export function systemOneTimeoutProblem(value: unknown): string | null {
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value < SYSTEM_ONE_MIN_TIMEOUT_MS ||
		value > SYSTEM_ONE_MAX_TIMEOUT_MS
	) {
		return `The timeout must be a whole number of milliseconds from ${SYSTEM_ONE_MIN_TIMEOUT_MS} to ${SYSTEM_ONE_MAX_TIMEOUT_MS}.`;
	}
	return null;
}

/**
 * Why a URL is not a usable OpenJev server, or `null` when it is. The same
 * rules as a model endpoint's base URL (http or https, no credentials, no query
 * string), in System One's words where the endpoint's would mislead.
 */
export function systemOneUrlProblem(raw: string): string | null {
	const problem = endpointBaseUrlProblem(raw);
	if (!problem) return null;
	if (problem === 'Base URL is required.') return 'Give the URL of your OpenJev server.';
	if (problem.startsWith('Do not put credentials in the URL')) {
		return 'Do not put credentials in the URL. Store the key for OpenJev instead.';
	}
	return problem;
}

/** Why a value is not a usable model pin, or `null` when it is. */
export function systemOneModelProblem(value: unknown): string | null {
	if (typeof value !== 'string' || value.trim() === '') return 'Give the name of the model to pin.';
	if (value.trim().length > SYSTEM_ONE_MAX_MODEL_CHARS) {
		return `A model name is at most ${SYSTEM_ONE_MAX_MODEL_CHARS} characters.`;
	}
	if (/\s/.test(value.trim())) return 'A model name has no spaces.';
	return null;
}

/** Why a value is not a key that can be stored, or `null` when it is. */
export function systemOneKeyProblem(value: unknown): string | null {
	if (typeof value !== 'string' || value.trim() === '') return 'The key is empty.';
	const key = value.trim();
	if (key.length > SYSTEM_ONE_MAX_KEY_CHARS) {
		return `A key is at most ${SYSTEM_ONE_MAX_KEY_CHARS} characters.`;
	}
	// A key travels in an HTTP header: one line, no spaces.
	if (/\s/.test(key)) return 'A key is one line with no spaces.';
	return null;
}

/**
 * Read stored settings. Like every Local Models reader this is also the
 * migration: an unusable field is dropped and reads as its default, so a file
 * from an older build, or one edited by hand, never blocks a start.
 */
export function parseSystemOneSettings(value: unknown): SystemOneSettings {
	const record = isPlainObject(value) ? value : {};
	const models: Partial<Record<SystemOneRemoteEngineId, string>> = {};
	if (isPlainObject(record.models)) {
		for (const engine of SYSTEM_ONE_REMOTE_ENGINE_IDS) {
			const model = record.models[engine];
			if (systemOneModelProblem(model) === null) models[engine] = (model as string).trim();
		}
	}
	const openJevUrl =
		typeof record.openJevUrl === 'string' && systemOneUrlProblem(record.openJevUrl) === null
			? normalizeEndpointBaseUrl(record.openJevUrl)
			: null;
	return {
		engine: isSystemOneEngineChoice(record.engine) ? record.engine : 'off',
		openJevUrl,
		timeoutMs:
			systemOneTimeoutProblem(record.timeoutMs) === null
				? (record.timeoutMs as number)
				: SYSTEM_ONE_DEFAULT_TIMEOUT_MS,
		models,
		failPolicies: parseSystemOneFailPolicies(record.failPolicies),
		keepInputs: record.keepInputs === true,
		agents: parseSystemOneAgentSettings(record.agents),
	};
}

// ---------------------------------------------------------------------------
// A change
// ---------------------------------------------------------------------------

/**
 * One change to the settings, as the Settings card and `maestro-cli s1 set`
 * both send it. Every field is optional; a field that is absent is left as it
 * is.
 */
export interface SystemOneSettingsPatch {
	engine?: SystemOneEngineChoice;
	/** `null` or an empty string forgets the URL. */
	openJevUrl?: string | null;
	/**
	 * The model to pin on the engine this change names, or, when it names none,
	 * on the engine in force. `null` or an empty string removes the pin.
	 */
	model?: string | null;
	timeoutMs?: number;
	/** `default` removes the user's choice, so the task's own default applies. */
	failPolicy?: { taskId: string; policy: SystemOneFailPolicy | 'default' };
	/** "Keep inputs in the ledger". */
	keepInputs?: boolean;
	/**
	 * What agents may do. Each field is optional and left as it is when absent;
	 * `perAgentBudgetUsd: null` removes the per-agent cap.
	 */
	agents?: {
		enabled?: boolean;
		dailyBudgetUsd?: number;
		perAgentBudgetUsd?: number | null;
	};
}

export type SystemOneSettingsChange =
	| { ok: true; settings: SystemOneSettings }
	| { ok: false; message: string };

/**
 * Apply a change to the settings, or say why it cannot be applied. Nothing is
 * changed on a refusal. This is the one validator: the card, the CLI and the
 * service all read a change through it.
 */
export function applySystemOneSettingsPatch(
	current: SystemOneSettings,
	raw: unknown
): SystemOneSettingsChange {
	if (!isPlainObject(raw)) {
		return { ok: false, message: 'A System One settings change must be an object.' };
	}
	const next: SystemOneSettings = {
		...current,
		models: { ...current.models },
		failPolicies: { ...current.failPolicies },
		agents: { ...current.agents },
	};

	if (raw.engine !== undefined) {
		if (!isSystemOneEngineChoice(raw.engine)) {
			return {
				ok: false,
				message: `"${String(raw.engine)}" is not an engine. Use ${SYSTEM_ONE_ENGINE_CHOICES.join(', ')}.`,
			};
		}
		next.engine = raw.engine;
	}

	if (raw.openJevUrl !== undefined) {
		if (raw.openJevUrl === null || raw.openJevUrl === '') {
			next.openJevUrl = null;
		} else if (typeof raw.openJevUrl !== 'string') {
			return { ok: false, message: 'The OpenJev URL must be text.' };
		} else {
			const problem = systemOneUrlProblem(raw.openJevUrl);
			if (problem) return { ok: false, message: problem };
			next.openJevUrl = normalizeEndpointBaseUrl(raw.openJevUrl);
		}
	}

	if (raw.model !== undefined) {
		if (!isSystemOneRemoteEngineId(next.engine)) {
			return {
				ok: false,
				message:
					'A pinned model belongs to Jev or OpenJev. The local judge answers on the model assigned to the Local judge task.',
			};
		}
		if (raw.model === null || raw.model === '') {
			delete next.models[next.engine];
		} else {
			const problem = systemOneModelProblem(raw.model);
			if (problem) return { ok: false, message: problem };
			next.models[next.engine] = (raw.model as string).trim();
		}
	}

	if (raw.timeoutMs !== undefined) {
		const problem = systemOneTimeoutProblem(raw.timeoutMs);
		if (problem) return { ok: false, message: problem };
		next.timeoutMs = raw.timeoutMs as number;
	}

	if (raw.failPolicy !== undefined) {
		const change = isPlainObject(raw.failPolicy) ? raw.failPolicy : {};
		const problem = systemOneFailPolicyProblem(change.taskId, change.policy);
		if (problem) return { ok: false, message: problem };
		next.failPolicies = withSystemOneFailPolicy(
			next.failPolicies,
			change.taskId as LocalModelTaskId,
			change.policy as SystemOneFailPolicy | 'default'
		);
	}

	if (raw.keepInputs !== undefined) {
		if (typeof raw.keepInputs !== 'boolean') {
			return { ok: false, message: 'Keep inputs in the ledger is on or off.' };
		}
		next.keepInputs = raw.keepInputs;
	}

	if (raw.agents !== undefined) {
		if (!isPlainObject(raw.agents)) {
			return { ok: false, message: 'A change to what agents may do must be an object.' };
		}
		const { enabled, dailyBudgetUsd, perAgentBudgetUsd } = raw.agents;
		if (enabled !== undefined) {
			if (typeof enabled !== 'boolean') {
				return { ok: false, message: 'Let agents use System One is on or off.' };
			}
			next.agents.enabled = enabled;
		}
		if (dailyBudgetUsd !== undefined) {
			const problem = systemOneBudgetProblem(dailyBudgetUsd);
			if (problem) return { ok: false, message: problem };
			next.agents.dailyBudgetUsd = dailyBudgetUsd as number;
		}
		if (perAgentBudgetUsd !== undefined) {
			if (perAgentBudgetUsd === null) {
				next.agents.perAgentBudgetUsd = null;
			} else {
				const problem = systemOneBudgetProblem(perAgentBudgetUsd);
				if (problem) return { ok: false, message: problem };
				next.agents.perAgentBudgetUsd = perAgentBudgetUsd as number;
			}
		}
	}

	return { ok: true, settings: next };
}

/** The budget one request gets on an engine. The local judge keeps its own. */
export function systemOneRequestTimeoutMs(
	settings: Pick<SystemOneSettings, 'timeoutMs'>,
	engine: SystemOneEngineId
): number {
	return engine === 'local-judge' ? LOCAL_JUDGE_DEFAULT_TIMEOUT_MS : settings.timeoutMs;
}

// ---------------------------------------------------------------------------
// Fail policies
// ---------------------------------------------------------------------------

/** The tasks that have a fail policy, in registry order. */
export function systemOneFailPolicyTasks(): LocalModelTaskDefinition[] {
	return LOCAL_MODEL_TASK_IDS.map((taskId) => LOCAL_MODEL_TASKS[taskId]).filter(
		(task) => task.failPolicy !== undefined
	);
}

/**
 * The policy a task applies when its engine gives no answer: the user's choice,
 * else the task's default. `null` for a task that has no fail policy.
 */
export function resolveSystemOneFailPolicy(
	policies: SystemOneFailPolicies | undefined,
	taskId: LocalModelTaskId
): SystemOneFailPolicy | null {
	const fallback = LOCAL_MODEL_TASKS[taskId].failPolicy;
	if (fallback === undefined) return null;
	const chosen = policies?.[taskId];
	return isSystemOneFailPolicy(chosen) ? chosen : fallback;
}

/** Why a fail policy cannot be set for a task, or `null` when it can. */
export function systemOneFailPolicyProblem(taskId: unknown, policy: unknown): string | null {
	const names = systemOneFailPolicyTasks()
		.map((task) => task.id)
		.join(', ');
	if (!isLocalModelTaskId(taskId)) {
		return `"${String(taskId)}" is not a task. The tasks with a fail policy are: ${names}.`;
	}
	if (LOCAL_MODEL_TASKS[taskId].failPolicy === undefined) {
		return `${LOCAL_MODEL_TASKS[taskId].label} has no fail policy. The tasks with one are: ${names}.`;
	}
	if (policy !== 'default' && !isSystemOneFailPolicy(policy)) {
		return 'A fail policy is open, closed or default.';
	}
	return null;
}

/**
 * Store one task's fail policy, returning the next sparse record. Choosing the
 * task's default (or `default`) removes the entry, so a default that moves in a
 * later build still reaches the task. Validate with
 * {@link systemOneFailPolicyProblem} first.
 */
export function withSystemOneFailPolicy(
	policies: SystemOneFailPolicies,
	taskId: LocalModelTaskId,
	policy: SystemOneFailPolicy | 'default'
): SystemOneFailPolicies {
	const next: SystemOneFailPolicies = { ...policies };
	if (policy === 'default' || policy === LOCAL_MODEL_TASKS[taskId].failPolicy) delete next[taskId];
	else next[taskId] = policy;
	return next;
}

function parseSystemOneFailPolicies(value: unknown): SystemOneFailPolicies {
	if (!isPlainObject(value)) return {};
	let policies: SystemOneFailPolicies = {};
	for (const [taskId, policy] of Object.entries(value)) {
		if (systemOneFailPolicyProblem(taskId, policy) !== null || policy === 'default') continue;
		policies = withSystemOneFailPolicy(
			policies,
			taskId as LocalModelTaskId,
			policy as SystemOneFailPolicy
		);
	}
	return policies;
}

/** One row of the fail policy column, for the task list and `s1 status`. */
export interface SystemOneFailPolicyRow {
	taskId: LocalModelTaskId;
	label: string;
	policy: SystemOneFailPolicy;
	defaultPolicy: SystemOneFailPolicy;
}

export function systemOneFailPolicyRows(
	policies: SystemOneFailPolicies | undefined
): SystemOneFailPolicyRow[] {
	return systemOneFailPolicyTasks().map((task) => ({
		taskId: task.id,
		label: task.label,
		policy: resolveSystemOneFailPolicy(policies, task.id) as SystemOneFailPolicy,
		defaultPolicy: task.failPolicy as SystemOneFailPolicy,
	}));
}

/** What a policy means, in the words the column and the CLI both use. */
export const SYSTEM_ONE_FAIL_POLICY_DESCRIPTIONS: Readonly<Record<SystemOneFailPolicy, string>> =
	Object.freeze({
		open: 'Fail open: with no answer, the work goes ahead unchecked.',
		closed: 'Fail closed: with no answer, the work stops.',
	});

// ---------------------------------------------------------------------------
// Kept inputs
// ---------------------------------------------------------------------------

/** What "Keep inputs in the ledger" means in each position, for the toggle and the CLI. */
export const SYSTEM_ONE_KEEP_INPUTS_DESCRIPTIONS: Readonly<Record<'on' | 'off', string>> =
	Object.freeze({
		on: 'Each decision record keeps the state and the questions it was asked, with secrets redacted.',
		off: 'A decision record keeps question ids and answers, never the text that was judged.',
	});

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

/** The variable the `jev` CLI reads the hosted key from. A read-only fallback here. */
export const TYPESAFE_API_KEY_ENV_VAR = 'TYPESAFE_API_KEY';

/** The variable the `jev` CLI reads another base URL for the hosted API from. */
export const TYPESAFE_BASE_URL_ENV_VAR = 'TYPESAFE_BASE_URL';

/** The file the `jev` CLI keeps the hosted key in, under the home folder. A read-only fallback. */
export const TYPESAFE_API_KEY_FILE = ['.config', 'typesafe', 'api_key'] as const;

/**
 * Where an engine's key comes from. Never the key.
 *
 *   - `stored` - sealed in Maestro's own file. `problem` is set when it is
 *                there and cannot be opened; the engine then has NO key, and
 *                nothing falls back to another source.
 *   - `env`    - the hosted engine only: `TYPESAFE_API_KEY`, from Settings >
 *                Environment or from the environment Maestro was started in.
 *   - `file`   - the hosted engine only: the `jev` CLI's key file.
 *   - `none`   - no key anywhere. An OpenJev server may need none.
 */
export type SystemOneKeyInfo =
	| { source: 'stored'; storage: SecretStorage; problem?: string }
	| { source: 'env'; envVar: string; from: 'settings' | 'process' }
	| { source: 'file'; path: string }
	| { source: 'none' };

export type SystemOneKeySource = SystemOneKeyInfo['source'];

/** One sentence for a person: where the key comes from. */
export function describeSystemOneKey(info: SystemOneKeyInfo): string {
	switch (info.source) {
		case 'stored':
			return info.problem ?? describeSecretStorage(info.storage);
		case 'env':
			return info.from === 'settings'
				? `Read from ${info.envVar} in Settings > Environment.`
				: `Read from ${info.envVar} in the environment Maestro was started in.`;
		case 'file':
			return `Read from ${info.path}.`;
		case 'none':
			return 'No key.';
	}
}

// ---------------------------------------------------------------------------
// The report and the test
// ---------------------------------------------------------------------------

/** Everything a surface shows about System One. It carries no key. */
export interface SystemOneReport {
	settings: SystemOneSettings;
	/** The engine in force, as a person reads it. "Off" when none is. */
	engineLabel: string;
	/** Where task text goes on this choice, in one sentence. */
	disclosure: string;
	/** Where the engine is called. Null when off, and for the local judge. */
	baseUrl: string | null;
	/**
	 * The model that answers: the pin of a remote engine (null when it has none
	 * and uses its default), or the local judge's source spelling (`local:<id>`,
	 * `endpoint:<id>:<model>`; null when the task has none assigned).
	 */
	model: string | null;
	/** `model` as a person reads it. Null when `model` is. */
	modelLabel: string | null;
	/** The budget a request gets on the engine in force. Null when off. */
	timeoutMs: number | null;
	/** Whether the engine's probabilities are calibrated. Null when off. */
	calibrated: boolean | null;
	/** Where each remote engine's key comes from. */
	keys: Record<SystemOneRemoteEngineId, SystemOneKeyInfo>;
	/**
	 * Why the engine in force cannot answer as it is set up, or null. Read from
	 * the settings alone: nothing is sent to find out.
	 */
	problem: string | null;
	/**
	 * When the engine in force last passed its Test AS IT IS SET UP NOW (epoch
	 * ms), or null: off, never tested, tested and failed, or changed since (the
	 * engine, its URL, its model or its key). Agents may ask only after a pass.
	 */
	testPassedAt: number | null;
	failPolicies: SystemOneFailPolicyRow[];
}

/** The id of the one question the Test button asks. */
export const SYSTEM_ONE_TEST_QUESTION_ID = 'check';

/** The state the Test button sends. Fixed, and it carries nothing of the user's. */
export const SYSTEM_ONE_TEST_STATE = 'The meeting was moved from Tuesday to Thursday at 3 pm.';

/** The fixed question. The right answer is yes, so a low number is a finding. */
export const SYSTEM_ONE_TEST_QUESTIONS: SystemOneQuestions = Object.freeze({
	[SYSTEM_ONE_TEST_QUESTION_ID]: noul('Does the state say the meeting is now on Thursday?'),
});

/**
 * What the Test button and `maestro-cli s1 test` show. A failure is a result,
 * not a thrown error: it names the engine that was asked and never another.
 */
export type SystemOneTestResult =
	| {
			ok: true;
			engine: SystemOneEngineId;
			engineLabel: string;
			/** The model the engine says answered. */
			model: string;
			/** P(yes) for the fixed question. The right answer is yes. */
			probability: number;
			latencyMs: number;
			calibrated: boolean;
			usage: SystemOneUsage;
			costUsd: number;
	  }
	| {
			ok: false;
			engine: SystemOneEngineChoice;
			engineLabel: string;
			/** `off` when no engine is chosen; otherwise why the engine gave no answer. */
			code: SystemOneErrorCode | 'off';
			error: string;
	  };

/** The host an engine choice is called at, for its label. Null when it has none. */
export function systemOneChoiceHost(
	settings: Pick<SystemOneSettings, 'openJevUrl'>,
	choice: SystemOneEngineChoice
): string | null {
	return choice === 'openjev' && settings.openJevUrl
		? systemOneEngineHost(settings.openJevUrl)
		: null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
