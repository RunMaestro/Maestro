/**
 * Tests for the group chip's "Close group" action: it closes every tab in the
 * group, so it must ask first, and only the confirm (Enter, or the button)
 * closes anything.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupTabChip } from '../../../../renderer/components/TabBar/GroupTabChip';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import { createGroupFromTabRefs } from '../../../../renderer/utils/panelLayout';
import { mockTheme } from '../../../helpers/mockTheme';

const group = createGroupFromTabRefs(
	[
		{ type: 'ai', id: 'ai-1' },
		{ type: 'terminal', id: 'term-1' },
		{ type: 'file', id: 'file-1' },
	],
	'Terminal 1'
);

function openMenu() {
	fireEvent.mouseEnter(screen.getByTitle('Terminal 1'));
	act(() => {
		vi.advanceTimersByTime(400);
	});
}

describe('GroupTabChip close group', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		useModalStore.getState().closeModal('confirm');
	});

	it('asks for confirmation and closes the group only on confirm', () => {
		const onClose = vi.fn();
		render(
			<GroupTabChip group={group} isActive theme={mockTheme} onSelect={vi.fn()} onClose={onClose} />
		);
		openMenu();

		fireEvent.click(screen.getByText('Close group'));
		expect(onClose).not.toHaveBeenCalled();

		const confirm = useModalStore.getState().modals.get('confirm')?.data as {
			title?: string;
			message: string;
			destructive?: boolean;
			onConfirm: () => void;
		};
		expect(confirm.title).toBe('Close group?');
		expect(confirm.message).toContain('"Terminal 1" and the 3 tabs in it');
		expect(confirm.destructive).toBe(true);

		confirm.onConfirm();
		expect(onClose).toHaveBeenCalledWith(group.id);
	});

	it('omits the item when no close handler is wired', () => {
		render(
			<GroupTabChip
				group={group}
				isActive
				theme={mockTheme}
				onSelect={vi.fn()}
				onBreakApart={vi.fn()}
			/>
		);
		openMenu();

		expect(screen.getByText('Break apart')).toBeTruthy();
		expect(screen.queryByText('Close group')).toBeNull();
	});
});

describe('GroupTabChip rename during IME composition', () => {
	function startRenaming(onRename: (groupId: string, name: string) => void) {
		render(
			<GroupTabChip
				group={group}
				isActive
				theme={mockTheme}
				onSelect={vi.fn()}
				onRename={onRename}
			/>
		);
		fireEvent.doubleClick(screen.getByTitle('Terminal 1'));
		return screen.getByDisplayValue('Terminal 1') as HTMLInputElement;
	}

	it.each([
		['isComposing', { isComposing: true }],
		['keyCode 229', { keyCode: 229 }],
	])('leaves a composing Enter (%s) to the input method', (_label, composing) => {
		const onRename = vi.fn();
		const input = startRenaming(onRename);
		fireEvent.change(input, { target: { value: 'Renamed' } });

		const notPrevented = fireEvent.keyDown(input, { key: 'Enter', ...composing });

		expect(notPrevented).toBe(true);
		expect(onRename).not.toHaveBeenCalled();
		expect(screen.getByDisplayValue('Renamed')).toBeTruthy();
	});

	it('still commits on a normal Enter', () => {
		const onRename = vi.fn();
		const input = startRenaming(onRename);
		fireEvent.change(input, { target: { value: 'Renamed' } });

		fireEvent.keyDown(input, { key: 'Enter' });

		expect(onRename).toHaveBeenCalledWith(group.id, 'Renamed');
	});

	it('lets keys other than Enter and Escape bubble out of the rename input', () => {
		const onRename = vi.fn();
		const input = startRenaming(onRename);
		const parentKeyDown = vi.fn();
		input.parentElement?.addEventListener('keydown', parentKeyDown);

		fireEvent.keyDown(input, { key: 'w', metaKey: true });

		expect(parentKeyDown).toHaveBeenCalledTimes(1);
	});
});
