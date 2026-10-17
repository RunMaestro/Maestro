/**
 * @file system-one-settings.test.ts
 *
 * What the user configures for System One, and the one validator every surface
 * reads a change through. Properties worth protecting:
 *
 *   - **Off by default**, and the hosted engine's sentence names TypeSafe.
 *   - **A refused change changes nothing**, and says why in the user's words.
 *   - **A pinned model belongs to one remote engine**; the local judge has none.
 *   - **Fail policies are sparse**: only a choice that differs from the task's
 *     default is stored, and only a task that gates something has one.
 *   - **A key's description never contains a key.**
 *   - **Agents ask under a budget**: the switch is on by default, a day's spend
 *     is capped at a dollar, and a per-agent cap exists only when it is set.
 *   - **A budget typed by a person** means the same number in Settings and on
 *     the command line, and an empty field is never read as zero.
 *   - **On is not "may ask now"**: the line beside the switch says what in the
 *     setup still stands in the way.
 */

import { describe, it, expect } from 'vitest';

import {
	JEV_CLOUD_BASE_URL,
	LOCAL_JUDGE_DEFAULT_TIMEOUT_MS,
	SYSTEM_ONE_DEFAULT_TIMEOUT_MS,
} from '../../../shared/local-models/system-one';
import {
	DEFAULT_SYSTEM_ONE_AGENT_SETTINGS,
	DEFAULT_SYSTEM_ONE_SETTINGS,
	SYSTEM_ONE_AGENT_USE_DESCRIPTIONS,
	SYSTEM_ONE_DEFAULT_DAILY_BUDGET_USD,
	SYSTEM_ONE_ENGINE_CHOICES,
	SYSTEM_ONE_ENGINE_DISCLOSURES,
	SYSTEM_ONE_MAX_DAILY_BUDGET_USD,
	SYSTEM_ONE_MAX_TIMEOUT_MS,
	SYSTEM_ONE_MIN_TIMEOUT_MS,
	SYSTEM_ONE_TEST_QUESTIONS,
	SYSTEM_ONE_TEST_QUESTION_ID,
	applySystemOneSettingsPatch,
	describeSystemOneKey,
	parseSystemOneBudgetText,
	parseSystemOneSettings,
	resolveSystemOneFailPolicy,
	systemOneAgentUseBlocker,
	systemOneAssignmentLabel,
	systemOneBudgetProblem,
	systemOneEngineChoiceLabel,
	systemOneFailPolicyProblem,
	systemOneFailPolicyRows,
	systemOneFailPolicyTasks,
	systemOneKeyProblem,
	systemOneModelProblem,
	systemOneRequestTimeoutMs,
	systemOneTimeoutProblem,
	systemOneUrlProblem,
	withSystemOneFailPolicy,
	type SystemOneSettings,
} from '../../../shared/local-models/system-one-settings';
import { LOCAL_MODEL_TASKS, LOCAL_MODEL_TASK_IDS } from '../../../shared/local-models/tasks';

function apply(current: SystemOneSettings, patch: unknown): SystemOneSettings {
	const change = applySystemOneSettingsPatch(current, patch);
	if (!change.ok) throw new Error(change.message);
	return change.settings;
}

function refusal(current: SystemOneSettings, patch: unknown): string {
	const change = applySystemOneSettingsPatch(current, patch);
	if (change.ok) throw new Error('expected a refusal');
	return change.message;
}

