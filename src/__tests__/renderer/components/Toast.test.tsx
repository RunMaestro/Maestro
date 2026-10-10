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
import { ToastContainer, buildToastClipboardText } from '../../../renderer/components/Toast';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useToastAvoidZoneStore } from '../../../renderer/hooks/ui/useToastAvoidZone';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Toast } from '../../../renderer/stores/notificationStore';
import { mockTheme } from '../../helpers/mockTheme';
import { usePhoneLayout } from '../../../renderer/hooks/ui/useViewportBreakpoint';
import { useMediaPlaybackStore } from '../../../renderer/stores/mediaPlaybackStore';

vi.mock('../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/hooks/ui/useViewportBreakpoint')>()),
	usePhoneLayout: vi.fn(() => false),
}));

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
			render(<ToastContainer theme={mockTheme} />);
			// Portal renders to document.body, so no toast elements should exist
			expect(document.body.querySelector('.fixed.bottom-4')).toBeNull();
		});
	});

	describe('interface font', () => {
		it('restates the interface font on the portal root', () => {
			// Toasts portal to document.body, OUTSIDE the app shell that carries
			// the interface font, so without this they inherit the body default
			// and a user who changed the UI font kept getting the old one.
			useSettingsStore.setState({ fontFamily: 'Verdana' });
			setStoreToasts([createMockToast()]);

			render(<ToastContainer theme={mockTheme} />);

			const root = screen.getByText('Test Toast').closest('[style*="font-family"]');
			expect(root).not.toBeNull();
			expect((root as HTMLElement).style.fontFamily).toContain('Verdana');
		});

		it('keeps a monospace fallback so a missing face cannot land on serif', () => {
			useSettingsStore.setState({ fontFamily: 'Verdana' });
			setStoreToasts([createMockToast()]);

			render(<ToastContainer theme={mockTheme} />);

			const root = screen.getByText('Test Toast').closest('[style*="font-family"]');
			expect((root as HTMLElement).style.fontFamily).toContain('monospace');
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

	describe('timestamp', () => {
		// Fixed local wall-clock instant so the assertions below are locale-safe:
		// they compare against Intl output computed the same way, and assert the
		// today-vs-earlier behavior rather than a hard-coded string.
		const NOW = new Date(2026, 0, 15, 14, 30, 0).getTime();
		const DAY_MS = 24 * 60 * 60 * 1000;

		const timeEl = () => document.body.querySelector('time');

		beforeEach(() => {
			vi.setSystemTime(NOW);
		});

		it('stamps every toast, even one with no group/project/tab', () => {
			setStoreToasts([createMockToast({ timestamp: NOW })]);

			render(<ToastContainer theme={mockTheme} />);
			expect(timeEl()).not.toBeNull();
			expect(timeEl()).toHaveAttribute('dateTime', new Date(NOW).toISOString());
		});

		it('shows only the clock time for a toast from today', () => {
			setStoreToasts([createMockToast({ timestamp: NOW })]);

			render(<ToastContainer theme={mockTheme} />);
			const expectedTime = new Date(NOW).toLocaleTimeString([], {
				hour: 'numeric',
				minute: '2-digit',
			});
			const expectedDate = new Date(NOW).toLocaleDateString([], {
				month: 'short',
				day: 'numeric',
			});
			expect(timeEl()?.textContent).toBe(expectedTime);
			// The point of 'smart': today needs no date, so it must not appear.
			expect(timeEl()?.textContent).not.toContain(expectedDate);
		});

		it('adds the date once a sticky toast is older than today', () => {
			const yesterday = NOW - DAY_MS;
			setStoreToasts([createMockToast({ timestamp: yesterday, dismissible: true })]);

			render(<ToastContainer theme={mockTheme} />);
			const expectedDate = new Date(yesterday).toLocaleDateString([], {
				month: 'short',
				day: 'numeric',
			});
			expect(timeEl()?.textContent).toContain(expectedDate);
		});

		it('exposes the full date and time as a hover title', () => {
			setStoreToasts([createMockToast({ timestamp: NOW })]);

			render(<ToastContainer theme={mockTheme} />);
			expect(timeEl()).toHaveAttribute('title', new Date(NOW).toLocaleString());
		});

		it('sits on the title line, not on the agent-context row', () => {
			setStoreToasts([
				createMockToast({ timestamp: NOW, title: 'Synopsis', group: 'OBSIDIAN', tabName: 'Tab 1' }),
			]);

			render(<ToastContainer theme={mockTheme} />);
			const row = timeEl()?.parentElement;
			expect(row?.textContent).toContain('Synopsis');
			expect(row?.textContent).not.toContain('OBSIDIAN');
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

			render(<ToastContainer theme={mockTheme} onSessionClick={onSessionClick} />);
			const clickableToast = document.body.querySelector('.cursor-pointer');
			fireEvent.click(clickableToast!);

			expect(onSessionClick).toHaveBeenCalledWith('session-1', undefined);
		});

		it('includes tabId when provided', () => {
			const onSessionClick = vi.fn();
			setStoreToasts([createMockToast({ sessionId: 'session-1', tabId: 'tab-1' })]);

			render(<ToastContainer theme={mockTheme} onSessionClick={onSessionClick} />);
			const clickableToast = document.body.querySelector('.cursor-pointer');
			fireEvent.click(clickableToast!);

			expect(onSessionClick).toHaveBeenCalledWith('session-1', 'tab-1');
		});

		it('is not clickable without sessionId', () => {
			const onSessionClick = vi.fn();
			setStoreToasts([createMockToast()]);

			render(<ToastContainer theme={mockTheme} onSessionClick={onSessionClick} />);
			expect(document.body.querySelector('.cursor-pointer')).not.toBeInTheDocument();
		});
	});

	describe('clickAction', () => {
		it('jump-session: dispatches onSessionClick with the action sessionId/tabId', () => {
			const onSessionClick = vi.fn();
			setStoreToasts([
				createMockToast({
					clickAction: { kind: 'jump-session', sessionId: 'sess-9', tabId: 'tab-3' },
				}),
			]);

			render(<ToastContainer theme={mockTheme} onSessionClick={onSessionClick} />);
			const clickableToast = document.body.querySelector('.cursor-pointer');
			fireEvent.click(clickableToast!);

			expect(onSessionClick).toHaveBeenCalledWith('sess-9', 'tab-3');
		});

		it('clickAction takes precedence over legacy sessionId/tabId fields', () => {
			const onSessionClick = vi.fn();
			setStoreToasts([
				createMockToast({
					sessionId: 'legacy-session',
					tabId: 'legacy-tab',
					clickAction: { kind: 'jump-session', sessionId: 'sess-9' },
				}),
			]);

			render(<ToastContainer theme={mockTheme} onSessionClick={onSessionClick} />);
			const clickableToast = document.body.querySelector('.cursor-pointer');
			fireEvent.click(clickableToast!);

			// Should pick the clickAction's sessionId, not the legacy one
			expect(onSessionClick).toHaveBeenCalledWith('sess-9', undefined);
			expect(onSessionClick).not.toHaveBeenCalledWith('legacy-session', 'legacy-tab');
		});

		it('open-file: dispatches the maestro:openFileTab CustomEvent', () => {
			const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
			setStoreToasts([
				createMockToast({
					clickAction: { kind: 'open-file', sessionId: 'sess-9', path: '/tmp/foo.ts' },
				}),
			]);

			render(<ToastContainer theme={mockTheme} />);
			const clickableToast = document.body.querySelector('.cursor-pointer');
			fireEvent.click(clickableToast!);

			const matched = dispatchSpy.mock.calls.find(
				([e]) => e instanceof CustomEvent && e.type === 'maestro:openFileTab'
			);
			expect(matched).toBeTruthy();
			const evt = matched![0] as CustomEvent;
			expect(evt.detail).toEqual({ sessionId: 'sess-9', filePath: '/tmp/foo.ts' });
			dispatchSpy.mockRestore();
		});

		it('open-url: opens the URL via the shell helper', () => {
			setStoreToasts([
				createMockToast({
					clickAction: { kind: 'open-url', url: 'https://example.com/logs' },
				}),
			]);

			render(<ToastContainer theme={mockTheme} />);
			const clickableToast = document.body.querySelector('.cursor-pointer');
			fireEvent.click(clickableToast!);

			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/logs');
		});

		it('makes a toast clickable even without a sessionId', () => {
			setStoreToasts([
				createMockToast({
					clickAction: { kind: 'open-url', url: 'https://example.com' },
				}),
			]);

			render(<ToastContainer theme={mockTheme} />);
			expect(document.body.querySelector('.cursor-pointer')).toBeInTheDocument();
		});
	});

	describe('animation states', () => {
		it('starts with entering animation then transitions to normal', () => {
			setStoreToasts([createMockToast()]);

			render(<ToastContainer theme={mockTheme} />);
			const toastOuter = document.body.querySelector('.relative.overflow-hidden');

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

			render(<ToastContainer theme={mockTheme} />);
			expect(document.body.querySelector('.h-1.rounded-b-lg')).toBeInTheDocument();
		});

		it('does not render when duration is 0', () => {
			setStoreToasts([createMockToast({ duration: 0 })]);

			render(<ToastContainer theme={mockTheme} />);
			expect(document.body.querySelector('.h-1.rounded-b-lg')).not.toBeInTheDocument();
		});

		// Regression: these guards used to read `toast.duration && toast.duration > 0`.
		// With a duration of 0 the leading truthiness check evaluates to the NUMBER
		// 0 rather than a boolean, and React renders a bare `0` text node where the
		// element should have been. The "never auto-dismiss" setting makes
		// `duration` 0 without setting `dismissible`, so the combination is
		// reachable. Asserting on whole-element text would not catch it (the stray
		// node sits among real content, and the arrival timestamp legitimately
		// contains digits), so look for a text node that is literally "0".
		const strayZeroCount = (): number => {
			const root = document.body.querySelector('.fixed.bottom-0.right-4');
			if (!root) return 0;
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let count = 0;
			while (walker.nextNode()) {
				if (walker.currentNode.textContent?.trim() === '0') count++;
			}
			return count;
		};

		it('renders no stray zero when duration is 0 and the toast is not dismissible', () => {
			setStoreToasts([createMockToast({ duration: 0, dismissible: false })]);

			render(<ToastContainer theme={mockTheme} />);
			expect(document.body.querySelector('.h-1.rounded-b-lg')).not.toBeInTheDocument();
			expect(strayZeroCount()).toBe(0);
		});

		// Same shape on the duration badge: a task that rounds to 0ms printed a
		// bare "0" instead of rendering nothing.
		it('renders no stray zero when taskDuration is 0', () => {
			setStoreToasts([createMockToast({ taskDuration: 0, duration: 5000 })]);

			render(<ToastContainer theme={mockTheme} />);
			expect(screen.queryByText(/Completed in/)).not.toBeInTheDocument();
			expect(strayZeroCount()).toBe(0);
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
			// Only the two rail buttons (close + copy), no action link
			const buttons = screen.getAllByRole('button');
			expect(buttons).toHaveLength(2);
		});
	});

	describe('close button does not trigger navigation', () => {
		it('close click does not call onSessionClick', () => {
			const onSessionClick = vi.fn();
			setStoreToasts([createMockToast({ sessionId: 'session-1' })]);

			render(<ToastContainer theme={mockTheme} onSessionClick={onSessionClick} />);
			fireEvent.click(screen.getByLabelText('Close'));

			// onSessionClick should NOT be called from close
			// (onSessionClick triggers from the toast body click)
			expect(onSessionClick).not.toHaveBeenCalled();
		});
	});

	describe('copy button', () => {
		const writeText = vi.fn().mockResolvedValue(undefined);

		beforeEach(() => {
			writeText.mockClear();
			Object.defineProperty(navigator, 'clipboard', {
				value: { writeText },
				configurable: true,
			});
		});

		it('copies the toast text to the clipboard', async () => {
			setStoreToasts([
				createMockToast({
					group: 'Ops',
					project: 'Maestro',
					tabName: 'main',
					title: 'Pipeline failing',
					message: 'chat source broken',
					actionUrl: 'https://example.com/run/1',
				}),
			]);

			render(<ToastContainer theme={mockTheme} />);
			await act(async () => {
				fireEvent.click(screen.getByLabelText('Copy notification text'));
			});

			expect(writeText).toHaveBeenCalledWith(
				'Ops · Maestro · main\nPipeline failing\nchat source broken\nhttps://example.com/run/1'
			);
		});

		it('does not navigate or dismiss the toast when copying', async () => {
			const onSessionClick = vi.fn();
			setStoreToasts([createMockToast({ sessionId: 'session-1' })]);

			render(<ToastContainer theme={mockTheme} onSessionClick={onSessionClick} />);
			await act(async () => {
				fireEvent.click(screen.getByLabelText('Copy notification text'));
			});
			act(() => {
				vi.advanceTimersByTime(300);
			});

			expect(onSessionClick).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().toasts).toHaveLength(1);
		});

		it('builds clipboard text from only the populated fields', () => {
			expect(buildToastClipboardText(createMockToast({ title: 'Done', message: 'All good' }))).toBe(
				'Done\nAll good'
			);
		});
	});

	describe('no metadata row', () => {
		it('renders no context badges when no group/project/tabName', () => {
			setStoreToasts([createMockToast()]);

			render(<ToastContainer theme={mockTheme} />);
			// The accentDim styled badges for group/tab should not exist. The
			// timestamp lives on the title line, so nothing keeps this row alive.
			const accentSpans = document.body.querySelectorAll('.px-1\\.5.py-0\\.5.rounded');
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
			// taskDuration of 0 is guarded - "does not display" already tested
			// But let's verify sub-second with exact 1000ms boundary
			setStoreToasts([createMockToast({ taskDuration: 1000 })]);

			const { unmount } = render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByText(/Completed in 1s/)).toBeInTheDocument();
			unmount();
		});
	});

	describe('composer avoidance', () => {
		// setup.ts reports every element as 1000px wide, which would make the
		// stack span nearly the whole jsdom window and overlap any composer.
		// Measure it at the default dynamic width (Right Bar 384 - 2 * 16).
		let offsetWidthSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			useSettingsStore.setState({ toastPosition: 'bottom-right' });
			offsetWidthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(352);
		});

		afterEach(() => {
			offsetWidthSpy.mockRestore();
			useToastAvoidZoneStore.setState({ zones: {} });
			useSettingsStore.setState({ toastPosition: 'bottom-right' });
		});

		const composerZone = (right: number) => ({
			composer: {
				left: 0,
				top: window.innerHeight - 120,
				right,
				bottom: window.innerHeight,
			},
		});

		it('sits just above the window bottom when no zone overlaps', () => {
			setStoreToasts([createMockToast()]);
			render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByTestId('toast-stack').style.bottom).toBe('8px');
		});

		it('lifts above a composer that runs under the stack', () => {
			// Right Bar closed: the composer spans to the window's right edge.
			useToastAvoidZoneStore.setState({ zones: composerZone(window.innerWidth) });
			setStoreToasts([createMockToast()]);
			render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByTestId('toast-stack').style.bottom).toBe('128px');
		});

		it('stays put when the composer stops short of the stack', () => {
			// Right Bar open and wider than the toast column.
			useToastAvoidZoneStore.setState({ zones: composerZone(window.innerWidth - 600) });
			setStoreToasts([createMockToast()]);
			render(<ToastContainer theme={mockTheme} />);
			expect(screen.getByTestId('toast-stack').style.bottom).toBe('8px');
		});

		it('ignores the composer in a top corner', () => {
			useSettingsStore.setState({ toastPosition: 'top-right' });
			useToastAvoidZoneStore.setState({ zones: composerZone(window.innerWidth) });
			setStoreToasts([createMockToast()]);
			render(<ToastContainer theme={mockTheme} />);
			const stack = screen.getByTestId('toast-stack');
			expect(stack.style.bottom).toBe('');
			expect(stack.style.top).toBe('48px');
		});
	});

	describe('position', () => {
		afterEach(() => {
			useSettingsStore.setState({ toastPosition: 'bottom-right' });
		});

		const titlesInDomOrder = () =>
			Array.from(screen.getByTestId('toast-stack').firstElementChild!.children).map(
				(el) => el.textContent
			);

		it('pins a bottom-right stack to the bottom and right edges, newest last', () => {
			setStoreToasts([
				createMockToast({ id: 'a', title: 'Older' }),
				createMockToast({ id: 'b', title: 'Newer' }),
			]);
			render(<ToastContainer theme={mockTheme} />);
			const stack = screen.getByTestId('toast-stack');
			expect(stack.style.right).toBe('16px');
			expect(stack.style.left).toBe('');
			expect(stack.firstElementChild!.className).toContain('flex-col');
			expect(stack.firstElementChild!.className).not.toContain('flex-col-reverse');
			expect(titlesInDomOrder()[1]).toContain('Newer');
		});

		it('pins a top-left stack below the title bar and reverses it so the newest is on top', () => {
			useSettingsStore.setState({ toastPosition: 'top-left' });
			setStoreToasts([createMockToast()]);
			render(<ToastContainer theme={mockTheme} />);
			const stack = screen.getByTestId('toast-stack');
			expect(stack.style.top).toBe('48px');
			expect(stack.style.left).toBe('16px');
			expect(stack.style.right).toBe('');
			expect(stack.firstElementChild!.className).toContain('flex-col-reverse');
		});

		it('slides a left-corner toast in from the left edge', () => {
			useSettingsStore.setState({ toastPosition: 'bottom-left' });
			setStoreToasts([createMockToast()]);
			render(<ToastContainer theme={mockTheme} />);
			const toastOuter = document.body.querySelector('.relative.overflow-hidden');
			expect(toastOuter).toHaveStyle({ transform: 'translateX(-100%)' });
		});
	});
});

