/**
 * @fileoverview Keyboard commit paths for the Snooze Tab dialog.
 *
 * The dialog is mostly mouse-driven: presets, a calendar, a time field, and a
 * free-form note. Before this, the ONLY way to commit from the keyboard was
 * plain Enter in the "Or type it" input - the one field a user is least likely
 * to be in when they finish. Cmd/Ctrl+Enter now commits from anywhere in the
 * body, matching QueuedItemEditModal.
 *
 * The double-fire test is the one that matters. `e.key === 'Enter'` is true for
 * Cmd+Enter too, so a body-level handler added without narrowing the input's
 * own handler makes the text field commit twice - snooze set twice, modal
 * closed twice.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SnoozeTabModal } from '../../../renderer/components/SnoozeTabModal';
import { mockTheme } from '../../helpers/mockTheme';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';

function setup(overrides: Record<string, unknown> = {}) {
	const onConfirm = vi.fn();
	const onClose = vi.fn();
	render(
		<LayerStackProvider>
			<SnoozeTabModal
				theme={mockTheme}
				tabLabel="Some tab"
				onClose={onClose}
				onConfirm={onConfirm}
				{...overrides}
			/>
		</LayerStackProvider>
	);
	return { onConfirm, onClose };
}

/** The free-form "Or type it" input. */
const typeInput = () => screen.getByPlaceholderText(/1d, 10h, 2 weeks/i);
/** The note-to-self textarea. */
const noteArea = () => screen.getByPlaceholderText(/Why are you coming back/i);
/** The prompt-on-return textarea (only rendered when the tab can be prompted). */
const promptArea = () => screen.getByTestId('snooze-wake-prompt');

/** Give the dialog a resolvable time so confirm is enabled. */
function enterExpression(value = '2 weeks') {
	fireEvent.change(typeInput(), { target: { value } });
}

describe('SnoozeTabModal keyboard commit', () => {
	it('commits on Cmd+Enter from the note textarea', () => {
		const { onConfirm } = setup();
		enterExpression();
		fireEvent.keyDown(noteArea(), { key: 'Enter', metaKey: true });
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('commits on Ctrl+Enter from the note textarea', () => {
		const { onConfirm } = setup();
		enterExpression();
		fireEvent.keyDown(noteArea(), { key: 'Enter', ctrlKey: true });
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('commits on Cmd+Enter from a focused preset button', () => {
		const { onConfirm } = setup();
		enterExpression();
		// A real preset inside the dialog body - not the header close button, which
		// sits outside the wrapper the handler is attached to.
		fireEvent.keyDown(screen.getByRole('button', { name: /Tomorrow/i }), {
			key: 'Enter',
			metaKey: true,
		});
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('fires onConfirm EXACTLY ONCE for Cmd+Enter in the free-form input', () => {
		// The regression this whole change risks: the input's own Enter handler
		// also matches Cmd+Enter, so without narrowing it the event commits at the
		// target and again on bubble.
		const { onConfirm } = setup();
		enterExpression();
		fireEvent.keyDown(typeInput(), { key: 'Enter', metaKey: true });
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('still commits on plain Enter in the free-form input', () => {
		const { onConfirm } = setup();
		enterExpression();
		fireEvent.keyDown(typeInput(), { key: 'Enter' });
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('leaves plain Enter in the textarea alone, so it stays a newline', () => {
		const { onConfirm } = setup();
		enterExpression();
		fireEvent.keyDown(noteArea(), { key: 'Enter' });
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('does nothing on Cmd+Enter when no time has been chosen', () => {
		// Same rule the confirm button follows: nothing resolvable, nothing to do.
		const { onConfirm } = setup();
		fireEvent.keyDown(noteArea(), { key: 'Enter', metaKey: true });
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('passes the trimmed note through with the resolved time', () => {
		const { onConfirm } = setup();
		enterExpression();
		fireEvent.change(noteArea(), { target: { value: '  check the deploy  ' } });
		fireEvent.keyDown(noteArea(), { key: 'Enter', metaKey: true });
		expect(onConfirm).toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ note: 'check the deploy' })
		);
	});
});

describe('SnoozeTabModal wake prompt', () => {
	it('is hidden unless the parked tab can actually be prompted', () => {
		// A file, terminal, or browser tab has no conversation to send to, so
		// offering the field there would collect a prompt that could never run.
		setup();
		expect(screen.queryByTestId('snooze-wake-prompt')).not.toBeInTheDocument();
	});

	it('passes the trimmed prompt through alongside the note', () => {
		const { onConfirm } = setup({ canRunWakePrompt: true });
		enterExpression();
		fireEvent.change(noteArea(), { target: { value: 'why' } });
		fireEvent.change(promptArea(), { target: { value: '  run the tests  ' } });
		fireEvent.keyDown(noteArea(), { key: 'Enter', metaKey: true });

		expect(onConfirm).toHaveBeenCalledWith(expect.any(Number), {
			note: 'why',
			wakePrompt: 'run the tests',
		});
	});

	it('commits on Cmd+Enter from the prompt textarea too', () => {
		const { onConfirm } = setup({ canRunWakePrompt: true });
		enterExpression();
		fireEvent.keyDown(promptArea(), { key: 'Enter', metaKey: true });
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('opens pre-filled when rescheduling a snooze that already has one', () => {
		setup({
			canRunWakePrompt: true,
			initialWakeAt: Date.now() + 3600_000,
			initialWakePrompt: 'go on',
		});
		expect(promptArea()).toHaveValue('go on');
	});

	it('sends an empty prompt when the field is cleared, so a reschedule removes it', () => {
		// An omitted field means "keep what was there", so emptying the box has to
		// travel as an empty string or the deletion is silently discarded.
		const { onConfirm } = setup({
			canRunWakePrompt: true,
			initialWakeAt: Date.now() + 3600_000,
			initialWakePrompt: 'go on',
		});
		fireEvent.change(promptArea(), { target: { value: '' } });
		fireEvent.keyDown(noteArea(), { key: 'Enter', metaKey: true });

		expect(onConfirm).toHaveBeenCalledWith(
			expect.any(Number),
			expect.objectContaining({ wakePrompt: '' })
		);
	});
});
