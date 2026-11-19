// Source: src/__tests__/renderer/components/TabBar/NewTabPopover.test.tsx
// Source: src/__tests__/renderer/components/TabBar/TabBar.slots.test.tsx
// Source: src/__tests__/renderer/components/TabBar/AITab.relay.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { act } from '@testing-library/react';
import { NewTabPopover } from '../../../../renderer/components/TabBar/NewTabPopover';
import { HOVER_POPOVER_OPEN_DELAY_MS } from '../../../../renderer/hooks/ui/useHoverPopover';
import { mockTheme } from '../../../helpers/mockTheme';
import React from 'react';
import { TabBar } from '../../../../renderer/components/TabBar';
import type { AITab } from '../../../../renderer/types';
import { AITab as AITabView } from '../../../../renderer/components/TabBar/AITab';
import { createMockAITab } from '../../../helpers/mockTab';

describeSourceSuite('NewTabPopover', () => {
	function renderPopover() {
		const props = {
			theme: mockTheme,
			onNewTab: vi.fn(),
			onNewFileTab: vi.fn(),
			onNewBrowserTab: vi.fn(),
			onNewTerminalTab: vi.fn(),
			newTabKeys: ['Meta', 't'],
			fileTabKeys: ['Meta', 'o'],
			browserTabKeys: ['Meta', 'l'],
			terminalKeys: ['Meta', 'j'],
			isOverflowing: false,
		};
		render(<NewTabPopover {...props} />);
		return props;
	}

	describe('NewTabPopover', () => {
		it('opens a menu whose chord badges are all tagged as shortcut hints', () => {
			renderPopover();
			fireEvent.click(screen.getByTitle('New tab…'));
			expect(screen.getByText('New Terminal')).toBeInTheDocument();
			const badges = document.querySelectorAll('[data-shortcut-keys]');
			expect(badges.length).toBeGreaterThanOrEqual(3);
			for (const badge of badges) {
				expect(badge).toHaveAttribute('data-shortcut-hint');
			}
		});

		it('peeks the menu on mouse hover without a click', () => {
			vi.useFakeTimers();
			try {
				renderPopover();
				fireEvent.pointerEnter(screen.getByTitle('New tab…'), { pointerType: 'mouse' });
				act(() => {
					vi.advanceTimersByTime(HOVER_POPOVER_OPEN_DELAY_MS);
				});
				expect(screen.getByText('New Terminal')).toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it('does not peek on hover when the + has no menu (AI tabs only)', () => {
			vi.useFakeTimers();
			try {
				const onNewTab = vi.fn();
				render(
					<NewTabPopover
						theme={mockTheme}
						onNewTab={onNewTab}
						newTabKeys={['Meta', 't']}
						fileTabKeys={['Meta', 'o']}
						browserTabKeys={['Meta', 'l']}
						terminalKeys={['Meta', 'j']}
						isOverflowing={false}
					/>
				);
				const button = screen.getByRole('button');
				fireEvent.pointerEnter(button, { pointerType: 'mouse' });
				act(() => {
					vi.advanceTimersByTime(HOVER_POPOVER_OPEN_DELAY_MS);
				});
				expect(screen.queryByText('New AI Chat')).not.toBeInTheDocument();
				fireEvent.click(button);
				expect(onNewTab).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it('runs the chosen handler and closes', () => {
			const props = renderPopover();
			fireEvent.click(screen.getByTitle('New tab…'));
			fireEvent.click(screen.getByText('New Terminal'));
			expect(props.onNewTerminalTab).toHaveBeenCalledTimes(1);
			expect(screen.queryByText('New Terminal')).not.toBeInTheDocument();
		});
	});
});
describeSourceSuite('TabBar.slots', () => {
	function baseTab(): AITab {
		return {
			id: 't1',
			agentSessionId: null,
			name: null,
			starred: false,
			logs: [],
			inputValue: '',
			stagedImages: [],
			createdAt: Date.now(),
			state: 'idle',
		};
	}

	function renderTabBar(extra?: { leadingSlot?: React.ReactNode }) {
		return render(
			<TabBar
				tabs={[baseTab()]}
				activeTabId="t1"
				theme={mockTheme}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
				{...extra}
			/>
		);
	}

	describe('TabBar pinned slots', () => {
		it('renders the leading slot node when leadingSlot is provided', () => {
			renderTabBar({ leadingSlot: <div data-testid="probe-lead" /> });

			expect(screen.getByTestId('probe-lead')).toBeInTheDocument();
		});

		it('renders no slot node when no slot is provided', () => {
			renderTabBar();

			expect(screen.queryByTestId('probe-lead')).not.toBeInTheDocument();
		});
	});
});
describe('AITab.relay', () => {
	describe('AI tab Relay provenance', () => {
		it.each(['idle', 'busy'] as const)(
			'shows origin independently of %s state, including after reload',
			(state) => {
				const tab = JSON.parse(
					JSON.stringify(createMockAITab({ origin: 'relay', state, name: 'Conversation' }))
				);
				const props = {
					tab,
					tabId: tab.id,
					isActive: false,
					theme: mockTheme,
					canClose: true,
					onSelect: vi.fn(),
					onClose: vi.fn(),
					onDragStart: vi.fn(),
					onDragOver: vi.fn(),
					onDragEnd: vi.fn(),
					onDrop: vi.fn(),
					isDragging: false,
					isDragOver: false,
					onRename: vi.fn(),
				};
				const view = render(<AITabView {...props} />);
				expect(screen.getByText('Relay')).toBeInTheDocument();
				view.rerender(<AITabView {...props} tab={{ ...tab, origin: 'user' }} />);
				expect(screen.queryByText('Relay')).not.toBeInTheDocument();
			}
		);
	});
});
