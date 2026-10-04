import { describe, expect, it } from 'vitest';
import type { AgentRecord, GroupRecord, ProviderInfo } from '../../../shared/maestro-lib';
import { createFakeClient } from '../../__tests__/fakeClient';
import {
	acceptCompletion,
	availableProviders,
	backspace,
	buildCreateInput,
	buildPatch,
	choiceOptions,
	commitEnvDraft,
	cwdChangeBlocker,
	cycleChoice,
	defaultNameFor,
	defaultProviderId,
	effectiveEnv,
	effectiveName,
	emptyFormContext,
	fieldValueText,
	formFields,
	groupsFromSections,
	initialFormState,
	moveFocus,
	parseEnvEntry,
	pressEnter,
	submitAgentForm,
	typeText,
	unsetEnvKeys,
	validateForm,
	type FormContext,
	type FormState,
} from '../form';

const PROVIDERS: ProviderInfo[] = [
	{ id: 'claude-code', name: 'Claude Code', available: false, unavailableReason: 'not installed' },
	{ id: 'codex', name: 'Codex', available: true, version: '0.42.0' },
	{ id: 'opencode', name: 'OpenCode', available: true },
];

const GROUPS: GroupRecord[] = [
	{ id: 'g-core', name: 'Core', emoji: '🎼' },
	{ id: 'g-web', name: 'Web' },
];

const EXISTING: AgentRecord = {
	id: 'a1',
	name: 'Maestro',
	toolType: 'claude-code',
	groupId: 'g-core',
	state: 'idle',
	cwd: '/work/maestro',
	customModel: 'sonnet',
	customEnvVars: { FOO: 'bar', TOKEN: 'secret-value-1234' },
	sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
	nudgeMessage: 'be brief',
	autoRunFolderPath: '/work/maestro/.maestro/playbooks',
};

const SSH_REMOTES = [
	{ id: 'r1', name: 'Build box', host: 'build.example' },
	{ id: 'r2', name: 'Lab', host: 'lab.example' },
] as unknown as FormContext['sshRemotes'];

const createContext = (overrides: Partial<FormContext> = {}): FormContext => ({
	...emptyFormContext('create'),
	agents: [EXISTING],
	groups: GROUPS,
	providers: PROVIDERS,
	sshRemotes: SSH_REMOTES,
	...overrides,
});

const editContext = (agent: AgentRecord = EXISTING, overrides: Partial<FormContext> = {}) => ({
	...createContext(),
	mode: 'edit' as const,
	agent,
	...overrides,
});

/** A form that passes validation on any cwd, so a test needs no real directory. */
const noDisk = { unusableCwd: () => null };

const typed = (context: FormContext, state: FormState, ...texts: string[]) =>
	texts.reduce((current, text) => typeText(context, current, text), state);

const focusOn = (context: FormContext, state: FormState, id: FormState['focus']): FormState => {
	let current = state;
	for (let guard = 0; guard < 30 && current.focus !== id; guard++) {
		current = moveFocus(context, current, 1);
	}
	return current;
};

describe('providers', () => {
	it('offers only installed providers, with the detected version', () => {
		const context = createContext();
		expect(availableProviders(context).map((p) => p.id)).toEqual(['codex', 'opencode']);
		expect(choiceOptions(context, initialFormState(context), 'provider')).toEqual([
			{ value: 'codex', label: 'Codex 0.42.0' },
			{ value: 'opencode', label: 'OpenCode' },
		]);
	});

	it('starts a new agent on the most preferred installed provider', () => {
		expect(defaultProviderId({ providers: PROVIDERS })).toBe('codex');
		expect(defaultProviderId({ providers: [PROVIDERS[2]] })).toBe('opencode');
		expect(defaultProviderId({ providers: [PROVIDERS[0]] })).toBe('');
		expect(initialFormState(createContext()).values.provider).toBe('codex');
	});

	it('reports a host with no installed provider instead of offering a dead choice', () => {
		const context = createContext({ providers: [PROVIDERS[0]] });
		const state = typed(context, initialFormState(context), 'x');
		const problems = validateForm(
			context,
			{ ...state, values: { ...state.values, cwd: '/p' } },
			noDisk
		);
		expect(problems.find((p) => p.field === 'provider')?.message).toMatch(/No installed provider/);
	});
});

