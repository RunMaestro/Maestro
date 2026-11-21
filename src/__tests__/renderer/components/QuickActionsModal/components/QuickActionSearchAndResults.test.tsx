// Source: src/__tests__/renderer/components/QuickActionsModal/components/QuickActionsList.test.tsx
// Source: src/__tests__/renderer/components/QuickActionsModal/components/QuickActionRow.test.tsx
// Source: src/__tests__/renderer/components/QuickActionsModal/components/RunningAgentSubtext.test.tsx
// Source: src/__tests__/renderer/components/QuickActionsModal/components/QuickActionsSearchBar.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { QuickActionsList } from '../../../../../renderer/components/QuickActionsModal/components/QuickActionsList';
import type { QuickAction } from '../../../../../renderer/components/QuickActionsModal/types';
import { mockTheme } from '../../../../helpers/mockTheme';
import { usePhoneLayout } from '../../../../../renderer/hooks/ui/useViewportBreakpoint';
import { QuickActionRow } from '../../../../../renderer/components/QuickActionsModal/components/QuickActionRow';
import { getShortcutKeys } from '../../../../helpers/shortcutKeys';
import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { RunningAgentSubtext } from '../../../../../renderer/components/QuickActionsModal/components/RunningAgentSubtext';
import { QuickActionsSearchBar } from '../../../../../renderer/components/QuickActionsModal/components/QuickActionsSearchBar';
import { createMockSession } from '../../../../helpers/mockSession';

