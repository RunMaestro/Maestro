/**
 * Tests for RunOnField - the one control for where an agent's model runs, and
 * the lines under it that say what the launch will do with the choice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunOnField, describeRunOnStatus } from '../../../../renderer/components/shared/RunOnField';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { LocalModelEndpoint } from '../../../../shared/local-models/endpoints';
import { GPT_OSS_20B_ID, QWEN3_1_7B_ID } from '../../../../shared/local-models/model-catalog';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../../shared/local-models/model-server';
import {
	RUN_ON_MIN_CONTEXT_TOKENS,
	type RunOnSourceTarget,
	type RunOnTarget,
	type RunOnTestResult,
} from '../../../../shared/local-models/run-on';
import { RUN_ON_UNTESTED_WARNING } from '../../../../shared/local-models/run-on-picker';
import { mockTheme } from '../../../helpers/mockTheme';

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

const QWEN: RunOnSourceTarget = {
	type: 'source',
	endpointId: OLLAMA.id,
	model: 'qwen3:latest',
	contextTokens: 65_536,
};

const onServer = (model: string): RunOnSourceTarget => ({
	type: 'source',
	endpointId: MODEL_SERVER_ENDPOINT_ID,
	model,
	contextTokens: RUN_ON_MIN_CONTEXT_TOKENS,
});

let savedEndpoints: LocalModelEndpoint[];

/** The Maestro model server lists `serverModels`; every saved source lists `qwen3:latest`. */
function listSources(serverModels: string[] = [GPT_OSS_20B_ID, QWEN3_1_7B_ID]) {
	vi.mocked(window.maestro.localModels.endpoints.listModels).mockImplementation(async (endpoint) =>
		typeof endpoint === 'string'
			? { ok: true, models: serverModels.map((id) => ({ id })) }
			: { ok: true, models: [{ id: 'qwen3:latest' }] }
	);
}

function renderField(props: Partial<React.ComponentProps<typeof RunOnField>> = {}) {
	const onChange = vi.fn();
	const view = render(
		<RunOnField
			theme={mockTheme}
			toolType="claude-code"
			value={{ type: 'provider' }}
			onChange={onChange}
			{...props}
		/>
	);
	return { onChange, ...view };
}

const picker = () => screen.getByTestId('run-on-field-select') as HTMLSelectElement;
const status = () => screen.queryByTestId('run-on-field-status');
const optionLabels = () => Array.from(picker().options).map((option) => option.textContent);
const sourcesListed = () =>
	waitFor(() => expect(picker().querySelectorAll('optgroup').length).toBeGreaterThan(0));

beforeEach(() => {
	savedEndpoints = useSettingsStore.getState().localModelEndpoints;
	useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
	vi.mocked(window.maestro.localModels.endpoints.listModels).mockClear();
	vi.mocked(window.maestro.localModels.server.start).mockClear();
	listSources();
});

afterEach(() => {
	useSettingsStore.setState({ localModelEndpoints: savedEndpoints });
	vi.mocked(window.maestro.localModels.endpoints.listModels).mockResolvedValue({
		ok: true,
		models: [],
	});
});

