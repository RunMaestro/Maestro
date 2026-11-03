/**
 * Tests for LocalModelsAssignmentsSection - one row per task of one system,
 * with a source picker filtered by the task's need and the main process's
 * readiness verdict inline.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import type { LocalModelListing } from '../../../../../main/local-models/service';
import type { LocalModelEndpoint } from '../../../../../shared/local-models/endpoints';
import type { LocalModelTaskReadiness } from '../../../../../shared/local-models/task-readiness';
import { LocalModelsAssignmentsSection } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/LocalModelsAssignmentsSection';
import { UtilityAgentSettings } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/UtilityAgentSettings';
import { buildAssignmentOptionGroups } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/assignmentOptions';
import { useLocalModelEndpoints, useLocalModels } from '../../../../../renderer/hooks/localModels';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import type { SystemOneEngineChoice } from '../../../../../shared/local-models/system-one-settings';
import {
	LOCAL_MODEL_TASKS,
	isLocalModelOfferedForTask,
	tasksForSystem,
	type LocalModelTaskId,
	type LocalModelAssignment,
} from '../../../../../shared/local-models/tasks';
import {
	BGE_SMALL_EN_ID,
	PARAKEET_TDT_V2_ID,
	GEMMA_4_E4B_ID,
	LOCAL_MODEL_CATALOG,
	PROMPT_GUARD_2_22M_ID,
	QWEN3_1_7B_ID,
	QWEN3_5_4B_ID,
	getLocalModel,
} from '../../../../../shared/local-models/model-catalog';

const theme = {
	colors: {
		accent: '#a78bfa',
		accentDim: '#3b2a5c',
		accentForeground: '#ffffff',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		bgActivity: '#111111',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as unknown as Theme;

const INSTALLED = new Set([QWEN3_1_7B_ID, BGE_SMALL_EN_ID]);

function listing(id: string): LocalModelListing {
	const entry = getLocalModel(id)!;
	return {
		entry,
		status: INSTALLED.has(id)
			? {
					id,
					status: 'installed',
					manifest: { installedAt: Date.now(), verifiedAt: Date.now() } as never,
					bytesOnDisk: entry.bytes,
				}
			: { id, status: 'not-installed', manifest: null, bytesOnDisk: 0 },
		installPaths: [],
	};
}

/** A catalog listing that reads as installed, whatever the shared set says. */
const installed = (id: string): LocalModelListing => {
	const entry = getLocalModel(id)!;
	return {
		entry,
		status: {
			id,
			status: 'installed',
			manifest: { installedAt: 1, verifiedAt: 1 } as never,
			bytesOnDisk: entry.bytes,
		},
		installPaths: [],
	};
};

const ollama: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

const qwenName = getLocalModel(QWEN3_1_7B_ID)!.displayName;
const bgeName = getLocalModel(BGE_SMALL_EN_ID)!.displayName;

const api = () => window.maestro.localModels as unknown as Record<string, ReturnType<typeof vi.fn>>;
const endpointsApi = () =>
	window.maestro.localModels.endpoints as unknown as Record<string, ReturnType<typeof vi.fn>>;

/**
 * The section takes the tab's hook state; this stands in for the tab. It mounts
 * both systems so a test can reach any task's row.
 */
function Section() {
	const models = useLocalModels();
	const endpoints = useLocalModelEndpoints();
	return (
		<>
			<UtilityAgentSettings theme={theme} models={models} endpoints={endpoints} />
			<LocalModelsAssignmentsSection
				theme={theme}
				system="one"
				models={models}
				endpoints={endpoints}
			/>
			<LocalModelsAssignmentsSection
				theme={theme}
				system="two"
				models={models}
				endpoints={endpoints}
			/>
		</>
	);
}

function optionLabels(taskLabel: string): string[] {
	const select = screen.getByLabelText(taskLabel);
	return within(select)
		.getAllByRole('option')
		.map((option) => option.textContent ?? '');
}

