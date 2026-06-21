import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SessionPillBar from '../../web/mobile/SessionPillBar';
import { ThemeProvider } from '../../web/components/ThemeProvider';
import type { Session } from '../../web/hooks/useSessions';
import type { Theme } from '../../shared/theme-types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#0b0b0d',
		bgSidebar: '#111113',
		bgActivity: '#1c1c1f',
		border: '#27272a',
		textMain: '#e4e4e7',
		textDim: '#a1a1aa',
		accent: '#6366f1',
		accentDim: 'rgba(99, 102, 241, 0.2)',
		accentText: '#a5b4fc',
		accentForeground: '#0b0b0d',
		success: '#22c55e',
		warning: '#eab308',
		error: '#ef4444',
	},
};

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Session 1',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/Users/test/project',
		toolType: 'claude-code',
		bookmarked: false,
		groupId: null,
		groupName: null,
		groupEmoji: null,
		...overrides,
	} as Session;
}

function renderBar(
	props: Partial<React.ComponentProps<typeof SessionPillBar>> & {
		sessions: Session[];
		activeSessionId: string | null;
	}
) {
	return render(
		<ThemeProvider theme={theme}>
			<SessionPillBar onSelectSession={vi.fn()} onToggleBookmark={vi.fn()} {...props} />
		</ThemeProvider>
	);
}

