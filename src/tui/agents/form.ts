/**
 * The create and edit agent form (AG-2, AG-3, AG-4), as pure state.
 *
 * The overlay (`AgentForm.tsx`) draws a `FormState` and the key handler calls the
 * reducers here, so every rule is testable without a terminal: which fields
 * exist, what a choice offers, what makes the form invalid, and the exact
 * `agents.create` input or `agents.update` patch a submit sends. Nothing in this
 * file talks to the desktop except `submitAgentForm`, and that goes through the
 * `MaestroClient` interface.
 *
 * One value store keeps it small: every field is a string in `values`, and a
 * choice field's string is the option's value (`''` is "inherit / none"). The
 * environment variables are the one exception, a list of rows.
 */

import {
	AGENT_AUTOSELECT_ORDER,
	completeDirectoryPath,
	getAgentDisplayName,
	defaultAgentNameForPath,
	getAgentDefinition,
	isBlankEnvKey,
	isBlankEnvValue,
	isSameDirectory,
	isSecretEnvKey,
	maskEnvValue,
	stripBlankEnvVars,
	unusableCwdReason,
	workingDirectoryChangeBlocker,
	type AgentCreateInput,
	type AgentPatch,
	type AgentRecord,
	type AgentTreeSection,
	type ClientError,
	type ClientResult,
	type GroupRecord,
	type MaestroClient,
	type ProviderInfo,
	type SshRemoteConfig,
} from '../../shared/maestro-lib';

export type FieldId =
	| 'name'
	| 'provider'
	| 'cwd'
	| 'group'
	| 'model'
	| 'effort'
	| 'ssh'
	| 'customPath'
	| 'customArgs'
	| 'env'
	| 'autoRunFolder'
	| 'nudge'
	| 'newSession';

/** The fields that hold one string. Env is a list, so it is not one of them. */
export type ValueFieldId = Exclude<FieldId, 'env'>;

/** The row the cursor rests on: a field, or the button that saves the form. */
export type FocusId = FieldId | 'submit';

/**
 * - `text`: typed into.
 * - `choice`: Left and Right step through `choiceOptions`.
 * - `env`: a list of `KEY=value` rows.
 * - `readonly`: shown, never edited; `note` says why.
 */
export type FieldKind = 'text' | 'choice' | 'env' | 'readonly';

export interface FieldSpec {
	id: FieldId;
	label: string;
	kind: FieldKind;
	/** After the Advanced divider (AG-3). */
	advanced: boolean;
	/** Why a read-only field cannot be edited, or a hint under a text field. */
	note?: string;
}

export interface ChoiceOption {
	value: string;
	label: string;
}

export interface EnvEntry {
	key: string;
	value: string;
}

export interface FormContext {
	mode: 'create' | 'edit';
	/** The agent being edited; read fresh from the host when the form opens. */
	agent?: AgentRecord;
	/** Every agent, for the name default and the duplicate check. */
	agents: readonly AgentRecord[];
	groups: readonly GroupRecord[];
	providers: readonly ProviderInfo[];
	sshRemotes: readonly SshRemoteConfig[];
	/** Model ids the chosen provider reports. Empty means the model is typed. */
	models: readonly string[];
}

export interface FormState {
	values: Record<ValueFieldId, string>;
	env: EnvEntry[];
	/** The `KEY=value` being typed; Enter turns it into a row. */
	envDraft: string;
	focus: FocusId;
	/** The last thing that went wrong, shown under the form until the next key. */
	error?: string;
}

export interface FormProblem {
	field: FocusId;
	message: string;
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Fields and choices
// ---------------------------------------------------------------------------

export function availableProviders(context: Pick<FormContext, 'providers'>): ProviderInfo[] {
	return context.providers.filter((provider) => provider.available);
}

/** The provider a new agent starts on: the most preferred one that is installed. */
export function defaultProviderId(context: Pick<FormContext, 'providers'>): string {
	const available = availableProviders(context);
	for (const id of AGENT_AUTOSELECT_ORDER) {
		if (available.some((provider) => provider.id === id)) return id;
	}
	return available[0]?.id ?? '';
}

function agentString(agent: AgentRecord | undefined, key: string): string {
	const value = agent?.[key];
	return typeof value === 'string' ? value : '';
}

function agentEnv(agent: AgentRecord | undefined): Record<string, string> {
	const value = agent?.customEnvVars;
	if (!value || typeof value !== 'object') return {};
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === 'string') result[key] = entry;
	}
	return result;
}