describe('the engine choice', () => {
	it('is off until the user chooses, with the three engines beside it', () => {
		expect(DEFAULT_SYSTEM_ONE_SETTINGS.engine).toBe('off');
		expect(SYSTEM_ONE_ENGINE_CHOICES).toEqual(['off', 'jev-cloud', 'openjev', 'local-judge']);
		expect(DEFAULT_SYSTEM_ONE_SETTINGS.timeoutMs).toBe(SYSTEM_ONE_DEFAULT_TIMEOUT_MS);
	});

	it('says where the text goes for every choice, and names TypeSafe for the hosted one', () => {
		for (const choice of SYSTEM_ONE_ENGINE_CHOICES) {
			expect(SYSTEM_ONE_ENGINE_DISCLOSURES[choice].length).toBeGreaterThan(20);
		}
		expect(SYSTEM_ONE_ENGINE_DISCLOSURES['jev-cloud']).toContain('TypeSafe');
		expect(SYSTEM_ONE_ENGINE_DISCLOSURES['jev-cloud']).toContain(new URL(JEV_CLOUD_BASE_URL).host);
		expect(SYSTEM_ONE_ENGINE_DISCLOSURES['jev-cloud']).toContain('redacted');
		expect(SYSTEM_ONE_ENGINE_DISCLOSURES['local-judge']).toContain('not calibrated');
	});

	it('never labels the local judge as Jev', () => {
		expect(systemOneEngineChoiceLabel('off')).toBe('Off');
		expect(systemOneEngineChoiceLabel('jev-cloud')).toBe('Jev (TypeSafe cloud)');
		expect(systemOneEngineChoiceLabel('openjev', { host: 'gpu.lan:8000' })).toBe(
			'OpenJev at gpu.lan:8000'
		);
		const judge = systemOneEngineChoiceLabel('local-judge', { model: 'Qwen3 1.7B' });
		expect(judge).toContain('not calibrated');
		expect(judge).not.toContain('Jev');
	});

	it('labels a task assigned to System One with the engine in force', () => {
		expect(systemOneAssignmentLabel('jev-cloud')).toBe('System One (Jev)');
		expect(systemOneAssignmentLabel('openjev')).toBe('System One (OpenJev)');
		expect(systemOneAssignmentLabel('local-judge')).toBe('System One (local judge)');
		// A task left on System One after the engine was switched off still has a name.
		expect(systemOneAssignmentLabel('off')).toBe('System One (no engine chosen)');
		expect(systemOneAssignmentLabel('local-judge')).not.toContain('Jev');
	});
});

describe('parseSystemOneSettings', () => {
	it('reads nothing, or anything that is not an object, as the defaults', () => {
		for (const value of [undefined, null, 'off', 7, []]) {
			expect(parseSystemOneSettings(value)).toEqual(DEFAULT_SYSTEM_ONE_SETTINGS);
		}
	});

	it('keeps the usable fields and drops the rest', () => {
		expect(
			parseSystemOneSettings({
				engine: 'openjev',
				openJevUrl: 'https://gpu.lan:8000/',
				timeoutMs: 900,
				models: { 'jev-cloud': ' jev-1.13.0 ', openjev: '', 'local-judge': 'nope' },
				failPolicies: { 'cue-gate': 'closed', 'injection-screen': 'closed', dictation: 'open' },
				keepInputs: true,
			})
		).toEqual({
			engine: 'openjev',
			openJevUrl: 'https://gpu.lan:8000',
			timeoutMs: 900,
			models: { 'jev-cloud': 'jev-1.13.0' },
			// The screen's own default is not written down; dictation has no policy.
			failPolicies: { 'cue-gate': 'closed' },
			keepInputs: true,
			agents: DEFAULT_SYSTEM_ONE_AGENT_SETTINGS,
		});

		expect(
			parseSystemOneSettings({
				engine: 'gpt',
				openJevUrl: 'ftp://nope',
				timeoutMs: 5,
				models: 'x',
				failPolicies: [],
			})
		).toEqual(DEFAULT_SYSTEM_ONE_SETTINGS);
	});
});

