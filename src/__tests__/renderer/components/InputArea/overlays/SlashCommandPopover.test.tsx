import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SlashCommandPopover } from '../../../../../renderer/components/InputArea/overlays/SlashCommandPopover';
import { createItemRefs, inputAreaTheme } from '../_fixtures';

describe('SlashCommandPopover', () => {
	const commands = [
		{ command: '/clear', description: 'Clear chat history' },
		{ command: '/help', description: 'Show help' },
	];

	it('renders nothing when closed or empty', () => {
		const { rerender } = render(
			<SlashCommandPopover
				isOpen={false}
				commands={commands}
				inputValueLower="/"
				selectedIndex={0}
				itemRefs={createItemRefs<HTMLButtonElement>()}
				theme={inputAreaTheme}
				setInputValue={vi.fn()}
				setSlashCommandOpen={vi.fn()}
				setSelectedSlashCommandIndex={vi.fn()}
				inputRef={{ current: null }}
			/>
		);

		expect(screen.queryByText('/clear')).not.toBeInTheDocument();

		rerender(
			<SlashCommandPopover
				isOpen
				commands={[]}
				inputValueLower="/"
				selectedIndex={0}
				itemRefs={createItemRefs<HTMLButtonElement>()}
				theme={inputAreaTheme}
				setInputValue={vi.fn()}
				setSlashCommandOpen={vi.fn()}
				setSelectedSlashCommandIndex={vi.fn()}
				inputRef={{ current: null }}
			/>
		);

		expect(screen.queryByText('/clear')).not.toBeInTheDocument();
	});

	it('renders commands, descriptions, and selected styling', () => {
		render(
			<SlashCommandPopover
				isOpen
				commands={commands}
				inputValueLower="/"
				selectedIndex={1}
				itemRefs={createItemRefs<HTMLButtonElement>()}
				theme={inputAreaTheme}
				setInputValue={vi.fn()}
				setSlashCommandOpen={vi.fn()}
				setSelectedSlashCommandIndex={vi.fn()}
				inputRef={{ current: null }}
			/>
		);

		expect(screen.getByText('/clear')).toBeInTheDocument();
		expect(screen.getByText('Show help')).toBeInTheDocument();
		expect(screen.getByText('/help').closest('button')).toHaveClass('font-semibold');
	});

	it('selects on click and mouse enter, fills on double-click', () => {
		const setSelected = vi.fn();
		const setInputValue = vi.fn();
		const setOpen = vi.fn();
		const focus = vi.fn();

		render(
			<SlashCommandPopover
				isOpen
				commands={commands}
				inputValueLower="/"
				selectedIndex={0}
				itemRefs={createItemRefs<HTMLButtonElement>()}
				theme={inputAreaTheme}
				setInputValue={setInputValue}
				setSlashCommandOpen={setOpen}
				setSelectedSlashCommandIndex={setSelected}
				inputRef={{ current: { focus } as HTMLTextAreaElement }}
			/>
		);

		const help = screen.getByText('/help').closest('button')!;
		fireEvent.mouseEnter(help);
		fireEvent.click(help);
		fireEvent.doubleClick(help);

		expect(setSelected).toHaveBeenCalledWith(1);
		expect(setInputValue).toHaveBeenCalledWith('/help');
		expect(setOpen).toHaveBeenCalledWith(false);
		expect(focus).toHaveBeenCalled();
	});
});