/** The SSH remote an agent runs on, or `''` for the local machine. */
function agentSshRemoteId(agent: AgentRecord | undefined): string {
	const ssh = agent?.sessionSshRemoteConfig as
		| { enabled?: boolean; remoteId?: string | null }
		| undefined;
	return ssh?.enabled && typeof ssh.remoteId === 'string' ? ssh.remoteId : '';
}

/** The provider's own effort words, when its definition lists them. */
function providerEffortOptions(providerId: string): string[] {
	const option = getAgentDefinition(providerId)?.configOptions?.find(
		(candidate) => candidate.key === 'effort'
	);
	if (!option || option.type !== 'select') return [];
	return (option.options ?? []).filter((value) => value !== '');
}

export function initialFormState(context: FormContext): FormState {
	const { agent } = context;
	const edit = context.mode === 'edit' && agent;
	return {
		values: {
			name: edit ? agent.name : '',
			provider: edit ? agent.toolType : defaultProviderId(context),
			cwd: edit ? agentString(agent, 'cwd') : '',
			group: edit ? (agent.groupId ?? '') : '',
			model: edit ? agentString(agent, 'customModel') : '',
			effort: edit ? agentString(agent, 'customEffort') : '',
			ssh: edit ? agentSshRemoteId(agent) : '',
			customPath: edit ? agentString(agent, 'customPath') : '',
			customArgs: edit ? agentString(agent, 'customArgs') : '',
			autoRunFolder: edit ? agentString(agent, 'autoRunFolderPath') : '',
			nudge: edit ? agentString(agent, 'nudgeMessage') : '',
			newSession: edit ? agentString(agent, 'newSessionMessage') : '',
		},
		env: edit ? Object.entries(agentEnv(agent)).map(([key, value]) => ({ key, value })) : [],
		envDraft: '',
		focus: 'name',
	};
}

/** A context with nothing loaded yet: what a form opens on before the host has answered. */
export function emptyFormContext(mode: FormContext['mode']): FormContext {
	return { mode, agents: [], groups: [], providers: [], sshRemotes: [], models: [] };
}

/** The fields of a live record that say whether the agent is working right now. */
export function liveAgentState(agent: AgentRecord | undefined): Partial<AgentRecord> {
	return agent ? { state: agent.state, aiPid: agent.aiPid } : {};
}

/**
 * The groups a person can file an agent under, read from the Agents pane's own
 * sections so a group created a moment ago is on offer without another round trip.
 */
export function groupsFromSections(sections: readonly AgentTreeSection[]): GroupRecord[] {
	return sections
		.filter((section) => section.kind === 'group' && section.groupId !== undefined)
		.map((section) => ({
			id: section.groupId as string,
			name: section.title,
			...(section.emoji ? { emoji: section.emoji } : {}),
		}));
}

/** The reason an edit may not move the working directory right now, or null. */
export function cwdChangeBlocker(context: FormContext): string | null {
	if (context.mode !== 'edit' || !context.agent) return null;
	const { agent } = context;
	return workingDirectoryChangeBlocker({
		state: agent.state,
		aiPid: typeof agent.aiPid === 'number' ? agent.aiPid : undefined,
	});
}