describe('Toast on a phone', () => {
	beforeEach(() => {
		useNotificationStore.setState({ toasts: [createMockToast()] });
	});

	afterEach(() => {
		vi.mocked(usePhoneLayout).mockReturnValue(false);
	});

	it('pins the stack to the right and sizes toasts from the preset on desktop', () => {
		// Pin the preset rather than leaning on whatever the store defaults to:
		// the point of this test is that the desktop path uses the preset at all,
		// and 'dynamic' derives its width from the live Right Bar instead.
		useSettingsStore.setState({ toastWidth: 'small' });
		render(<ToastContainer theme={mockTheme} />);
		const stack = screen.getByTestId('toast-stack');
		expect(stack.style.right).toBe('16px');
		expect(stack.style.left).toBe('');
		const card = screen.getByText('Test Toast').closest('.rounded-lg') as HTMLElement;
		expect(card.style.minWidth).toBe('320px');
		expect(card.style.maxWidth).toBe('400px');
	});

	it('spans the screen and fills the stack on a phone', () => {
		vi.mocked(usePhoneLayout).mockReturnValue(true);
		render(<ToastContainer theme={mockTheme} />);
		const stack = screen.getByTestId('toast-stack');
		expect(stack.style.left).toBe('12px');
		expect(stack.style.right).toBe('12px');
		const card = screen.getByText('Test Toast').closest('.rounded-lg') as HTMLElement;
		expect(card.style.minWidth).toBe('');
		expect(card.style.maxWidth).toBe('');
		expect(card.style.width).toBe('100%');
	});
});