describe('applySystemOneSettingsPatch', () => {
	const base = DEFAULT_SYSTEM_ONE_SETTINGS;

	it('changes only what the patch names', () => {
		const next = apply(base, { engine: 'jev-cloud' });
		expect(next).toEqual({ ...base, engine: 'jev-cloud' });
		expect(apply(next, { timeoutMs: 800 })).toEqual({ ...next, timeoutMs: 800 });
		expect(apply(next, {})).toEqual(next);
		// The stored settings are never edited in place.
		expect(base.engine).toBe('off');
	});

	it('normalizes the OpenJev URL, and keeps it when another engine is chosen', () => {
		const open = apply(base, { engine: 'openjev', openJevUrl: ' https://gpu.lan:8000/ ' });
		expect(open.openJevUrl).toBe('https://gpu.lan:8000');
		expect(apply(open, { engine: 'jev-cloud' }).openJevUrl).toBe('https://gpu.lan:8000');
		expect(apply(open, { openJevUrl: null }).openJevUrl).toBeNull();
		expect(apply(open, { openJevUrl: '' }).openJevUrl).toBeNull();
	});

	it('lets OpenJev be chosen before its URL is typed, so the picker can lead', () => {
		expect(apply(base, { engine: 'openjev' })).toMatchObject({
			engine: 'openjev',
			openJevUrl: null,
		});
	});

	it('pins a model on the engine the same change names, and each engine keeps its own', () => {
		const jev = apply(base, { engine: 'jev-cloud', model: 'jev-1.13.0' });
		expect(jev.models).toEqual({ 'jev-cloud': 'jev-1.13.0' });
		const open = apply(jev, { engine: 'openjev', model: 'openjev-1' });
		expect(open.models).toEqual({ 'jev-cloud': 'jev-1.13.0', openjev: 'openjev-1' });
		// With no engine named, the pin goes to the engine in force.
		expect(apply(open, { model: null }).models).toEqual({ 'jev-cloud': 'jev-1.13.0' });
		expect(apply(jev, { model: '' }).models).toEqual({});
	});

	it('refuses a pin where there is no remote engine to pin it on', () => {
		expect(refusal(base, { model: 'jev-1.13.0' })).toContain('Jev or OpenJev');
		expect(refusal(base, { engine: 'local-judge', model: 'qwen' })).toContain('Local judge task');
	});

	it('refuses what it cannot use, in words a person can act on', () => {
		expect(refusal(base, 'jev-cloud')).toContain('must be an object');
		expect(refusal(base, { engine: 'gpt' })).toContain('off, jev-cloud, openjev, local-judge');
		expect(refusal(base, { openJevUrl: 'ftp://gpu.lan' })).toContain('http and https');
		expect(refusal(base, { openJevUrl: 'https://me:pw@gpu.lan' })).toContain(
			'Store the key for OpenJev'
		);
		expect(refusal(base, { openJevUrl: 7 })).toContain('must be text');
		expect(refusal(base, { timeoutMs: 20 })).toContain(String(SYSTEM_ONE_MIN_TIMEOUT_MS));
		expect(refusal(base, { timeoutMs: '900' })).toContain('whole number');
		expect(refusal(base, { engine: 'jev-cloud', model: 'two words' })).toContain('no spaces');
		expect(refusal(base, { failPolicy: { taskId: 'dictation', policy: 'open' } })).toContain(
			'has no fail policy'
		);
		expect(refusal(base, { failPolicy: { taskId: 'cue-gate', policy: 'maybe' } })).toContain(
			'open, closed or default'
		);
		expect(refusal(base, { failPolicy: 'closed' })).toContain('is not a task');
	});

	it('keeps no inputs until the user says so, and turns it on and off', () => {
		expect(base.keepInputs).toBe(false);
		const on = apply(base, { keepInputs: true });
		expect(on).toEqual({ ...base, keepInputs: true });
		// Another change leaves the choice alone.
		expect(apply(on, { engine: 'jev-cloud' }).keepInputs).toBe(true);
		expect(apply(on, { keepInputs: false }).keepInputs).toBe(false);
		expect(refusal(base, { keepInputs: 'yes' })).toContain('on or off');
	});

	it('reads a stored keepInputs only when it is exactly true', () => {
		expect(parseSystemOneSettings({ keepInputs: true }).keepInputs).toBe(true);
		for (const other of [false, 'true', 1, null, undefined]) {
			expect(parseSystemOneSettings({ keepInputs: other }).keepInputs).toBe(false);
		}
	});

	it('applies a valid field only when every field is valid', () => {
		const change = applySystemOneSettingsPatch(base, { engine: 'jev-cloud', timeoutMs: 1 });
		expect(change.ok).toBe(false);
		expect(base.engine).toBe('off');
	});
});