describe('name', () => {
	it('defaults to the folder name, kept clear of names already in use (AG-2)', () => {
		const context = createContext();
		let state = initialFormState(context);
		state = { ...state, values: { ...state.values, cwd: '/work/pedsidian' } };
		expect(defaultNameFor(context, state)).toBe('pedsidian');
		expect(effectiveName(context, state)).toBe('pedsidian');

		state = { ...state, values: { ...state.values, cwd: '/work/maestro' } };
		expect(effectiveName(context, state)).toBe('maestro 2');
	});

	it('lets a typed name win over the default', () => {
		const context = createContext();
		let state = initialFormState(context);
		state = { ...state, values: { ...state.values, cwd: '/work/x', name: 'Mine' } };
		expect(effectiveName(context, state)).toBe('Mine');
	});

	it('shows the default dim in an empty Name box', () => {
		const context = createContext();
		let state = initialFormState(context);
		state = { ...state, values: { ...state.values, cwd: '/work/pedsidian' } };
		const name = formFields(context, state).find((f) => f.id === 'name')!;
		expect(fieldValueText(context, state, name)).toEqual({ text: 'pedsidian', placeholder: true });
	});

	it('rejects a duplicate of another agent but not of the agent being edited', () => {
		const create = createContext();
		let state = initialFormState(create);
		state = { ...state, values: { ...state.values, name: 'maestro', cwd: '/p' } };
		expect(validateForm(create, state, noDisk).map((p) => p.field)).toContain('name');

		const edit = editContext();
		const same = initialFormState(edit);
		expect(validateForm(edit, same, noDisk)).toEqual([]);
	});
});

describe('fields and choices', () => {
	it('puts the Advanced fields after the basics, in the order the spec lists them', () => {
		const context = createContext();
		const fields = formFields(context, initialFormState(context));
		expect(fields.filter((f) => !f.advanced).map((f) => f.id)).toEqual([
			'name',
			'provider',
			'cwd',
			'group',
			'model',
			'effort',
		]);
		expect(fields.filter((f) => f.advanced).map((f) => f.id)).toEqual([
			'ssh',
			'customPath',
			'customArgs',
			'env',
			'autoRunFolder',
			'nudge',
			'newSession',
		]);
	});

	it('types the model when the host reports none, and picks it when it reports some', () => {
		const state = initialFormState(createContext());
		const kind = (context: FormContext) =>
			formFields(context, state).find((f) => f.id === 'model')?.kind;
		expect(kind(createContext())).toBe('text');
		expect(kind(createContext({ models: ['gpt-5', 'gpt-5-mini'] }))).toBe('choice');
		expect(choiceOptions(createContext({ models: ['gpt-5'] }), state, 'model')).toEqual([
			{ value: '', label: 'default' },
			{ value: 'gpt-5', label: 'gpt-5' },
		]);
	});

	it('offers a provider effort ladder only when its definition lists one', () => {
		const context = createContext({ providers: [{ ...PROVIDERS[0], available: true }] });
		const state = initialFormState(context);
		expect(state.values.provider).toBe('claude-code');
		const options = choiceOptions(context, state, 'effort');
		expect(options?.[0]).toEqual({ value: '', label: 'default' });
		expect(options?.map((o) => o.value)).toContain('high');

		const unknown = { values: { ...state.values, provider: 'no-such-provider' } };
		expect(choiceOptions(context, unknown, 'effort')).toBeUndefined();
	});

	it('lists groups with their emoji and an ungrouped choice, and SSH remotes with a local choice', () => {
		const context = createContext();
		const state = initialFormState(context);
		expect(choiceOptions(context, state, 'group')).toEqual([
			{ value: '', label: '(none)' },
			{ value: 'g-core', label: '🎼 Core' },
			{ value: 'g-web', label: 'Web' },
		]);
		expect(choiceOptions(context, state, 'ssh')?.map((o) => o.value)).toEqual(['', 'r1', 'r2']);
	});

	it('reads the group choices from the Agents pane sections', () => {
		expect(
			groupsFromSections([
				{
					key: 'bookmarks',
					kind: 'bookmarks',
					title: 'Bookmarks',
					collapsedByDefault: false,
					nodes: [],
				},
				{
					key: 'group:g1',
					kind: 'group',
					title: 'Core',
					emoji: '🎼',
					groupId: 'g1',
					collapsedByDefault: false,
					nodes: [],
				},
				{
					key: 'ungrouped',
					kind: 'ungrouped',
					title: 'Ungrouped',
					collapsedByDefault: false,
					nodes: [],
				},
			])
		).toEqual([{ id: 'g1', name: 'Core', emoji: '🎼' }]);
	});

	it('steps a choice with wraparound, and resets model and effort when the provider changes', () => {
		const context = createContext({ models: ['m1'] });
		let state = initialFormState(context);
		state = { ...state, values: { ...state.values, model: 'm1', effort: 'high' } };
		state = focusOn(context, state, 'provider');
		state = cycleChoice(context, state, 1);
		expect(state.values.provider).toBe('opencode');
		expect(state.values.model).toBe('');
		expect(state.values.effort).toBe('');
		state = cycleChoice(context, state, 1);
		expect(state.values.provider).toBe('codex');
		state = cycleChoice(context, state, -1);
		expect(state.values.provider).toBe('opencode');
	});

	it('leaves a text field alone when asked to step it', () => {
		const context = createContext();
		const state = focusOn(context, initialFormState(context), 'cwd');
		expect(cycleChoice(context, state, 1)).toBe(state);
	});
});

