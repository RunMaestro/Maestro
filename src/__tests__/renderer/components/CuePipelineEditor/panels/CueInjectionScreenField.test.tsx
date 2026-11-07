/**
 * Tests for CueInjectionScreenField, the prompt-injection screen on a Cue
 * trigger.
 *
 * What these guard: the screen is two halves (the setting here, a classifier
 * on the `injection-screen` Local Models task), and the second is off by
 * default. The field has to say which state the task is in and what the
 * failure policy does until it is ready, because that policy differs by mode:
 * a screen that was asked for blocks commands, the default with no classifier
 * screens nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { CueInjectionScreenField } from '../../../../../renderer/components/CuePipelineEditor/panels/CueInjectionScreenField';
import { THEMES } from '../../../../../renderer/constants/themes';
import type { CueInjectionScreenSetting } from '../../../../../shared/cue/injection-screen';

const theme = THEMES['dracula'];
const taskReadiness = vi.mocked(window.maestro.localModels.taskReadiness);

const OFF = {
	taskId: 'injection-screen',
	label: 'Prompt-injection screen',
	needs: 'classifier',
	assignment: { type: 'off' },
	state: 'off',
	detail: 'Prompt-injection screen is off.',
	suggestedAction: 'Assign it a classifier model in Settings > Local Models.',
};
const UNAVAILABLE = {
	taskId: 'injection-screen',
	label: 'Prompt-injection screen',
	needs: 'classifier',
	assignment: { type: 'local', modelId: 'prompt-guard-2-86m' },
	state: 'unavailable',
	reason: 'model-not-installed',
	detail: 'Prompt Guard 2 is not installed.',
	suggestedAction: 'Download it in Settings > Local Models.',
};
const READY = {
	taskId: 'injection-screen',
	label: 'Prompt-injection screen',
	needs: 'classifier',
	assignment: { type: 'local', modelId: 'prompt-guard-2-86m' },
	state: 'ready',
	detail: 'Runs on Prompt Guard 2.',
};

function renderField(value: Partial<CueInjectionScreenSetting> = {}) {
	const onChange = vi.fn();
	render(
		<CueInjectionScreenField theme={theme} value={{ mode: 'auto', ...value }} onChange={onChange} />
	);
	return onChange;
}

describe('CueInjectionScreenField', () => {
	beforeEach(() => {
		taskReadiness.mockReset();
		taskReadiness.mockResolvedValue([]);
	});

	it('asks only the injection-screen task for readiness', () => {
		renderField();
		expect(taskReadiness).toHaveBeenCalledWith('injection-screen');
	});

	it('changes the mode, keeping the threshold', () => {
		const onChange = renderField({ threshold: 0.6 });
		fireEvent.click(screen.getByRole('button', { name: 'Prompt-injection screen' }));
		fireEvent.click(screen.getByText('Always screen'));
		expect(onChange).toHaveBeenCalledWith({ mode: 'on', threshold: 0.6 });
	});

	it('shows the default threshold and reports a new one, keeping the mode', () => {
		const onChange = renderField({ mode: 'on' });
		const input = screen.getByTestId('cue-injection-threshold');
		expect(input).toHaveValue(0.8);

		fireEvent.change(input, { target: { value: '0.65' } });
		expect(onChange).toHaveBeenCalledWith({ mode: 'on', threshold: 0.65 });
	});

	it('does not report a threshold that cannot be saved', () => {
		const onChange = renderField({ mode: 'on' });
		const input = screen.getByTestId('cue-injection-threshold');
		for (const value of ['', '0', '1.5', '-1']) {
			fireEvent.change(input, { target: { value } });
		}
		expect(onChange).not.toHaveBeenCalled();
	});

	it('hides the threshold and the readiness line when the screen is off', async () => {
		taskReadiness.mockResolvedValue([OFF] as never);
		renderField({ mode: 'off' });
		await Promise.resolve();
		expect(screen.queryByTestId('cue-injection-threshold')).not.toBeInTheDocument();
		expect(screen.queryByTestId('cue-injection-screen-not-ready')).not.toBeInTheDocument();
	});

	it('says nothing is screened when the default applies and no classifier is assigned', async () => {
		taskReadiness.mockResolvedValue([OFF] as never);
		renderField({ mode: 'auto' });

		const note = await screen.findByTestId('cue-injection-screen-not-ready');
		expect(note).toHaveTextContent('Prompt-injection screen is off.');
		expect(note).toHaveTextContent('Until a classifier is assigned, nothing is screened.');
	});

	it('says a command is blocked when the default applies and the assigned classifier cannot run', async () => {
		taskReadiness.mockResolvedValue([UNAVAILABLE] as never);
		renderField({ mode: 'auto' });

		const note = await screen.findByTestId('cue-injection-screen-not-ready');
		expect(note).toHaveTextContent('Prompt Guard 2 is not installed.');
		expect(note).toHaveTextContent('Until then, a command that uses this text is blocked.');
	});

	it('names both halves of the policy when the screen was asked for and cannot run', async () => {
		taskReadiness.mockResolvedValue([OFF] as never);
		renderField({ mode: 'on' });

		expect(await screen.findByTestId('cue-injection-screen-not-ready')).toHaveTextContent(
			'Until then, a command is blocked and a prompt starts unscreened with a warning.'
		);
	});

	it('names the classifier that screens once the task is ready', async () => {
		taskReadiness.mockResolvedValue([READY] as never);
		renderField({ mode: 'on' });

		expect(await screen.findByTestId('cue-injection-screen-ready')).toHaveTextContent(
			/Screened by /
		);
		expect(screen.queryByTestId('cue-injection-screen-not-ready')).not.toBeInTheDocument();
	});
});