/** The options a choice field offers, or undefined when the field is typed instead. */
export function choiceOptions(
	context: FormContext,
	state: Pick<FormState, 'values'>,
	id: FieldId
): ChoiceOption[] | undefined {
	switch (id) {
		case 'provider':
			return availableProviders(context).map((provider) => ({
				value: provider.id,
				label: provider.version ? `${provider.name} ${provider.version}` : provider.name,
			}));
		case 'group':
			return [
				{ value: '', label: '(none)' },
				...context.groups
					.filter((group) => group.kind !== 'worktree')
					.map((group) => ({
						value: group.id,
						label: group.emoji ? `${group.emoji} ${group.name}` : group.name,
					})),
			];
		case 'ssh':
			return [
				{ value: '', label: 'local' },
				...context.sshRemotes.map((remote) => ({
					value: remote.id,
					label: `${remote.name} (${remote.host})`,
				})),
			];
		case 'model':
			return context.models.length > 0
				? [
						{ value: '', label: 'default' },
						...context.models.map((model) => ({ value: model, label: model })),
					]
				: undefined;
		case 'effort': {
			const efforts = providerEffortOptions(state.values.provider);
			return efforts.length > 0
				? [
						{ value: '', label: 'default' },
						...efforts.map((effort) => ({ value: effort, label: effort })),
					]
				: undefined;
		}
		default:
			return undefined;
	}
}

/** The fields in the order the cursor walks them. */
export function formFields(context: FormContext, state: Pick<FormState, 'values'>): FieldSpec[] {
	const edit = context.mode === 'edit';
	const blocker = cwdChangeBlocker(context);
	const choiceKind = (id: FieldId): FieldKind =>
		choiceOptions(context, state, id) ? 'choice' : 'text';
	return [
		{ id: 'name', label: 'Name', kind: 'text', advanced: false },
		{
			id: 'provider',
			label: 'Provider',
			// Swapping providers on a live agent is a later phase (PS-1).
			kind: edit ? 'readonly' : 'choice',
			advanced: false,
			note: edit ? 'fixed once the agent exists' : undefined,
		},
		{
			id: 'cwd',
			label: 'Directory',
			kind: blocker ? 'readonly' : 'text',
			advanced: false,
			note: blocker ?? undefined,
		},
		{ id: 'group', label: 'Group', kind: 'choice', advanced: false },
		{ id: 'model', label: 'Model', kind: choiceKind('model'), advanced: false },
		{ id: 'effort', label: 'Effort', kind: choiceKind('effort'), advanced: false },
		{ id: 'ssh', label: 'SSH remote', kind: 'choice', advanced: true },
		{ id: 'customPath', label: 'Binary path', kind: 'text', advanced: true },
		{ id: 'customArgs', label: 'Extra args', kind: 'text', advanced: true },
		{ id: 'env', label: 'Environment', kind: 'env', advanced: true },
		{ id: 'autoRunFolder', label: 'Auto Run folder', kind: 'text', advanced: true },
		{ id: 'nudge', label: 'Nudge', kind: 'text', advanced: true },
		{ id: 'newSession', label: 'New session', kind: 'text', advanced: true },
	];
}

function focusOrder(context: FormContext, state: FormState): FocusId[] {
	// A read-only field is still a stop: its note explains itself when the cursor lands there.
	return [...formFields(context, state).map((field) => field.id), 'submit'];
}

function fieldSpecFor(context: FormContext, state: FormState, id: FocusId): FieldSpec | undefined {
	return formFields(context, state).find((field) => field.id === id);
}

/** The name a blank Name box stands for: the folder, kept clear of names in use. */
export function defaultNameFor(context: FormContext, state: Pick<FormState, 'values'>): string {
	if (context.mode !== 'create') return '';
	return defaultAgentNameForPath(
		state.values.cwd,
		context.agents.map((agent) => agent.name)
	);
}