describe('LocalModelsAssignmentsSection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([]);
		api().list.mockResolvedValue(LOCAL_MODEL_CATALOG.map((entry) => listing(entry.id)));
		api().footprint.mockResolvedValue({ bytes: 0, models: [] });
		api().onProgress.mockReturnValue(() => {});
		api().taskReadiness.mockResolvedValue([]);
		endpointsApi().listModels.mockResolvedValue({
			ok: true,
			models: [{ id: 'llama3.2:latest' }],
		});
		useSettingsStore.setState({
			localModelAssignments: {},
			localModelEndpoints: [ollama],
			utilityAgentId: null,
			utilityModelId: null,
			utilitySource: { type: 'utility-agent' },
		});
	});

	it('offers providers, installed text models and endpoints as the shared utility source', async () => {
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			{ id: 'codex', name: 'Codex', available: true },
		] as never);
		render(<Section />);
		await waitFor(() => expect(optionLabels('Source')).toContain(qwenName));
		await waitFor(() => expect(optionLabels('Source')).toContain('llama3.2:latest'));
		await waitFor(() => expect(optionLabels('Source')).toContain('Codex'));
		expect(optionLabels('Source')).not.toContain(bgeName);
		expect(optionLabels('Source')).not.toContain('Off');

		fireEvent.change(screen.getByLabelText('Source'), {
			target: { value: `local:${QWEN3_1_7B_ID}` },
		});
		expect(useSettingsStore.getState().utilitySource).toEqual({
			type: 'local',
			modelId: QWEN3_1_7B_ID,
		});
		expect(window.maestro.settings.set).toHaveBeenCalledWith('utilitySource', {
			type: 'local',
			modelId: QWEN3_1_7B_ID,
		});
		expect(screen.getByLabelText('Tab naming')).toHaveValue('utility-agent');
		expect(
			within(screen.getByTestId('local-models-task-ai-command')).getByText(/kills a process/)
		).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText('Source'), {
			target: { value: 'endpoint:ep-ollama:llama3.2:latest' },
		});
		expect(useSettingsStore.getState().utilitySource).toEqual({
			type: 'endpoint',
			endpointId: 'ep-ollama',
			model: 'llama3.2:latest',
		});
		fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'provider:codex' } });
		expect(useSettingsStore.getState().utilitySource).toEqual({ type: 'utility-agent' });
		expect(useSettingsStore.getState().utilityAgentId).toBe('codex');
		expect(screen.getByLabelText('Model override')).toBeInTheDocument();
	});

	it('keeps a missing shared model selected and rechecks inherited task readiness on changes', async () => {
		useSettingsStore.setState({ utilitySource: { type: 'local', modelId: 'removed-model' } });
		render(<Section />);
		expect(screen.getByLabelText('Source')).toHaveValue('local:removed-model');
		expect(optionLabels('Source').some((label) => label.includes('removed-model'))).toBe(true);
		const calls = api().taskReadiness.mock.calls.length;
		fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'utility-agent' } });
		await waitFor(() => expect(api().taskReadiness.mock.calls.length).toBeGreaterThan(calls));
	});

	it('offers each task only sources of the kind it needs', async () => {
		render(<Section />);
		await waitFor(() => expect(optionLabels('Tab naming')).toContain(qwenName));
		await waitFor(() => expect(optionLabels('Tab naming')).toContain('llama3.2:latest'));

		// Text generation: Utility Agent, the installed text model, the endpoint model.
		const tabNaming = optionLabels('Tab naming');
		expect(tabNaming).toEqual(expect.arrayContaining(['Off', 'Utility source']));
		expect(tabNaming).not.toContain(bgeName);

		// Embeddings: no Utility Agent path, only the embedding model.
		const semantic = optionLabels('Semantic search');
		expect(semantic).toContain(bgeName);
		expect(semantic).not.toContain(qwenName);
		expect(semantic).not.toContain('Utility source');

		// Classifiers: no installed classifier and no endpoint can serve one.
		expect(optionLabels('Prompt-injection screen')).toEqual(['Off']);
	});

	it('persists the Dictation language in the existing assignment and preserves it on remount', async () => {
		useSettingsStore.setState({
			localModelAssignments: {
				dictation: { type: 'local', modelId: 'whisper-base', language: 'en' },
			},
		});
		const view = render(<Section />);
		const row = screen.getByTestId('local-models-task-dictation');
		fireEvent.click(within(row).getByRole('button', { name: 'Deutsch' }));
		expect(useSettingsStore.getState().localModelAssignments.dictation).toEqual({
			type: 'local',
			modelId: 'whisper-base',
			language: 'de',
		});
		expect(window.maestro.settings.set).toHaveBeenCalledWith('localModelAssignments', {
			dictation: { type: 'local', modelId: 'whisper-base', language: 'de' },
		});
		view.unmount();
		render(<Section />);
		expect(screen.getByLabelText('Dictation')).toHaveValue('local:whisper-base?language=de');
		expect(
			within(screen.getByTestId('local-models-task-dictation')).getByRole('button', {
				name: 'Deutsch',
			})
		).toBeEnabled();
	});

	it('preserves German when switching installed Dictation models', async () => {
		api().list.mockResolvedValue(['whisper-base', 'whisper-small'].map(installed));
		useSettingsStore.setState({
			localModelAssignments: {
				dictation: { type: 'local', modelId: 'whisper-base', language: 'de' },
			},
		});
		render(<Section />);
		const select = screen.getByLabelText('Dictation');
		const small = await within(select).findByRole('option', {
			name: getLocalModel('whisper-small')!.displayName,
		});
		fireEvent.change(select, { target: { value: (small as HTMLOptionElement).value } });
		expect(useSettingsStore.getState().localModelAssignments.dictation).toEqual({
			type: 'local',
			modelId: 'whisper-small',
			language: 'de',
		});
		expect(window.maestro.settings.set).toHaveBeenCalledWith('localModelAssignments', {
			dictation: { type: 'local', modelId: 'whisper-small', language: 'de' },
		});
	});

	it('saves a pick through the shared assignment writer', async () => {
		render(<Section />);
		await waitFor(() => expect(optionLabels('Semantic search')).toContain(bgeName));

		fireEvent.change(screen.getByLabelText('Semantic search'), {
			target: { value: `local:${BGE_SMALL_EN_ID}` },
		});
		expect(useSettingsStore.getState().localModelAssignments).toEqual({
			'semantic-search': { type: 'local', modelId: BGE_SMALL_EN_ID },
		});

		// Choosing the default again drops the entry, keeping the record sparse.
		fireEvent.change(screen.getByLabelText('Semantic search'), { target: { value: 'off' } });
		expect(useSettingsStore.getState().localModelAssignments).toEqual({});
	});

	it('shows readiness inline, with a download button for a missing model', async () => {
		const guardName = getLocalModel(PROMPT_GUARD_2_22M_ID)!.displayName;
		useSettingsStore.setState({
			localModelAssignments: {
				'injection-screen': { type: 'local', modelId: PROMPT_GUARD_2_22M_ID },
			},
		});
		const verdicts: LocalModelTaskReadiness[] = [
			{
				taskId: 'tab-naming',
				label: 'Tab naming',
				needs: 'text-gen',
				assignment: { type: 'local', modelId: QWEN3_1_7B_ID },
				state: 'ready',
				detail: `Runs ${qwenName} on this machine.`,
			},
			{
				taskId: 'injection-screen',
				label: 'Prompt-injection screen',
				needs: 'classifier',
				assignment: { type: 'local', modelId: PROMPT_GUARD_2_22M_ID },
				state: 'unavailable',
				reason: 'model-not-installed',
				detail: `${guardName} is not downloaded.`,
				suggestedAction: 'Download it in Settings -> Local Models.',
			},
		];
		api().taskReadiness.mockResolvedValue(verdicts);
		render(<Section />);

		const ready = await within(screen.getByTestId('local-models-task-tab-naming')).findByText(
			'Ready'
		);
		expect(ready).toBeInTheDocument();

		const row = screen.getByTestId('local-models-task-injection-screen');
		expect(await within(row).findByText(`${guardName} is not downloaded.`)).toBeInTheDocument();
		// The current, not-installed pick stays visible in the picker.
		expect(optionLabels('Prompt-injection screen')).toContain(`${guardName} (not installed)`);

		fireEvent.click(within(row).getByRole('button', { name: `Download ${guardName}` }));
		expect(api().download).toHaveBeenCalledWith(PROMPT_GUARD_2_22M_ID);
		// Nothing downloads without that click.
		expect(api().download).toHaveBeenCalledTimes(1);
	});

	it('lists one row per task of its system, and only those', () => {
		const models = { listings: [], progress: {} } as never;
		const endpoints = { endpoints: [], models: {} } as never;
		render(
			<LocalModelsAssignmentsSection
				theme={theme}
				system="two"
				models={models}
				endpoints={endpoints}
			/>
		);
		const rows = screen
			.getAllByTestId(/^local-models-task-(?!readiness|recovery)/)
			.map((row) => row.getAttribute('data-testid'));
		expect(rows).toEqual(tasksForSystem('two').map((task) => `local-models-task-${task.id}`));
		// The semantic index card belongs to System One's Semantic search row.
		expect(screen.queryByTestId('semantic-index-settings')).toBeNull();
	});
});