describe('typing and focus', () => {
	it('types into and deletes from the focused text field only', () => {
		const context = createContext();
		let state = typed(context, initialFormState(context), 'Mae', 'stro');
		expect(state.values.name).toBe('Maestro');
		state = backspace(context, state);
		expect(state.values.name).toBe('Maestr');

		// A choice field takes no typing.
		state = focusOn(context, state, 'group');
		expect(typeText(context, state, 'zzz')).toBe(state);
		expect(backspace(context, state)).toBe(state);
	});

	it('walks the fields and ends on the save button without wrapping', () => {
		const context = createContext();
		let state = initialFormState(context);
		expect(state.focus).toBe('name');
		state = moveFocus(context, state, -1);
		expect(state.focus).toBe('name');
		for (let i = 0; i < 40; i++) state = moveFocus(context, state, 1);
		expect(state.focus).toBe('submit');
	});

	it('moves on with Enter, and Enter on the button asks to save', () => {
		const context = createContext();
		const first = pressEnter(context, initialFormState(context));
		expect(first.state.focus).toBe('provider');
		expect(first.submit).toBe(false);
		const button = pressEnter(context, focusOn(context, initialFormState(context), 'submit'));
		expect(button.submit).toBe(true);
	});

	it('clears an error as soon as the person types', () => {
		const context = createContext();
		const state = { ...initialFormState(context), error: 'boom' };
		expect(typeText(context, state, 'a').error).toBeUndefined();
	});

	it('takes the top path completion on Directory only', () => {
		const context = createContext();
		let state = typed(context, focusOn(context, initialFormState(context), 'cwd'), '/wo');
		state = acceptCompletion(state, ['/work/', '/workbench/']);
		expect(state.values.cwd).toBe('/work/');
		const name = initialFormState(context);
		expect(acceptCompletion(name, ['/work/'])).toBe(name);
		expect(acceptCompletion(state, []).values.cwd).toBe('/work/');
	});
});

