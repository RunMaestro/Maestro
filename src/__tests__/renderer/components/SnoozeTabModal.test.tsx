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
		expect(onConfirm).toHaveBeenCalledWith(expect.any(Number), 'check the deploy');
	});
});
