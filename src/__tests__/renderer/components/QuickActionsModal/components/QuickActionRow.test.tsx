import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuickActionRow } from '../../../../../renderer/components/QuickActionsModal/components/QuickActionRow';
import { mockTheme } from '../../../../helpers/mockTheme';
import { getShortcutKeys } from '../../../../helpers/shortcutKeys';

// Mock useShortcutKeys to return the shortcut's keys directly from the action.
// In real usage, it resolves through the active keyboard mode, but in tests
// we want to display whatever shortcut is passed to the component.
vi.mock('../../../../../renderer/hooks/keyboard/useShortcutKeys', () => ({
	useShortcutKeys: (actionId?: string) => ({
		keys: [],
		sequence: undefined,
	}),
}));

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