describe('buildAssignmentOptionGroups', () => {
	const sources = {
		listings: LOCAL_MODEL_CATALOG.map((entry) => listing(entry.id)),
		endpoints: [ollama, { ...ollama, id: 'ep-off', name: 'Off server', enabled: false }],
		endpointModels: {
			'ep-ollama': { ok: true as const, models: [{ id: 'qwen3:latest' }] },
			'ep-off': { ok: true as const, models: [{ id: 'hidden' }] },
		},
	};

	it.each([
		[
			{ type: 'local', modelId: 'whisper-base', language: 'de' },
			'whisper-small',
			'local:whisper-small?language=de',
		],
		[
			{ type: 'local', modelId: 'whisper-base', language: 'en' },
			'whisper-small',
			'local:whisper-small?language=en',
		],
		[
			{ type: 'local', modelId: 'whisper-base', language: 'de' },
			PARAKEET_TDT_V2_ID,
			`local:${PARAKEET_TDT_V2_ID}`,
		],
		[
			{ type: 'local', modelId: 'whisper-base', language: 'en' },
			PARAKEET_TDT_V2_ID,
			`local:${PARAKEET_TDT_V2_ID}?language=en`,
		],
		[{ type: 'local', modelId: 'whisper-base' }, 'whisper-small', 'local:whisper-small'],
		[{ type: 'off' }, 'whisper-small', 'local:whisper-small'],
	] satisfies [LocalModelAssignment, string, string][])(
		'carries only a supported explicit language from %j to %s',
		(current, target, expected) => {
			const groups = buildAssignmentOptionGroups(LOCAL_MODEL_TASKS.dictation, current, {
				listings: ['whisper-base', 'whisper-small', PARAKEET_TDT_V2_ID].map(installed),
				endpoints: [],
				endpointModels: {},
			});
			expect(
				groups
					.flatMap((group) => group.options)
					.find((option) => option.label === getLocalModel(target)!.displayName)?.value
			).toBe(expected);
		}
	);

	it('groups local models and each enabled endpoint, skipping disabled ones', () => {
		const groups = buildAssignmentOptionGroups(
			LOCAL_MODEL_TASKS['tab-naming'],
			{ type: 'utility-agent' },
			sources
		);
		expect(groups.map((group) => group.label)).toEqual([null, 'Local models', 'Ollama']);
		expect(groups[2].options).toEqual([
			{ value: 'endpoint:ep-ollama:qwen3:latest', label: 'qwen3:latest' },
		]);
	});

	describe('the fail policy column', () => {
		const rows = [
			{ taskId: 'cue-gate', label: 'Cue gate', policy: 'open', defaultPolicy: 'open' },
			{
				taskId: 'injection-screen',
				label: 'Prompt-injection screen',
				policy: 'closed',
				defaultPolicy: 'closed',
			},
		] as const;

		function SystemOne({
			onChange = vi.fn(),
			disabled = false,
			policies = rows,
		}: {
			onChange?: (taskId: string, policy: string) => void;
			disabled?: boolean;
			policies?: typeof rows | readonly [];
		}) {
			const models = useLocalModels();
			const endpoints = useLocalModelEndpoints();
			return (
				<LocalModelsAssignmentsSection
					theme={theme}
					system="one"
					models={models}
					endpoints={endpoints}
					failPolicies={{ rows: policies, disabled, onChange }}
				/>
			);
		}

		const policySelect = (taskId: string) =>
			screen.queryByTestId(`local-models-task-fail-policy-${taskId}`) as HTMLSelectElement | null;

		it('shows a policy only for a task that gates something, with its default marked', () => {
			render(<SystemOne />);
			expect(screen.getByTestId('local-models-assignments-columns')).toHaveTextContent(
				'If no answer'
			);
			expect(policySelect('cue-gate')!.value).toBe('open');
			expect(policySelect('injection-screen')!.value).toBe('closed');
			expect(
				within(policySelect('cue-gate')!)
					.getAllByRole('option')
					.map((option) => option.textContent)
			).toEqual(['Fail open (default)', 'Fail closed']);
			for (const task of tasksForSystem('one')) {
				if (task.failPolicy === undefined) expect(policySelect(task.id)).toBeNull();
			}
		});

		it('sends the task and the policy picked', () => {
			const onChange = vi.fn();
			render(<SystemOne onChange={onChange} />);
			fireEvent.change(policySelect('cue-gate')!, { target: { value: 'closed' } });
			expect(onChange).toHaveBeenCalledWith('cue-gate', 'closed');
		});

		it('keeps the column and shows no value until the report arrives', () => {
			render(<SystemOne policies={[]} />);
			expect(screen.getByTestId('local-models-assignments-columns')).toBeInTheDocument();
			expect(policySelect('cue-gate')).toBeNull();
		});

		it('disables the picker while a change is being stored', () => {
			render(<SystemOne disabled />);
			expect(policySelect('cue-gate')).toBeDisabled();
		});

		it('is absent where no task has a fail policy', () => {
			render(<Section />);
			expect(screen.queryByTestId('local-models-assignments-columns')).toBeNull();
			expect(policySelect('cue-gate')).toBeNull();
		});
	});

	it('does not offer a model the task records as measured-unfit', () => {
		const qwen = `local:${QWEN3_1_7B_ID}`;
		const values = (taskId: 'tab-naming' | 'voice-routing') =>
			buildAssignmentOptionGroups(LOCAL_MODEL_TASKS[taskId], { type: 'off' }, sources).flatMap(
				(group) => group.options.map((option) => option.value)
			);
		// The same installed text model: offered to name tabs, not to route voice.
		expect(values('tab-naming')).toContain(qwen);
		expect(values('voice-routing')).not.toContain(qwen);
	});

	it('shows an unfit model that is already assigned, and says it is not recommended', () => {
		const groups = buildAssignmentOptionGroups(
			LOCAL_MODEL_TASKS['voice-routing'],
			{ type: 'local', modelId: QWEN3_1_7B_ID },
			sources
		);
		expect(groups[0].options).toContainEqual({
			value: `local:${QWEN3_1_7B_ID}`,
			label: `${getLocalModel(QWEN3_1_7B_ID)!.displayName} (not recommended)`,
		});
		expect(groups.find((group) => group.label === 'Local models')).toBeUndefined();
	});

	it('keeps a current assignment no option covers, named by why', () => {
		const groups = buildAssignmentOptionGroups(
			LOCAL_MODEL_TASKS['tab-naming'],
			{ type: 'endpoint', endpointId: 'gone', model: 'mistral' },
			sources
		);
		expect(groups[0].options).toContainEqual({
			value: 'endpoint:gone:mistral',
			label: 'mistral (endpoint removed)',
		});
	});

	describe('System One as a source', () => {
		const SYSTEM_ONE = { type: 'system-one' } as const;
		/** The ungrouped head of a task's picker: Off, the Utility Agent, System One. */
		const head = (
			taskId: LocalModelTaskId,
			engine?: SystemOneEngineChoice,
			current: { type: 'off' } | { type: 'system-one' } = { type: 'off' }
		) =>
			buildAssignmentOptionGroups(LOCAL_MODEL_TASKS[taskId], current, {
				...sources,
				...(engine ? { systemOneEngine: engine } : {}),
			})[0].options;

		it('is offered to a task with typed questions, labeled with the engine in force', () => {
			expect(head('cue-gate', 'jev-cloud')).toEqual([
				{ value: 'off', label: 'Off' },
				{ value: 'system-one', label: 'System One (Jev)' },
			]);
			expect(head('cue-gate', 'openjev')).toContainEqual({
				value: 'system-one',
				label: 'System One (OpenJev)',
			});
			expect(head('cue-gate', 'local-judge')).toContainEqual({
				value: 'system-one',
				label: 'System One (local judge)',
			});
		});

		it('is not offered while no engine is chosen, or before the engine is known', () => {
			expect(head('cue-gate', 'off')).toEqual([{ value: 'off', label: 'Off' }]);
			expect(head('cue-gate')).toEqual([{ value: 'off', label: 'Off' }]);
		});

		it('is offered to exactly the tasks that declare typed questions', () => {
			const accepting = [
				'tab-cleanup',
				'cue-gate',
				'injection-screen',
				'secret-screen',
				'voice-routing',
				'model-routing',
			];
			for (const task of Object.values(LOCAL_MODEL_TASKS)) {
				// Every group: a local-first task lists System One last, not in the head.
				const offered = buildAssignmentOptionGroups(
					task,
					{ type: 'off' },
					{ ...sources, systemOneEngine: 'jev-cloud' }
				).flatMap((group) => group.options.map((option) => option.value));
				if (accepting.includes(task.id)) expect(offered).toContain('system-one');
				else expect(offered).not.toContain('system-one');
			}
		});

		it('keeps a task left on it after the engine was switched off, and says no engine is chosen', () => {
			expect(head('cue-gate', 'off', SYSTEM_ONE)).toEqual([
				{ value: 'off', label: 'Off' },
				{ value: 'system-one', label: 'System One (no engine chosen)' },
			]);
			// With an engine it is an ordinary option, listed once.
			expect(
				head('cue-gate', 'jev-cloud', SYSTEM_ONE).filter((option) => option.value === 'system-one')
			).toHaveLength(1);
		});
	});
});

