import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuickActionRow } from '../../../../../renderer/components/QuickActionsModal/components/QuickActionRow';
import { mockTheme } from '../../../../helpers/mockTheme';
import { getShortcutKeys, queryAllShortcutKeys } from '../../../../helpers/shortcutKeys';

// `useShortcutKeys` is the row's ONLY source of truth for the chord to draw.
// It used to return a flat "unbound" here and the row fell back to
// `action.shortcut.keys`, which is the statically-built DEFAULT-mode record -
// so the row re-advertised a chord the live mode may have cleared or displaced,
// and this mock was what made that look correct. The resolver's answer is now
// authoritative, so a test states it per action id instead.
const resolvedShortcuts = vi.hoisted(
	() => new Map<string, { keys: string[]; sequence?: string[][] }>()
);

vi.mock('../../../../../renderer/hooks/keyboard/useShortcutKeys', () => ({
	useShortcutKeys: (actionId?: string) =>
		resolvedShortcuts.get(actionId ?? '') ?? { keys: [], sequence: undefined },
}));

describe('QuickActionRow', () => {
	afterEach(() => resolvedShortcuts.clear());

	it('renders label, subtext, number badge, shortcut, and calls action click handler', () => {
		const onClick = vi.fn();
		resolvedShortcuts.set('settings', { keys: ['Cmd', ','] });
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

	it('draws a sequence-only binding, with no chord beside it', () => {
		// Vim mode binds actions to a sequence alone (`z`, `g g`). The row used
		// to gate the whole cluster on `keys.length`, so those bindings were
		// drawn as nothing at all.
		resolvedShortcuts.set('toggleZenMode', { keys: [], sequence: [['z']] });
		render(
			<QuickActionRow
				action={{
					id: 'toggleZenMode',
					label: 'Toggle Zen Mode',
					shortcut: { id: 'toggleZenMode', keys: [] },
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

		expect(screen.getByText('z')).toBeInTheDocument();
		// No chord, so no "or" joining two triggers.
		expect(screen.queryByText('or')).toBeNull();
	});

	it('ignores the default-mode record when the resolver reports unbound', () => {
		// The row is handed the statically-built record carrying `Cmd+,`, while
		// the live mode has that action cleared. Showing the record's chord would
		// advertise a keypress that no longer reaches the action.
		render(
			<QuickActionRow
				action={{
					id: 'settings',
					label: 'Settings',
					shortcut: { id: 'settings', keys: ['Cmd', ','], enabled: true },
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

		expect(screen.getByRole('button')).toHaveTextContent(/^Settings$/);
	});

	it('draws a per-row literal chord instead of asking the resolver', () => {
		// The agent-jump rows all share the one `jumpToSession` action while each
		// slot answers to its own digit, and `FIXED_SHORTCUTS` spells that family
		// `Opt+Cmd+1-0` - a range for the help list, not a pressable chord. The
		// row has to draw its own digit, so `shortcutKeys` wins over the id.
		resolvedShortcuts.set('jumpToSession', { keys: ['Alt', 'Meta', '1-0'] });
		render(
			<QuickActionRow
				action={{
					id: 'jump-session-3',
					label: 'Jump to: Atlas',
					shortcut: { id: 'jumpToSession', keys: ['Alt', 'Meta', '3'] },
					shortcutKeys: ['Alt', 'Meta', '3'],
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

		expect(getShortcutKeys(['Alt', 'Meta', '3'])).toBeInTheDocument();
		expect(queryAllShortcutKeys(['Alt', 'Meta', '1-0'])).toHaveLength(0);
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