describe('RunOnField: the picker', () => {
	it('lists Provider first, then each source with what it serves', async () => {
		renderField();
		await sourcesListed();

		expect(optionLabels()).toEqual([
			'Provider (default)',
			'gpt-oss 20B (MXFP4) (Fits, Agent-ready)',
			'Qwen3 1.7B Instruct (Q4_K_M) (Fits)',
			'qwen3:latest',
		]);
		expect(Array.from(picker().querySelectorAll('optgroup')).map((group) => group.label)).toEqual([
			'Maestro model server',
			'Ollama',
		]);
		expect(picker().value).toBe('provider');
	});

	it('asks the Maestro model server what it serves without starting it', async () => {
		renderField();
		await sourcesListed();

		expect(window.maestro.localModels.endpoints.listModels).toHaveBeenCalledWith(
			MODEL_SERVER_ENDPOINT_ID
		);
		expect(window.maestro.localModels.server.start).not.toHaveBeenCalled();
	});

	it('does not ask a disabled source', async () => {
		useSettingsStore.setState({ localModelEndpoints: [{ ...OLLAMA, enabled: false }] });
		renderField();
		await sourcesListed();

		expect(optionLabels()).not.toContain('qwen3:latest');
		// The one call is the Maestro model server's, which answers from disk.
		expect(vi.mocked(window.maestro.localModels.endpoints.listModels).mock.calls).toEqual([
			[MODEL_SERVER_ENDPOINT_ID],
		]);
	});

	it('hands up a picked model at the context the Library runs it at', async () => {
		const { onChange } = renderField();
		await sourcesListed();

		fireEvent.change(picker(), {
			target: { value: `${MODEL_SERVER_ENDPOINT_ID}:${GPT_OSS_20B_ID}` },
		});

		expect(onChange).toHaveBeenCalledWith(onServer(GPT_OSS_20B_ID));
	});

	it('hands up Provider with no context', async () => {
		const { onChange } = renderField({ value: QWEN });
		await sourcesListed();

		fireEvent.change(picker(), { target: { value: 'provider' } });

		expect(onChange).toHaveBeenCalledWith({ type: 'provider' });
	});

	it('keeps a current target no source lists, with the reason', async () => {
		renderField({ value: { type: 'source', endpointId: 'ep-gone', model: 'm' } });
		await sourcesListed();

		expect(picker().value).toBe('ep-gone:m');
		expect(optionLabels()).toContain('m (source removed)');
		// And the launch refusal is shown before a turn meets it.
		expect(status()).toHaveTextContent('is no longer configured');
		expect(status()).toHaveAttribute('data-tone', 'error');
	});

	it('says why a source lists nothing', async () => {
		vi.mocked(window.maestro.localModels.endpoints.listModels).mockImplementation(
			async (endpoint) =>
				typeof endpoint === 'string'
					? { ok: false, error: { kind: 'invalid', message: 'The engine is not downloaded.' } }
					: { ok: true, models: [{ id: 'qwen3:latest' }] }
		);
		renderField();

		expect(await screen.findByTestId('run-on-field-source-problem')).toHaveTextContent(
			'Maestro model server: The engine is not downloaded.'
		);
	});

	it('is disabled for a provider with no recipe, with the reason', async () => {
		renderField({ toolType: 'gemini-cli' });

		expect(picker()).toBeDisabled();
		expect(status()).toHaveTextContent('speaks only the Gemini API');
		expect(status()).toHaveAttribute('data-tone', 'dim');
	});

	it('shows a save error from the host over its own status', async () => {
		renderField({ value: QWEN, error: 'A Run on target names a model.' });

		expect(status()).toHaveTextContent('A Run on target names a model.');
		expect(status()).toHaveAttribute('data-tone', 'error');
	});
});

