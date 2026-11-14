/**
 * Tests for CueGateField, the Gate on a Cue subscription.
 *
 * What these guard: a gate is two halves (the condition here, a model on the
 * `cue-gate` Local Models task), and the second is off by default. A typed
 * gate must never look live while no model checks it, so the field has to say
 * which state the task is in and what the policy does until it is ready.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
	CueGateField,
	type CueGateFieldValue,
} from '../../../../../renderer/components/CuePipelineEditor/panels/CueGateField';
import { THEMES } from '../../../../../renderer/constants/themes';
import { CUE_GATE_MAX_CONDITION_LENGTH } from '../../../../../shared/cue/gate';

const theme = THEMES['dracula'];
const taskReadiness = vi.mocked(window.maestro.localModels.taskReadiness);

const OFF = {
	taskId: 'cue-gate',
	label: 'Cue gate',
	needs: 'text-gen',
	assignment: { type: 'off' },
	state: 'off',
	detail: 'Cue gate is off.',
	suggestedAction: 'Assign it a local model or an endpoint in Settings > Models > System One.',
};
const READY = {
	taskId: 'cue-gate',
	label: 'Cue gate',
	needs: 'text-gen',
	assignment: { type: 'endpoint', endpointId: 'ollama', model: 'qwen3:4b' },
	state: 'ready',
	detail: 'Runs on qwen3:4b.',
};

function renderField(value: Partial<CueGateFieldValue> = {}, variant?: 'panel' | 'form') {
	const onChange = vi.fn();
	render(
		<CueGateField
			theme={theme}
			value={{ condition: '', onUnavailable: 'run', ...value }}
			onChange={onChange}
			variant={variant}
		/>
	);
	return onChange;
}

describe('CueGateField', () => {
	beforeEach(() => {
		taskReadiness.mockReset();
		taskReadiness.mockResolvedValue([]);
	});

	it('reports what is typed, keeping the policy', () => {
		const onChange = renderField({ onUnavailable: 'skip' });
		const input = screen.getByTestId('cue-gate-condition');
		expect(input).toHaveAttribute('maxlength', String(CUE_GATE_MAX_CONDITION_LENGTH));

		fireEvent.change(input, { target: { value: 'the comment reports a bug' } });
		expect(onChange).toHaveBeenCalledWith({
			condition: 'the comment reports a bug',
			onUnavailable: 'skip',
		});
	});

	it('asks only the cue-gate task for readiness', () => {
		renderField();
		expect(taskReadiness).toHaveBeenCalledWith('cue-gate');
	});

	it('offers the policy and a readiness line only once there is a condition', async () => {
		taskReadiness.mockResolvedValue([OFF] as never);
		renderField();
		// Give the readiness answer a chance to land before asserting absence.
		await Promise.resolve();
		expect(screen.queryByText('If no model can answer')).not.toBeInTheDocument();
		expect(screen.queryByTestId('cue-gate-not-ready')).not.toBeInTheDocument();
	});

	it('changes the policy, keeping the condition', () => {
		const onChange = renderField({ condition: 'the comment reports a bug' });
		fireEvent.click(screen.getByRole('button', { name: 'If no model can answer' }));
		fireEvent.click(screen.getByText('Skip the event'));
		expect(onChange).toHaveBeenCalledWith({
			condition: 'the comment reports a bug',
			onUnavailable: 'skip',
		});
	});

	it('warns that a gate with no model lets every event run', async () => {
		taskReadiness.mockResolvedValue([OFF] as never);
		renderField({ condition: 'the comment reports a bug' });

		const note = await screen.findByTestId('cue-gate-not-ready');
		expect(note).toHaveTextContent('Cue gate is off.');
		expect(note).toHaveTextContent('Settings > Models > System One');
		expect(note).toHaveTextContent('Until then, every event starts a run unchecked.');
		expect(screen.queryByTestId('cue-gate-ready')).not.toBeInTheDocument();
	});

	it('says every event is skipped when the policy is skip', async () => {
		taskReadiness.mockResolvedValue([OFF] as never);
		renderField({ condition: 'the comment reports a bug', onUnavailable: 'skip' });

		expect(await screen.findByTestId('cue-gate-not-ready')).toHaveTextContent(
			'Until then, every event is skipped.'
		);
	});

	it('names the source that checks the gate once the task is ready', async () => {
		taskReadiness.mockResolvedValue([READY] as never);
		renderField({ condition: 'the comment reports a bug' }, 'form');

		expect(await screen.findByTestId('cue-gate-ready')).toHaveTextContent(/Checked by .*qwen3:4b/);
		expect(screen.queryByTestId('cue-gate-not-ready')).not.toBeInTheDocument();
	});

	it('treats a whitespace-only condition as no gate', async () => {
		taskReadiness.mockResolvedValue([OFF] as never);
		renderField({ condition: '   ' });
		await Promise.resolve();
		expect(screen.queryByText('If no model can answer')).not.toBeInTheDocument();
		expect(screen.queryByTestId('cue-gate-not-ready')).not.toBeInTheDocument();
	});
});
