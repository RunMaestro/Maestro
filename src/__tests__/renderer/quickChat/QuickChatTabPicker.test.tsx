/**
 * QuickChatTabPicker - choose the tab the next Quick Chat message goes to.
 *
 * The fixed rows (New tab, Any tab) come first so Cmd+T, Up, Enter starts a
 * new tab, and the row for where the next message goes now is selected.
 */

import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QuickChatTabPicker } from '../../../renderer/quickChat/QuickChatTabPicker';
import { mockTheme } from '../../helpers/mockTheme';
import type { QuickChatNextTarget, QuickChatTabOption } from '../../../shared/quickChat';

const TABS: QuickChatTabOption[] = [
	{ id: 't1', name: 'Release notes', busy: false, inChat: true },
	{ id: 't2', name: 'Flaky test hunt', busy: true, inChat: false },
];

function renderPicker(next: QuickChatNextTarget = { kind: 'auto' }) {
	const onPick = vi.fn();
	const onClose = vi.fn();
	render(
		<QuickChatTabPicker
			theme={mockTheme}
			tabs={TABS}
			next={next}
			onPick={onPick}
			onClose={onClose}
		/>
	);
	const input = screen.getByTestId('quick-chat-tab-filter');
	return { onPick, onClose, input };
}

describe('QuickChatTabPicker', () => {
	it('lists New tab and Any tab first, then each tab with its notes', () => {
		renderPicker();
		const rows = screen.getAllByTestId('quick-chat-tab-row');
		expect(rows).toHaveLength(4);
		expect(rows[0]).toHaveTextContent('New tab');
		expect(rows[1]).toHaveTextContent('Any tab');
		expect(screen.getByText('this chat')).toBeInTheDocument();
		expect(screen.getByText('working')).toBeInTheDocument();
	});

	it('starts on the tab the next message goes to', () => {
		const { onPick, input } = renderPicker({
			kind: 'tab',
			tabId: 't2',
			name: 'Flaky test hunt',
			chosen: true,
		});
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onPick).toHaveBeenCalledWith('tab:t2');
	});

	it('starts on New tab when the next message starts one', () => {
		const { onPick, input } = renderPicker({ kind: 'new' });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onPick).toHaveBeenCalledWith('new');
	});

	it('filters by tab name', () => {
		const { onPick, input } = renderPicker();
		fireEvent.change(input, { target: { value: 'flaky' } });
		expect(screen.getAllByTestId('quick-chat-tab-row')).toHaveLength(1);
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(onPick).toHaveBeenCalledWith('tab:t2');
	});

	it('keeps New tab in view once the window grows to fit the picker', async () => {
		// The picker mounts while the window is still composer-sized: the first
		// scroll to the selected row (Any tab) ran against a list one row tall and
		// scrolled New tab out of view. Once the list has its height, it refits
		// from the top.
		const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200);
		const scrollSpy = vi.mocked(Element.prototype.scrollIntoView);
		scrollSpy.mockClear();
		scrollSpy.mockImplementationOnce(function (this: Element) {
			(this.parentElement as HTMLElement).scrollTop = 40;
		});
		try {
			// renderPicker queries the DOM, so it cannot run inside act: React
			// commits only when act exits. Render, then flush the height refit.
			renderPicker();
			await act(async () => {});
			const rows = screen.getAllByTestId('quick-chat-tab-row');
			expect(screen.getByRole('listbox').scrollTop).toBe(0);
			expect(scrollSpy.mock.contexts.at(-1)).toBe(rows[1]);
			expect(scrollSpy).toHaveBeenLastCalledWith({ block: 'nearest' });
		} finally {
			heightSpy.mockRestore();
		}
	});

	it('closes on Escape without picking', () => {
		const { onPick, onClose, input } = renderPicker();
		fireEvent.keyDown(input, { key: 'Escape' });
		expect(onClose).toHaveBeenCalled();
		expect(onPick).not.toHaveBeenCalled();
	});
});
