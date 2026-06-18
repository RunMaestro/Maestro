import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugApplicationStatsModal } from '../../../renderer/components/DebugApplicationStatsModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session, Theme } from '../../../renderer/types';
import { THEMES } from '../../../shared/themes';

const loggerMock = vi.hoisted(() => ({
	error: vi.fn(),
}));

vi.mock('../../../renderer/utils/logger', () => ({
	logger: loggerMock,
}));

const theme = THEMES.dracula as Theme;

function makeSession(overrides: Partial<Session>): Session {
	return {
		id: 'session',
		name: 'Session',
		cwd: '/repo',
		projectRoot: '/repo',
		status: 'idle',
		toolType: 'claude-code',
		logs: [],
		aiTabs: [],
		terminalTabs: [],
		browserTabs: [],
		filePreviewTabs: [],
		fileTree: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as Session;
}

function appStats(overrides = {}) {
	return {
		main: {
			heapUsed: 1024,
			heapTotal: 4096,
		},
		electronProcesses: [
			{
				pid: 1,
				type: 'browser',
				name: 'Maestro',
				workingSetBytes: 8192,
				cpuPercent: 1.25,
			},
		],
		managedProcesses: [
			{ pid: 101, rssBytes: 4096 },
			{ pid: 202, rssBytes: 2048 },
		],
		...overrides,
	};
}

function renderModal(onClose = vi.fn()) {
	return render(
		<LayerStackProvider>
			<DebugApplicationStatsModal theme={theme} onClose={onClose} />
		</LayerStackProvider>
	);
}

function resetSessions(sessions: Session[] = []) {
	act(() => {
		useSessionStore.setState({
			sessions,
			groups: [],
			activeSessionId: sessions[0]?.id ?? '',
			sessionsLoaded: true,
			initialLoadComplete: true,
			initialFileTreeReady: true,
			removedWorktreePaths: new Set(),
			cyclePosition: -1,
		});
	});
}

describe('DebugApplicationStatsModal', () => {
	beforeEach(() => {
		loggerMock.error.mockClear();
		(window as any).maestro.debug = {
			getAppStats: vi.fn().mockResolvedValue(appStats()),
		};
	});

	afterEach(() => {
		cleanup();
		resetSessions();
		delete (window as any).maestro.debug;
	});

	it('summarizes lazy-loaded session footprints and process memory', async () => {
		resetSessions([
			makeSession({
				id: 'cold',
				name: 'Cold Agent',
				aiTabs: [
					{
						id: 'ai-cold',
						title: 'AI',
						logs: [{ type: 'output', data: 'persisted log text' }],
					},
				] as any,
				filePreviewTabs: [
					{ id: 'file-1', path: '/repo/README.md', content: 'preview body' },
				] as any,
				browserTabs: [{ id: 'web-1', url: 'https://example.test' }] as any,
			}),
			makeSession({
				id: 'warm',
				name: 'Warm Agent',
				fileTree: [
					{ name: 'src', path: '/repo/src', type: 'directory', children: [] },
					{ name: 'index.ts', path: '/repo/src/index.ts', type: 'file' },
				] as any,
				fileTreeStats: { fileCount: 1, folderCount: 1 },
			} as Partial<Session>),
			makeSession({
				id: 'active',
				name: 'Active Agent',
				aiPid: 101,
				terminalTabs: [{ id: 'term-1', title: 'Shell', pid: 202 }] as any,
			} as Partial<Session>),
		]);

		renderModal();

		expect(await screen.findByText('Electron processes (1)')).toBeInTheDocument();
		expect(screen.getByText('1 active · 1 warm · 1 cold')).toBeInTheDocument();
		expect(screen.getByText('1 log entries')).toBeInTheDocument();
		expect(screen.getByText('2 PIDs tracked')).toBeInTheDocument();
		expect(screen.getByText('main heap 1.0 KB / 4.0 KB')).toBeInTheDocument();

		expect(screen.getByText('Cold Agent')).toBeInTheDocument();
		expect(screen.getByText('Warm Agent')).toBeInTheDocument();
		expect(screen.getByText('Active Agent')).toBeInTheDocument();
		expect(screen.getByText('Cold')).toBeInTheDocument();
		expect(screen.getByText('Warm')).toBeInTheDocument();
		expect(screen.getByText('Active')).toBeInTheDocument();
		expect(screen.getByText('pid 101')).toBeInTheDocument();
		expect(screen.getAllByText('4.0 KB').length).toBeGreaterThan(0);
		expect((window as any).maestro.debug.getAppStats).toHaveBeenCalledTimes(1);
	});

	it('sorts agents, refreshes stats, closes, and reports refresh failures', async () => {
		const onClose = vi.fn();
		resetSessions([
			makeSession({ id: 'b', name: 'Bravo Agent', aiPid: 101 }),
			makeSession({ id: 'a', name: 'Alpha Agent', fileTree: [{ name: 'src' }] as any }),
		]);

		const getAppStats = vi
			.fn()
			.mockResolvedValueOnce(appStats())
			.mockResolvedValueOnce(appStats({ managedProcesses: [] }))
			.mockRejectedValueOnce(new Error('debug unavailable'));
		(window as any).maestro.debug.getAppStats = getAppStats;

		renderModal(onClose);
		await screen.findByText('Electron processes (1)');

		fireEvent.click(screen.getByText(/^Agent$/));
		const alpha = screen.getByText('Alpha Agent');
		const bravo = screen.getByText('Bravo Agent');
		expect(alpha.compareDocumentPosition(bravo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
		await waitFor(() => expect(getAppStats).toHaveBeenCalledTimes(2));

		fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
		expect(await screen.findByText('Failed to load stats: debug unavailable')).toBeInTheDocument();
		expect(loggerMock.error).toHaveBeenCalledWith(
			'[DebugAppStats] Failed to load stats',
			undefined,
			expect.any(Error)
		);

		fireEvent.click(screen.getByRole('button', { name: /close modal/i }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('renders an empty session table while snapshot data is still loading', async () => {
		resetSessions();
		(window as any).maestro.debug.getAppStats = vi.fn().mockResolvedValue(
			appStats({
				electronProcesses: [],
				managedProcesses: [],
			})
		);

		renderModal();

		expect(screen.getByText('No agents.')).toBeInTheDocument();
		expect(screen.getByText('0 active · 0 warm · 0 cold')).toBeInTheDocument();
		expect(await screen.findByText('0 PIDs tracked')).toBeInTheDocument();
	});
});