describe('environment variables (AG-3)', () => {
	const onEnv = () => {
		const context = createContext();
		return { context, state: focusOn(context, initialFormState(context), 'env') };
	};

	it('parses KEY=value and refuses the rest', () => {
		expect(parseEnvEntry('FOO=bar')).toEqual({ entry: { key: 'FOO', value: 'bar' } });
		expect(parseEnvEntry('FOO=a=b')).toEqual({ entry: { key: 'FOO', value: 'a=b' } });
		expect(parseEnvEntry('FOO')).toEqual({ error: 'Type the variable as KEY=value.' });
		expect(parseEnvEntry('=x')).toEqual({ error: 'The variable needs a name before the =.' });
		expect(parseEnvEntry('1BAD=x')).toEqual({ error: '"1BAD" is not a valid variable name.' });
		expect(parseEnvEntry('has space=x')).toEqual({
			error: '"has space" is not a valid variable name.',
		});
	});

	it('adds a row on Enter, replaces a row with the same key, and removes the last on an empty Backspace', () => {
		const { context, state: start } = onEnv();
		let state = typed(context, start, 'A=1');
		state = pressEnter(context, state).state;
		expect(state.env).toEqual([{ key: 'A', value: '1' }]);
		expect(state.envDraft).toBe('');
		expect(state.focus).toBe('env');

		state = pressEnter(context, typed(context, state, 'A=2')).state;
		state = pressEnter(context, typed(context, state, 'B=3')).state;
		expect(state.env).toEqual([
			{ key: 'A', value: '2' },
			{ key: 'B', value: '3' },
		]);

		state = backspace(context, state);
		expect(state.env).toEqual([{ key: 'A', value: '2' }]);
	});

	it('keeps a bad draft and says why instead of dropping it', () => {
		const { context, state: start } = onEnv();
		const state = commitEnvDraft(typed(context, start, 'NOEQUALS'));
		expect(state.envDraft).toBe('NOEQUALS');
		expect(state.error).toBe('Type the variable as KEY=value.');
		expect(validateForm(context, state, noDisk).find((p) => p.field === 'env')).toBeDefined();
	});

	it('treats a blank value as unset: shown, listed as not sent, never submitted', () => {
		const { context, state: start } = onEnv();
		let state = start;
		for (const entry of ['KEEP=yes', 'GONE=', 'SPACES=   ']) {
			state = pressEnter(context, typed(context, state, entry)).state;
		}
		expect(state.env.map((row) => row.key)).toEqual(['KEEP', 'GONE', 'SPACES']);
		expect(unsetEnvKeys(state)).toEqual(['GONE', 'SPACES']);
		expect(effectiveEnv(state)).toEqual({ KEEP: 'yes' });

		const ready = { ...state, values: { ...state.values, cwd: '/p' } };
		expect(buildCreateInput(context, ready).env).toEqual({ KEEP: 'yes' });
		const none = { ...ready, env: [{ key: 'ONLY', value: '' }] };
		expect(buildCreateInput(context, none).env).toBeUndefined();
	});

	it('counts a draft that was typed but not yet added', () => {
		const { context, state } = onEnv();
		expect(effectiveEnv(typed(context, state, 'LATE=1'))).toEqual({ LATE: '1' });
	});

	it('masks a secret-looking value and prints the rest plainly', () => {
		const context = editContext();
		const state = initialFormState(context);
		const field = formFields(context, state).find((f) => f.id === 'env')!;
		const text = fieldValueText(context, state, field).text;
		expect(text).toContain('FOO=bar');
		expect(text).toContain('TOKEN=••••••••1234');
		expect(text).not.toContain('secret-value');
		const blank = { ...state, env: [{ key: 'EMPTY', value: '' }] };
		expect(fieldValueText(context, blank, field).text).toBe('EMPTY (unset)');
	});
});

describe('validation', () => {
	it('needs a working directory and a name', () => {
		const context = createContext();
		const problems = validateForm(context, initialFormState(context), noDisk);
		expect(problems.map((p) => p.field)).toEqual(['name', 'cwd']);
	});

	it('refuses a local directory unusableCwdReason rejects, with its reason', () => {
		const context = createContext();
		const state = {
			...initialFormState(context),
			values: { ...initialFormState(context).values, cwd: '/nope', name: 'N' },
		};
		const problems = validateForm(context, state, {
			unusableCwd: (cwd) => `Working directory does not exist: ${cwd}`,
		});
		expect(problems).toEqual([
			{ field: 'cwd', message: 'Working directory does not exist: /nope' },
		]);
	});

	it('does not check a remote path against the local disk', () => {
		const context = createContext();
		const base = initialFormState(context);
		const state = {
			...base,
			values: { ...base.values, cwd: '/remote/only', name: 'N', ssh: 'r2' },
		};
		expect(validateForm(context, state, { unusableCwd: () => 'would fail locally' })).toEqual([]);
	});

	it('checks the real disk by default', () => {
		const context = createContext();
		const base = initialFormState(context);
		const state = {
			...base,
			values: { ...base.values, cwd: '/definitely/not/a/real/dir-xyz', name: 'N' },
		};
		expect(validateForm(context, state).find((p) => p.field === 'cwd')?.message).toMatch(
			/does not exist/
		);
	});
});

