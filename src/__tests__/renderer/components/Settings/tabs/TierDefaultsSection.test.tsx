/**
 * Tests for TierDefaultsSection - the harness tier defaults table: one row per
 * installed harness, a picker per tier with the layer its value comes from,
 * and Suggest, Reset and Save, where only Save writes the setting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TierDefaultsSection } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/TierDefaultsSection';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import type { LocalModelEndpoint } from '../../../../../shared/local-models/endpoints';
import type { HarnessTierOptions } from '../../../../../shared/local-models/tier-options';
import type { HarnessTierDefaults } from '../../../../../shared/modelTiers';
import { mockTheme } from '../../../../helpers/mockTheme';

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

const CODEX: HarnessTierOptions = {
	harness: 'codex',
	name: 'Codex',
	installed: true,
	catalog: [
		{ id: 'gpt-6.1-sol', description: 'Latest workhorse model.', priority: 1 },
		{ id: 'gpt-6-astra', description: 'Frontier intelligence.', priority: 2 },
		{ id: 'gpt-7-luna', description: 'Fast and affordable model.', priority: 3 },
	],
	runOn: { supported: true },
	sources: [{ endpointId: OLLAMA.id, name: 'Ollama', models: ['qwen3:latest'] }],
	problems: [{ endpointId: 'ep-lm', name: 'LM Studio', message: 'connection refused' }],
};

const DROID: HarnessTierOptions = {
	harness: 'factory-droid',
	name: 'Factory Droid',
	installed: true,
	catalog: [{ id: 'claude-haiku-4-5-20251001' }],
	runOn: { supported: false, reason: 'No verified recipe.' },
	sources: [],
	problems: [],
};

const OPENCODE: HarnessTierOptions = {
	harness: 'opencode',
	name: 'OpenCode',
	installed: true,
	catalog: [{ id: 'anthropic/claude-opus-5-5' }, { id: 'ollama/qwen3:latest' }],
	runOn: { supported: true },
	sources: [],
	problems: [],
};

let savedDefaults: HarnessTierDefaults;

const options = () => vi.mocked(window.maestro.localModels.tiers.options);
const picker = (harness: string, tier: string) =>
	screen.getByTestId(`tier-defaults-${harness}-${tier}`) as HTMLSelectElement;
const source = (harness: string, tier: string) =>
	screen.getByTestId(`tier-defaults-${harness}-${tier}-source`).textContent;
const button = (name: string, harness: string) =>
	screen.getByTestId(`tier-defaults-${name}-${harness}`) as HTMLButtonElement;
const stored = () => useSettingsStore.getState().harnessTierDefaults;

async function renderSection(rows: HarnessTierOptions[] = [CODEX, DROID]) {
	options().mockResolvedValue(rows);
	render(<TierDefaultsSection theme={mockTheme} endpoints={[OLLAMA]} />);
	if (rows.length > 0) {
		await waitFor(() => screen.getByTestId(`tier-defaults-row-${rows[0].harness}`));
	}
}

beforeEach(() => {
	savedDefaults = useSettingsStore.getState().harnessTierDefaults;
	useSettingsStore.setState({ harnessTierDefaults: {} });
	options().mockReset();
	vi.mocked(window.maestro.settings.set).mockClear();
});

afterEach(() => {
	useSettingsStore.setState({ harnessTierDefaults: savedDefaults });
});

describe('TierDefaultsSection', () => {
	it('asks for every installed harness once and draws a row for each', async () => {
		await renderSection();

		expect(options()).toHaveBeenCalledTimes(1);
		expect(options()).toHaveBeenCalledWith({ refresh: false });
		expect(screen.getByTestId('tier-defaults-row-codex')).toBeTruthy();
		expect(screen.getByTestId('tier-defaults-row-factory-droid')).toBeTruthy();
	});

	it('shows the built-in table and names it as the source', async () => {
		await renderSection();

		expect(picker('codex', 'medium').value).toBe('default');
		expect(picker('codex', 'medium').selectedOptions[0].textContent).toBe('Built-in (gpt-6.1-sol)');
		expect(source('codex', 'medium')).toBe('Built-in');
	});

	it('names a tier no layer maps', async () => {
		await renderSection([OPENCODE]);

		expect(picker('opencode', 'low').selectedOptions[0].textContent).toBe('Built-in (not mapped)');
		expect(source('opencode', 'low')).toBe('Not mapped');
	});

	it('offers the catalogue and the sources, and no source to a harness with no recipe', async () => {
		await renderSection();

		const codexValues = Array.from(picker('codex', 'low').options).map((option) => option.value);
		expect(codexValues).toEqual(
			expect.arrayContaining([
				'default',
				'provider',
				'provider:gpt-7-luna',
				'ep-ollama:qwen3:latest',
			])
		);
		const droidValues = Array.from(picker('factory-droid', 'low').options).map(
			(option) => option.value
		);
		expect(droidValues).not.toContain('ep-ollama:qwen3:latest');
		expect(screen.getByTestId('tier-defaults-no-run-on-factory-droid').textContent).toMatch(
			/Provider models only\. No verified recipe\./
		);
	});

	it('flags a built-in model the catalogue does not list, with what Suggest would use', async () => {
		await renderSection();

		// The built-in low slug is gpt-6-luna; this catalogue lists gpt-7-luna.
		expect(screen.getByTestId('tier-defaults-codex-low-stale').textContent).toMatch(
			/gpt-6-luna is not in Codex's catalogue\. Suggest would use gpt-7-luna\./
		);
		expect(screen.queryByTestId('tier-defaults-codex-medium-stale')).toBeNull();
	});

	it('stores nothing when a picker changes, until Save', async () => {
		await renderSection();

		expect(button('save', 'codex').disabled).toBe(true);
		fireEvent.change(picker('codex', 'low'), { target: { value: 'ep-ollama:qwen3:latest' } });

		expect(source('codex', 'low')).toBe('Harness default');
		expect(screen.getByTestId('tier-defaults-unsaved-codex')).toBeTruthy();
		expect(stored()).toEqual({});

		fireEvent.click(button('save', 'codex'));

		expect(stored()).toEqual({
			codex: { low: { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' } },
		});
		expect(window.maestro.settings.set).toHaveBeenCalledWith('harnessTierDefaults', stored());
		expect(screen.queryByTestId('tier-defaults-unsaved-codex')).toBeNull();
	});

	it('fills the pickers on Suggest with the reason, and saves nothing', async () => {
		await renderSection();

		fireEvent.click(button('suggest', 'codex'));

		expect(picker('codex', 'low').value).toBe('provider:gpt-7-luna');
		expect(picker('codex', 'high').value).toBe('provider:gpt-6-astra');
		expect(screen.getByTestId('tier-defaults-codex-low-suggestion').textContent).toBe(
			'Suggested: the only Luna listed'
		);
		expect(screen.queryByTestId('tier-defaults-codex-low-stale')).toBeNull();
		expect(stored()).toEqual({});
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
	});

	it('says why Suggest left a tier alone, and keeps the value it had', async () => {
		useSettingsStore.setState({
			harnessTierDefaults: {
				opencode: { low: { type: 'provider-model', model: 'ollama/qwen3:latest' } },
			},
		});
		await renderSection([OPENCODE]);

		fireEvent.click(button('suggest', 'opencode'));

		expect(picker('opencode', 'low').value).toBe('provider:ollama/qwen3:latest');
		expect(screen.getByTestId('tier-defaults-opencode-high-suggestion').textContent).toMatch(
			/OpenCode's catalogue states nothing/
		);
		// Nothing changed, so there is nothing to save.
		expect(button('save', 'opencode').disabled).toBe(true);
	});

	it('drops a suggestion reason once the picker holds another value', async () => {
		await renderSection();

		fireEvent.click(button('suggest', 'codex'));
		fireEvent.change(picker('codex', 'low'), { target: { value: 'provider:gpt-6.1-sol' } });

		expect(screen.queryByTestId('tier-defaults-codex-low-suggestion')).toBeNull();
		expect(screen.getByTestId('tier-defaults-codex-high-suggestion')).toBeTruthy();
	});

	it('resets a row to the built-in table, saved only by Save', async () => {
		const saved: HarnessTierDefaults = {
			codex: { high: { type: 'provider-model', model: 'gpt-6.1-sol' } },
			'factory-droid': { low: { type: 'provider-model', model: 'claude-haiku-4-5-20251001' } },
		};
		useSettingsStore.setState({ harnessTierDefaults: saved });
		await renderSection();

		expect(picker('codex', 'high').value).toBe('provider:gpt-6.1-sol');
		fireEvent.click(button('reset', 'codex'));

		expect(picker('codex', 'high').value).toBe('default');
		expect(source('codex', 'high')).toBe('Built-in');
		expect(stored()).toEqual(saved);

		fireEvent.click(button('save', 'codex'));

		expect(stored()).toEqual({ 'factory-droid': saved['factory-droid'] });
	});

	it('discards unsaved edits back to what is saved', async () => {
		await renderSection();

		fireEvent.change(picker('codex', 'low'), { target: { value: 'provider' } });
		fireEvent.click(button('discard', 'codex'));

		expect(picker('codex', 'low').value).toBe('default');
		expect(button('save', 'codex').disabled).toBe(true);
	});

	it('shows a stored default a launch would refuse, in the launch words', async () => {
		useSettingsStore.setState({
			harnessTierDefaults: {
				'factory-droid': {
					high: { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' },
				},
			},
		});
		await renderSection([DROID]);

		expect(screen.getByTestId('tier-defaults-factory-droid-high-problem').textContent).toMatch(
			/cannot run on/
		);
		// Saving the row as it is repeats the refusal instead of storing it again.
		fireEvent.change(picker('factory-droid', 'low'), { target: { value: 'provider' } });
		fireEvent.click(button('save', 'factory-droid'));
		expect(screen.getByTestId('tier-defaults-refusal-factory-droid').textContent).toMatch(
			/Not saved\. high:/
		);
	});

	it('says once which source did not answer', async () => {
		await renderSection([CODEX, { ...OPENCODE, problems: CODEX.problems }]);

		const problems = screen.getAllByTestId('tier-defaults-source-problem');
		expect(problems).toHaveLength(1);
		expect(problems[0].textContent).toBe('LM Studio: connection refused');
	});

	it('asks again past the cache on Refresh', async () => {
		await renderSection();

		fireEvent.click(screen.getByTestId('tier-defaults-refresh'));

		await waitFor(() => expect(options()).toHaveBeenCalledTimes(2));
		expect(options()).toHaveBeenLastCalledWith({ refresh: true });
	});

	it('says so when no installed harness can select a model', async () => {
		await renderSection([]);
		await waitFor(() => screen.getByTestId('tier-defaults-empty'));
	});

	it('shows why the lists could not be read', async () => {
		options().mockRejectedValue(new Error('the app is still starting'));
		render(<TierDefaultsSection theme={mockTheme} endpoints={[]} />);

		await waitFor(() =>
			expect(screen.getByTestId('tier-defaults-error').textContent).toMatch(/still starting/)
		);
	});
});
