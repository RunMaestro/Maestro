/**
 * Tests for LeftPanel component — Phase 2 responsiveness scope.
 *
 * This file intentionally targets only the surfaces touched by Phase 2
 * (Tasks 2.8 / 2.9 / 2.10): hover-tint migration to Tailwind, the
 * focus-visible ring sweep, and the inline-mode resize handle. LeftPanel
 * is a 40KB component scheduled for a larger pass in Phase 6; broader
 * coverage (create-group sheet, move-to-group sheet, group collapse
 * semantics, long-press) is deferred to that phase.
 *
 * @file src/__tests__/web/mobile/LeftPanel.test.tsx
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LeftPanel } from '../../../web/mobile/LeftPanel';
import type { Session } from '../../../web/hooks/useSessions';

const mockColors = {
	accent: '#8b5cf6',
	accentForeground: '#ffffff',
	border: '#374151',
	bgMain: '#1f2937',
	bgSidebar: '#111827',
	textMain: '#f3f4f6',
	textDim: '#9ca3af',
	error: '#ef4444',
	warning: '#f59e0b',
	success: '#22c55e',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/components/Badge', () => ({
	StatusDot: ({ status, size }: { status: string; size: string }) => (
		<span data-testid="status-dot" data-status={status} data-size={size}>
			{status}
		</span>
	),
}));

vi.mock('../../../web/hooks/useSwipeGestures', () => ({
	useSwipeGestures: () => ({
		handlers: {
			onTouchStart: vi.fn(),
			onTouchMove: vi.fn(),
			onTouchEnd: vi.fn(),
			onTouchCancel: vi.fn(),
		},
		offsetX: 0,
		offsetY: 0,
		isSwiping: false,
		swipeDirection: null,
		resetOffset: vi.fn(),
	}),
}));

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: { tap: [10], success: [30] },
}));

vi.mock('../../../shared/agentMetadata', () => ({
	getAgentDisplayName: (id: string) => id,
}));

vi.mock('../../../shared/formatters', () => ({
	truncatePath: (p: string) => p,
}));

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/Users/test/project',
		toolType: 'claude-code',
		bookmarked: false,
		groupId: null,
		groupName: null,
		groupEmoji: null,
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	} as Session;
}

function renderLeftPanel(
	props: Partial<React.ComponentProps<typeof LeftPanel>> = {}
): ReturnType<typeof render> {
	const defaults: React.ComponentProps<typeof LeftPanel> = {
		sessions: [createMockSession()],
		activeSessionId: 'session-1',
		onSelectSession: vi.fn(),
		onClose: vi.fn(),
		mode: 'inline',
		collapsedGroups: new Set<string>(),
		setCollapsedGroups: vi.fn(),
		showUnreadOnly: false,
		setShowUnreadOnly: vi.fn(),
		groups: [],
	};
	return render(<LeftPanel {...defaults} {...props} />);
}

describe('LeftPanel — Phase 2 responsiveness', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Task 2.8 — hover-tint migration', () => {
		it('inactive session row wrapper carries Tailwind hover tint class', () => {
			const sessions = [
				createMockSession({ id: 'a', name: 'Alpha' }),
				createMockSession({ id: 'b', name: 'Beta' }),
			];

			renderLeftPanel({ sessions, activeSessionId: 'a' });

			// The inactive row wrapper is the parent of the session-select
			// <button> for Beta.
			const betaButton = screen.getByRole('button', { name: /Beta/ });
			expect(betaButton.parentElement).toHaveClass('hover:bg-white/[0.06]');
		});

		it('active session row wrapper does NOT carry the hover tint class', () => {
			const sessions = [
				createMockSession({ id: 'a', name: 'Alpha' }),
				createMockSession({ id: 'b', name: 'Beta' }),
			];

			renderLeftPanel({ sessions, activeSessionId: 'a' });

			const alphaButton = screen.getByRole('button', { name: /Alpha/ });
			expect(alphaButton.parentElement).not.toHaveClass('hover:bg-white/[0.06]');
		});

		it('inline-mode resize handle uses hover:bg-accent (no JS mouse handlers)', () => {
			const { container } = renderLeftPanel({
				mode: 'inline',
				onResizeStart: vi.fn(),
				width: 240,
			});

			// The resize handle is the only element with cursor-col-resize.
			const handle = container.querySelector('.cursor-col-resize');
			expect(handle).not.toBeNull();
			expect(handle).toHaveClass('hover:bg-accent', 'touch-none', 'absolute');
			// Phase 2.8 removed the onMouseEnter / onMouseLeave JS that used to
			// drive the accent tint. A handle that wires those handlers would
			// leak them as attributes in jsdom's serialized output — this is
			// a regression fence.
			expect(handle?.outerHTML).not.toMatch(/mouseenter|mouseleave/i);
		});

		it('hovering an inactive row does not mutate inline backgroundColor', () => {
			const sessions = [
				createMockSession({ id: 'a', name: 'Alpha' }),
				createMockSession({ id: 'b', name: 'Beta' }),
			];

			renderLeftPanel({ sessions, activeSessionId: 'a' });

			const betaWrapper = screen.getByRole('button', { name: /Beta/ }).parentElement!;
			const beforeBg = (betaWrapper as HTMLElement).style.backgroundColor;
			fireEvent.mouseEnter(betaWrapper);
			fireEvent.mouseLeave(betaWrapper);
			expect((betaWrapper as HTMLElement).style.backgroundColor).toBe(beforeBg);
		});
	});

	describe('Task 2.9 — focus-visible rings', () => {
		it('bell filter button carries focus-visible ring utilities', () => {
			renderLeftPanel();

			const bell = screen.getByRole('button', { name: /unread/i });
			expect(bell).toHaveClass('outline-none', 'focus-visible:ring-2', 'focus-visible:ring-accent');
		});

		it('new-agent button carries focus-visible ring utilities', () => {
			renderLeftPanel({ onNewAgent: vi.fn() });

			const newAgent = screen.getByRole('button', { name: 'New agent' });
			expect(newAgent).toHaveClass(
				'outline-none',
				'focus-visible:ring-2',
				'focus-visible:ring-accent'
			);
		});

		it('new-group button carries focus-visible ring utilities', () => {
			renderLeftPanel({ onCreateGroup: vi.fn().mockResolvedValue(null) });

			const newGroup = screen.getByRole('button', { name: 'New group' });
			expect(newGroup).toHaveClass(
				'outline-none',
				'focus-visible:ring-2',
				'focus-visible:ring-accent'
			);
		});

		it('close button carries focus-visible ring utilities', () => {
			renderLeftPanel();

			const close = screen.getByRole('button', { name: 'Close panel' });
			expect(close).toHaveClass(
				'outline-none',
				'focus-visible:ring-2',
				'focus-visible:ring-accent'
			);
		});

		it('inner session-select button carries focus-visible ring utilities', () => {
			const sessions = [createMockSession({ id: 'a', name: 'Alpha' })];
			renderLeftPanel({ sessions, activeSessionId: 'a' });

			const selectButton = screen.getByRole('button', { name: /Alpha/ });
			expect(selectButton).toHaveClass(
				'outline-none',
				'focus-visible:ring-2',
				'focus-visible:ring-accent',
				'rounded-md'
			);
		});

		it('group header role=button carries focus-visible ring utilities', () => {
			const sessions = [
				createMockSession({
					id: 'a',
					name: 'Alpha',
					groupId: 'group-1',
					groupName: 'Frontend',
				}),
				createMockSession({
					id: 'b',
					name: 'Beta',
					groupId: 'group-2',
					groupName: 'Backend',
				}),
			];
			renderLeftPanel({ sessions, activeSessionId: 'a' });

			// Group headers render as role="button" divs; find by text.
			const header = screen.getByText('Frontend').closest('[role="button"]');
			expect(header).not.toBeNull();
			expect(header).toHaveClass(
				'outline-none',
				'focus-visible:ring-2',
				'focus-visible:ring-accent',
				'rounded'
			);
		});

		it('worktree-toggle button carries focus-visible ring utilities', () => {
			const sessions = [
				createMockSession({
					id: 'parent',
					name: 'Parent',
					parentSessionId: undefined,
				} as Partial<Session>),
				createMockSession({
					id: 'child',
					name: 'Child',
					parentSessionId: 'parent',
					worktreeBranch: 'feature/x',
				} as Partial<Session>),
			];
			renderLeftPanel({ sessions, activeSessionId: 'parent' });

			const toggle = screen.getByRole('button', { name: /worktree/i });
			expect(toggle).toHaveClass(
				'outline-none',
				'focus-visible:ring-2',
				'focus-visible:ring-accent'
			);
		});

		it('worktree child button carries focus-visible + conditional hover classes', () => {
			// Worktree parents are expanded by default (see `expandedWorktrees`
			// useState initialiser in LeftPanel), so the child renders on
			// initial mount without any toggle interaction.
			const sessions = [
				createMockSession({
					id: 'parent',
					name: 'Parent',
				}),
				createMockSession({
					id: 'child',
					name: 'Child',
					parentSessionId: 'parent',
					worktreeBranch: 'feature/x',
				} as Partial<Session>),
			];

			renderLeftPanel({ sessions, activeSessionId: 'parent' });

			// The worktree-child button's accessible name comes from its
			// `title` attribute: `Worktree: ${worktreeBranch ?? name}`.
			const child = screen.getByTitle('Worktree: feature/x');
			expect(child).toHaveClass(
				'outline-none',
				'focus-visible:ring-2',
				'focus-visible:ring-accent',
				'hover:bg-white/[0.06]'
			);
		});
	});

	describe('Task 2.10 — Tailwind layout migration', () => {
		it('session row wrapper uses Tailwind utilities (no inline padding/gap/rounded)', () => {
			const sessions = [createMockSession({ id: 'a', name: 'Alpha' })];
			renderLeftPanel({ sessions, activeSessionId: 'a' });

			const wrapper = screen.getByRole('button', { name: /Alpha/ }).parentElement!;
			expect(wrapper).toHaveClass(
				'flex',
				'items-center',
				'gap-2',
				'w-full',
				'px-[10px]',
				'py-2',
				'rounded-md',
				'text-text-main',
				'transition-colors'
			);
		});

		it('inner session-select button uses Tailwind utilities for flex / tap highlight', () => {
			const sessions = [createMockSession({ id: 'a', name: 'Alpha' })];
			renderLeftPanel({ sessions, activeSessionId: 'a' });

			const button = screen.getByRole('button', { name: /Alpha/ });
			expect(button).toHaveClass(
				'flex',
				'items-center',
				'gap-2',
				'flex-1',
				'min-w-0',
				'border-0',
				'bg-transparent',
				'[touch-action:manipulation]',
				'[-webkit-tap-highlight-color:transparent]'
			);
		});

		it('resize handle uses Tailwind absolute positioning + touch-none', () => {
			const { container } = renderLeftPanel({
				mode: 'inline',
				onResizeStart: vi.fn(),
				width: 240,
			});

			const handle = container.querySelector('.cursor-col-resize');
			expect(handle).toHaveClass(
				'absolute',
				'top-0',
				'right-0',
				'w-1',
				'h-full',
				'z-10',
				'touch-none'
			);
			// All inline dimensional styles removed by 2.10 — only the
			// `onPointerDown` prop survives.
			expect((handle as HTMLElement).getAttribute('style')).toBeNull();
		});
	});

	describe('SessionContextMenu (Move to Group) — Task 2.8 / 2.10', () => {
		it('right-click renders "Move to Group" button with hover class and no mouse handlers', () => {
			const sessions = [
				createMockSession({ id: 'a', name: 'Alpha' }),
				createMockSession({ id: 'b', name: 'Beta' }),
			];

			renderLeftPanel({
				sessions,
				activeSessionId: 'a',
				onMoveToGroup: vi.fn().mockResolvedValue(true),
			});

			const betaWrapper = screen.getByRole('button', { name: /Beta/ }).parentElement!;
			fireEvent.contextMenu(betaWrapper);

			const moveButton = screen.getByRole('button', { name: /Move to Group/ });
			expect(moveButton).toHaveClass(
				'hover:bg-white/[0.05]',
				'text-text-main',
				'[touch-action:manipulation]'
			);
			// Regression fence: the pre-2.8 component mutated backgroundColor
			// on mouse enter/leave. The Tailwind migration must not leave a
			// stray inline backgroundColor on the base state.
			expect((moveButton as HTMLElement).style.backgroundColor).toBe('');
			fireEvent.mouseEnter(moveButton);
			expect((moveButton as HTMLElement).style.backgroundColor).toBe('');
		});
	});
});