describe('the model routing picker (a local-first task)', () => {
	const ROUTING = LOCAL_MODEL_TASKS['model-routing'];
	const name = (id: string) => getLocalModel(id)!.displayName;

	const sources = {
		// Listed largest first, so the order below is the picker's and not the input's.
		listings: [GEMMA_4_E4B_ID, QWEN3_5_4B_ID, QWEN3_1_7B_ID, BGE_SMALL_EN_ID].map(installed),
		endpoints: [ollama],
		endpointModels: { 'ep-ollama': { ok: true as const, models: [{ id: 'qwen3:latest' }] } },
	};
	const groups = (engine?: SystemOneEngineChoice) =>
		buildAssignmentOptionGroups(
			ROUTING,
			{ type: 'off' },
			{
				...sources,
				...(engine ? { systemOneEngine: engine } : {}),
			}
		);

	it('lists local models first, endpoints next and System One last', () => {
		expect(groups('jev-cloud').map((group) => group.label)).toEqual([
			null,
			'Local models',
			'Ollama',
			'System One',
		]);
		expect(groups('jev-cloud')[0].options).toEqual([{ value: 'off', label: 'Off' }]);
	});

	it('puts the embedding model first, then the judge model, then the rest', () => {
		// Qwen3.5 4B carries the judge role; Gemma 4 E4B does not.
		expect(getLocalModel(QWEN3_5_4B_ID)!.roles).toContain('judge');
		expect(getLocalModel(GEMMA_4_E4B_ID)!.roles).not.toContain('judge');
		expect(groups()[1].options.map((option) => option.value)).toEqual([
			`local:${BGE_SMALL_EN_ID}`,
			`local:${QWEN3_5_4B_ID}`,
			`local:${GEMMA_4_E4B_ID}`,
		]);
	});

	it('does not offer Qwen3 1.7B, the judge that rated every request as the most model', () => {
		// Installed, a text model, and a judge by role: the picker would list it
		// first among the judges. The task records what the routing eval measured.
		expect(getLocalModel(QWEN3_1_7B_ID)!.roles).toContain('judge');
		expect(isLocalModelOfferedForTask('model-routing', QWEN3_1_7B_ID)).toBe(false);
		expect(groups()[1].options.map((option) => option.value)).not.toContain(
			`local:${QWEN3_1_7B_ID}`
		);
	});

	it('says of every source which router it is and whether it is calibrated', () => {
		const [, local, endpoint, systemOne] = groups('jev-cloud');
		expect(local.options[0].label).toBe(
			`${name(BGE_SMALL_EN_ID)} (embedding router, not calibrated)`
		);
		expect(local.options[1].label).toBe(`${name(QWEN3_5_4B_ID)} (local judge, not calibrated)`);
		expect(endpoint.options).toEqual([
			{
				value: 'endpoint:ep-ollama:qwen3:latest',
				label: 'qwen3:latest (local judge, not calibrated)',
			},
		]);
		expect(systemOne.options).toEqual([
			{ value: 'system-one', label: 'System One (Jev), calibrated' },
		]);
		expect(groups('openjev')[3].options[0].label).toBe('System One (OpenJev), calibrated');
		expect(groups('local-judge')[3].options[0].label).toBe(
			'System One (local judge), not calibrated'
		);
	});

	it('offers System One only while an engine is chosen', () => {
		expect(groups('off').map((group) => group.label)).toEqual([null, 'Local models', 'Ollama']);
		expect(groups().map((group) => group.label)).toEqual([null, 'Local models', 'Ollama']);
	});

	it('offers no classifier, speech or voice model', () => {
		const offered = buildAssignmentOptionGroups(
			ROUTING,
			{ type: 'off' },
			{
				listings: LOCAL_MODEL_CATALOG.map((entry) => installed(entry.id)),
				endpoints: [],
				endpointModels: {},
			}
		)[1].options.map((option) => getLocalModel(option.value.slice('local:'.length))!.kind);
		expect(new Set(offered)).toEqual(new Set(['embedding', 'text-gen']));
	});

	it("leaves every other task's labels and order as they were", () => {
		const cueGate = buildAssignmentOptionGroups(
			LOCAL_MODEL_TASKS['cue-gate'],
			{ type: 'off' },
			{ ...sources, systemOneEngine: 'jev-cloud' }
		);
		expect(cueGate[0].options).toEqual([
			{ value: 'off', label: 'Off' },
			{ value: 'system-one', label: 'System One (Jev)' },
		]);
		// Input order, no note.
		expect(cueGate[1].options[0]).toEqual({
			value: `local:${GEMMA_4_E4B_ID}`,
			label: name(GEMMA_4_E4B_ID),
		});
	});
});

