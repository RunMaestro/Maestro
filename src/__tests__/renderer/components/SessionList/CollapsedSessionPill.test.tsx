import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsedSessionPill } from '../../../../renderer/components/SessionList/CollapsedSessionPill';
import type { Session, Theme } from '../../../../renderer/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockTheme: Theme = {
	name: 'test',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgInput: '#0f3460',
		textMain: '#e0e0e0',
		textDim: '#888888',
		accent: '#e94560',
		border: '#333333',
		error: '#ff4444',
		success: '#00cc66',
		warning: '#ffaa00',
	},
} as Theme;

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

	it('renders tooltip content within each segment', () => {
		const session = makeSession({ name: 'My Test Agent' });
		const props = createDefaultProps({ session });

		render(<CollapsedSessionPill {...props} />);

		// The tooltip content should include the session name
		expect(screen.getByText('My Test Agent')).toBeTruthy();
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
