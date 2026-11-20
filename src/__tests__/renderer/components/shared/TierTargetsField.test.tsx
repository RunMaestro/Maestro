/**
 * Tests for TierTargetsField - the agent's own tier targets: a picker per tier
 * whose first choice is the harness default, the layer each value comes from,
 * and the launch's own words for a tier that is refused or does not apply.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TierTargetsField } from '../../../../renderer/components/shared/TierTargetsField';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { LocalModelEndpoint } from '../../../../shared/local-models/endpoints';
import type { RunOnTarget } from '../../../../shared/local-models/run-on';
import type { HarnessTierOptions } from '../../../../shared/local-models/tier-options';
import type { HarnessTierDefaults, TierTargets } from '../../../../shared/modelTiers';
import { mockTheme } from '../../../helpers/mockTheme';

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};
const LOCAL = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:latest' };

const CLAUDE: HarnessTierOptions = {
	harness: 'claude-code',
	name: 'Claude Code',
	installed: true,
	catalog: [{ id: 'haiku' }, { id: 'sonnet' }, { id: 'opus' }],
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

let savedDefaults: HarnessTierDefaults;
let savedEndpoints: LocalModelEndpoint[];

const options = () => vi.mocked(window.maestro.localModels.tiers.options);
const picker = (tier: string) =>
	screen.getByTestId(`tier-targets-field-${tier}`) as HTMLSelectElement;
const source = (tier: string) =>
	screen.getByTestId(`tier-targets-field-${tier}-source`).textContent;
const listed = () => waitFor(() => screen.getByTestId('tier-targets-field-low'));

function renderField(
	props: Partial<React.ComponentProps<typeof TierTargetsField>> = {},
	rows: HarnessTierOptions[] = [CLAUDE]
) {
	options().mockResolvedValue(rows);
	const onChange = vi.fn();
	const view = render(
		<TierTargetsField
			theme={mockTheme}
			toolType="claude-code"
			value={{}}
			onChange={onChange}
			runOn={{ type: 'provider' }}
			{...props}
		/>
	);
	return { onChange, ...view };
}

beforeEach(() => {
	savedDefaults = useSettingsStore.getState().harnessTierDefaults;
	savedEndpoints = useSettingsStore.getState().localModelEndpoints;
	useSettingsStore.setState({ harnessTierDefaults: {}, localModelEndpoints: [OLLAMA] });
	options().mockReset();
});

afterEach(() => {
	useSettingsStore.setState({
		harnessTierDefaults: savedDefaults,
		localModelEndpoints: savedEndpoints,
	});
	options().mockResolvedValue([]);
});

describe('TierTargetsField', () => {
	it("asks for the agent's own harness alone", async () => {
		renderField();
		await listed();

		expect(options()).toHaveBeenCalledTimes(1);
		expect(options()).toHaveBeenCalledWith({ refresh: false, harness: 'claude-code' });
	});

	it('starts each tier on Harness default, with the value and the layer it comes from', async () => {
		renderField();
		await listed();

		expect(picker('low').value).toBe('default');
		expect(picker('low').selectedOptions[0].textContent).toBe('Harness default (haiku)');
		expect(picker('high').selectedOptions[0].textContent).toBe('Harness default (opus)');
		// The value is the built-in table's until someone sets a harness default.
		expect(source('low')).toBe('Built-in');
	});

	it('follows a harness default the user saved, and names that layer', async () => {
		useSettingsStore.setState({ harnessTierDefaults: { 'claude-code': { low: LOCAL } } });
		renderField();
		await listed();

		expect(picker('low').selectedOptions[0].textContent).toBe(
			'Harness default (qwen3:latest on Ollama)'
		);
		expect(source('low')).toBe('Harness default');
		expect(source('medium')).toBe('Built-in');
	});

	it("shows the agent's own target and names the agent as its layer", async () => {
		renderField({ value: { low: LOCAL, high: { type: 'provider-model', model: 'sonnet' } } });
		await listed();

		expect(picker('low').value).toBe('ep-ollama:qwen3:latest');
		expect(source('low')).toBe('Agent');
		expect(picker('high').value).toBe('provider:sonnet');
		expect(source('high')).toBe('Agent');
		expect(source('medium')).toBe('Built-in');
	});

	it('offers the catalogue and each source, in the spelling --tier takes', async () => {
		renderField();
		await listed();

		expect(Array.from(picker('low').options).map((option) => option.value)).toEqual([
			'default',
			'provider',
			'provider:haiku',
			'provider:sonnet',
			'provider:opus',
			'ep-ollama:qwen3:latest',
		]);
	});

	it('hands up the record with the tier set, and without it for Harness default', async () => {
		const { onChange } = renderField({ value: { high: LOCAL } });
		await listed();

		fireEvent.change(picker('low'), { target: { value: 'provider:haiku' } });
		expect(onChange).toHaveBeenLastCalledWith({
			high: LOCAL,
			low: { type: 'provider-model', model: 'haiku' },
		});

		fireEvent.change(picker('high'), { target: { value: 'default' } });
		expect(onChange).toHaveBeenLastCalledWith({});
	});

	it('says why the built-in table does not apply to an agent that runs on a source', async () => {
		const runOn: RunOnTarget = { ...LOCAL, contextTokens: 65_536 };
		renderField({ runOn });
		await listed();

		expect(source('low')).toBe('Not mapped');
		expect(picker('low').selectedOptions[0].textContent).toBe('Harness default (not mapped)');
		expect(screen.getByTestId('tier-targets-field-low-note').textContent).toMatch(
			/runs on a Local Models source/
		);
		expect(screen.queryByTestId('tier-targets-field-low-problem')).toBeNull();
	});

	it('shows a target a launch would refuse in the launch words', async () => {
		renderField({ toolType: 'factory-droid', value: { high: LOCAL } as TierTargets }, [DROID]);
		await listed();

		expect(screen.getByTestId('tier-targets-field-high-problem').textContent).toMatch(
			/cannot run on/
		);
		expect(source('high')).toBe('Agent');
		expect(screen.getByTestId('tier-targets-field-no-run-on').textContent).toContain(
			'No verified recipe.'
		);
	});

	it('says which source did not answer, and shows the host error', async () => {
		renderField({ error: 'low: nope' });
		await listed();

		expect(screen.getByTestId('tier-targets-field-source-problem').textContent).toBe(
			'LM Studio: connection refused'
		);
		expect(screen.getByTestId('tier-targets-field-error').textContent).toBe('low: nope');
	});

	it('does not draw another harness list while its own is being asked', async () => {
		// The last answer is Factory Droid's; this agent is Claude Code.
		renderField({}, [DROID]);

		await waitFor(() => expect(options()).toHaveBeenCalled());
		expect(screen.queryByTestId('tier-targets-field-low')).toBeNull();
		expect(screen.getByTestId('tier-targets-field-loading')).toBeTruthy();
	});

	it('says why the list could not be read', async () => {
		options().mockRejectedValue(new Error('the app is still starting'));
		render(
			<TierTargetsField
				theme={mockTheme}
				toolType="claude-code"
				value={{}}
				onChange={vi.fn()}
				runOn={{ type: 'provider' }}
			/>
		);

		await waitFor(() =>
			expect(screen.getByTestId('tier-targets-field-list-error').textContent).toContain(
				'the app is still starting'
			)
		);
	});

	it('names the reason for a harness that has no tiers, and asks nothing', () => {
		renderField({ toolType: 'terminal' });

		expect(screen.getByTestId('tier-targets-field-unsupported').textContent).toMatch(/terminal/);
		expect(options()).not.toHaveBeenCalled();
	});
});