describe('LocalModelsAssignmentsSection and System One', () => {
	function SystemOneSection({
		engine,
		problem = null,
	}: {
		engine?: SystemOneEngineChoice;
		problem?: string | null;
	}) {
		const models = useLocalModels();
		const endpoints = useLocalModelEndpoints();
		return (
			<LocalModelsAssignmentsSection
				theme={theme}
				system="one"
				models={models}
				endpoints={endpoints}
				systemOneEngine={engine ? { engine, problem } : undefined}
			/>
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		api().list.mockResolvedValue(LOCAL_MODEL_CATALOG.map((entry) => listing(entry.id)));
		api().footprint.mockResolvedValue({ bytes: 0, models: [] });
		api().onProgress.mockReturnValue(() => {});
		api().taskReadiness.mockResolvedValue([]);
		endpointsApi().listModels.mockResolvedValue({ ok: true, models: [] });
		useSettingsStore.setState({
			localModelAssignments: {},
			localModelEndpoints: [],
			utilityAgentId: null,
			utilityModelId: null,
		});
	});

	it('offers the engine in force for the Cue gate and saves the pick', async () => {
		render(<SystemOneSection engine="local-judge" />);
		expect(optionLabels('Cue gate')).toContain('System One (local judge)');
		expect(optionLabels('Semantic search')).not.toContain('System One (local judge)');

		fireEvent.change(screen.getByLabelText('Cue gate'), { target: { value: 'system-one' } });

		expect(useSettingsStore.getState().localModelAssignments).toEqual({
			'cue-gate': { type: 'system-one' },
		});
		await waitFor(() =>
			expect((screen.getByLabelText('Cue gate') as HTMLSelectElement).value).toBe('system-one')
		);
	});

	it('asks readiness again when the engine, or what is wrong with it, changes', async () => {
		const asked = () => api().taskReadiness.mock.calls.length;
		const { rerender } = render(<SystemOneSection engine="jev-cloud" problem="No API key." />);
		// The model listing loads after the mount and asks once more; wait it out.
		await waitFor(() => expect(optionLabels('Semantic search')).toContain(bgeName));
		await new Promise((resolve) => setTimeout(resolve, 20));
		const base = asked();

		rerender(<SystemOneSection engine="jev-cloud" problem={null} />);
		await waitFor(() => expect(asked()).toBe(base + 1));

		rerender(<SystemOneSection engine="local-judge" problem={null} />);
		await waitFor(() => expect(asked()).toBe(base + 2));

		// The same standing asks nothing.
		rerender(<SystemOneSection engine="local-judge" problem={null} />);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(asked()).toBe(base + 2);
	});
});