describe('RunOnField: what it says about a chosen model', () => {
	it('warns about a model that has not passed the agent qualification', async () => {
		renderField({ value: QWEN });

		expect(screen.getByTestId('run-on-field-untested')).toHaveTextContent(RUN_ON_UNTESTED_WARNING);
	});

	it('does not warn about a model that qualified with this harness', async () => {
		renderField({ value: onServer(GPT_OSS_20B_ID) });

		expect(screen.queryByTestId('run-on-field-untested')).not.toBeInTheDocument();
	});

	it('warns when the model qualified with another harness only', async () => {
		// gpt-oss 20B has no qualification run with OpenCode.
		renderField({ toolType: 'opencode', value: onServer(GPT_OSS_20B_ID) });

		expect(screen.getByTestId('run-on-field-untested')).toBeInTheDocument();
	});

	it('says when a model does not fit this computer', async () => {
		vi.mocked(window.maestro.localModels.hardware).mockResolvedValueOnce({
			platform: 'darwin',
			arch: 'arm64',
			totalMemoryBytes: 8 * 1024 ** 3,
			unifiedMemory: true,
			gpus: [],
		});
		renderField({ value: onServer(GPT_OSS_20B_ID) });

		expect(await screen.findByTestId('run-on-field-fit')).toHaveTextContent('Too large');
	});

	it('flags a loopback source for an agent on an SSH remote', async () => {
		renderField({ value: QWEN, sshRemoteName: 'Build box' });

		expect(status()).toHaveTextContent('SSH remote "Build box" cannot reach');
		expect(status()).toHaveAttribute('data-tone', 'warning');
	});

	it('names a recipe variable the agent sets itself, because it wins', async () => {
		renderField({
			value: QWEN,
			userEnvVars: { ANTHROPIC_BASE_URL: 'https://mine.example.com' },
		});

		expect(status()).toHaveTextContent(
			"Not applied in full: ANTHROPIC_BASE_URL is set in this agent's environment variables"
		);
	});

	it('says which Provider tab setting a source takes out of force', async () => {
		renderField({ value: QWEN });
		expect(screen.getByText(/runs as claude --print/)).toBeInTheDocument();
	});

	it('shows nothing about a model while the target is Provider', async () => {
		renderField();

		expect(status()).toBeNull();
		expect(screen.queryByTestId('run-on-field-context')).not.toBeInTheDocument();
		expect(screen.queryByTestId('run-on-field-test')).not.toBeInTheDocument();
	});
});

describe('RunOnField: the context size', () => {
	const contextInput = () =>
		screen.getByTestId('run-on-field-context').querySelector('input') as HTMLInputElement;

	it('shows the size the target holds', () => {
		renderField({ value: QWEN });

		expect(contextInput().value).toBe('65536');
	});

	it('hands up a whole number as it is typed', () => {
		const { onChange } = renderField({ value: QWEN });

		fireEvent.change(contextInput(), { target: { value: '131072' } });

		expect(onChange).toHaveBeenCalledWith({ ...QWEN, contextTokens: 131_072 });
	});

	it('says so under the field when the size is under the agent minimum', () => {
		renderField({ value: { ...QWEN, contextTokens: 8192 } });

		expect(screen.getByTestId('run-on-field-context')).toHaveTextContent(
			`at least ${RUN_ON_MIN_CONTEXT_TOKENS} tokens`
		);
	});

	it('does not hand up text that is not a number, and puts the stored size back on blur', () => {
		const { onChange } = renderField({ value: QWEN });

		fireEvent.change(contextInput(), { target: { value: 'lots' } });
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByTestId('run-on-field-context')).toHaveTextContent('whole number');

		fireEvent.blur(contextInput());
		expect(contextInput().value).toBe('65536');
	});
});