describe('ToastContainer over the floating media player', () => {
	beforeEach(() => {
		useNotificationStore.setState({ toasts: [createMockToast()] });
		useSettingsStore.setState({ toastWidth: 'small' });
	});

	afterEach(() => {
		useMediaPlaybackStore.setState({ floatFootprint: null });
		vi.mocked(usePhoneLayout).mockReturnValue(false);
	});

	it('sits on the bottom edge when no player is on screen', () => {
		useMediaPlaybackStore.setState({ floatFootprint: null });
		render(<ToastContainer theme={mockTheme} />);
		expect(screen.getByTestId('toast-stack').style.bottom).toBe('8px');
	});

	it('steps over a player parked in the same corner', () => {
		// Without this the toast paints over the widget (toasts are z-index
		// 100000, the player is 60), and the player appears to close itself.
		useMediaPlaybackStore.setState({
			floatFootprint: { fromBottom: 156, fromRight: 24, width: 380, viewportHeight: 900 },
		});
		render(<ToastContainer theme={mockTheme} />);
		expect(screen.getByTestId('toast-stack').style.bottom).toBe('172px');
	});

	it('stays on the bottom edge for a player in another column', () => {
		useMediaPlaybackStore.setState({
			floatFootprint: { fromBottom: 156, fromRight: 1100, width: 380, viewportHeight: 900 },
		});
		render(<ToastContainer theme={mockTheme} />);
		expect(screen.getByTestId('toast-stack').style.bottom).toBe('8px');
	});

	it('keeps the safe-area inset while stepping over the player on a phone', () => {
		vi.mocked(usePhoneLayout).mockReturnValue(true);
		useMediaPlaybackStore.setState({
			floatFootprint: { fromBottom: 156, fromRight: 12, width: 366, viewportHeight: 844 },
		});
		render(<ToastContainer theme={mockTheme} />);
		// The lift is a margin and the safe-area inset is padding, so neither can
		// eat the other. (jsdom drops the `env()` padding entirely, so only the
		// margin is assertable here.)
		expect(screen.getByTestId('toast-stack').style.bottom).toBe('172px');
	});
});
