/**
 * Tests for BackgroundRequestsField - the picker for where the Maestro token
 * proxy sends an agent's side requests: Off, or a model on a source that
 * serves the Anthropic Messages route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { BackgroundRequestsField } from '../../../../renderer/components/shared/BackgroundRequestsField';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	BACKGROUND_REQUESTS_DESCRIPTION,
	BACKGROUND_REQUESTS_OFF_LABEL,
} from '../../../../shared/local-models/background-requests';
import type { LocalModelEndpoint } from '../../../../shared/local-models/endpoints';
import { mockTheme } from '../../../helpers/mockTheme';

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};
const CLOUD: LocalModelEndpoint = {
	id: 'ep-cloud',
	name: 'OpenRouter',
	kind: 'openai-compatible',
	baseUrl: 'https://openrouter.ai/api/v1',
	enabled: true,
};
const QWEN = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:4b' };

let savedEndpoints: LocalModelEndpoint[];

function renderField(props: Partial<React.ComponentProps<typeof BackgroundRequestsField>> = {}) {
	const onChange = vi.fn();
	const view = render(
		<BackgroundRequestsField theme={mockTheme} value={undefined} onChange={onChange} {...props} />
	);
	return { onChange, ...view };
}

const picker = () => screen.getByTestId('background-requests-field-select') as HTMLSelectElement;
const optionValues = () => Array.from(picker().options).map((option) => option.value);
const listed = () =>
	waitFor(() => expect(picker().querySelectorAll('optgroup').length).toBeGreaterThan(0));

beforeEach(() => {
	savedEndpoints = useSettingsStore.getState().localModelEndpoints;
	useSettingsStore.setState({ localModelEndpoints: [OLLAMA, CLOUD] });
	// The Maestro model server lists nothing; each saved source lists one model.
	vi.mocked(window.maestro.localModels.endpoints.listModels).mockImplementation(async (endpoint) =>
		typeof endpoint === 'string'
			? { ok: true, models: [] }
			: { ok: true, models: [{ id: endpoint.id === OLLAMA.id ? 'qwen3:4b' : 'some/model' }] }
	);
});

afterEach(() => {
	useSettingsStore.setState({ localModelEndpoints: savedEndpoints });
	vi.mocked(window.maestro.localModels.endpoints.listModels).mockResolvedValue({
		ok: true,
		models: [],
	});
});

describe('BackgroundRequestsField', () => {
	it('reads Off for an agent with no target, and says what is routed', async () => {
		renderField();
		await listed();

		expect(picker().value).toBe('none');
		expect(picker().selectedOptions[0].textContent).toBe(BACKGROUND_REQUESTS_OFF_LABEL);
		expect(screen.getByTestId('background-requests-field').textContent).toContain(
			BACKGROUND_REQUESTS_DESCRIPTION
		);
	});

	it('offers only the sources a background request can be sent to', async () => {
		renderField();
		await listed();

		// OpenRouter is a base URL and nothing else: Maestro cannot tell that it
		// serves /v1/messages, so choosing it would be refused.
		expect(optionValues()).toEqual(['none', 'ep-ollama:qwen3:4b']);
	});

	it('shows the stored target', async () => {
		renderField({ value: { target: QWEN } });
		await listed();

		expect(picker().value).toBe('ep-ollama:qwen3:4b');
	});

	it('hands up the target chosen, and undefined for Off', async () => {
		const { onChange } = renderField({ value: { target: QWEN } });
		await listed();

		fireEvent.change(picker(), { target: { value: 'none' } });
		expect(onChange).toHaveBeenLastCalledWith(undefined);
	});

	it('hands up a source and a model with no context size: a request states its own', async () => {
		const { onChange } = renderField();
		await listed();

		fireEvent.change(picker(), { target: { value: 'ep-ollama:qwen3:4b' } });
		expect(onChange).toHaveBeenLastCalledWith({ target: QWEN });
	});

	it('is disabled with the reason while the choice must wait, and while a write runs', async () => {
		const { rerender } = renderField({ disabledReason: 'Save the provider change first.' });

		expect(picker()).toBeDisabled();
		expect(screen.getByTestId('background-requests-field-blocked').textContent).toBe(
			'Save the provider change first.'
		);

		rerender(
			<BackgroundRequestsField theme={mockTheme} value={undefined} onChange={vi.fn()} busy />
		);
		expect(picker()).toBeDisabled();
	});

	it('shows why the last choice failed', () => {
		renderField({ error: 'the source is disabled' });

		expect(screen.getByTestId('background-requests-field-error').textContent).toBe(
			'the source is disabled'
		);
	});
});
