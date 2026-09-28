import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuickActionsSearchBar } from '../../../../../renderer/components/QuickActionsModal/components/QuickActionsSearchBar';
import { createMockSession } from '../../../../helpers/mockSession';
import { mockTheme } from '../../../../helpers/mockTheme';

describe('QuickActionsSearchBar', () => {
	it('renders the main placeholder and forwards search changes', () => {
		const setSearch = vi.fn();
		const onClose = vi.fn();
		render(
			<QuickActionsSearchBar
				theme={mockTheme}
				mode="main"
				activeSession={createMockSession({ name: 'Atlas' })}
				renaming={false}
				search=""
				setSearch={setSearch}
				renameValue=""
				setRenameValue={vi.fn()}
				inputRef={{ current: null }}
				onKeyDown={vi.fn()}
				onClose={onClose}
			/>
		);

		fireEvent.change(screen.getByPlaceholderText('Type a command or jump to agent...'), {
			target: { value: 'search' },
		});
		expect(setSearch).toHaveBeenCalledWith('search');

		// The ESC pill is a real button: pointer-only surfaces need a way out.
		fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('uses mode-specific placeholders and rename input', () => {
		const { rerender } = render(
			<QuickActionsSearchBar
				theme={mockTheme}
				mode="agents"
				activeSession={createMockSession({ name: 'Atlas' })}
				renaming={false}
				search=""
				setSearch={vi.fn()}
				renameValue=""
				setRenameValue={vi.fn()}
				inputRef={{ current: null }}
				onKeyDown={vi.fn()}
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByPlaceholderText('Jump to agent...')).toBeInTheDocument();

		rerender(
			<QuickActionsSearchBar
				theme={mockTheme}
				mode="move-to-group"
				activeSession={createMockSession({ name: 'Atlas' })}
				renaming={false}
				search=""
				setSearch={vi.fn()}
				renameValue=""
				setRenameValue={vi.fn()}
				inputRef={{ current: null }}
				onKeyDown={vi.fn()}
				onClose={vi.fn()}
			/>
		);
		expect(screen.getByPlaceholderText('Move Atlas to...')).toBeInTheDocument();

		rerender(
			<QuickActionsSearchBar
				theme={mockTheme}
				mode="main"
				activeSession={createMockSession({ name: 'Atlas' })}
				renaming={true}
				search=""
				setSearch={vi.fn()}
				renameValue="Atlas"
				setRenameValue={vi.fn()}
				inputRef={{ current: null }}
				onKeyDown={vi.fn()}
				onClose={vi.fn()}
			/>
		);
		expect(screen.getByPlaceholderText('Enter new name...')).toHaveValue('Atlas');
	});
});
