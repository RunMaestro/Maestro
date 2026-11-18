import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandHistoryPopover } from '../../../../../renderer/components/InputArea/overlays/CommandHistoryPopover';
import { inputAreaTheme } from '../_fixtures';

describe('CommandHistoryPopover', () => {
	function renderPopover(overrides = {}) {
		return render(
			<CommandHistoryPopover
				isOpen
				isTerminalMode={false}
				filter=""
				selectedIndex={0}
				filteredHistory={['hello world', 'explain code']}
				theme={inputAreaTheme}
				setFilter={vi.fn()}
				setOpen={vi.fn()}
				setSelectedIndex={vi.fn()}
				setInputValue={vi.fn()}
				inputRef={{ current: null }}
				{...overrides}
			/>
		);
	}

	it('renders nothing when closed', () => {
		renderPopover({ isOpen: false });

		expect(screen.queryByText('hello world')).not.toBeInTheDocument();
	});

	it('uses AI and terminal placeholders/empty text', () => {
		const { rerender } = renderPopover({ filteredHistory: [] });

		expect(screen.getByPlaceholderText('Filter messages...')).toBeInTheDocument();
		expect(screen.getByText('No matching messages')).toBeInTheDocument();

		rerender(
			<CommandHistoryPopover
				isOpen
				isTerminalMode
				filter=""
				selectedIndex={0}
				filteredHistory={[]}
				theme={inputAreaTheme}
				setFilter={vi.fn()}
				setOpen={vi.fn()}
				setSelectedIndex={vi.fn()}
				setInputValue={vi.fn()}
				inputRef={{ current: null }}
			/>
		);

		expect(screen.getByPlaceholderText('Filter commands...')).toBeInTheDocument();
		expect(screen.getByText('No matching commands')).toBeInTheDocument();
	});

	it('updates filter and resets selection', () => {
		const setFilter = vi.fn();
		const setSelectedIndex = vi.fn();
		renderPopover({ setFilter, setSelectedIndex });

		fireEvent.change(screen.getByPlaceholderText('Filter messages...'), {
			target: { value: 'hello' },
		});

		expect(setFilter).toHaveBeenCalledWith('hello');
		expect(setSelectedIndex).toHaveBeenCalledWith(0);
	});

	it('handles keyboard navigation, Enter, and Escape', () => {
		vi.useFakeTimers();
		const setSelectedIndex = vi.fn();
		const setInputValue = vi.fn();
		const setOpen = vi.fn();
		const setFilter = vi.fn();
		const focus = vi.fn();
		renderPopover({
			setSelectedIndex,
			setInputValue,
			setOpen,
			setFilter,
			inputRef: { current: { focus } as HTMLTextAreaElement },
		});

		const filter = screen.getByPlaceholderText('Filter messages...');
		fireEvent.keyDown(filter, { key: 'ArrowDown' });
		fireEvent.keyDown(filter, { key: 'ArrowUp' });
		fireEvent.keyDown(filter, { key: 'Enter' });
		fireEvent.keyDown(filter, { key: 'Escape' });
		vi.runAllTimers();

		expect(setSelectedIndex).toHaveBeenCalledWith(1);
		expect(setSelectedIndex).toHaveBeenCalledWith(0);
		expect(setInputValue).toHaveBeenCalledWith('hello world');
		expect(setOpen).toHaveBeenCalledWith(false);
		expect(setFilter).toHaveBeenCalledWith('');
		expect(focus).toHaveBeenCalled();
		vi.useRealTimers();
	});

	it('selects a history item on click and updates hover selection', () => {
		const setInputValue = vi.fn();
		const setSelectedIndex = vi.fn();
		const focus = vi.fn();
		renderPopover({
			setInputValue,
			setSelectedIndex,
			inputRef: { current: { focus } as HTMLTextAreaElement },
		});

		const second = screen.getByText('explain code');
		fireEvent.mouseEnter(second);
		fireEvent.click(second);

		expect(setSelectedIndex).toHaveBeenCalledWith(1);
		expect(setInputValue).toHaveBeenCalledWith('explain code');
		expect(focus).toHaveBeenCalled();
	});

	it('does not select or close on Enter during active IME composition (isComposing: true)', () => {
		const setInputValue = vi.fn();
		const setOpen = vi.fn();
		renderPopover({ setInputValue, setOpen });

		const filter = screen.getByPlaceholderText('Filter messages...');
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		Object.defineProperty(event, 'isComposing', { value: true });
		const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

		filter.dispatchEvent(event);

		expect(setInputValue).not.toHaveBeenCalled();
		expect(setOpen).not.toHaveBeenCalled();
		expect(preventDefaultSpy).not.toHaveBeenCalled();
	});

	it('does not select or close on Enter during Safari IME confirmation (keyCode 229)', () => {
		const setInputValue = vi.fn();
		const setOpen = vi.fn();
		renderPopover({ setInputValue, setOpen });

		const filter = screen.getByPlaceholderText('Filter messages...');
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		Object.defineProperty(event, 'keyCode', { value: 229 });
		const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

		filter.dispatchEvent(event);

		expect(setInputValue).not.toHaveBeenCalled();
		expect(setOpen).not.toHaveBeenCalled();
		expect(preventDefaultSpy).not.toHaveBeenCalled();
	});
});
