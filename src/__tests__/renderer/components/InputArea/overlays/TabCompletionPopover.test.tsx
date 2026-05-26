import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TabCompletionPopover } from '../../../../../renderer/components/InputArea/overlays/TabCompletionPopover';
import { createItemRefs, inputAreaTheme } from '../_fixtures';

describe('TabCompletionPopover', () => {
	const suggestions = [
		{ value: 'ls -la', displayText: 'ls -la', type: 'history' as const },
		{ value: 'git checkout main', displayText: 'main', type: 'branch' as const },
		{ value: 'src/', displayText: 'src', type: 'folder' as const },
	];

	function renderPopover(overrides = {}) {
		return render(
			<TabCompletionPopover
				isOpen
				isTerminalMode
				isGitRepo
				suggestions={suggestions}
				selectedIndex={0}
				filter="all"
				itemRefs={createItemRefs<HTMLButtonElement>()}
				theme={inputAreaTheme}
				setInputValue={vi.fn()}
				setOpen={vi.fn()}
				setFilter={vi.fn()}
				setSelectedIndex={vi.fn()}
				inputRef={{ current: null }}
				{...overrides}
			/>
		);
	}

	it('renders nothing outside terminal mode or when closed', () => {
		const { rerender } = renderPopover({ isOpen: false });
		expect(screen.queryByText('Tab Completion')).not.toBeInTheDocument();

		rerender(
			<TabCompletionPopover
				isOpen
				isTerminalMode={false}
				suggestions={suggestions}
				selectedIndex={0}
				filter="all"
				itemRefs={createItemRefs<HTMLButtonElement>()}
				theme={inputAreaTheme}
				setInputValue={vi.fn()}
				setOpen={vi.fn()}
				setFilter={vi.fn()}
				setSelectedIndex={vi.fn()}
				isGitRepo={false}
				inputRef={{ current: null }}
			/>
		);
		expect(screen.queryByText('Tab Completion')).not.toBeInTheDocument();
	});

	it('renders suggestions and git filter buttons', () => {
		renderPopover({ selectedIndex: 1 });

		expect(screen.getByText('Tab Completion')).toBeInTheDocument();
		expect(screen.getByText('ls -la')).toBeInTheDocument();
		expect(screen.getByText('Branches')).toBeInTheDocument();
		expect(screen.getByText('main').closest('button')).toHaveClass('ring-1');
	});

	it('hides git filters when not in a git repo', () => {
		renderPopover({ isGitRepo: false });

		expect(screen.queryByText('Branches')).not.toBeInTheDocument();
		expect(screen.queryByText('Tags')).not.toBeInTheDocument();
	});

	it('changes filter and resets selected index', () => {
		const setFilter = vi.fn();
		const setSelectedIndex = vi.fn();
		renderPopover({ setFilter, setSelectedIndex });

		fireEvent.click(screen.getByText('Branches'));

		expect(setFilter).toHaveBeenCalledWith('branch');
		expect(setSelectedIndex).toHaveBeenCalledWith(0);
	});

	it('selects suggestion on click and hover', () => {
		const setInputValue = vi.fn();
		const setOpen = vi.fn();
		const setSelectedIndex = vi.fn();
		const focus = vi.fn();
		renderPopover({
			setInputValue,
			setOpen,
			setSelectedIndex,
			inputRef: { current: { focus } as HTMLTextAreaElement },
		});

		const branch = screen.getByText('main').closest('button')!;
		fireEvent.mouseEnter(branch);
		fireEvent.click(branch);

		expect(setSelectedIndex).toHaveBeenCalledWith(1);
		expect(setInputValue).toHaveBeenCalledWith('git checkout main');
		expect(setOpen).toHaveBeenCalledWith(false);
		expect(focus).toHaveBeenCalled();
	});

	it('renders filter-specific empty state', () => {
		renderPopover({ suggestions: [], filter: 'branch' });

		expect(screen.getByText('No matching branches')).toBeInTheDocument();
	});
});