vi.mock('../../../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../../renderer/hooks/ui/useViewportBreakpoint')
	>()),
	usePhoneLayout: vi.fn(() => false),
}));
describeSourceSuite('QuickActionsList', () => {
	const action = (id: string, label: string, isRunningAgent?: boolean): QuickAction => ({
		id,
		label,
		isRunningAgent,
		action: vi.fn(),
	});

	describe('QuickActionsList', () => {
		it('renders rows, live/idle headers, and no-actions state', () => {
			const onActionClick = vi.fn();
			const { rerender } = render(
				<QuickActionsList
					filtered={[action('live', 'Live Agent', true), action('idle', 'Idle Agent', false)]}
					selectedIndex={0}
					firstVisibleIndex={0}
					showBucketHeaders={true}
					now={0}
					theme={mockTheme}
					scrollContainerRef={{ current: null }}
					selectedItemRef={{ current: null }}
					onScroll={vi.fn()}
					onActionClick={onActionClick}
				/>
			);

			expect(screen.getByText('LIVE')).toBeInTheDocument();
			expect(screen.getByText('IDLE')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Live Agent'));
			expect(onActionClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'live' }));

			rerender(
				<QuickActionsList
					filtered={[]}
					selectedIndex={0}
					firstVisibleIndex={0}
					showBucketHeaders={false}
					now={0}
					theme={mockTheme}
					scrollContainerRef={{ current: null }}
					selectedItemRef={{ current: null }}
					onScroll={vi.fn()}
					onActionClick={vi.fn()}
				/>
			);
			expect(screen.getByText('No actions found')).toBeInTheDocument();
		});
	});

	describe('QuickActionsList on a phone', () => {
		const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);
		const props = {
			filtered: [action('a', 'Alpha'), action('b', 'Beta')],
			selectedIndex: 0,
			firstVisibleIndex: 0,
			showBucketHeaders: false,
			now: 0,
			theme: mockTheme,
			scrollContainerRef: { current: null },
			selectedItemRef: { current: null },
			onScroll: vi.fn(),
			onActionClick: vi.fn(),
		};

		it('numbers the rows on desktop', () => {
			mockedUsePhoneLayout.mockReturnValue(false);
			render(<QuickActionsList {...props} />);
			expect(screen.getByText('1')).toBeInTheDocument();
			expect(screen.getByText('2')).toBeInTheDocument();
		});

		it('drops the hotkey numbers on a phone', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			render(<QuickActionsList {...props} />);
			expect(screen.queryByText('1')).not.toBeInTheDocument();
			expect(screen.queryByText('2')).not.toBeInTheDocument();
			expect(screen.getByText('Alpha')).toBeInTheDocument();
			mockedUsePhoneLayout.mockReturnValue(false);
		});
	});
});
describeSourceSuite('QuickActionRow', () => {
	describe('QuickActionRow', () => {
		it('renders label, subtext, number badge, shortcut, and calls action click handler', () => {
			const onClick = vi.fn();
			const action = {
				id: 'settings',
				label: 'Settings',
				subtext: 'Open settings',
				shortcut: { id: 'settings', keys: ['Cmd', ','], enabled: true },
				action: vi.fn(),
			};

			render(
				<QuickActionRow
					action={action}
					isSelected={true}
					showNumber={true}
					numberBadge={1}
					now={1000}
					theme={mockTheme}
					selectedItemRef={{ current: null }}
					onClick={onClick}
				/>
			);

			expect(screen.getByText('Settings')).toBeInTheDocument();
			expect(screen.getByText('Open settings')).toBeInTheDocument();
			expect(screen.getByText('1')).toBeInTheDocument();
			expect(getShortcutKeys(['Cmd', ','])).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button'));
			expect(onClick).toHaveBeenCalledWith(action);
		});

		it('draws no key-cap for an action that ships unbound', () => {
			// An unbound action still carries its shortcut record, so a presence-only
			// check would paint an empty chip where a chord belongs.
			render(
				<QuickActionRow
					action={{
						id: 'gitPull',
						label: 'Git Pull',
						shortcut: { id: 'gitPull', keys: [] },
						action: vi.fn(),
					}}
					isSelected={false}
					showNumber={false}
					now={1000}
					theme={mockTheme}
					selectedItemRef={{ current: null }}
					onClick={vi.fn()}
				/>
			);

			expect(screen.getByRole('button')).toHaveTextContent(/^Git Pull$/);
		});

		it('renders running status and Auto Run badge', () => {
			render(
				<QuickActionRow
					action={{
						id: 'agent',
						label: 'Atlas',
						action: vi.fn(),
						isInBatch: true,
						runningInfo: {
							state: 'busy',
							thinkingStartTime: 0,
							busyTabName: 'Tab 1',
							queueCount: 2,
						},
					}}
					isSelected={false}
					showNumber={false}
					numberBadge={1}
					now={2000}
					theme={mockTheme}
					selectedItemRef={{ current: null }}
					onClick={vi.fn()}
				/>
			);

			expect(screen.getByText('Atlas')).toBeInTheDocument();
			expect(screen.getByText('AUTO')).toBeInTheDocument();
			expect(screen.getByText(/Tab 1/)).toBeInTheDocument();
			expect(screen.getByText(/2 queued/)).toBeInTheDocument();
		});
		it('fills the AUTO pill to the run percent and prints it', () => {
			render(
				<QuickActionRow
					action={{
						id: 'agent',
						label: 'Atlas',
						action: vi.fn(),
						isInBatch: true,
						autoRunProgress: { percent: 42, goalMode: false },
					}}
					isSelected={false}
					showNumber={false}
					now={1000}
					theme={mockTheme}
					selectedItemRef={{ current: null }}
					onClick={vi.fn()}
				/>
			);

			expect(screen.getByText('42%')).toBeInTheDocument();
			expect(screen.getByTestId('auto-run-pill-fill')).toHaveStyle({ width: '42%' });
			expect(screen.getByTitle('Auto Run active: 42% complete')).toBeInTheDocument();
		});

		it('marks a goal-mode percent as an estimate', () => {
			render(
				<QuickActionRow
					action={{
						id: 'agent',
						label: 'Atlas',
						action: vi.fn(),
						isInBatch: true,
						autoRunProgress: { percent: 70, goalMode: true },
					}}
					isSelected={false}
					showNumber={false}
					now={1000}
					theme={mockTheme}
					selectedItemRef={{ current: null }}
					onClick={vi.fn()}
				/>
			);

			expect(screen.getByText('~70%')).toBeInTheDocument();
		});

		it('draws a plain AUTO pill when no progress is known', () => {
			render(
				<QuickActionRow
					action={{ id: 'agent', label: 'Atlas', action: vi.fn(), isInBatch: true }}
					isSelected={false}
					showNumber={false}
					now={1000}
					theme={mockTheme}
					selectedItemRef={{ current: null }}
					onClick={vi.fn()}
				/>
			);

			expect(screen.getByTitle('Auto Run active')).toBeInTheDocument();
			expect(screen.queryByTestId('auto-run-pill-fill')).toBeNull();
		});
	});
});

__maestroMicrobenchDescribe('RunningAgentSubtext', () => {
	describe('RunningAgentSubtext', () => {
		it('renders elapsed time, busy tab name, and queue count', () => {
			render(
				<RunningAgentSubtext
					info={{
						state: 'busy',
						thinkingStartTime: 0,
						busyTabName: 'Planner',
						queueCount: 3,
					}}
					now={3000}
					theme={mockTheme}
					isSelected={false}
				/>
			);

			expect(screen.getByText(/3s/)).toBeInTheDocument();
			expect(screen.getByText(/Planner/)).toBeInTheDocument();
			expect(screen.getByText(/3 queued/)).toBeInTheDocument();
		});
	});
});
__maestroMicrobenchDescribe('QuickActionsSearchBar', () => {
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
});