describe('what agents may do', () => {
	const base = DEFAULT_SYSTEM_ONE_SETTINGS;

	it('lets agents ask by default, under a dollar a day and no cap of their own', () => {
		expect(base.agents).toEqual({
			enabled: true,
			dailyBudgetUsd: SYSTEM_ONE_DEFAULT_DAILY_BUDGET_USD,
			perAgentBudgetUsd: null,
		});
		expect(SYSTEM_ONE_DEFAULT_DAILY_BUDGET_USD).toBe(1);
	});

	it('changes one field of the three and leaves the others as they are', () => {
		const off = apply(base, { agents: { enabled: false } });
		expect(off.agents).toEqual({ ...base.agents, enabled: false });
		const capped = apply(off, { agents: { dailyBudgetUsd: 2.5, perAgentBudgetUsd: 0.25 } });
		expect(capped.agents).toEqual({ enabled: false, dailyBudgetUsd: 2.5, perAgentBudgetUsd: 0.25 });
		// Null removes the per-agent cap; the daily budget has no "none".
		expect(apply(capped, { agents: { perAgentBudgetUsd: null } }).agents.perAgentBudgetUsd).toBe(
			null
		);
		// Another change leaves all three alone.
		expect(apply(capped, { engine: 'jev-cloud' }).agents).toEqual(capped.agents);
		// The stored settings are never edited in place.
		expect(base.agents.enabled).toBe(true);
	});

	it('takes a budget of zero, which refuses every request', () => {
		expect(apply(base, { agents: { dailyBudgetUsd: 0 } }).agents.dailyBudgetUsd).toBe(0);
		expect(systemOneBudgetProblem(0)).toBeNull();
		expect(systemOneBudgetProblem(SYSTEM_ONE_MAX_DAILY_BUDGET_USD)).toBeNull();
	});

	it('refuses what is not a switch or a budget, and changes nothing', () => {
		expect(refusal(base, { agents: 'on' })).toContain('must be an object');
		expect(refusal(base, { agents: { enabled: 'yes' } })).toContain('on or off');
		for (const budget of [-1, SYSTEM_ONE_MAX_DAILY_BUDGET_USD + 1, Number.NaN, '1', null]) {
			expect(refusal(base, { agents: { dailyBudgetUsd: budget } })).toContain('US dollars a day');
		}
		expect(refusal(base, { agents: { perAgentBudgetUsd: -0.5 } })).toContain('US dollars a day');
		// One bad field refuses the whole change.
		const change = applySystemOneSettingsPatch(base, {
			agents: { enabled: false, dailyBudgetUsd: -1 },
		});
		expect(change.ok).toBe(false);
		expect(base.agents.enabled).toBe(true);
	});

	it('reads stored agent settings field by field, a bad one as its default', () => {
		expect(
			parseSystemOneSettings({
				agents: { enabled: false, dailyBudgetUsd: 3, perAgentBudgetUsd: 0.5 },
			}).agents
		).toEqual({ enabled: false, dailyBudgetUsd: 3, perAgentBudgetUsd: 0.5 });
		expect(
			parseSystemOneSettings({
				agents: { enabled: 'no', dailyBudgetUsd: -4, perAgentBudgetUsd: 'lots' },
			}).agents
		).toEqual(DEFAULT_SYSTEM_ONE_AGENT_SETTINGS);
		// Only an explicit false switches agents off: a file from before the switch keeps it on.
		for (const other of [undefined, null, 0, 'false']) {
			expect(parseSystemOneSettings({ agents: { enabled: other } }).agents.enabled).toBe(true);
		}
		expect(parseSystemOneSettings({ agents: [] }).agents).toEqual(
			DEFAULT_SYSTEM_ONE_AGENT_SETTINGS
		);
	});

	it('reads a budget as a person types it', () => {
		for (const [text, usd] of [
			['1', 1],
			['0.25', 0.25],
			['.5', 0.5],
			['2.', 2],
			['$3', 3],
			[' $ 0.10 ', 0.1],
			['0', 0],
			[String(SYSTEM_ONE_MAX_DAILY_BUDGET_USD), SYSTEM_ONE_MAX_DAILY_BUDGET_USD],
		] as const) {
			expect(parseSystemOneBudgetText(text), text).toEqual({ ok: true, usd });
		}
	});

	it('refuses text that is not a budget, an empty field included', () => {
		// `Number('')` is 0, and 0 refuses every agent request: an emptied field must not store it.
		for (const text of ['', '   ', '$', 'none', '-1', '1e3', '0x10', '1,5', '1 2', 'Infinity']) {
			const parsed = parseSystemOneBudgetText(text);
			expect(parsed.ok, text).toBe(false);
			if (!parsed.ok) expect(parsed.message).toContain('US dollars a day');
		}
		expect(parseSystemOneBudgetText(String(SYSTEM_ONE_MAX_DAILY_BUDGET_USD + 1)).ok).toBe(false);
	});

	it('says what the switch means in each position', () => {
		expect(SYSTEM_ONE_AGENT_USE_DESCRIPTIONS.on).toContain('maestro-cli s1');
		expect(SYSTEM_ONE_AGENT_USE_DESCRIPTIONS.on).toContain('passed its Test');
		expect(SYSTEM_ONE_AGENT_USE_DESCRIPTIONS.off).toContain('No agent may ask');
		expect(SYSTEM_ONE_AGENT_USE_DESCRIPTIONS.off).toContain('system prompt');
	});

	it('says what in the setup stops agents while the switch is on', () => {
		const ready = {
			settings: { ...base, engine: 'jev-cloud' as const },
			problem: null,
			testPassedAt: 1_700_000_000_000,
		};
		expect(systemOneAgentUseBlocker(ready)).toBeNull();
		expect(systemOneAgentUseBlocker({ ...ready, settings: base })).toContain('No engine is chosen');
		expect(
			systemOneAgentUseBlocker({ ...ready, problem: 'Jev (TypeSafe cloud) has no API key.' })
		).toContain('cannot answer as it is set up');
		expect(systemOneAgentUseBlocker({ ...ready, testPassedAt: null })).toContain('passes its Test');
		// The engine being off is the first thing to say, whatever else is true.
		expect(
			systemOneAgentUseBlocker({ settings: base, problem: 'anything', testPassedAt: null })
		).toContain('No engine is chosen');
	});
});