describe('creating (AG-2, AG-3)', () => {
	it('builds the exact agents.create input', () => {
		const context = createContext({ models: ['gpt-5'] });
		let state = initialFormState(context);
		state = {
			...state,
			values: {
				...state.values,
				cwd: ' /work/pedsidian ',
				group: 'g-core',
				model: 'gpt-5',
				effort: '',
				ssh: 'r2',
				customPath: '/opt/codex',
				customArgs: '--flag',
				autoRunFolder: '/work/pedsidian/docs',
				nudge: 'be brief',
				newSession: 'hello',
			},
			env: [{ key: 'FOO', value: 'bar' }],
		};
		expect(buildCreateInput(context, state)).toEqual({
			name: 'pedsidian',
			provider: 'codex',
			cwd: '/work/pedsidian',
			groupId: 'g-core',
			model: 'gpt-5',
			effort: undefined,
			customPath: '/opt/codex',
			customArgs: '--flag',
			env: { FOO: 'bar' },
			ssh: { enabled: true, remoteId: 'r2' },
			autoRunFolderPath: '/work/pedsidian/docs',
			nudgeMessage: 'be brief',
			newSessionMessage: 'hello',
		});
	});

	it('leaves every optional field out when it is blank', () => {
		const context = createContext();
		const base = initialFormState(context);
		const input = buildCreateInput(context, {
			...base,
			values: { ...base.values, cwd: '/work/x' },
		});
		expect(input).toEqual({
			name: 'x',
			provider: 'codex',
			cwd: '/work/x',
			groupId: undefined,
			model: undefined,
			effort: undefined,
			customPath: undefined,
			customArgs: undefined,
			env: undefined,
			ssh: undefined,
			autoRunFolderPath: undefined,
			nudgeMessage: undefined,
			newSessionMessage: undefined,
		});
	});

	it('submits through client.agents.create and nothing else', async () => {
		const fake = createFakeClient();
		const context = createContext();
		const base = initialFormState(context);
		const state = { ...base, values: { ...base.values, cwd: '/work/x' } };
		const result = await submitAgentForm(fake.client, context, state, noDisk);
		expect(result).toEqual({ ok: true, value: { agentId: 'new-agent-1' } });
		expect(fake.requests).toEqual([
			{ method: 'agents.create', args: [buildCreateInput(context, state)] },
		]);
	});

	it('returns an invalid result, and calls nothing, when the form does not validate', async () => {
		const fake = createFakeClient();
		const context = createContext();
		const result = await submitAgentForm(fake.client, context, initialFormState(context), noDisk);
		expect(result).toEqual({
			ok: false,
			error: { code: 'invalid', message: 'The agent needs a name.', method: 'agents.create' },
		});
		expect(fake.requests).toEqual([]);
	});

	it("passes the host's refusal back as a result", async () => {
		const fake = createFakeClient({ failures: { 'agents.create': 'rejected' } });
		const context = createContext();
		const base = initialFormState(context);
		const result = await submitAgentForm(
			fake.client,
			context,
			{ ...base, values: { ...base.values, cwd: '/work/x' } },
			noDisk
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.code).toBe('rejected');
	});
});