/** The name the form will submit. */
export function effectiveName(context: FormContext, state: Pick<FormState, 'values'>): string {
	const typed = state.values.name.trim();
	return typed || defaultNameFor(context, state);
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

const clean = (state: FormState): FormState =>
	state.error ? { ...state, error: undefined } : state;

export function moveFocus(context: FormContext, state: FormState, delta: number): FormState {
	const order = focusOrder(context, state);
	const at = Math.max(0, order.indexOf(state.focus));
	const focus = order[Math.min(order.length - 1, Math.max(0, at + delta))];
	return focus === state.focus ? clean(state) : { ...clean(state), focus };
}

export function typeText(context: FormContext, state: FormState, text: string): FormState {
	if (!text || state.focus === 'submit') return state;
	const spec = fieldSpecFor(context, state, state.focus);
	if (!spec) return state;
	if (spec.kind === 'env') return { ...clean(state), envDraft: state.envDraft + text };
	if (spec.kind !== 'text' || spec.id === 'env') return state;
	const id = spec.id as ValueFieldId;
	return { ...clean(state), values: { ...state.values, [id]: state.values[id] + text } };
}

export function backspace(context: FormContext, state: FormState): FormState {
	if (state.focus === 'submit') return state;
	const spec = fieldSpecFor(context, state, state.focus);
	if (!spec) return state;
	if (spec.kind === 'env') {
		// An empty draft backs into the rows: the last one comes off.
		if (state.envDraft) return { ...clean(state), envDraft: state.envDraft.slice(0, -1) };
		return state.env.length > 0 ? { ...clean(state), env: state.env.slice(0, -1) } : state;
	}
	if (spec.kind !== 'text' || spec.id === 'env') return state;
	const id = spec.id as ValueFieldId;
	const current = state.values[id];
	return current
		? { ...clean(state), values: { ...state.values, [id]: current.slice(0, -1) } }
		: state;
}

/** Left and Right on a choice field: step through the options, wrapping. */
export function cycleChoice(context: FormContext, state: FormState, delta: number): FormState {
	if (state.focus === 'submit' || state.focus === 'env') return state;
	const spec = fieldSpecFor(context, state, state.focus);
	if (!spec || spec.kind !== 'choice') return state;
	const options = choiceOptions(context, state, spec.id);
	if (!options || options.length === 0) return state;
	const id = spec.id as ValueFieldId;
	const at = Math.max(
		0,
		options.findIndex((option) => option.value === state.values[id])
	);
	const next = options[(at + delta + options.length) % options.length].value;
	if (next === state.values[id]) return state;
	const values = { ...state.values, [id]: next };
	// A model and an effort word belong to one provider; a new provider starts from its defaults.
	if (id === 'provider') {
		values.model = '';
		values.effort = '';
	}
	return { ...clean(state), values };
}

/**
 * Directories that complete the typed working directory. None over SSH: the
 * path names a directory on the other machine, which this disk cannot list.
 */
export function cwdCandidates(cwd: string, remote: boolean): string[] {
	return remote ? [] : completeDirectoryPath(cwd);
}

/** Right on the Directory field takes the top completion. */
export function acceptCompletion(state: FormState, candidates: readonly string[]): FormState {
	const [first] = candidates;
	if (state.focus !== 'cwd' || !first) return state;
	return { ...clean(state), values: { ...state.values, cwd: first } };
}

export function parseEnvEntry(text: string): { entry: EnvEntry } | { error: string } {
	const equals = text.indexOf('=');
	if (equals < 0) return { error: 'Type the variable as KEY=value.' };
	const key = text.slice(0, equals).trim();
	if (isBlankEnvKey(key)) return { error: 'The variable needs a name before the =.' };
	if (!ENV_KEY_PATTERN.test(key)) return { error: `"${key}" is not a valid variable name.` };
	return { entry: { key, value: text.slice(equals + 1) } };
}

function upsertEnv(rows: readonly EnvEntry[], entry: EnvEntry): EnvEntry[] {
	return rows.some((row) => row.key === entry.key)
		? rows.map((row) => (row.key === entry.key ? entry : row))
		: [...rows, entry];
}

/** Enter on the Environment field adds the typed `KEY=value`. */
export function commitEnvDraft(state: FormState): FormState {
	if (!state.envDraft.trim()) return { ...clean(state), envDraft: '' };
	const parsed = parseEnvEntry(state.envDraft);
	if ('error' in parsed) return { ...state, error: parsed.error };
	return { ...clean(state), env: upsertEnv(state.env, parsed.entry), envDraft: '' };
}

/** Enter: save from the button, add an env row, or walk on to the next field. */
export function pressEnter(
	context: FormContext,
	state: FormState
): { state: FormState; submit: boolean } {
	if (state.focus === 'submit') return { state, submit: true };
	if (state.focus === 'env' && state.envDraft.trim()) {
		return { state: commitEnvDraft(state), submit: false };
	}
	return { state: moveFocus(context, state, 1), submit: false };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidateDeps {
	/** Why a local directory cannot be used. Injected so a test needs no disk. */
	unusableCwd?: (cwd: string) => string | null;
}

/** The env rows as the host would receive them: the draft counted, blanks and unnamed rows dropped. */
export function effectiveEnv(state: FormState): Record<string, string> {
	let rows = state.env;
	if (state.envDraft.trim()) {
		const parsed = parseEnvEntry(state.envDraft);
		if ('entry' in parsed) rows = upsertEnv(rows, parsed.entry);
	}
	return stripBlankEnvVars(Object.fromEntries(rows.map((row) => [row.key, row.value])));
}

/** Rows whose value is blank: kept on screen so the person sees them, dropped on submit. */
export function unsetEnvKeys(state: FormState): string[] {
	return state.env.filter((row) => isBlankEnvValue(row.value)).map((row) => row.key);
}

export function validateForm(
	context: FormContext,
	state: FormState,
	deps: ValidateDeps = {}
): FormProblem[] {
	const problems: FormProblem[] = [];
	const unusableCwd = deps.unusableCwd ?? unusableCwdReason;
	const name = effectiveName(context, state);

	if (!name) {
		problems.push({ field: 'name', message: 'The agent needs a name.' });
	} else {
		const taken = context.agents
			.filter((agent) => agent.id !== context.agent?.id)
			.some((agent) => agent.name.trim().toLowerCase() === name.toLowerCase());
		if (taken)
			problems.push({ field: 'name', message: `An agent named "${name}" already exists.` });
	}

	if (context.mode === 'create') {
		const provider = availableProviders(context).find((p) => p.id === state.values.provider);
		if (!provider) {
			problems.push({
				field: 'provider',
				message:
					availableProviders(context).length === 0
						? 'No installed provider was found on the host.'
						: 'Choose an installed provider.',
			});
		}
	}

	const cwd = state.values.cwd.trim();
	const onRemote = state.values.ssh !== '';
	if (!cwd) {
		problems.push({ field: 'cwd', message: 'The agent needs a working directory.' });
	} else if (context.mode === 'edit' && context.agent) {
		const moved = !isSameDirectory(cwd, agentString(context.agent, 'cwd'));
		const blocker = moved ? cwdChangeBlocker(context) : null;
		if (blocker) problems.push({ field: 'cwd', message: blocker });
		// A remote path names a directory on the other machine; this disk cannot vouch for it.
		else if (moved && !onRemote) {
			const reason = unusableCwd(cwd);
			if (reason) problems.push({ field: 'cwd', message: reason });
		}
	} else if (!onRemote) {
		const reason = unusableCwd(cwd);
		if (reason) problems.push({ field: 'cwd', message: reason });
	}

	if (state.envDraft.trim()) {
		const parsed = parseEnvEntry(state.envDraft);
		if ('error' in parsed) problems.push({ field: 'env', message: parsed.error });
	}

	return problems;
}

// ---------------------------------------------------------------------------
// What a submit sends
// ---------------------------------------------------------------------------

const orUndefined = (value: string): string | undefined => (value.trim() ? value : undefined);

function sshInput(remoteId: string): AgentCreateInput['ssh'] {
	return remoteId ? { enabled: true, remoteId } : undefined;
}

/** AG-2 and AG-3: the exact `agents.create` input for a valid form. */
export function buildCreateInput(context: FormContext, state: FormState): AgentCreateInput {
	const { values } = state;
	const env = effectiveEnv(state);
	return {
		name: effectiveName(context, state),
		provider: values.provider,
		cwd: values.cwd.trim(),
		groupId: orUndefined(values.group),
		model: orUndefined(values.model),
		effort: orUndefined(values.effort),
		customPath: orUndefined(values.customPath),
		customArgs: orUndefined(values.customArgs),
		env: Object.keys(env).length > 0 ? env : undefined,
		ssh: sshInput(values.ssh),
		autoRunFolderPath: orUndefined(values.autoRunFolder),
		nudgeMessage: orUndefined(values.nudge),
		newSessionMessage: orUndefined(values.newSession),
	};
}

/** `null` clears a field so it inherits again; a field the form left alone is not in the patch. */
function nullableChange(next: string, original: string): string | null | undefined {
	if (next.trim() === original.trim()) return undefined;
	return next.trim() ? next : null;
}

const envKey = (env: Record<string, string>): string =>
	JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));

