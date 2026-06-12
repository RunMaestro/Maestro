import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuickActionRow } from '../../../../../renderer/components/QuickActionsModal/components/QuickActionRow';
import { mockTheme } from '../../../../helpers/mockTheme';

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
		expect(screen.getByText('Cmd+,')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button'));
		expect(onClick).toHaveBeenCalledWith(action);
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
});
