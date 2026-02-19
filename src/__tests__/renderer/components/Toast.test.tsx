/**
 * Tests for Toast.tsx
 *
 * Tests the ToastContainer and ToastItem components' core behavior:
 * - Rendering toasts with content
 * - Toast type icons
 * - Metadata display (group, project, tab)
 * - Close button functionality
 * - Session navigation clicks
 * - Animation states
 * - Duration formatting
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastContainer } from '../../../renderer/components/Toast';
import type { Theme } from '../../../renderer/types';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import type { Toast } from '../../../renderer/stores/notificationStore';

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f920',
		accentText: '#f8f8f2',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

const createMockToast = (overrides = {}): Toast => ({
	id: 'toast-1',
	type: 'info',
	title: 'Test Toast',
	message: 'This is a test message',
	timestamp: Date.now(),
	duration: 5000,
	...overrides,
});

/** Helper to set toasts in the store before rendering */
function setStoreToasts(toasts: Toast[]) {
	useNotificationStore.setState({ toasts });
}

describe('Toast', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useNotificationStore.setState({
			toasts: [],
			config: {
				defaultDuration: 20,
				audioFeedbackEnabled: false,
				audioFeedbackCommand: '',
				osNotificationsEnabled: true,
			},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	describe('empty state', () => {
		it('returns null when no toasts', () => {
			const { container } = render(<ToastContainer theme={mockTheme} />);
			expect(container.firstChild).toBeNull();
		});
	});

	describe('rendering toasts', () => {
		it('renders toast with title and message', () => {
			setStoreToasts([createMockToast()]);

			render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByText('Test Toast')).toBeInTheDocument();
			expect(screen.getByText('This is a test message')).toBeInTheDocument();
		});

		it('renders multiple toasts', () => {
			setStoreToasts([
				createMockToast({ id: 'toast-1', title: 'First' }),
				createMockToast({ id: 'toast-2', title: 'Second' }),
			]);

			render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByText('First')).toBeInTheDocument();
			expect(screen.getByText('Second')).toBeInTheDocument();
		});
	});

	describe('toast types', () => {
		it('renders all toast types without error', () => {
			const types = ['success', 'error', 'warning', 'info'] as const;
			types.forEach((type) => {
				setStoreToasts([createMockToast({ type, title: `${type} toast` })]);

				const { unmount } = render(<ToastContainer theme={mockTheme} />);
				expect(screen.getByText(`${type} toast`)).toBeInTheDocument();
				unmount();
			});
		});
	});

	describe('metadata display', () => {
		it('displays group, project, and tab when provided', () => {
			setStoreToasts([
				createMockToast({
					group: 'Test Group',
					project: 'My Project',
					tabName: 'Tab 1',
				}),
			]);

			render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByText('Test Group')).toBeInTheDocument();
			expect(screen.getByText('My Project')).toBeInTheDocument();
			expect(screen.getByText('Tab 1')).toBeInTheDocument();
		});

		it('shows agentSessionId as title attribute on tab name', () => {
			setStoreToasts([
				createMockToast({
					tabName: 'Tab 1',
					agentSessionId: 'abc-123',
				}),
			]);

			render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByText('Tab 1')).toHaveAttribute('title', 'Claude Session: abc-123');
		});
	});

	describe('duration badge', () => {
		it('formats duration correctly', () => {
			const testCases = [
				{ duration: 500, expected: '500ms' },
				{ duration: 5000, expected: '5s' },
				{ duration: 125000, expected: '2m 5s' },
				{ duration: 120000, expected: '2m' },
			];

			testCases.forEach(({ duration, expected }) => {
				setStoreToasts([createMockToast({ taskDuration: duration })]);

				const { unmount } = render(<ToastContainer theme={mockTheme} />);
				expect(screen.getByText(new RegExp(`Completed in ${expected}`))).toBeInTheDocument();
				unmount();
			});
		});

		it('does not display when taskDuration is 0 or undefined', () => {
			setStoreToasts([createMockToast({ taskDuration: 0 })]);

			render(<ToastContainer theme={mockTheme} />);
			expect(screen.queryByText(/Completed in/)).not.toBeInTheDocument();
		});
	});

	describe('close button', () => {
		it('calls removeToast when clicked', async () => {
			setStoreToasts([createMockToast()]);

			render(<ToastContainer theme={mockTheme} />);
			const closeButton = screen.getAllByRole('button')[0];
			fireEvent.click(closeButton);

			act(() => {
				vi.advanceTimersByTime(300);
			});

			// Toast should be removed from the store
			expect(useNotificationStore.getState().toasts).toHaveLength(0);
		});
	});

	describe('session navigation', () => {
		it('calls onSessionClick with sessionId when toast is clicked', () => {
			const onSessionClick = vi.fn();
			setStoreToasts([createMockToast({ sessionId: 'session-1' })]);

			const { container } = render(
				<ToastContainer theme={mockTheme} onSessionClick={onSessionClick} />
			);
			const clickableToast = container.querySelector('.cursor-pointer');
			fireEvent.click(clickableToast!);

			expect(onSessionClick).toHaveBeenCalledWith('session-1', undefined);
		});

		it('includes tabId when provided', () => {
			const onSessionClick = vi.fn();
			setStoreToasts([createMockToast({ sessionId: 'session-1', tabId: 'tab-1' })]);

			const { container } = render(
				<ToastContainer theme={mockTheme} onSessionClick={onSessionClick} />
			);
			const clickableToast = container.querySelector('.cursor-pointer');
			fireEvent.click(clickableToast!);

			expect(onSessionClick).toHaveBeenCalledWith('session-1', 'tab-1');
		});

		it('is not clickable without sessionId', () => {
			const onSessionClick = vi.fn();
			setStoreToasts([createMockToast()]);

			const { container } = render(
				<ToastContainer theme={mockTheme} onSessionClick={onSessionClick} />
			);
			expect(container.querySelector('.cursor-pointer')).not.toBeInTheDocument();
		});
	});

	describe('animation states', () => {
		it('starts with entering animation then transitions to normal', () => {
			setStoreToasts([createMockToast()]);

			const { container } = render(<ToastContainer theme={mockTheme} />);
			const toastOuter = container.querySelector('.relative.overflow-hidden');

			// Initially entering
			expect(toastOuter).toHaveStyle({ transform: 'translateX(100%)' });

			// After enter animation
			act(() => {
				vi.advanceTimersByTime(50);
			});
			expect(toastOuter).toHaveStyle({ transform: 'translateX(0)' });
		});
	});

	describe('progress bar', () => {
		it('renders when duration is provided', () => {
			setStoreToasts([createMockToast({ duration: 5000 })]);

			const { container } = render(<ToastContainer theme={mockTheme} />);
			expect(container.querySelector('.h-1.rounded-b-lg')).toBeInTheDocument();
		});

		it('does not render when duration is 0', () => {
			setStoreToasts([createMockToast({ duration: 0 })]);

			const { container } = render(<ToastContainer theme={mockTheme} />);
			expect(container.querySelector('.h-1.rounded-b-lg')).not.toBeInTheDocument();
		});
	});

	describe('action URL link', () => {
		it('renders action link when actionUrl is provided', () => {
			setStoreToasts([
				createMockToast({
					actionUrl: 'https://github.com/org/repo/pull/1',
					actionLabel: 'View PR',
				}),
			]);

			render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByText('View PR')).toBeInTheDocument();
		});

		it('uses actionUrl as label when actionLabel is not provided', () => {
			setStoreToasts([
				createMockToast({
					actionUrl: 'https://github.com/org/repo/pull/1',
				}),
			]);

			render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByText('https://github.com/org/repo/pull/1')).toBeInTheDocument();
		});

		it('opens external URL when action link is clicked', () => {
			setStoreToasts([
				createMockToast({
					actionUrl: 'https://github.com/org/repo/pull/1',
					actionLabel: 'View PR',
				}),
			]);

			render(<ToastContainer theme={mockTheme} />);
			fireEvent.click(screen.getByText('View PR'));
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
				'https://github.com/org/repo/pull/1'
			);
		});

		it('does not render action link when actionUrl is not provided', () => {
			setStoreToasts([createMockToast()]);

			render(<ToastContainer theme={mockTheme} />);
			// No anchor/button with link behavior beyond the close button
			const buttons = screen.getAllByRole('button');
			expect(buttons).toHaveLength(1); // only the close button
		});
	});

	describe('close button does not trigger navigation', () => {
		it('close click does not call onSessionClick', () => {
			const onSessionClick = vi.fn();
			setStoreToasts([createMockToast({ sessionId: 'session-1' })]);

			render(<ToastContainer theme={mockTheme} onSessionClick={onSessionClick} />);
			// Close button is the last button (the X icon)
			const buttons = screen.getAllByRole('button');
			const closeButton = buttons[buttons.length - 1];
			fireEvent.click(closeButton);

			// onSessionClick should NOT be called from close
			// (onSessionClick triggers from the toast body click)
			expect(onSessionClick).not.toHaveBeenCalled();
		});
	});

	describe('no metadata row', () => {
		it('does not render metadata section when no group/project/tabName', () => {
			setStoreToasts([createMockToast()]);

			const { container } = render(<ToastContainer theme={mockTheme} />);
			// The metadata row has accentDim styled spans - should not exist
			const accentSpans = container.querySelectorAll('.px-1\\.5.py-0\\.5.rounded');
			expect(accentSpans).toHaveLength(0);
		});
	});

	describe('store reactivity', () => {
		it('re-renders when toasts are added to the store after mount', () => {
			render(<ToastContainer theme={mockTheme} />);
			expect(screen.queryByText('Dynamic Toast')).not.toBeInTheDocument();

			// Add toast to store after render
			act(() => {
				useNotificationStore
					.getState()
					.addToast(createMockToast({ id: 'dynamic-1', title: 'Dynamic Toast' }));
			});

			expect(screen.getByText('Dynamic Toast')).toBeInTheDocument();
		});

		it('re-renders when toasts are removed from the store', () => {
			setStoreToasts([createMockToast({ id: 'removable', title: 'Will Vanish' })]);

			render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByText('Will Vanish')).toBeInTheDocument();

			act(() => {
				useNotificationStore.getState().removeToast('removable');
			});

			expect(screen.queryByText('Will Vanish')).not.toBeInTheDocument();
		});
	});

	describe('duration formatting edge cases', () => {
		it('formats hours correctly', () => {
			setStoreToasts([createMockToast({ taskDuration: 3661000 })]);

			const { unmount } = render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByText(/Completed in 1h 1m 1s/)).toBeInTheDocument();
			unmount();
		});

		it('formats days correctly', () => {
			// 1 day, 2 hours, 3 minutes (seconds omitted when days present)
			setStoreToasts([createMockToast({ taskDuration: 93780000 })]);

			const { unmount } = render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByText(/Completed in 1d 2h 3m/)).toBeInTheDocument();
			unmount();
		});

		it('shows 0s for exactly 0ms edge (not rendered due to guard)', () => {
			// taskDuration of 0 is guarded — "does not display" already tested
			// But let's verify sub-second with exact 1000ms boundary
			setStoreToasts([createMockToast({ taskDuration: 1000 })]);

			const { unmount } = render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByText(/Completed in 1s/)).toBeInTheDocument();
			unmount();
		});
	});
});