/** AG-4: only what changed, so an untouched field is never rewritten. */
export function buildPatch(context: FormContext, state: FormState): AgentPatch {
	const { agent } = context;
	if (!agent) return {};
	const { values } = state;
	const patch: AgentPatch = {};

	const name = effectiveName(context, state);
	if (name !== agent.name.trim()) patch.name = name;

	const cwd = values.cwd.trim();
	if (cwd && !isSameDirectory(cwd, agentString(agent, 'cwd'))) patch.cwd = cwd;

	if (values.group !== (agent.groupId ?? '')) patch.groupId = values.group || null;

	for (const [field, key, value] of [
		['model', 'customModel', values.model],
		['effort', 'customEffort', values.effort],
		['customPath', 'customPath', values.customPath],
		['customArgs', 'customArgs', values.customArgs],
		['nudgeMessage', 'nudgeMessage', values.nudge],
		['newSessionMessage', 'newSessionMessage', values.newSession],
	] as const) {
		const change = nullableChange(value, agentString(agent, key));
		if (change !== undefined) patch[field] = change;
	}

	if (values.ssh !== agentSshRemoteId(agent)) {
		patch.ssh = values.ssh
			? { enabled: true, remoteId: values.ssh }
			: { enabled: false, remoteId: null };
	}

	// The host has no way to clear the folder, so a blank box means "leave it".
	const folder = values.autoRunFolder.trim();
	if (folder && folder !== agentString(agent, 'autoRunFolderPath').trim()) {
		patch.autoRunFolderPath = folder;
	}

	const env = effectiveEnv(state);
	if (envKey(env) !== envKey(stripBlankEnvVars(agentEnv(agent)))) {
		patch.env = Object.keys(env).length > 0 ? env : null;
	}

	return patch;
}

