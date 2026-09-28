import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuickActionsList } from '../../../../../renderer/components/QuickActionsModal/components/QuickActionsList';
import type { QuickAction } from '../../../../../renderer/components/QuickActionsModal/types';
import { mockTheme } from '../../../../helpers/mockTheme';

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

// The number badges are the Cmd+1..9 hotkeys. A phone has no keyboard to press
// them on, so the column reads as ten unexplained digits.
vi.mock('../../../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../../renderer/hooks/ui/useViewportBreakpoint')
	>()),
	usePhoneLayout: vi.fn(() => false),
}));
import { usePhoneLayout } from '../../../../../renderer/hooks/ui/useViewportBreakpoint';

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