describe('SessionPillBar integration', () => {
	let originalOntouchstart: PropertyDescriptor | undefined;
	let originalInnerWidth: PropertyDescriptor | undefined;
	let originalVibrate: PropertyDescriptor | undefined;
	let originalScrollTo: PropertyDescriptor | undefined;
	let originalGetBoundingClientRect: PropertyDescriptor | undefined;
	let vibrate: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		originalOntouchstart = Object.getOwnPropertyDescriptor(window, 'ontouchstart');
		originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
		originalVibrate = Object.getOwnPropertyDescriptor(navigator, 'vibrate');
		originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo');
		originalGetBoundingClientRect = Object.getOwnPropertyDescriptor(
			Element.prototype,
			'getBoundingClientRect'
		);
		Object.defineProperty(window, 'innerWidth', {
			value: 375,
			writable: true,
			configurable: true,
		});
		Element.prototype.scrollTo = vi.fn();
		Element.prototype.getBoundingClientRect = vi.fn(() => ({
			x: 100,
			y: 50,
			width: 120,
			height: 36,
			top: 50,
			right: 220,
			bottom: 86,
			left: 100,
			toJSON: () => ({}),
		}));
		vibrate = vi.fn();
		Object.defineProperty(navigator, 'vibrate', {
			value: vibrate,
			configurable: true,
		});
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (originalOntouchstart) {
			Object.defineProperty(window, 'ontouchstart', originalOntouchstart);
		} else {
			delete (window as Record<string, unknown>).ontouchstart;
		}
		if (originalInnerWidth) {
			Object.defineProperty(window, 'innerWidth', originalInnerWidth);
		}
		if (originalVibrate) {
			Object.defineProperty(navigator, 'vibrate', originalVibrate);
		} else {
			delete (navigator as unknown as Record<string, unknown>).vibrate;
		}
		if (originalScrollTo) {
			Object.defineProperty(Element.prototype, 'scrollTo', originalScrollTo);
		} else {
			delete (Element.prototype as unknown as Record<string, unknown>).scrollTo;
		}
		if (originalGetBoundingClientRect) {
			Object.defineProperty(
				Element.prototype,
				'getBoundingClientRect',
				originalGetBoundingClientRect
			);
		}
	});

	it('selects a desktop pill, sorts named groups, and scrolls the active pill', async () => {
		delete (window as Record<string, unknown>).ontouchstart;
		const onSelectSession = vi.fn();
		const scrollTo = vi.spyOn(Element.prototype, 'scrollTo');
		const sessions = [
			createSession({
				id: 'zeta-session',
				name: 'Zeta Session',
				groupId: 'zeta',
				groupName: 'Zeta',
			}),
			createSession({
				id: 'alpha-session',
				name: 'Alpha Session',
				groupId: 'alpha',
				groupName: 'Alpha',
			}),
		];

		const { rerender } = renderBar({
			sessions,
			activeSessionId: null,
			onSelectSession,
		});

		await screen.findByRole('button', { name: /Alpha group/ });
		const groupHeaders = screen
			.getAllByRole('button')
			.filter((button) => button.hasAttribute('aria-expanded'));
		expect(groupHeaders.map((button) => button.textContent)).toEqual([
			expect.stringContaining('Alpha'),
			expect.stringContaining('Zeta'),
		]);

		fireEvent.click(screen.getByRole('button', { name: /Alpha group/ }));
		await screen.findByText('Alpha Session');
		rerender(
			<ThemeProvider theme={theme}>
				<SessionPillBar
					sessions={sessions}
					activeSessionId="alpha-session"
					onSelectSession={onSelectSession}
				/>
			</ThemeProvider>
		);
		await waitFor(() => {
			expect(scrollTo).toHaveBeenCalled();
		});
		fireEvent.click(screen.getByRole('button', { name: /Alpha Session/ }));
		expect(onSelectSession).toHaveBeenCalledWith('alpha-session');
		expect(vibrate).toHaveBeenCalledWith(10);

		fireEvent.click(screen.getByRole('button', { name: /Zeta group/ }));
		await screen.findByText('Zeta Session');
		fireEvent.click(screen.getByRole('button', { name: /Zeta group/ }));
		expect(screen.queryByText('Zeta Session')).not.toBeInTheDocument();
	});

	it('clamps a right-edge popover and tolerates a missing active session', async () => {
		Object.defineProperty(window, 'innerWidth', {
			value: 320,
			writable: true,
			configurable: true,
		});
		Element.prototype.getBoundingClientRect = vi.fn(() => ({
			x: 290,
			y: 50,
			width: 60,
			height: 36,
			top: 50,
			right: 350,
			bottom: 86,
			left: 290,
			toJSON: () => ({}),
		}));
		const sessions = [
			createSession({
				id: 'active-session',
				name: 'Active Session',
			}),
		];
		const { rerender } = render(
			<ThemeProvider theme={theme}>
				<SessionPillBar
					sessions={sessions}
					activeSessionId="missing-session"
					onSelectSession={vi.fn()}
				/>
			</ThemeProvider>
		);

		rerender(
			<ThemeProvider theme={theme}>
				<SessionPillBar
					sessions={sessions}
					activeSessionId="active-session"
					onSelectSession={vi.fn()}
					onToggleBookmark={vi.fn()}
				/>
			</ThemeProvider>
		);

		await screen.findByText('Active Session');
		fireEvent.touchMove(screen.getByRole('button', { name: /Active Session/ }), {
			touches: [{ clientX: 10, clientY: 10 }],
		});
		fireEvent.contextMenu(screen.getByRole('button', { name: /Active Session/ }));

		const popover = await screen.findByRole('dialog', {
			name: 'Session info for Active Session',
		});
		expect(popover).toHaveStyle({ left: '28px' });
	});

	it('renders empty state, pinned actions, and bookmarked groups', async () => {
		const onOpenAllSessions = vi.fn();
		const onOpenHistory = vi.fn();
		const { rerender } = renderBar({
			sessions: [],
			activeSessionId: null,
		});

		expect(screen.getByText('No sessions available')).toBeInTheDocument();

		const sessions = [
			createSession({
				id: 'bookmarked-session',
				name: 'Bookmarked Session',
				bookmarked: true,
			}),
			createSession({
				id: 'grouped-session',
				name: 'Grouped Session',
				groupId: 'workspace',
				groupName: 'Workspace',
			}),
		];

		rerender(
			<ThemeProvider theme={theme}>
				<SessionPillBar
					sessions={sessions}
					activeSessionId={null}
					onSelectSession={vi.fn()}
					onOpenAllSessions={onOpenAllSessions}
					onOpenHistory={onOpenHistory}
				/>
			</ThemeProvider>
		);

		expect(await screen.findByText('Bookmarks')).toBeInTheDocument();
		expect(screen.getByText('Bookmarked Session')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Search 2 sessions' }));
		fireEvent.click(screen.getByRole('button', { name: 'View history' }));

		expect(onOpenAllSessions).toHaveBeenCalledTimes(1);
		expect(onOpenHistory).toHaveBeenCalledTimes(1);
	});

	it('handles touch tap, long press, scroll cancellation, and touch cancel on pills', async () => {
		Object.defineProperty(window, 'ontouchstart', {
			value: null,
			configurable: true,
		});
		const onSelectSession = vi.fn();

		renderBar({
			sessions: [createSession({ id: 'touch-session', name: 'Touch Session' })],
			activeSessionId: 'touch-session',
			onSelectSession,
		});

		const pill = await screen.findByRole('button', { name: /Touch Session/ });
		vi.useFakeTimers();
		fireEvent.touchStart(pill, {
			touches: [{ clientX: 20, clientY: 20 }],
		});
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(screen.getByRole('dialog', { name: /Touch Session/ })).toBeInTheDocument();
		expect(onSelectSession).not.toHaveBeenCalled();
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByRole('dialog', { name: /Touch Session/ })).not.toBeInTheDocument();

		fireEvent.touchStart(pill, {
			touches: [{ clientX: 20, clientY: 20 }],
		});
		fireEvent.touchMove(pill, {
			touches: [{ clientX: 45, clientY: 20 }],
		});
		fireEvent.touchEnd(pill);
		expect(onSelectSession).not.toHaveBeenCalled();

		fireEvent.touchStart(pill, {
			touches: [{ clientX: 20, clientY: 20 }],
		});
		fireEvent.touchCancel(pill);

		fireEvent.touchStart(pill, {
			touches: [{ clientX: 20, clientY: 20 }],
		});
		fireEvent.touchEnd(pill);
		expect(onSelectSession).toHaveBeenCalledWith('touch-session');
	});

	it('handles left-edge popover placement, bookmark toggling, and status variants', async () => {
		Object.defineProperty(window, 'innerWidth', {
			value: 320,
			writable: true,
			configurable: true,
		});
		Element.prototype.getBoundingClientRect = vi.fn(() => ({
			x: -40,
			y: 50,
			width: 60,
			height: 36,
			top: 50,
			right: 20,
			bottom: 86,
			left: -40,
			toJSON: () => ({}),
		}));
		const onToggleBookmark = vi.fn();
		const sessions = [
			createSession({
				id: 'busy-session',
				name: 'Busy Session',
				state: 'busy',
				inputMode: 'terminal',
			}),
		];
		const { rerender } = renderBar({
			sessions,
			activeSessionId: 'busy-session',
			onToggleBookmark,
		});

		fireEvent.contextMenu(await screen.findByRole('button', { name: /Busy Session/ }));
		const busyPopover = await screen.findByRole('dialog', { name: /Busy Session/ });
		expect(busyPopover).toHaveStyle({ left: '12px' });
		expect(screen.getByText('Thinking...')).toBeInTheDocument();
		expect(screen.getByText('Command Terminal')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Bookmark/ }));
		expect(onToggleBookmark).toHaveBeenCalledWith('busy-session');
		expect(screen.queryByRole('dialog', { name: /Busy Session/ })).not.toBeInTheDocument();

		rerender(
			<ThemeProvider theme={theme}>
				<SessionPillBar
					sessions={[
						createSession({
							id: 'connecting-session',
							name: 'Connecting Session',
							state: 'connecting',
						}),
					]}
					activeSessionId="connecting-session"
					onSelectSession={vi.fn()}
				/>
			</ThemeProvider>
		);
		fireEvent.contextMenu(await screen.findByRole('button', { name: /Connecting Session/ }));
		expect(await screen.findByText('Connecting...')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close popover' }));

		rerender(
			<ThemeProvider theme={theme}>
				<SessionPillBar
					sessions={[
						createSession({
							id: 'error-session',
							name: 'Error Session',
							state: 'error',
						}),
					]}
					activeSessionId="error-session"
					onSelectSession={vi.fn()}
				/>
			</ThemeProvider>
		);
		fireEvent.contextMenu(await screen.findByRole('button', { name: /Error Session/ }));
		expect(await screen.findByText('Error')).toBeInTheDocument();
	});

	it('closes the popover on delayed outside pointer events', async () => {
		renderBar({
			sessions: [createSession({ id: 'outside-session', name: 'Outside Session' })],
			activeSessionId: 'outside-session',
		});

		const pill = await screen.findByRole('button', { name: /Outside Session/ });
		vi.useFakeTimers();
		fireEvent.contextMenu(pill);
		expect(screen.getByRole('dialog', { name: /Outside Session/ })).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(100);
		});
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole('dialog', { name: /Outside Session/ })).not.toBeInTheDocument();
	});

	it('ignores header scroll gestures and safely drops a pending expand scroll after unmount', async () => {
		vi.useFakeTimers();
		Object.defineProperty(window, 'ontouchstart', {
			value: null,
			configurable: true,
		});
		const sessions = [
			createSession({
				id: 'alpha-session',
				name: 'Alpha Session',
				groupId: 'alpha',
				groupName: 'Alpha',
			}),
			createSession({
				id: 'beta-session',
				name: 'Beta Session',
				groupId: 'beta',
				groupName: 'Beta',
			}),
		];
		const { unmount } = renderBar({
			sessions,
			activeSessionId: null,
		});

		const alphaHeader = screen.getByRole('button', { name: /Alpha group/ });
		fireEvent.touchMove(alphaHeader, {
			touches: [{ clientX: 70, clientY: 40 }],
		});
		fireEvent.touchCancel(alphaHeader);
		fireEvent.touchStart(alphaHeader, {
			touches: [{ clientX: 40, clientY: 40 }],
		});
		fireEvent.touchMove(alphaHeader, {
			touches: [{ clientX: 70, clientY: 40 }],
		});
		fireEvent.touchEnd(alphaHeader);
		expect(screen.queryByText('Alpha Session')).not.toBeInTheDocument();

		fireEvent.touchStart(alphaHeader, {
			touches: [{ clientX: 40, clientY: 40 }],
		});
		fireEvent.touchEnd(alphaHeader);
		unmount();
		act(() => {
			vi.advanceTimersByTime(50);
		});
	});
});
