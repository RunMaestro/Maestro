import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SkinnySidebar } from '../../../../renderer/components/SessionList/SkinnySidebar';
import type { Session, Group, Theme } from '../../../../renderer/types';

import { mockTheme } from '../../../helpers/mockTheme';
import { createMockSession } from '../../../helpers';
import {
	useCrossAgentInFlightStore,
	type InFlightCrossAgentRequest,
} from '../../../../renderer/stores/crossAgentInFlightStore';

function consult(targetSessionId: string): InFlightCrossAgentRequest {
	return {
		requestId: `req-${targetSessionId}`,
		sourceSessionId: 'asker',
		sourceTabId: 'tab-1',
		targetSessionId,
		targetAgentName: 'Target',
		startedAt: Date.now(),
	};
}

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
		agentSessionId: 'active-session',
		...overrides,
	} as Session;
}

function createProps(overrides: Partial<Parameters<typeof SkinnySidebar>[0]> = {}) {
	return {
		theme: mockTheme,
		sortedSessions: [] as Session[],
		activeSessionId: '',
		groups: [] as Group[],
		activeBatchSessionIds: [] as string[],
		contextWarningYellowThreshold: 70,
		contextWarningRedThreshold: 90,
		getFileCount: vi.fn(() => 0),
		setActiveSessionId: vi.fn(),
		handleContextMenu: vi.fn(),
		showUnreadAgentsOnly: false,
		stuckOutageSignature: '',
		// Dot mode unless a test opts in: most cases here assert on the bare dot.
		showInitials: false,
		...overrides,
	};
}

