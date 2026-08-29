/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Tests for QueuedItemEditModal keyboard handling.
 *
 * Cmd/Ctrl+Enter saves and closes from anywhere in the modal body, including
 * the textarea where plain Enter must stay a newline.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueuedItemEditModal } from '../../../renderer/components/QueuedItemEditModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../helpers/mockTheme';
import type { QueuedItem } from '../../../renderer/types';

function setup(overrides: Partial<QueuedItem> = {}) {
	const item: QueuedItem = {
		id: 'q1',
		timestamp: 0,
		tabId: 'tab-1',
		type: 'message',
		text: 'a queued message',
		...overrides,
	};
	const onSave = vi.fn();
	const onClose = vi.fn();
	render(
		<LayerStackProvider>
			<QueuedItemEditModal item={item} theme={mockTheme} onClose={onClose} onSave={onSave} />
		</LayerStackProvider>
	);
	return { onSave, onClose, textarea: screen.getByPlaceholderText('Message to send…') };
}

describe('QueuedItemEditModal keyboard', () => {
	it('saves and closes on Cmd+Enter from the textarea', () => {
		const { onSave, onClose, textarea } = setup();
		fireEvent.change(textarea, { target: { value: 'edited text' } });
		fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
		expect(onSave).toHaveBeenCalledWith({ text: 'edited text', images: [] });
		expect(onClose).toHaveBeenCalled();
	});

	it('saves on Ctrl+Enter for Windows and Linux', () => {
		const { onSave, textarea } = setup();
		fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		expect(onSave).toHaveBeenCalledWith({ text: 'a queued message', images: [] });
	});

	it('leaves plain Enter alone so it inserts a newline', () => {
		const { onSave, onClose, textarea } = setup();
		fireEvent.keyDown(textarea, { key: 'Enter' });
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('does not save an empty message on Cmd+Enter', () => {
		const { onSave, onClose, textarea } = setup({ text: '' });
		fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});
});

describe('QueuedItemEditModal focus', () => {
	// Regression: Modal auto-focuses on mount inside a requestAnimationFrame, and
	// with no initialFocusRef it focuses its own overlay container. That frame
	// lands AFTER the modal body's own effect, so a locally-focused textarea was
	// silently handed back to a div one frame later and Cmd+Shift+E dropped the
	// user on a surface that swallowed every keystroke.
	it('lands focus in the textarea with the caret at the end', async () => {
		const { textarea } = setup();
		await waitFor(() => expect(document.activeElement).toBe(textarea));
		expect((textarea as HTMLTextAreaElement).selectionStart).toBe('a queued message'.length);
		expect((textarea as HTMLTextAreaElement).selectionEnd).toBe('a queued message'.length);
	});
});