describe('validators', () => {
	it('accepts a whole number of milliseconds inside the range', () => {
		expect(systemOneTimeoutProblem(SYSTEM_ONE_MIN_TIMEOUT_MS)).toBeNull();
		expect(systemOneTimeoutProblem(SYSTEM_ONE_MAX_TIMEOUT_MS)).toBeNull();
		for (const bad of [SYSTEM_ONE_MIN_TIMEOUT_MS - 1, SYSTEM_ONE_MAX_TIMEOUT_MS + 1, 150.5, NaN]) {
			expect(systemOneTimeoutProblem(bad)).not.toBeNull();
		}
	});

	it('asks for an OpenJev URL in its own words', () => {
		expect(systemOneUrlProblem('')).toBe('Give the URL of your OpenJev server.');
		expect(systemOneUrlProblem('http://10.0.0.4:8000')).toBeNull();
		expect(systemOneUrlProblem('https://gpu.lan/v1?x=1')).toContain('query string');
	});

	it('refuses a model name or a key that is empty, has spaces, or is a pasted blob', () => {
		expect(systemOneModelProblem('jev-1.13.0')).toBeNull();
		expect(systemOneModelProblem('  ')).not.toBeNull();
		expect(systemOneModelProblem('x'.repeat(201))).toContain('200');

		expect(systemOneKeyProblem('sk-abc123')).toBeNull();
		expect(systemOneKeyProblem(' sk-abc123\n')).toBeNull();
		expect(systemOneKeyProblem('')).toBe('The key is empty.');
		expect(systemOneKeyProblem(undefined)).toBe('The key is empty.');
		expect(systemOneKeyProblem('line one\nline two')).toContain('one line');
		expect(systemOneKeyProblem('k'.repeat(5000))).toContain('4096');
	});

	it('never repeats a key in the reason it refuses one', () => {
		const key = 'sk-secret value-with-a-space';
		expect(systemOneKeyProblem(key)).not.toContain('sk-secret');
	});
});

describe('the request budget', () => {
	it('is the stored timeout for the remote engines, and its own for the local judge', () => {
		const settings = { timeoutMs: 700 };
		expect(systemOneRequestTimeoutMs(settings, 'jev-cloud')).toBe(700);
		expect(systemOneRequestTimeoutMs(settings, 'openjev')).toBe(700);
		expect(systemOneRequestTimeoutMs(settings, 'local-judge')).toBe(LOCAL_JUDGE_DEFAULT_TIMEOUT_MS);
	});
});