describe('SkinnySidebar', () => {
	beforeEach(() => {
		idCounter = 0;
		useCrossAgentInFlightStore.setState({ requests: {} });
	});

	it('renders nothing when there are no sessions', () => {
		const { container } = render(<SkinnySidebar {...createProps()} />);
		expect(container.firstElementChild!.children.length).toBe(0);
	});

	it('renders a dot for each session', () => {
		const sessions = [makeSession(), makeSession(), makeSession()];
		const { container } = render(<SkinnySidebar {...createProps({ sortedSessions: sessions })} />);
		// Each session gets a clickable dot container
		expect(container.firstElementChild!.children.length).toBe(3);
	});

	it('calls setActiveSessionId when a dot is clicked', () => {
		const s1 = makeSession({ id: 'test-id' });
		const setActiveSessionId = vi.fn();
		const { container } = render(
			<SkinnySidebar {...createProps({ sortedSessions: [s1], setActiveSessionId })} />
		);

		fireEvent.click(container.firstElementChild!.firstElementChild!);
		expect(setActiveSessionId).toHaveBeenCalledWith('test-id');
	});

	it('calls handleContextMenu on right-click', () => {
		const s1 = makeSession({ id: 'ctx-id' });
		const handleContextMenu = vi.fn();
		const { container } = render(
			<SkinnySidebar {...createProps({ sortedSessions: [s1], handleContextMenu })} />
		);

		fireEvent.contextMenu(container.firstElementChild!.firstElementChild!);
		expect(handleContextMenu).toHaveBeenCalled();
		expect(handleContextMenu.mock.calls[0][1]).toBe('ctx-id');
	});

	it('shows active session at full opacity', () => {
		const s1 = makeSession({ id: 'active' });
		const { container } = render(
			<SkinnySidebar {...createProps({ sortedSessions: [s1], activeSessionId: 'active' })} />
		);

		const dot = container.querySelector('.rounded-full.w-3') as HTMLElement;
		expect(dot.style.opacity).toBe('1');
	});

	it('shows inactive sessions at reduced opacity', () => {
		const s1 = makeSession({ id: 'inactive' });
		const { container } = render(
			<SkinnySidebar {...createProps({ sortedSessions: [s1], activeSessionId: 'other' })} />
		);

		const dot = container.querySelector('.rounded-full.w-3') as HTMLElement;
		expect(dot.style.opacity).toBe('0.25');
	});

	it('applies pulse animation for busy sessions', () => {
		const s1 = makeSession({ state: 'busy' });
		const { container } = render(<SkinnySidebar {...createProps({ sortedSessions: [s1] })} />);

		const dot = container.querySelector('.w-3.h-3') as HTMLElement;
		expect(dot.className).toContain('animate-pulse');
	});

	it('applies pulse animation for batch sessions', () => {
		const s1 = makeSession({ id: 'batch-s' });
		const { container } = render(
			<SkinnySidebar
				{...createProps({ sortedSessions: [s1], activeBatchSessionIds: ['batch-s'] })}
			/>
		);

		const dot = container.querySelector('.w-3.h-3') as HTMLElement;
		expect(dot.className).toContain('animate-pulse');
	});

	it('shows unread badge for inactive sessions with unread tabs', () => {
		const s1 = makeSession({
			id: 'unread-s',
			aiTabs: [{ hasUnread: true } as any],
		});
		const { container } = render(
			<SkinnySidebar {...createProps({ sortedSessions: [s1], activeSessionId: 'other' })} />
		);

		const badge = container.querySelector('[title="Unread messages"]');
		expect(badge).toBeTruthy();
	});

	it('hides unread badge for active session', () => {
		const s1 = makeSession({
			id: 'active-s',
			aiTabs: [{ hasUnread: true } as any],
		});
		const { container } = render(
			<SkinnySidebar {...createProps({ sortedSessions: [s1], activeSessionId: 'active-s' })} />
		);

		const badge = container.querySelector('[title="Unread messages"]');
		expect(badge).toBeNull();
	});

	it('renders tooltip with session name on hover', () => {
		const s1 = makeSession({ name: 'My Special Agent' });
		render(<SkinnySidebar {...createProps({ sortedSessions: [s1] })} />);

		expect(screen.getByText('My Special Agent')).toBeTruthy();
	});

	it('uses hollow style for claude-code sessions without agentSessionId', () => {
		const s1 = makeSession({
			toolType: 'claude-code',
			agentSessionId: undefined,
		});
		const { container } = render(<SkinnySidebar {...createProps({ sortedSessions: [s1] })} />);

		const dot = container.querySelector('.w-3.h-3') as HTMLElement;
		expect(dot.style.backgroundColor).toBe('transparent');
		expect(dot.style.border).toContain('1.5px solid');
	});
	it('keeps an auto-running (batch) agent visible under the unread filter', () => {
		const batch = createMockSession({ id: 'batch-s' });
		const idle = createMockSession({ id: 'idle-s' });
		const { container } = render(
			<SkinnySidebar
				{...createProps({
					sortedSessions: [batch, idle],
					activeSessionId: 'other',
					activeBatchSessionIds: ['batch-s'],
					showUnreadAgentsOnly: true,
				})}
			/>
		);

		expect(container.querySelectorAll('[aria-label^="Switch to "]').length).toBe(1);
	});

	it('keeps a stuck (outage) agent visible under the unread filter', () => {
		const stuck = createMockSession({ id: 'stuck-s' });
		const idle = createMockSession({ id: 'idle-s' });
		const { container } = render(
			<SkinnySidebar
				{...createProps({
					sortedSessions: [stuck, idle],
					activeSessionId: 'other',
					stuckOutageSignature: 'stuck-s',
					showUnreadAgentsOnly: true,
				})}
			/>
		);

		expect(container.querySelectorAll('[aria-label^="Switch to "]').length).toBe(1);
	});

	it('hides idle agents under the unread filter', () => {
		const idle1 = createMockSession({ id: 'idle-1' });
		const idle2 = createMockSession({ id: 'idle-2' });
		const { container } = render(
			<SkinnySidebar
				{...createProps({
					sortedSessions: [idle1, idle2],
					activeSessionId: 'other',
					showUnreadAgentsOnly: true,
				})}
			/>
		);

		expect(container.querySelectorAll('[aria-label^="Switch to "]').length).toBe(0);
	});
	/**
	 * A consult never touches `session.state` (hidden tab, synthetic process id),
	 * so the rail folds the in-flight store in beside Auto Run. Without it a
	 * consulted agent drew a green idle dot for the whole time it was working.
	 */
	it('paints a consulted agent as busy', () => {
		const s1 = makeSession({ id: 'consulted' });
		useCrossAgentInFlightStore.setState({ requests: { a: consult('consulted') } });

		const { container } = render(<SkinnySidebar {...createProps({ sortedSessions: [s1] })} />);

		const dot = container.querySelector('.w-3.h-3') as HTMLElement;
		expect(dot.className).toContain('animate-pulse');
		expect(dot.style.backgroundColor).toBeTruthy();
		expect(dot.style.backgroundColor).not.toBe('transparent');
	});

	// An unopened Claude agent is the COMMON consult target, so the hollow dot
	// would mask exactly the case the consult signal exists to show.
	it('outranks the unbound-Claude hollow dot', () => {
		const s1 = makeSession({ id: 'consulted', toolType: 'claude-code', agentSessionId: undefined });
		useCrossAgentInFlightStore.setState({ requests: { a: consult('consulted') } });

		const { container } = render(<SkinnySidebar {...createProps({ sortedSessions: [s1] })} />);

		const dot = container.querySelector('.w-3.h-3') as HTMLElement;
		expect(dot.style.backgroundColor).not.toBe('transparent');
		expect(dot.className).toContain('animate-pulse');
	});

	it('leaves an agent nobody is consulting alone', () => {
		const s1 = makeSession({ id: 'quiet' });
		useCrossAgentInFlightStore.setState({ requests: { a: consult('someone-else') } });

		const { container } = render(<SkinnySidebar {...createProps({ sortedSessions: [s1] })} />);

		const dot = container.querySelector('.w-3.h-3') as HTMLElement;
		expect(dot.className).not.toContain('animate-pulse');
	});

	describe('initials mode', () => {
		const fill = (container: HTMLElement) =>
			container.querySelector('[data-testid="skinny-initials-fill"]') as HTMLElement;

		it('labels each agent with two letters instead of a dot', () => {
			const sessions = [
				makeSession({ name: 'Maestro RC' }),
				makeSession({ name: 'Greg Fitzgerald' }),
			];
			const { container } = render(
				<SkinnySidebar {...createProps({ sortedSessions: sessions, showInitials: true })} />
			);

			const badges = container.querySelectorAll('[data-testid="skinny-initials-badge"]');
			expect(Array.from(badges, (b) => b.textContent)).toEqual(['MR', 'GF']);
			// Scoped to the status dot: the hover tooltip has w-3 icons of its own.
			expect(container.querySelector('.rounded-full.w-3.h-3')).toBeNull();
		});

		it('gives agents that would collide different labels', () => {
			const sessions = [makeSession({ name: 'Maestro' }), makeSession({ name: 'Marketing' })];
			const { container } = render(
				<SkinnySidebar {...createProps({ sortedSessions: sessions, showInitials: true })} />
			);

			const labels = Array.from(
				container.querySelectorAll('[data-testid="skinny-initials-badge"]'),
				(b) => b.textContent
			);
			expect(labels[0]).toBe('Ma');
			expect(labels[1]).not.toBe('Ma');
			expect(labels[1]).toHaveLength(2);
		});

		// The unread filter hides rows; it must not rename the ones left over.
		it('keeps a label stable when the unread filter hides its rival', () => {
			const first = makeSession({ id: 'first', name: 'Maestro' });
			const second = makeSession({ id: 'second', name: 'Marketing' });
			const props = createProps({
				sortedSessions: [first, second],
				activeSessionId: 'second',
				showInitials: true,
			});

			const unfiltered = render(<SkinnySidebar {...props} />);
			const before = unfiltered.container.querySelectorAll(
				'[data-testid="skinny-initials-badge"]'
			)[1].textContent;
			unfiltered.unmount();

			const { container } = render(<SkinnySidebar {...props} showUnreadAgentsOnly />);
			const badges = container.querySelectorAll('[data-testid="skinny-initials-badge"]');
			expect(badges.length).toBe(1);
			expect(badges[0].textContent).toBe(before);
		});

		it('rings the active agent and leaves the others unringed', () => {
			const active = makeSession({ id: 'active', name: 'Alpha' });
			const other = makeSession({ id: 'other', name: 'Beta' });
			const { container } = render(
				<SkinnySidebar
					{...createProps({
						sortedSessions: [active, other],
						activeSessionId: 'active',
						showInitials: true,
					})}
				/>
			);

			const fills = container.querySelectorAll<HTMLElement>('[data-testid="skinny-initials-fill"]');
			expect(fills[0].style.border).not.toContain('transparent');
			expect(fills[1].style.border).toContain('transparent');
		});

		it('pulses the fill, not the letters, for a busy agent', () => {
			const s1 = makeSession({ state: 'busy', name: 'Busy Bee' });
			const { container } = render(
				<SkinnySidebar {...createProps({ sortedSessions: [s1], showInitials: true })} />
			);

			expect(fill(container).className).toContain('animate-pulse');
			expect(screen.getByText('BB').className).not.toContain('animate-pulse');
		});

		it('keeps the hollow outline for a Claude agent with no provider session', () => {
			const s1 = makeSession({ toolType: 'claude-code', agentSessionId: undefined });
			const { container } = render(
				<SkinnySidebar {...createProps({ sortedSessions: [s1], showInitials: true })} />
			);

			expect(fill(container).style.backgroundColor).toBe('transparent');
			expect(fill(container).style.border).toContain('1.5px solid');
		});

		it('fills a consulted agent even when it has no provider session', () => {
			const s1 = makeSession({
				id: 'consulted',
				toolType: 'claude-code',
				agentSessionId: undefined,
			});
			useCrossAgentInFlightStore.setState({ requests: { a: consult('consulted') } });

			const { container } = render(
				<SkinnySidebar {...createProps({ sortedSessions: [s1], showInitials: true })} />
			);

			expect(fill(container).style.backgroundColor).not.toBe('transparent');
			expect(fill(container).className).toContain('animate-pulse');
		});

		it('still shows the unread corner dot on an inactive agent', () => {
			const s1 = makeSession({ id: 'unread-s', aiTabs: [{ hasUnread: true } as any] });
			const { container } = render(
				<SkinnySidebar
					{...createProps({
						sortedSessions: [s1],
						activeSessionId: 'other',
						showInitials: true,
					})}
				/>
			);

			expect(container.querySelector('[title="Unread messages"]')).toBeTruthy();
		});
	});
});