describe('RunOnField: Test', () => {
	const PASSED: RunOnTestResult = {
		ok: true,
		model: 'qwen3:latest',
		label: 'qwen3:latest on Ollama',
		reply: 'ready',
		durationMs: 12_340,
		contextTokens: 65_536,
	};
	const button = () => screen.getByTestId('run-on-field-test') as HTMLButtonElement;

	it('draws no button when the host cannot run a test', () => {
		renderField({ value: QWEN });

		expect(screen.queryByTestId('run-on-field-test')).not.toBeInTheDocument();
	});

	it('runs one turn on the target shown and shows the reply', async () => {
		const onTest = vi.fn(async () => PASSED);
		renderField({ value: QWEN, onTest });

		fireEvent.click(button());
		expect(button()).toBeDisabled();
		expect(button()).toHaveTextContent('Testing...');

		const result = await screen.findByTestId('run-on-field-test-result');
		expect(onTest).toHaveBeenCalledWith(QWEN);
		expect(result).toHaveAttribute('data-ok', 'true');
		expect(result).toHaveTextContent('qwen3:latest on Ollama answered in 12.3 s: ready');
		expect(button()).not.toBeDisabled();
	});

	it('shows the reason a test failed', async () => {
		const onTest = vi.fn(
			async (): Promise<RunOnTestResult> => ({
				ok: false,
				code: 'run-on-test-turn-failed',
				message:
					'Claude Code did not complete a turn on qwen3:latest on Ollama: Prompt is too long.',
			})
		);
		renderField({ value: QWEN, onTest });

		fireEvent.click(button());

		const result = await screen.findByTestId('run-on-field-test-result');
		expect(result).toHaveAttribute('data-ok', 'false');
		expect(result).toHaveTextContent('Prompt is too long');
	});

	it('shows a call that was rejected as a failed test, not a crash', async () => {
		const onTest = vi.fn(async () => {
			throw new Error("Error invoking remote method 'localModels:runOn:test': Error: boom");
		});
		renderField({ value: QWEN, onTest });

		fireEvent.click(button());

		expect(await screen.findByTestId('run-on-field-test-result')).toHaveTextContent('boom');
	});

	it('drops the verdict when the target changes: it described another one', async () => {
		const onTest = vi.fn(async () => PASSED);
		const { rerender, onChange } = renderField({ value: QWEN, onTest });
		fireEvent.click(button());
		await screen.findByTestId('run-on-field-test-result');

		const next: RunOnTarget = { ...QWEN, contextTokens: 131_072 };
		await act(async () => {
			rerender(
				<RunOnField
					theme={mockTheme}
					toolType="claude-code"
					value={next}
					onChange={onChange}
					onTest={onTest}
				/>
			);
		});

		expect(screen.queryByTestId('run-on-field-test-result')).not.toBeInTheDocument();
	});

	it('is disabled with the reason the host gives', () => {
		const onTest = vi.fn(async () => PASSED);
		renderField({ value: QWEN, onTest, testBlockedReason: 'Choose a working directory first.' });

		expect(button()).toBeDisabled();
		expect(screen.getByText('Choose a working directory first.')).toBeInTheDocument();
	});

	it('is disabled while the context size cannot be stored', () => {
		const onTest = vi.fn(async () => PASSED);
		renderField({ value: { ...QWEN, contextTokens: 8192 }, onTest });

		expect(button()).toBeDisabled();
	});
});

describe('describeRunOnStatus', () => {
	it('says nothing for a launch on the provider or a clean launch on a source', () => {
		expect(describeRunOnStatus({ kind: 'none' })).toBeNull();
		expect(
			describeRunOnStatus({
				kind: 'inject',
				envVars: {},
				args: [],
				subcommandArgs: [],
				model: 'm',
				harnessModel: 'm',
				envVarMerges: {},
				contextTokens: 40_960,
				userOverrides: [],
				clearedEnvVars: [],
			})
		).toBeNull();
	});

	it('words several variables the agent sets itself as one sentence', () => {
		const line = describeRunOnStatus({
			kind: 'inject',
			envVars: {},
			args: [],
			subcommandArgs: [],
			model: 'm',
			harnessModel: 'm',
			envVarMerges: {},
			contextTokens: 40_960,
			userOverrides: ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'],
			clearedEnvVars: [],
		});

		expect(line?.tone).toBe('warning');
		expect(line?.text).toContain('ANTHROPIC_BASE_URL, CLAUDE_CODE_MAX_CONTEXT_TOKENS are set');
	});

	it('treats a refusal as an error, and the SSH loopback case as a warning', () => {
		expect(
			describeRunOnStatus({ kind: 'refused', code: 'run-on-source-disabled', message: 'Off.' })
		).toEqual({ tone: 'error', text: 'Off.' });
		expect(
			describeRunOnStatus({ kind: 'refused', code: 'run-on-loopback-on-remote', message: 'No.' })
		).toEqual({ tone: 'warning', text: 'No.' });
	});
});