describe('editing (AG-4)', () => {
	it('opens on the agent as the host holds it', () => {
		const state = initialFormState(editContext());
		expect(state.values).toMatchObject({
			name: 'Maestro',
			provider: 'claude-code',
			cwd: '/work/maestro',
			group: 'g-core',
			model: 'sonnet',
			ssh: 'r1',
			nudge: 'be brief',
			autoRunFolder: '/work/maestro/.maestro/playbooks',
		});
		expect(state.env).toEqual([
			{ key: 'FOO', value: 'bar' },
			{ key: 'TOKEN', value: 'secret-value-1234' },
		]);
	});

	it('sends an empty patch for an untouched form, and makes no call', async () => {
		const context = editContext();
		const state = initialFormState(context);
		expect(buildPatch(context, state)).toEqual({});
		const fake = createFakeClient({ agents: [EXISTING] });
		const result = await submitAgentForm(fake.client, context, state, noDisk);
		expect(result).toEqual({ ok: true, value: { agentId: 'a1' } });
		expect(fake.requests).toEqual([]);
	});

	it('sends only what changed', () => {
		const context = editContext();
		let state = initialFormState(context);
		state = {
			...state,
			values: { ...state.values, name: 'Renamed', nudge: 'be terse', cwd: '/work/maestro/' },
		};
		// A trailing separator is not a move.
		expect(buildPatch(context, state)).toEqual({ name: 'Renamed', nudgeMessage: 'be terse' });
	});

	it('clears a field with null so it inherits again', () => {
		const context = editContext();
		const base = initialFormState(context);
		const state = {
			...base,
			values: { ...base.values, model: '', nudge: '', group: '', ssh: '' },
			env: [],
		};
		expect(buildPatch(context, state)).toEqual({
			groupId: null,
			model: null,
			nudgeMessage: null,
			ssh: { enabled: false, remoteId: null },
			env: null,
		});
	});

	it('replaces the whole env map when a row changes, and ignores blank rows', () => {
		const context = editContext();
		const base = initialFormState(context);
		const changed = {
			...base,
			env: [
				{ key: 'FOO', value: 'baz' },
				{ key: 'DROP', value: '' },
			],
		};
		expect(buildPatch(context, changed)).toEqual({ env: { FOO: 'baz' } });

		// Adding only a blank row changes nothing the host would see.
		const blankOnly = { ...base, env: [...base.env, { key: 'UNSET_ME', value: '' }] };
		expect(buildPatch(context, blankOnly)).toEqual({});
	});

	it('moves the agent to another remote and to a new group', () => {
		const context = editContext();
		const base = initialFormState(context);
		const state = { ...base, values: { ...base.values, ssh: 'r2', group: 'g-web' } };
		expect(buildPatch(context, state)).toEqual({
			groupId: 'g-web',
			ssh: { enabled: true, remoteId: 'r2' },
		});
	});

	it('cannot clear the Auto Run folder, so a blank box leaves it', () => {
		const context = editContext();
		const base = initialFormState(context);
		expect(buildPatch(context, { ...base, values: { ...base.values, autoRunFolder: '' } })).toEqual(
			{}
		);
		expect(
			buildPatch(context, { ...base, values: { ...base.values, autoRunFolder: '/elsewhere' } })
		).toEqual({ autoRunFolderPath: '/elsewhere' });
	});

	it('shows the provider but does not let it change', () => {
		const context = editContext();
		const state = focusOn(context, initialFormState(context), 'provider');
		const field = formFields(context, state).find((f) => f.id === 'provider')!;
		expect(field.kind).toBe('readonly');
		expect(fieldValueText(context, state, field).text).toBe('Claude Code');
		expect(cycleChoice(context, state, 1)).toBe(state);
	});

	it('submits through client.agents.update with the exact patch', async () => {
		const fake = createFakeClient({ agents: [EXISTING] });
		const context = editContext();
		const base = initialFormState(context);
		const state = { ...base, values: { ...base.values, name: 'Renamed', cwd: '/work/other' } };
		const result = await submitAgentForm(fake.client, context, state, noDisk);
		expect(result).toEqual({ ok: true, value: { agentId: 'a1' } });
		expect(fake.requests).toEqual([
			{ method: 'agents.update', args: ['a1', { name: 'Renamed', cwd: '/work/other' }] },
		]);
	});
});

describe('moving the working directory is blocked while the agent is working', () => {
	const busy = { ...EXISTING, state: 'busy' as const };

	it('names the reason and refuses to edit the field', () => {
		const context = editContext(busy);
		expect(cwdChangeBlocker(context)).toBe('Stop the agent before changing its working directory.');
		const state = focusOn(context, initialFormState(context), 'cwd');
		const field = formFields(context, state).find((f) => f.id === 'cwd')!;
		expect(field.kind).toBe('readonly');
		expect(field.note).toBe('Stop the agent before changing its working directory.');
		expect(typeText(context, state, 'x')).toBe(state);
	});

	it('also blocks an agent with a live process', () => {
		expect(cwdChangeBlocker(editContext({ ...EXISTING, aiPid: 4242 }))).not.toBeNull();
		expect(cwdChangeBlocker(editContext({ ...EXISTING, state: 'connecting' }))).not.toBeNull();
		expect(cwdChangeBlocker(editContext())).toBeNull();
		expect(cwdChangeBlocker(createContext())).toBeNull();
	});

	it('refuses the submit when the agent became busy after the directory was typed', () => {
		const base = initialFormState(editContext());
		const state = { ...base, values: { ...base.values, cwd: '/work/other' } };
		const problems = validateForm(editContext(busy), state, noDisk);
		expect(problems).toEqual([
			{ field: 'cwd', message: 'Stop the agent before changing its working directory.' },
		]);
	});

	it('still lets every other field save while the directory is locked', () => {
		const context = editContext(busy);
		const base = initialFormState(context);
		const state = { ...base, values: { ...base.values, name: 'Renamed' } };
		expect(validateForm(context, state, noDisk)).toEqual([]);
		expect(buildPatch(context, state)).toEqual({ name: 'Renamed' });
	});
});