/** Validates, then creates or updates. A refusal comes back as a result, never a throw. */
export async function submitAgentForm(
	client: MaestroClient,
	context: FormContext,
	state: FormState,
	deps: ValidateDeps = {}
): Promise<ClientResult<{ agentId: string }>> {
	const method = context.mode === 'create' ? 'agents.create' : 'agents.update';
	const [problem] = validateForm(context, state, deps);
	if (problem) {
		const error: ClientError = { code: 'invalid', message: problem.message, method };
		return { ok: false, error };
	}
	if (context.mode === 'create') return client.agents.create(buildCreateInput(context, state));

	const agentId = context.agent?.id;
	if (!agentId) {
		return {
			ok: false,
			error: { code: 'not-found', message: 'The agent to edit is gone.', method },
		};
	}
	const patch = buildPatch(context, state);
	if (Object.keys(patch).length === 0) return { ok: true, value: { agentId } };
	const updated = await client.agents.update(agentId, patch);
	return updated.ok ? { ok: true, value: { agentId } } : updated;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** What a field shows to the right of its label, before the cursor. */
export function fieldValueText(
	context: FormContext,
	state: FormState,
	spec: FieldSpec
): { text: string; placeholder: boolean } {
	if (spec.id === 'env') {
		// A blank value means unset, so it reads as such; a secret-looking value stays masked.
		const rows = state.env.map((row) =>
			isBlankEnvValue(row.value)
				? `${row.key} (unset)`
				: `${row.key}=${isSecretEnvKey(row.key) ? maskEnvValue(row.value) : row.value}`
		);
		return { text: rows.join('  '), placeholder: false };
	}
	const value = state.values[spec.id];
	if (spec.kind === 'choice' || (spec.kind === 'readonly' && spec.id === 'provider')) {
		const options = choiceOptions(context, state, spec.id);
		const label = options?.find((option) => option.value === value)?.label;
		if (label !== undefined) return { text: label, placeholder: false };
		if (spec.id === 'provider' && value)
			return { text: getAgentDisplayName(value), placeholder: false };
		return { text: value || '(none)', placeholder: !value };
	}
	if (spec.id === 'name' && !value) {
		const fallback = defaultNameFor(context, state);
		return { text: fallback, placeholder: true };
	}
	return { text: value, placeholder: false };
}
