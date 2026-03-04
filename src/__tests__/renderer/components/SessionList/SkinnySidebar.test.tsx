import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SkinnySidebar } from '../../../../renderer/components/SessionList/SkinnySidebar';
import type { Session, Group, Theme } from '../../../../renderer/types';

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
		...overrides,
	};
}

describe('SkinnySidebar', () => {
	beforeEach(() => {
		idCounter = 0;
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
});
