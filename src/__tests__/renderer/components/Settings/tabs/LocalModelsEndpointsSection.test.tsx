/**
 * Tests for LocalModelsEndpointsSection - the Endpoints section of the Local
 * Models tab.
 *
 * Verifies that mounting never probes for servers, that "Detect local servers"
 * offers what it finds and saves only on the offer's Add click, that the add
 * form validates and saves through the settings store, that a failing Test
 * shows the server's error, and that removing an endpoint a task is assigned to
 * warns and names the task first.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import type { LocalModelEndpoint } from '../../../../../shared/local-models/endpoints';
import { LocalModelsEndpointsSection } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/LocalModelsEndpointsSection';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { useLocalModelEndpoints } from '../../../../../renderer/hooks/localModels';

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

const ollama: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

/** The section takes the tab's hook state; this stands in for the tab. */
function EndpointsSection() {
	const state = useLocalModelEndpoints();
	return <LocalModelsEndpointsSection theme={theme} state={state} />;
}

const endpointsApi = () =>
	window.maestro.localModels.endpoints as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('LocalModelsEndpointsSection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		endpointsApi().detect.mockResolvedValue([]);
		endpointsApi().listModels.mockResolvedValue({ ok: true, models: [] });
		useSettingsStore.setState({ localModelEndpoints: [], localModelAssignments: {} });
	});

	it('shows the empty state and probes nothing on mount', () => {
		render(<EndpointsSection />);
		expect(screen.getByTestId('local-models-endpoints-empty')).toBeInTheDocument();
		expect(endpointsApi().detect).not.toHaveBeenCalled();
		expect(endpointsApi().listModels).not.toHaveBeenCalled();
	});

	it('lists the models of each enabled endpoint, and leaves a disabled one alone', async () => {
		endpointsApi().listModels.mockResolvedValue({
			ok: true,
			models: [{ id: 'llama3.2:3b', sizeBytes: 2_000_000_000 }],
		});
		useSettingsStore.setState({
			localModelEndpoints: [
				ollama,
				{ ...ollama, id: 'ep-off', name: 'Off', baseUrl: 'http://127.0.0.1:1234', enabled: false },
			],
		});
		render(<EndpointsSection />);
		expect(await screen.findByText('llama3.2:3b')).toBeInTheDocument();
		expect(endpointsApi().listModels).toHaveBeenCalledTimes(1);
		expect(endpointsApi().listModels).toHaveBeenCalledWith(ollama);
		expect(screen.getByText('Disabled. Maestro does not call it.')).toBeInTheDocument();
	});

	it('detects on click and adds an offer only when its Add is clicked', async () => {
		endpointsApi().detect.mockResolvedValue([
			{
				kind: 'ollama',
				name: 'Ollama',
				baseUrl: 'http://127.0.0.1:11434',
				models: [{ id: 'qwen3:1.7b' }],
			},
		]);
		render(<EndpointsSection />);

		fireEvent.click(screen.getByTestId('local-models-detect-endpoints'));
		expect(await screen.findByTestId('local-models-detected-ollama')).toHaveTextContent('1 model');
		expect(useSettingsStore.getState().localModelEndpoints).toEqual([]);

		fireEvent.click(screen.getByTestId('local-models-detected-add-ollama'));
		const saved = useSettingsStore.getState().localModelEndpoints;
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			name: 'Ollama',
			kind: 'ollama',
			baseUrl: 'http://127.0.0.1:11434',
			enabled: true,
		});
		expect(window.maestro.settings.set).toHaveBeenCalledWith('localModelEndpoints', saved);
		// The offer's models seed the row, so the new endpoint is not listed again.
		expect(await screen.findByText('qwen3:1.7b')).toBeInTheDocument();
		expect(endpointsApi().listModels).not.toHaveBeenCalled();
		expect(screen.queryByTestId('local-models-detected-ollama')).not.toBeInTheDocument();
	});

	it('says so when detection finds nothing new', async () => {
		render(<EndpointsSection />);
		fireEvent.click(screen.getByTestId('local-models-detect-endpoints'));
		expect(await screen.findByTestId('local-models-detect-none')).toBeInTheDocument();
	});

	it('adds an endpoint from the form, refusing an invalid URL first', async () => {
		render(<EndpointsSection />);
		fireEvent.click(screen.getByTestId('local-models-add-endpoint'));

		const url = screen.getByTestId('local-model-endpoint-url').querySelector('input')!;
		fireEvent.change(url, { target: { value: 'ftp://nope' } });
		fireEvent.click(screen.getByTestId('local-model-endpoint-save'));
		expect(screen.getByText(/Only http and https URLs are supported/)).toBeInTheDocument();
		expect(useSettingsStore.getState().localModelEndpoints).toEqual([]);

		fireEvent.change(url, { target: { value: 'http://127.0.0.1:11434/' } });
		fireEvent.click(screen.getByTestId('local-model-endpoint-save'));
		await waitFor(() => expect(useSettingsStore.getState().localModelEndpoints).toHaveLength(1));
		expect(useSettingsStore.getState().localModelEndpoints[0]).toMatchObject({
			name: 'Ollama',
			kind: 'ollama',
			baseUrl: 'http://127.0.0.1:11434',
			enabled: true,
		});
		expect(screen.queryByTestId('local-model-endpoint-form')).not.toBeInTheDocument();
	});

	it('shows the error when a Test fails', async () => {
		endpointsApi().test.mockResolvedValue({
			ok: false,
			error: { kind: 'network', message: 'Ollama is not running at http://127.0.0.1:11434.' },
		});
		useSettingsStore.setState({ localModelEndpoints: [ollama] });
		render(<EndpointsSection />);

		fireEvent.click(screen.getByTestId(`local-model-endpoint-test-${ollama.id}`));
		expect(
			await screen.findByTestId(`local-model-endpoint-verdict-${ollama.id}`)
		).toHaveTextContent('Ollama is not running at http://127.0.0.1:11434.');
		expect(endpointsApi().test).toHaveBeenCalledWith(ollama);
	});

	it('shows latency when a Test passes', async () => {
		endpointsApi().test.mockResolvedValue({ ok: true, model: 'llama3.2:3b', latencyMs: 412.4 });
		useSettingsStore.setState({ localModelEndpoints: [ollama] });
		render(<EndpointsSection />);

		fireEvent.click(screen.getByTestId(`local-model-endpoint-test-${ollama.id}`));
		expect(
			await screen.findByTestId(`local-model-endpoint-verdict-${ollama.id}`)
		).toHaveTextContent('llama3.2:3b answered in 412 ms');
	});

	it('warns and names the tasks before removing an endpoint in use', async () => {
		useSettingsStore.setState({
			localModelEndpoints: [ollama],
			localModelAssignments: {
				'tab-naming': { type: 'endpoint', endpointId: ollama.id, model: 'llama3.2:3b' },
			},
		});
		render(<EndpointsSection />);

		fireEvent.click(screen.getByTestId(`local-model-endpoint-remove-${ollama.id}`));
		const warning = await screen.findByTestId('local-model-endpoint-remove-warning');
		expect(warning).toHaveTextContent('Ollama is assigned to Tab naming');
		expect(useSettingsStore.getState().localModelEndpoints).toEqual([ollama]);

		fireEvent.click(screen.getByText('Remove anyway'));
		expect(useSettingsStore.getState().localModelEndpoints).toEqual([]);
	});

	it('removes an unused endpoint at once', () => {
		useSettingsStore.setState({ localModelEndpoints: [ollama] });
		render(<EndpointsSection />);
		fireEvent.click(screen.getByTestId(`local-model-endpoint-remove-${ollama.id}`));
		expect(useSettingsStore.getState().localModelEndpoints).toEqual([]);
	});
});
