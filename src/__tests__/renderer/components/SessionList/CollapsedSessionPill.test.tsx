import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	CollapsedSessionPill,
	CollapsedSessionPillRows,
} from '../../../../renderer/components/SessionList/CollapsedSessionPill';
import type { Session, Theme } from '../../../../renderer/types';

import { mockTheme } from '../../../helpers/mockTheme';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function makeSession(overrides: Partial<Session> = {}): Session {
	idCounter++;
	return {
		id: `s${idCounter}`,
		name: `Session ${idCounter}`,
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		...overrides,
	} as Session;
}

function createDefaultProps(overrides: Partial<Parameters<typeof CollapsedSessionPill>[0]> = {}) {
	return {
		session: makeSession(),
		keyPrefix: 'test',
		theme: mockTheme,
		activeBatchSessionIds: [] as string[],
		leftSidebarWidth: 300,
		contextWarningYellowThreshold: 70,
		contextWarningRedThreshold: 90,
		getFileCount: vi.fn(() => 0),
		getWorktreeChildren: vi.fn(() => [] as Session[]),
		setActiveSessionId: vi.fn(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CollapsedSessionPill', () => {
	beforeEach(() => {
		idCounter = 0;
	});

	it('renders a single pill segment for a session without worktrees', () => {
		const props = createDefaultProps();
		const { container } = render(<CollapsedSessionPill {...props} />);

		// Should have the outer pill container
		const pillContainer = container.firstElementChild;
		expect(pillContainer).toBeTruthy();
		// One segment (no worktrees)
		const segments = pillContainer!.children;
		expect(segments.length).toBe(1);
	});

	it('renders multiple segments for sessions with worktree children', () => {
		const parent = makeSession({ id: 'parent' });
		const child1 = makeSession({ id: 'child1' });
		const child2 = makeSession({ id: 'child2' });

		const props = createDefaultProps({
			session: parent,
			getWorktreeChildren: vi.fn(() => [child1, child2]),
		});

		const { container } = render(<CollapsedSessionPill {...props} />);

		const segments = container.firstElementChild!.children;
		expect(segments.length).toBe(3); // parent + 2 children
	});

	it('calls setActiveSessionId when a segment is clicked', () => {
		const session = makeSession({ id: 'test-session' });
		const setActiveSessionId = vi.fn();
		const props = createDefaultProps({ session, setActiveSessionId });

		const { container } = render(<CollapsedSessionPill {...props} />);

		const segment = container.firstElementChild!.firstElementChild!;
		fireEvent.click(segment);

		expect(setActiveSessionId).toHaveBeenCalledWith('test-session');
	});

	it('stops event propagation on click', () => {
		const props = createDefaultProps();
		const { container } = render(<CollapsedSessionPill {...props} />);

		const segment = container.firstElementChild!.firstElementChild!;
		const clickEvent = new MouseEvent('click', { bubbles: true });
		const stopPropagationSpy = vi.spyOn(clickEvent, 'stopPropagation');

		segment.dispatchEvent(clickEvent);
		expect(stopPropagationSpy).toHaveBeenCalled();
	});

	it('shows unread indicator on last segment when session has unread tabs', () => {
		const session = makeSession({
			aiTabs: [{ hasUnread: true } as any],
		});
		const props = createDefaultProps({ session });

		const { container } = render(<CollapsedSessionPill {...props} />);

		// The unread indicator is a small dot
		const segment = container.firstElementChild!.firstElementChild!;
		const unreadDot = segment.querySelector('.rounded-full');
		expect(unreadDot).toBeTruthy();
	});

	it('applies batch styling when session is in active batch', () => {
		const session = makeSession({ id: 'batch-session' });
		const props = createDefaultProps({
			session,
			activeBatchSessionIds: ['batch-session'],
		});

		const { container } = render(<CollapsedSessionPill {...props} />);

		const segment = container.firstElementChild!.firstElementChild!;
		expect(segment.className).toContain('animate-pulse');
	});

	it('applies hollow style for claude-code sessions without agentSessionId', () => {
		const session = makeSession({
			toolType: 'claude-code',
			agentSessionId: undefined,
		});
		const props = createDefaultProps({ session });

		const { container } = render(<CollapsedSessionPill {...props} />);

		const segment = container.firstElementChild!.firstElementChild! as HTMLElement;
		expect(segment.style.border).toContain('1px solid');
		expect(segment.style.backgroundColor).toBe('transparent');
	});

	it('mounts tooltip content only while a segment is hovered', () => {
		const session = makeSession({ name: 'My Test Agent' });
		const getFileCount = vi.fn(() => 3);
		const props = createDefaultProps({ session, getFileCount });

		const { container } = render(<CollapsedSessionPill {...props} />);
		const segment = container.firstElementChild!.firstElementChild!;

		expect(screen.queryByText('My Test Agent')).not.toBeInTheDocument();
		expect(getFileCount).not.toHaveBeenCalled();

		fireEvent.mouseEnter(segment, { clientX: 10, clientY: 20 });
		expect(screen.getByText('My Test Agent')).toBeTruthy();
		expect(getFileCount).toHaveBeenCalledTimes(1);

		fireEvent.mouseLeave(segment);
		expect(screen.queryByText('My Test Agent')).not.toBeInTheDocument();
	});

	it('mounts tooltip content while a segment has keyboard focus', () => {
		const session = makeSession({ name: 'Keyboard Agent' });
		const props = createDefaultProps({ session });
		const { container } = render(<CollapsedSessionPill {...props} />);
		const segment = container.firstElementChild!.firstElementChild!;

		fireEvent.focus(segment);
		expect(screen.getByText('Keyboard Agent')).toBeInTheDocument();

		fireEvent.blur(segment);
		expect(screen.queryByText('Keyboard Agent')).not.toBeInTheDocument();
	});

	it('does not show unread dot on non-last segments in multi-segment pill', () => {
		const parent = makeSession({ id: 'p1', aiTabs: [{ hasUnread: true } as any] });
		const child = makeSession({ id: 'c1', aiTabs: [{ hasUnread: true } as any] });

		const props = createDefaultProps({
			session: parent,
			getWorktreeChildren: vi.fn(() => [child]),
		});

		const { container } = render(<CollapsedSessionPill {...props} />);

		const segments = container.firstElementChild!.children;
		// First segment (parent) should NOT have unread dot (it's not last)
		const firstSegment = segments[0];
		const firstDots = firstSegment.querySelectorAll('.w-1\\.5.h-1\\.5');
		expect(firstDots.length).toBe(0);
	});

	it('uses gap between segments only when there are worktrees', () => {
		// Without worktrees
		const props1 = createDefaultProps();
		const { container: c1 } = render(<CollapsedSessionPill {...props1} />);
		expect((c1.firstElementChild as HTMLElement).style.gap).toBe('0');

		// With worktrees
		const parent = makeSession({ id: 'p2' });
		const child = makeSession({ id: 'c2' });
		const props2 = createDefaultProps({
			session: parent,
			getWorktreeChildren: vi.fn(() => [child]),
		});
		const { container: c2 } = render(<CollapsedSessionPill {...props2} />);
		expect((c2.firstElementChild as HTMLElement).style.gap).toBe('1px');
	});
});

// ---------------------------------------------------------------------------
// CollapsedSessionPillRows
// ---------------------------------------------------------------------------

function createRowsProps(
	sessions: Session[],
	overrides: Partial<Parameters<typeof CollapsedSessionPillRows>[0]> = {}
) {
	return {
		sessions,
		keyPrefix: 'rows-test',
		onContainerClick: vi.fn(),
		theme: mockTheme as Theme,
		activeBatchSessionIds: [] as string[],
		leftSidebarWidth: 300,
		contextWarningYellowThreshold: 70,
		contextWarningRedThreshold: 90,
		getFileCount: vi.fn(() => 0),
		getWorktreeChildren: vi.fn(() => [] as Session[]),
		setActiveSessionId: vi.fn(),
		...overrides,
	};
}

describe('CollapsedSessionPillRows', () => {
	beforeEach(() => {
		idCounter = 0;
	});

	it('renders a single row when session count is at or below the per-row cap', () => {
		const sessions = Array.from({ length: 20 }, () => makeSession());
		const props = createRowsProps(sessions);
		const { container } = render(<CollapsedSessionPillRows {...props} />);

		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.children.length).toBe(1);

		const row = wrapper.firstElementChild as HTMLElement;
		expect(row.children.length).toBe(20);
		// No spacers should exist when there is only a single row
		const spacers = row.querySelectorAll(':scope > div.flex-1:not(.rounded-full)');
		expect(spacers.length).toBe(0);
	});

	it('wraps to a new row when exceeding the per-row cap', () => {
		const sessions = Array.from({ length: 22 }, () => makeSession());
		const props = createRowsProps(sessions);
		const { container } = render(<CollapsedSessionPillRows {...props} />);

		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.children.length).toBe(2);

		const firstRow = wrapper.children[0] as HTMLElement;
		const secondRow = wrapper.children[1] as HTMLElement;
		// First row is full (20 pills, no spacers)
		expect(firstRow.children.length).toBe(20);
		// Second row has 2 pills + 18 spacers so widths stay aligned with row above
		expect(secondRow.children.length).toBe(20);
	});

	it('produces three rows for 41 sessions (20 + 20 + 1 + 19 spacers)', () => {
		const sessions = Array.from({ length: 41 }, () => makeSession());
		const props = createRowsProps(sessions);
		const { container } = render(<CollapsedSessionPillRows {...props} />);

		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.children.length).toBe(3);
		expect((wrapper.children[0] as HTMLElement).children.length).toBe(20);
		expect((wrapper.children[1] as HTMLElement).children.length).toBe(20);
		// Last row padded to 20 (1 pill + 19 spacers)
		expect((wrapper.children[2] as HTMLElement).children.length).toBe(20);
	});

	it('honors a custom maxPerRow, wrapping and padding to that cap', () => {
		const sessions = Array.from({ length: 12 }, () => makeSession());
		const props = createRowsProps(sessions, { maxPerRow: 5 });
		const { container } = render(<CollapsedSessionPillRows {...props} />);

		const wrapper = container.firstElementChild as HTMLElement;
		// 12 sessions at 5/row → 3 rows (5 + 5 + 2)
		expect(wrapper.children.length).toBe(3);
		expect((wrapper.children[0] as HTMLElement).children.length).toBe(5);
		expect((wrapper.children[1] as HTMLElement).children.length).toBe(5);
		// Last row padded to 5 (2 pills + 3 spacers)
		expect((wrapper.children[2] as HTMLElement).children.length).toBe(5);
	});

	it('falls back to the default cap of 20 when maxPerRow is omitted', () => {
		const sessions = Array.from({ length: 21 }, () => makeSession());
		const props = createRowsProps(sessions);
		const { container } = render(<CollapsedSessionPillRows {...props} />);

		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.children.length).toBe(2);
		expect((wrapper.children[0] as HTMLElement).children.length).toBe(20);
	});

	it('fires onContainerClick when the wrapper is clicked', () => {
		const sessions = [makeSession(), makeSession()];
		const onContainerClick = vi.fn();
		const props = createRowsProps(sessions, { onContainerClick });
		const { container } = render(<CollapsedSessionPillRows {...props} />);

		fireEvent.click(container.firstElementChild!);
		expect(onContainerClick).toHaveBeenCalledTimes(1);
	});

	it('renders nothing inside the wrapper when sessions is empty', () => {
		const props = createRowsProps([]);
		const { container } = render(<CollapsedSessionPillRows {...props} />);
		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.children.length).toBe(0);
	});
});
