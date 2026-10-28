/**
 * @file DigestWriterField.test.tsx
 * @description Who writes Computer History digests: the local model is offered
 * first, the two writers are one or the other, and the model picker writes the
 * `history-digests` Local Models assignment (never a second setting).
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CHOOSE_MODEL_LABEL,
	DigestWriterField,
} from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components/DigestWriterField';
import { useSettingsStore } from '../../../../../../renderer/stores/settingsStore';
import { defaultComputerHistoryConfig } from '../../../../../../shared/computer-history/config';
import type { ComputerHistoryConfig } from '../../../../../../shared/computer-history/types';
import {
	BGE_SMALL_EN_ID,
	QWEN3_1_7B_ID,
	getLocalModel,
} from '../../../../../../shared/local-models/model-catalog';
import { mockTheme } from '../../../../../helpers/mockTheme';

const AGENTS = [
	{ id: 'agent-1', name: 'Maestro' },
	{ id: 'agent-2', name: 'Docs' },
];

function installed(id: string) {
	const entry = getLocalModel(id)!;
	return {
		entry,
		status: { id, status: 'installed', manifest: {}, bytesOnDisk: entry.bytes },
		installPaths: [],
	};
}

function digests(patch: Partial<ComputerHistoryConfig['digests']> = {}) {
	return { ...defaultComputerHistoryConfig().digests, enabled: true, ...patch };
}

function mount(config: ComputerHistoryConfig['digests']) {
	const onSave = vi.fn();
	render(<DigestWriterField theme={mockTheme} digests={config} agents={AGENTS} onSave={onSave} />);
	return onSave;
}

function optionLabels(select: HTMLElement): string[] {
	return within(select)
		.getAllByRole('option')
		.map((option) => option.textContent ?? '');
}

beforeEach(() => {
	vi.mocked(window.maestro.localModels.list).mockReset().mockResolvedValue([]);
	vi.mocked(window.maestro.localModels.taskReadiness).mockReset().mockResolvedValue([]);
	useSettingsStore.setState({ localModelAssignments: {}, localModelEndpoints: [] });
});

describe('DigestWriterField', () => {
	it('offers the local model first and selects it by default', () => {
		mount(digests());
		const options = within(screen.getByTestId('computer-history-digest-source')).getAllByRole(
			'radio'
		);
		expect(options.map((option) => option.textContent)).toEqual(['Local model', 'Agent']);
		expect(options[0].getAttribute('aria-checked')).toBe('true');
		expect(screen.getByLabelText('Digest model')).toBeTruthy();
		// One or the other: the agent picker is not drawn beside the model picker.
		expect(screen.queryByLabelText('Digest agent')).toBeNull();
	});

	it('with no text model installed, says where to get one', async () => {
		mount(digests());
		expect(await screen.findByTestId('computer-history-digest-no-models')).toBeTruthy();
		expect(optionLabels(screen.getByLabelText('Digest model'))).toEqual([CHOOSE_MODEL_LABEL]);
		expect(screen.getByTestId('computer-history-digest-no-models').textContent).toContain(
			'Settings > Models > Library'
		);
	});

	it('lists installed text models only, and a pick writes the history-digests assignment', async () => {
		vi.mocked(window.maestro.localModels.list).mockResolvedValue([
			installed(QWEN3_1_7B_ID),
			installed(BGE_SMALL_EN_ID),
		] as never);
		const onSave = mount(digests());
		const select = screen.getByLabelText('Digest model') as HTMLSelectElement;
		const model = getLocalModel(QWEN3_1_7B_ID)!.displayName;
		await waitFor(() => expect(optionLabels(select)).toEqual([CHOOSE_MODEL_LABEL, model]));
		expect(screen.queryByTestId('computer-history-digest-no-models')).toBeNull();

		fireEvent.change(select, { target: { value: `local:${QWEN3_1_7B_ID}` } });
		expect(useSettingsStore.getState().localModelAssignments).toEqual({
			'history-digests': { type: 'local', modelId: QWEN3_1_7B_ID },
		});
		// The model is a Local Models setting: nothing is written to config.json.
		expect(onSave).not.toHaveBeenCalled();
		// Readiness is asked for this one task, not for every task.
		expect(window.maestro.localModels.taskReadiness).toHaveBeenCalledWith('history-digests');
	});

	it('shows the stored assignment and can clear it back to no model', async () => {
		vi.mocked(window.maestro.localModels.list).mockResolvedValue([
			installed(QWEN3_1_7B_ID),
		] as never);
		useSettingsStore.setState({
			localModelAssignments: { 'history-digests': { type: 'local', modelId: QWEN3_1_7B_ID } },
		});
		mount(digests());
		const select = screen.getByLabelText('Digest model') as HTMLSelectElement;
		expect(select.value).toBe(`local:${QWEN3_1_7B_ID}`);
		fireEvent.change(select, { target: { value: 'off' } });
		expect(useSettingsStore.getState().localModelAssignments).toEqual({});
	});

	it('switching the writer saves the source alone', () => {
		const onSave = mount(digests());
		fireEvent.click(screen.getByTestId('computer-history-digest-source-agent'));
		expect(onSave).toHaveBeenCalledWith({ digests: { source: 'agent' } });
	});

	it('the agent source draws the agent picker and no model picker', () => {
		const onSave = mount(digests({ source: 'agent', agentId: 'agent-2' }));
		const select = screen.getByLabelText('Digest agent') as HTMLSelectElement;
		expect(select.value).toBe('agent-2');
		expect(optionLabels(select)).toEqual(['Choose an agent', 'Maestro', 'Docs']);
		expect(screen.queryByLabelText('Digest model')).toBeNull();
		// Nothing about Local Models is read while an agent writes the digests.
		expect(window.maestro.localModels.taskReadiness).not.toHaveBeenCalled();

		fireEvent.change(select, { target: { value: 'agent-1' } });
		expect(onSave).toHaveBeenCalledWith({ digests: { agentId: 'agent-1' } });
		fireEvent.change(select, { target: { value: '' } });
		expect(onSave).toHaveBeenLastCalledWith({ digests: { agentId: null } });
		fireEvent.click(screen.getByTestId('computer-history-digest-source-local'));
		expect(onSave).toHaveBeenLastCalledWith({ digests: { source: 'local' } });
	});
});
