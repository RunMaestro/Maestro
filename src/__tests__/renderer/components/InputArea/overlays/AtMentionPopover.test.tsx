import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AtMentionPopover } from '../../../../../renderer/components/InputArea/overlays/AtMentionPopover';
import { createItemRefs, inputAreaTheme } from '../_fixtures';

describe('AtMentionPopover', () => {
	const suggestions = [
		{
			value: 'src/index.ts',
			type: 'file' as const,
			displayText: 'index.ts',
			fullPath: 'src/index.ts',
		},
		{
			value: 'docs/tasks.md',
			type: 'file' as const,
			displayText: 'tasks.md',
			fullPath: 'docs/tasks.md',
			source: 'autorun' as const,
		},
		{
			value: 'src/utils',
			type: 'folder' as const,
			displayText: 'utils',
			fullPath: 'src/utils',
		},
	];

	function renderPopover(overrides = {}) {
		return render(
			<AtMentionPopover
				isOpen
				isTerminalMode={false}
				suggestions={suggestions}
				selectedIndex={0}
				filter="src"
				startIndex={5}
				inputValue="open @src now"
				itemRefs={createItemRefs<HTMLButtonElement>()}
				theme={inputAreaTheme}
				setInputValue={vi.fn()}
				setOpen={vi.fn()}
				setFilter={vi.fn()}
				setStartIndex={vi.fn()}
				setSelectedIndex={vi.fn()}
				inputRef={{ current: null }}
				{...overrides}
			/>
		);
	}

	it('renders nothing when closed, in terminal mode, or empty', () => {
		const { rerender } = renderPopover({ isOpen: false });
		expect(screen.queryByText('src/index.ts')).not.toBeInTheDocument();

		rerender(
			<AtMentionPopover
				isOpen
				isTerminalMode
				suggestions={suggestions}
				selectedIndex={0}
				filter=""
				startIndex={0}
				inputValue="@"
				itemRefs={createItemRefs<HTMLButtonElement>()}
				theme={inputAreaTheme}
				setInputValue={vi.fn()}
				inputRef={{ current: null }}
			/>
		);
		expect(screen.queryByText('src/index.ts')).not.toBeInTheDocument();

		rerender(
			<AtMentionPopover
				isOpen
				isTerminalMode={false}
				suggestions={[]}
				selectedIndex={0}
				filter=""
				startIndex={0}
				inputValue="@"
				itemRefs={createItemRefs<HTMLButtonElement>()}
				theme={inputAreaTheme}
				setInputValue={vi.fn()}
				inputRef={{ current: null }}
			/>
		);
		expect(screen.queryByText('Files')).not.toBeInTheDocument();
	});

	it('renders filter text, suggestions, type labels, and Auto Run badge', () => {
		renderPopover({ selectedIndex: 2 });

		expect(screen.getByText(/matching "src"/)).toBeInTheDocument();
		expect(screen.getByText('src/index.ts')).toBeInTheDocument();
		expect(screen.getByText('src/utils')).toBeInTheDocument();
		expect(screen.getByText('Auto Run')).toBeInTheDocument();
		expect(screen.getByText('src/utils').closest('button')).toHaveClass('ring-1');
	});

	it('replaces @filter on click and clears mention state', () => {
		const setInputValue = vi.fn();
		const setOpen = vi.fn();
		const setFilter = vi.fn();
		const setStartIndex = vi.fn();
		const setSelectedIndex = vi.fn();
		const focus = vi.fn();
		renderPopover({
			setInputValue,
			setOpen,
			setFilter,
			setStartIndex,
			setSelectedIndex,
			inputRef: { current: { focus } as HTMLTextAreaElement },
		});

		const item = screen.getByText('src/index.ts').closest('button')!;
		fireEvent.mouseEnter(item);
		fireEvent.click(item);

		expect(setSelectedIndex).toHaveBeenCalledWith(0);
		expect(setInputValue).toHaveBeenCalledWith('open @src/index.ts  now');
		expect(setOpen).toHaveBeenCalledWith(false);
		expect(setFilter).toHaveBeenCalledWith('');
		expect(setStartIndex).toHaveBeenCalledWith(-1);
		expect(focus).toHaveBeenCalled();
	});
});