describe('fail policies', () => {
	it('belong only to the tasks that gate something, with the defaults the design names', () => {
		expect(systemOneFailPolicyTasks().map((task) => task.id)).toEqual([
			'cue-gate',
			'injection-screen',
		]);
		expect(LOCAL_MODEL_TASKS['cue-gate'].failPolicy).toBe('open');
		expect(LOCAL_MODEL_TASKS['injection-screen'].failPolicy).toBe('closed');
	});

	it('resolve to the user choice, else the default, and to null where there is none', () => {
		expect(resolveSystemOneFailPolicy(undefined, 'cue-gate')).toBe('open');
		expect(resolveSystemOneFailPolicy({ 'cue-gate': 'closed' }, 'cue-gate')).toBe('closed');
		expect(resolveSystemOneFailPolicy({}, 'injection-screen')).toBe('closed');
		for (const taskId of LOCAL_MODEL_TASK_IDS) {
			if (LOCAL_MODEL_TASKS[taskId].failPolicy !== undefined) continue;
			expect(resolveSystemOneFailPolicy({}, taskId)).toBeNull();
		}
	});

	it('store only a choice that differs from the default', () => {
		const closed = withSystemOneFailPolicy({}, 'cue-gate', 'closed');
		expect(closed).toEqual({ 'cue-gate': 'closed' });
		expect(withSystemOneFailPolicy(closed, 'cue-gate', 'open')).toEqual({});
		expect(withSystemOneFailPolicy(closed, 'cue-gate', 'default')).toEqual({});
		expect(withSystemOneFailPolicy({}, 'injection-screen', 'closed')).toEqual({});
	});

	it('are refused for a task that has none, naming the ones that do', () => {
		expect(systemOneFailPolicyProblem('cue-gate', 'closed')).toBeNull();
		expect(systemOneFailPolicyProblem('cue-gate', 'default')).toBeNull();
		expect(systemOneFailPolicyProblem('semantic-search', 'open')).toContain(
			'cue-gate, injection-screen'
		);
		expect(systemOneFailPolicyProblem('nope', 'open')).toContain('is not a task');
	});

	it('list one row per task for the column and the CLI', () => {
		expect(systemOneFailPolicyRows({ 'cue-gate': 'closed' })).toEqual([
			{ taskId: 'cue-gate', label: 'Cue gate', policy: 'closed', defaultPolicy: 'open' },
			{
				taskId: 'injection-screen',
				label: 'Prompt-injection screen',
				policy: 'closed',
				defaultPolicy: 'closed',
			},
		]);
	});
});

describe('describeSystemOneKey', () => {
	it('says where a key comes from', () => {
		expect(describeSystemOneKey({ source: 'stored', storage: 'os' })).toContain('system key store');
		expect(describeSystemOneKey({ source: 'stored', storage: 'obscured' })).toContain(
			'not encrypted'
		);
		expect(
			describeSystemOneKey({ source: 'stored', storage: 'os', problem: 'It will not open.' })
		).toBe('It will not open.');
		expect(
			describeSystemOneKey({ source: 'env', envVar: 'TYPESAFE_API_KEY', from: 'settings' })
		).toBe('Read from TYPESAFE_API_KEY in Settings > Environment.');
		expect(
			describeSystemOneKey({ source: 'env', envVar: 'TYPESAFE_API_KEY', from: 'process' })
		).toContain('the environment Maestro was started in');
		expect(describeSystemOneKey({ source: 'file', path: '/home/u/.config/typesafe/api_key' })).toBe(
			'Read from /home/u/.config/typesafe/api_key.'
		);
		expect(describeSystemOneKey({ source: 'none' })).toBe('No key.');
	});
});

describe('the test question', () => {
	it('is one fixed yes or no question that carries nothing of the user', () => {
		expect(Object.keys(SYSTEM_ONE_TEST_QUESTIONS)).toEqual([SYSTEM_ONE_TEST_QUESTION_ID]);
		expect(SYSTEM_ONE_TEST_QUESTIONS[SYSTEM_ONE_TEST_QUESTION_ID].type).toBe('noul');
	});
});
