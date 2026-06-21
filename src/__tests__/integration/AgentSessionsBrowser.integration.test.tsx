import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSessionsBrowser } from '../../renderer/components/AgentSessionsBrowser';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { ClaudeSession, SessionMessage } from '../../renderer/hooks';
import type { Session, Theme } from '../../renderer/types';
import { logger } from '../../renderer/utils/logger';

const theme: Theme = {
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
		accentDim: '#bd93f933',
		accentText: '#f8f8f2',
		accentForeground: '#282a36',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

let projectStatsListener: ((stats: any) => void) | null = null;

function agentSession(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
	return {
		sessionId: 'session-alpha-1111',
		projectPath: '/repo',
		timestamp: '2026-01-01T10:00:00Z',
		modifiedAt: '2026-01-01T11:00:00Z',
		firstMessage: 'Build the release checklist',
		messageCount: 8,
		sizeBytes: 4096,
		costUsd: 0.25,
		inputTokens: 1200,
		outputTokens: 800,
		cacheReadTokens: 100,
		cacheCreationTokens: 50,
		durationSeconds: 125,
		origin: 'user',
		...overrides,
	};
}

function message(overrides: Partial<SessionMessage> = {}): SessionMessage {
	return {
		type: 'assistant',
		content: 'Assistant response',
		timestamp: '2026-01-01T10:05:00Z',
		uuid: `msg-${Math.random().toString(36).slice(2)}`,
		...overrides,
	};
}

function activeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Desktop Project',
		toolType: 'claude-code',
		createdAt: Date.parse('2026-01-01T09:00:00Z'),
		state: 'idle',
		inputMode: 'ai',
		cwd: '/repo',
		projectRoot: '/repo',
		aiLogs: [],
		shellLogs: [],
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		...overrides,
	} as Session;
}

function renderBrowser(overrides: Partial<React.ComponentProps<typeof AgentSessionsBrowser>> = {}) {
	const props = {
		theme,
		activeSession: activeSession(),
		activeAgentSessionId: null,
		onClose: vi.fn(),
		onResumeSession: vi.fn(),
		onNewSession: vi.fn(),
		onUpdateTab: vi.fn(),
		...overrides,
	};

	const view = render(
		<LayerStackProvider>
			<AgentSessionsBrowser {...props} />
		</LayerStackProvider>
	);

	return { ...view, props };
}

function setInitialSessions(sessions: ClaudeSession[], options: { hasMore?: boolean } = {}) {
	vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
		sessions,
		hasMore: options.hasMore ?? false,
		totalCount: sessions.length,
		nextCursor: options.hasMore ? 'next-page' : null,
	});
}

function resetBridgeMocks() {
	projectStatsListener = null;

	vi.mocked(window.maestro.agentSessions.listPaginated).mockReset();
	vi.mocked(window.maestro.agentSessions.read).mockReset();
	vi.mocked(window.maestro.agentSessions.search).mockReset();
	vi.mocked(window.maestro.agentSessions.getOrigins).mockReset();
	vi.mocked(window.maestro.agentSessions.setSessionName).mockReset();
	vi.mocked(window.maestro.agentSessions.setSessionStarred).mockReset();
	vi.mocked(window.maestro.claude.getSessionOrigins).mockReset();
	vi.mocked(window.maestro.claude.getProjectStats).mockReset();
	vi.mocked(window.maestro.claude.updateSessionName).mockReset();
	vi.mocked(window.maestro.claude.updateSessionStarred).mockReset();
	vi.mocked(window.maestro.claude.onProjectStatsUpdate).mockReset();

	vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
		sessions: [],
		hasMore: false,
		totalCount: 0,
		nextCursor: null,
	});
	vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
		messages: [],
		total: 0,
		hasMore: false,
	});
	vi.mocked(window.maestro.agentSessions.search).mockResolvedValue([]);
	vi.mocked(window.maestro.agentSessions.getOrigins).mockResolvedValue({});
	vi.mocked(window.maestro.agentSessions.setSessionName).mockResolvedValue(undefined);
	vi.mocked(window.maestro.agentSessions.setSessionStarred).mockResolvedValue(undefined);
	vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({});
	vi.mocked(window.maestro.claude.getProjectStats).mockResolvedValue(undefined);
	vi.mocked(window.maestro.claude.updateSessionName).mockResolvedValue(undefined);
	vi.mocked(window.maestro.claude.updateSessionStarred).mockResolvedValue(undefined);
	vi.mocked(window.maestro.claude.onProjectStatsUpdate).mockImplementation((listener) => {
		projectStatsListener = listener;
		return () => {
			projectStatsListener = null;
		};
	});
}

describe('AgentSessionsBrowser integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetBridgeMocks();
		Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
			configurable: true,
			value: vi.fn(),
		});
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			callback(performance.now());
			return 1;
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		resetBridgeMocks();
	});

	it('loads Claude sessions with origins, project stats, rename, star, and quick resume flows', async () => {
		const sessions = [
			agentSession({ sessionId: 'session-alpha-1111', sessionName: 'Initial named session' }),
			agentSession({
				sessionId: 'session-beta-2222',
				firstMessage: 'Investigate deployment output',
				modifiedAt: '2026-01-01T09:30:00Z',
				messageCount: 7,
				costUsd: 0.5,
				origin: 'auto',
			}),
		];
		setInitialSessions(sessions);
		vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
			'session-alpha-1111': {
				origin: 'user',
				sessionName: 'Initial named session',
				starred: true,
			},
		});

		const { props } = renderBrowser();

		expect(await screen.findByText('Initial named session')).toBeInTheDocument();
		expect(window.maestro.agentSessions.listPaginated).toHaveBeenCalledWith(
			'claude-code',
			'/repo',
			{ limit: 100 },
			undefined
		);
		expect(window.maestro.claude.getProjectStats).toHaveBeenCalledWith('/repo');

		act(() => {
			projectStatsListener?.({
				projectPath: '/repo',
				totalSessions: 2,
				totalMessages: 15,
				totalCostUsd: 1.5,
				totalSizeBytes: 8192,
				totalTokens: 6400,
				oldestTimestamp: '2026-01-01T08:00:00Z',
				isComplete: true,
			});
		});
		expect(screen.getByText('2 sessions')).toBeInTheDocument();
		expect(screen.getByText('15 messages')).toBeInTheDocument();
		expect(screen.getByText('$1.50')).toBeInTheDocument();

		fireEvent.click(screen.getAllByTitle('Remove from favorites')[0]);
		await waitFor(() =>
			expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
				'/repo',
				'session-alpha-1111',
				false
			)
		);
		expect(props.onUpdateTab).toHaveBeenCalledWith('session-alpha-1111', { starred: false });

		fireEvent.click(screen.getAllByTitle('Rename session')[0]);
		const renameInput = await screen.findByPlaceholderText('Enter session name...');
		fireEvent.change(renameInput, { target: { value: 'Release audit' } });
		fireEvent.keyDown(renameInput, { key: 'Enter' });
		await waitFor(() =>
			expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
				'/repo',
				'session-alpha-1111',
				'Release audit'
			)
		);
		expect(props.onUpdateTab).toHaveBeenCalledWith('session-alpha-1111', {
			name: 'Release audit',
		});

		fireEvent.click(screen.getAllByTitle('Resume session in new tab')[0]);
		expect(props.onResumeSession).toHaveBeenCalledWith(
			'session-alpha-1111',
			[],
			'Release audit',
			false,
			expect.objectContaining({ totalCostUsd: 0.25 })
		);
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('searches content, opens details, paginates messages, and resumes with loaded logs', async () => {
		const session = agentSession({
			sessionId: 'session-search-3333',
			sessionName: 'Deploy thread',
			firstMessage: 'Review deploy script',
		});
		setInitialSessions([session]);
		vi.mocked(window.maestro.agentSessions.search).mockResolvedValue([
			{
				sessionId: 'session-search-3333',
				matchType: 'user',
				matchPreview: 'deploy script failed on staging',
				matchCount: 2,
			},
		]);
		vi.mocked(window.maestro.agentSessions.read)
			.mockResolvedValueOnce({
				messages: [
					message({
						type: 'user',
						content: 'Please inspect the deploy script',
						timestamp: '2026-01-01T10:00:00Z',
						uuid: 'user-1',
					}),
					message({
						content: 'The deploy script exits before uploading artifacts',
						timestamp: '2026-01-01T10:01:00Z',
						uuid: 'assistant-1',
					}),
				],
				total: 3,
				hasMore: true,
			})
			.mockResolvedValueOnce({
				messages: [
					message({
						type: 'user',
						content: 'Older context',
						timestamp: '2026-01-01T09:50:00Z',
						uuid: 'user-0',
					}),
				],
				total: 3,
				hasMore: false,
			});

		const { props } = renderBrowser();

		expect(await screen.findByText('Deploy thread')).toBeInTheDocument();
		fireEvent.click(screen.getByText('All'));
		fireEvent.click(screen.getByText('My Messages'));
		fireEvent.change(screen.getByPlaceholderText('Search your messages...'), {
			target: { value: 'deploy' },
		});

		await waitFor(() =>
			expect(window.maestro.agentSessions.search).toHaveBeenCalledWith(
				'claude-code',
				'/repo',
				'deploy',
				'user',
				undefined
			)
		);
		expect(
			await screen.findByText(
				(_, element) => element?.textContent === '"deploy script failed on staging"'
			)
		).toBeInTheDocument();

		fireEvent.click(screen.getByText('Deploy thread'));
		expect(
			await screen.findByText('The deploy script exits before uploading artifacts')
		).toBeInTheDocument();
		expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
			'claude-code',
			'/repo',
			'session-search-3333',
			{ offset: 0, limit: 20 },
			undefined
		);

		fireEvent.click(screen.getByText('Load earlier messages...'));
		expect(await screen.findByText('Older context')).toBeInTheDocument();
		expect(window.maestro.agentSessions.read).toHaveBeenLastCalledWith(
			'claude-code',
			'/repo',
			'session-search-3333',
			{ offset: 2, limit: 20 },
			undefined
		);

		fireEvent.click(screen.getByText('Resume'));
		expect(props.onResumeSession).toHaveBeenCalledWith(
			'session-search-3333',
			expect.arrayContaining([
				expect.objectContaining({ id: 'user-0', text: 'Older context', source: 'user' }),
				expect.objectContaining({
					id: 'assistant-1',
					text: 'The deploy script exits before uploading artifacts',
					source: 'stdout',
				}),
			]),
			'Deploy thread',
			false,
			expect.objectContaining({ totalCostUsd: 0.25 })
		);
	});

	it('uses remote non-Claude storage, local aggregate stats, filters, graph toggle, and keyboard open', async () => {
		const visibleSession = agentSession({
			sessionId: 'opencode-visible-4444',
			sessionName: 'Remote named',
			firstMessage: 'Remote visible work',
			modifiedAt: '2026-01-02T11:00:00Z',
			messageCount: 4,
			costUsd: 0.75,
			inputTokens: 300,
			outputTokens: 200,
		});
		const hiddenAgentSession = agentSession({
			sessionId: 'agent-hidden-5555',
			sessionName: 'Hidden agent session',
			firstMessage: 'Hidden until show all',
			modifiedAt: '2026-01-02T10:00:00Z',
			messageCount: 6,
			costUsd: 0.25,
			inputTokens: 100,
			outputTokens: 50,
		});
		setInitialSessions([visibleSession, hiddenAgentSession]);
		vi.mocked(window.maestro.agentSessions.getOrigins).mockResolvedValue({
			'opencode-visible-4444': { origin: 'user', starred: true },
		});
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
			messages: [message({ content: 'Remote detail loaded', uuid: 'remote-1' })],
			total: 1,
			hasMore: false,
		});

		renderBrowser({
			activeSession: activeSession({
				name: 'Remote Project',
				toolType: 'opencode',
				sshRemoteId: 'remote-1',
				remoteCwd: '/srv/app',
				projectRoot: '/local/repo',
			}),
		});

		expect(await screen.findByText('Remote named')).toBeInTheDocument();
		expect(window.maestro.agentSessions.getOrigins).toHaveBeenCalledWith('opencode', '/srv/app');
		expect(window.maestro.agentSessions.listPaginated).toHaveBeenCalledWith(
			'opencode',
			'/srv/app',
			{ limit: 100 },
			'remote-1'
		);
		expect(window.maestro.claude.onProjectStatsUpdate).not.toHaveBeenCalled();
		expect(screen.queryByText('Hidden agent session')).not.toBeInTheDocument();

		fireEvent.click(screen.getAllByTitle('Remove from favorites')[0]);
		await waitFor(() =>
			expect(window.maestro.agentSessions.setSessionStarred).toHaveBeenCalledWith(
				'opencode',
				'/local/repo',
				'opencode-visible-4444',
				false
			)
		);

		fireEvent.click(screen.getAllByTitle('Rename session')[0]);
		const renameInput = await screen.findByPlaceholderText('Enter session name...');
		fireEvent.change(renameInput, { target: { value: 'Remote renamed' } });
		fireEvent.keyDown(renameInput, { key: 'Enter' });
		await waitFor(() =>
			expect(window.maestro.agentSessions.setSessionName).toHaveBeenCalledWith(
				'opencode',
				'/local/repo',
				'opencode-visible-4444',
				'Remote renamed'
			)
		);
		expect(await screen.findByText('Remote renamed')).toBeInTheDocument();

		fireEvent.click(screen.getByLabelText('Show All'));
		expect(await screen.findByText('Hidden agent session')).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText('Named'));
		expect(screen.getByText('Remote renamed')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Show activity graph'));
		expect(screen.getByTitle(/All time:/)).toBeInTheDocument();
		fireEvent.keyDown(document, { key: 'f', metaKey: true });
		expect(await screen.findByPlaceholderText('Search all content...')).toBeInTheDocument();

		fireEvent.keyDown(screen.getByPlaceholderText('Search all content...'), { key: 'Enter' });
		expect(await screen.findByText('Remote detail loaded')).toBeInTheDocument();
		expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
			'opencode',
			'/srv/app',
			'opencode-visible-4444',
			{ offset: 0, limit: 20 },
			'remote-1'
		);
	});

	it('handles detail header rename, favorite toggles, tool-call rendering, and Escape navigation', async () => {
		const session = agentSession({
			sessionId: 'session-detail-6666',
			sessionName: undefined,
			firstMessage: 'Investigate unnamed detail',
			durationSeconds: 3725,
			inputTokens: 185000,
			outputTokens: 10000,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
		});
		setInitialSessions([session]);
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
			messages: [
				message({
					content: '',
					uuid: 'tool-1',
					toolUse: [
						{
							name: 'Bash',
							state: {
								status: 'completed',
								input: { command: 'npm test' },
								output: 'ok',
							},
						},
					],
				}),
			],
			total: 1,
			hasMore: false,
		});

		const { props } = renderBrowser();

		expect(await screen.findByText('Investigate unnamed detail')).toBeInTheDocument();
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(props.onClose).toHaveBeenCalledOnce();
		props.onClose.mockClear();

		fireEvent.click(screen.getByText('Investigate unnamed detail'));
		expect(await screen.findByText('Tool: Bash')).toBeInTheDocument();
		expect(screen.getByText('1h 2m')).toBeInTheDocument();
		expect(screen.getByText(/97\.5/)).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Add to favorites'));
		await waitFor(() =>
			expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
				'/repo',
				'session-detail-6666',
				true
			)
		);

		fireEvent.click(screen.getByTitle('Add session name'));
		const input = await screen.findByPlaceholderText('Enter session name...');
		fireEvent.change(input, { target: { value: 'Named from detail' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		await waitFor(() =>
			expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
				'/repo',
				'session-detail-6666',
				'Named from detail'
			)
		);
		expect(props.onUpdateTab).toHaveBeenCalledWith('session-detail-6666', {
			name: 'Named from detail',
		});
		await waitFor(() => expect(screen.getByText('Named from detail')).toBeInTheDocument());

		props.onResumeSession.mockClear();
		fireEvent.click(screen.getByText('Resume'));
		expect(props.onResumeSession).toHaveBeenCalledWith(
			'session-detail-6666',
			[],
			'Named from detail',
			true,
			expect.objectContaining({ totalCostUsd: 0.25 })
		);
		props.onClose.mockClear();

		fireEvent.keyDown(document, { key: 'Escape' });
		expect(await screen.findByText('Investigate unnamed detail')).toBeInTheDocument();
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('navigates the list with arrow keys and quick-resumes sessions without usage stats', async () => {
		const firstSession = agentSession({
			sessionId: 'keyboard-first-7777',
			sessionName: 'Keyboard first',
			firstMessage: 'Newest keyboard session',
			modifiedAt: '2026-01-03T11:00:00Z',
			costUsd: undefined,
		});
		const secondSession = agentSession({
			sessionId: 'keyboard-second-8888',
			sessionName: 'Keyboard second',
			firstMessage: 'Older keyboard session',
			modifiedAt: '2026-01-03T10:00:00Z',
		});
		setInitialSessions([firstSession, secondSession]);
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
			messages: [message({ content: 'Keyboard second detail loaded', uuid: 'keyboard-detail' })],
			total: 1,
			hasMore: false,
		});

		const { props } = renderBrowser();

		const searchInput = await screen.findByPlaceholderText('Search all content...');
		fireEvent.click(screen.getAllByTitle('Resume session in new tab')[0]);
		expect(props.onResumeSession).toHaveBeenCalledWith(
			'keyboard-first-7777',
			[],
			'Keyboard first',
			false,
			undefined
		);
		props.onResumeSession.mockClear();

		fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
		fireEvent.keyDown(searchInput, { key: 'ArrowUp' });
		fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
		fireEvent.keyDown(searchInput, { key: 'Enter' });

		expect(await screen.findByText('Keyboard second detail loaded')).toBeInTheDocument();
		expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
			'claude-code',
			'/repo',
			'keyboard-second-8888',
			{ offset: 0, limit: 20 },
			undefined
		);
	});

	it('auto-opens the active session and resumes detail view from Enter', async () => {
		const session = agentSession({
			sessionId: 'active-jump-9999',
			sessionName: 'Active jump',
			firstMessage: 'Open from history',
			inputTokens: 140000,
			outputTokens: 10000,
		});
		setInitialSessions([session]);
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
			messages: [message({ content: 'Active jump log loaded', uuid: 'active-log' })],
			total: 1,
			hasMore: false,
		});

		const { props } = renderBrowser({ activeAgentSessionId: 'active-jump-9999' });

		expect(await screen.findByText('Active jump log loaded')).toBeInTheDocument();
		expect(screen.getByText(/75\.0/)).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Rename session'));
		const renameInput = await screen.findByPlaceholderText('Enter session name...');
		expect(renameInput).toHaveValue('Active jump');
		fireEvent.keyDown(renameInput, { key: 'ArrowLeft' });
		fireEvent.change(renameInput, { target: { value: 'Active renamed' } });
		fireEvent.blur(renameInput);
		await waitFor(() =>
			expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
				'/repo',
				'active-jump-9999',
				'Active renamed'
			)
		);

		fireEvent.keyDown(screen.getByRole('region', { name: 'Session messages' }), { key: 'Enter' });
		expect(props.onResumeSession).toHaveBeenCalledWith(
			'active-jump-9999',
			[expect.objectContaining({ text: 'Active jump log loaded', source: 'stdout' })],
			'Active renamed',
			false,
			expect.objectContaining({ totalCostUsd: 0.25 })
		);
	});

	it('guards renames without a project root and logs rename failures', async () => {
		const guardedSession = agentSession({
			sessionId: 'rename-guard-0001',
			sessionName: 'Guarded rename',
		});
		setInitialSessions([guardedSession]);

		const guardedView = renderBrowser({
			activeSession: activeSession({
				toolType: 'opencode',
				sshRemoteId: 'remote-guard',
				remoteCwd: '/srv/guarded',
				projectRoot: undefined,
			}),
		});

		expect(await screen.findByText('Guarded rename')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Rename session'));
		const guardedInput = await screen.findByPlaceholderText('Enter session name...');
		fireEvent.change(guardedInput, { target: { value: 'Should not persist' } });
		fireEvent.keyDown(guardedInput, { key: 'Enter' });
		expect(window.maestro.claude.updateSessionName).not.toHaveBeenCalled();
		expect(window.maestro.agentSessions.setSessionName).not.toHaveBeenCalled();

		guardedView.unmount();
		resetBridgeMocks();

		const renameError = new Error('rename bridge failed');
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		setInitialSessions([
			agentSession({
				sessionId: 'rename-failure-0002',
				sessionName: 'Rename failure',
			}),
		]);
		vi.mocked(window.maestro.claude.updateSessionName).mockRejectedValue(renameError);

		renderBrowser();

		expect(await screen.findByText('Rename failure')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Rename session'));
		const failingInput = await screen.findByPlaceholderText('Enter session name...');
		fireEvent.change(failingInput, { target: { value: 'Rejected name' } });
		fireEvent.keyDown(failingInput, { key: 'Enter' });

		await waitFor(() =>
			expect(loggerError).toHaveBeenCalledWith('Failed to rename session:', undefined, renameError)
		);
		expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
			'/repo',
			'rename-failure-0002',
			'Rejected name'
		);
	});

	it('cleans up debounced failed content search and clears the query', async () => {
		const searchError = new Error('search bridge failed');
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		setInitialSessions([
			agentSession({
				sessionId: 'search-failure-0003',
				sessionName: 'Search failure session',
			}),
		]);
		vi.mocked(window.maestro.agentSessions.search).mockRejectedValue(searchError);

		renderBrowser();

		const searchInput = await screen.findByPlaceholderText('Search all content...');
		fireEvent.change(searchInput, { target: { value: 'first query' } });
		fireEvent.change(searchInput, { target: { value: 'second query' } });

		await waitFor(() =>
			expect(window.maestro.agentSessions.search).toHaveBeenCalledWith(
				'claude-code',
				'/repo',
				'second query',
				'all',
				undefined
			)
		);
		expect(window.maestro.agentSessions.search).toHaveBeenCalledTimes(1);
		expect(loggerError).toHaveBeenCalledWith('Search failed:', undefined, searchError);

		const clearButton = searchInput.parentElement?.querySelector('button');
		expect(clearButton).not.toBeNull();
		fireEvent.click(clearButton as HTMLButtonElement);
		expect(searchInput).toHaveValue('');
	});

	it('restores search focus after leaving detail and closes the search mode dropdown', async () => {
		const session = agentSession({
			sessionId: 'focus-restore-0004',
			sessionName: 'Focus restore session',
		});
		setInitialSessions([session]);
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
			messages: [message({ content: 'Focus detail loaded', uuid: 'focus-detail' })],
			total: 1,
			hasMore: false,
		});

		renderBrowser();

		expect(await screen.findByPlaceholderText('Search all content...')).toBeInTheDocument();
		fireEvent.click(await screen.findByText('Focus restore session'));
		expect(await screen.findByText('Focus detail loaded')).toBeInTheDocument();

		fireEvent.keyDown(document, { key: 'Escape' });
		const restoredSearchInput = await screen.findByPlaceholderText('Search all content...');
		await waitFor(() => expect(restoredSearchInput).toHaveFocus());

		fireEvent.click(screen.getByText('All'));
		expect(screen.getByText('Title Only')).toBeInTheDocument();
		fireEvent.mouseDown(document.body);
		await waitFor(() => expect(screen.queryByText('Title Only')).not.toBeInTheDocument());
	});

	it('stops content search when no project path is available after debounce', async () => {
		renderBrowser({
			activeSession: activeSession({ projectRoot: undefined }),
		});

		const searchInput = await screen.findByPlaceholderText('Search all content...');
		vi.useFakeTimers();
		fireEvent.change(searchInput, { target: { value: 'offline search' } });

		await act(async () => {
			vi.advanceTimersByTime(301);
			await Promise.resolve();
		});

		expect(window.maestro.agentSessions.search).not.toHaveBeenCalled();
	});

	it('selects and scrolls to a session from an activity graph bucket click', async () => {
		const session = agentSession({
			sessionId: 'graph-bucket-0005',
			sessionName: undefined,
			firstMessage: 'Click the graph bucket',
			modifiedAt: '2026-01-04T12:00:00Z',
		});
		setInitialSessions([session]);

		renderBrowser();

		expect(await screen.findByText('Click the graph bucket')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Show activity graph'));
		const graph = await screen.findByTitle(/All time: 1 session/);
		const clickableBars = Array.from(graph.querySelectorAll('div[style*="cursor: pointer"]'));
		expect(clickableBars.length).toBeGreaterThan(0);
		clickableBars.forEach((bar) => fireEvent.click(bar));

		await waitFor(() =>
			expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
				block: 'center',
				behavior: 'smooth',
			})
		);

		vi.mocked(window.HTMLElement.prototype.scrollIntoView).mockClear();
		fireEvent.click(screen.getByText('Named'));
		expect(screen.getByText('No sessions match your search')).toBeInTheDocument();
		clickableBars.forEach((bar) => fireEvent.click(bar));
		expect(window.HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTitle(/Search sessions/));
		const searchInput = await screen.findByPlaceholderText('Search all content...');
		await waitFor(() => expect(searchInput).toHaveFocus());
	});

	it('uses fallback active metadata, light message styling, and empty-state wording', async () => {
		const fallbackSession = agentSession({
			sessionId: 'fallback-active-0006',
			sessionName: 'Fallback active session',
			durationSeconds: 45,
			costUsd: 0,
		});
		setInitialSessions([fallbackSession]);
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
			messages: [
				message({
					type: 'user',
					content: '',
					uuid: undefined,
					timestamp: '2026-01-04T13:00:00Z',
				}),
			],
			total: 1,
			hasMore: false,
		});

		const { props, unmount } = renderBrowser({
			theme: { ...theme, mode: 'light' },
			activeSession: activeSession({
				name: '',
				toolType: undefined as unknown as Session['toolType'],
			}),
		});

		expect(await screen.findByText('Fallback active session')).toBeInTheDocument();
		expect(screen.getByText('Claude Sessions for Agent')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Fallback active session'));
		expect(await screen.findByText('[No content]')).toBeInTheDocument();
		expect(screen.getByText('45s')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Resume'));
		expect(props.onResumeSession).toHaveBeenCalledWith(
			'fallback-active-0006',
			[expect.objectContaining({ id: 'fallback-active-0006-0', text: '[No content]' })],
			'Fallback active session',
			false,
			undefined
		);
		unmount();

		resetBridgeMocks();
		renderBrowser({
			activeSession: activeSession({ name: '', toolType: 'opencode' }),
		});
		expect(await screen.findByText('No agent sessions found for this project')).toBeInTheDocument();
	});

	it('covers remote path fallbacks, stats mismatch, search-mode placeholders, and no-project star persistence', async () => {
		const fallbackSession = agentSession({
			sessionId: 'remote-fallback-0007',
			sessionName: 'Remote fallback',
			firstMessage: 'Remote fallback summary',
			messageCount: undefined,
			costUsd: undefined,
			sizeBytes: undefined,
			inputTokens: undefined,
			outputTokens: undefined,
			timestamp: undefined,
			modifiedAt: '2026-01-05T12:00:00Z',
		});
		setInitialSessions([fallbackSession], { hasMore: true });

		const { props } = renderBrowser({
			activeSession: activeSession({
				name: '',
				toolType: 'opencode',
				projectRoot: undefined,
				remoteCwd: undefined,
				sessionSshRemoteConfig: {
					remoteId: 'remote-config',
					workingDirOverride: '/srv/fallback',
				} as Session['sessionSshRemoteConfig'],
				createdAt: 0,
			}),
		});

		expect(await screen.findByText('Remote fallback')).toBeInTheDocument();
		expect(window.maestro.agentSessions.listPaginated).toHaveBeenCalledWith(
			'opencode',
			'/srv/fallback',
			{ limit: 100 },
			'remote-config'
		);
		expect(window.maestro.agentSessions.getOrigins).toHaveBeenCalledWith(
			'opencode',
			'/srv/fallback'
		);
		expect(screen.getByText('1 session')).toBeInTheDocument();
		expect(screen.getByText('0 messages')).toBeInTheDocument();
		expect(screen.getByText('$0.00')).toBeInTheDocument();
		expect(screen.getByText('1 of 1 sessions loaded')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Add to favorites'));
		expect(window.maestro.agentSessions.setSessionStarred).not.toHaveBeenCalled();
		expect(props.onUpdateTab).toHaveBeenCalledWith('remote-fallback-0007', { starred: true });

		fireEvent.click(screen.getByText('All'));
		fireEvent.click(screen.getByText('AI Responses'));
		expect(screen.getByPlaceholderText('Search AI responses...')).toBeInTheDocument();
		fireEvent.click(screen.getByText('assistant'));
		fireEvent.click(screen.getByText('Title Only'));
		expect(screen.getByPlaceholderText('Search titles...')).toBeInTheDocument();

		act(() => {
			projectStatsListener?.({
				projectPath: '/not-this-project',
				totalSessions: 99,
				totalMessages: 99,
				totalCostUsd: 99,
				totalSizeBytes: 99,
				totalTokens: 99,
				oldestTimestamp: '2026-01-01T00:00:00Z',
				isComplete: true,
			});
		});
		expect(screen.queryByText('99 sessions')).not.toBeInTheDocument();
	});

	it('covers project-root remote fallback, blank rename, and detail keyboard no-ops', async () => {
		const session = agentSession({
			sessionId: 'project-root-fallback-0008',
			sessionName: undefined,
			firstMessage: 'Project root fallback session',
			costUsd: undefined,
			durationSeconds: 61,
		});
		setInitialSessions([session]);
		vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
			messages: [
				message({
					type: 'user',
					content: 'User content with no generated uuid',
					uuid: undefined,
					timestamp: '2026-01-05T13:00:00Z',
				}),
			],
			total: 1,
			hasMore: false,
		});

		renderBrowser({
			activeSession: activeSession({
				sshRemoteId: 'remote-project-root',
				remoteCwd: undefined,
				sessionSshRemoteConfig: undefined,
				projectRoot: '/project-root-fallback',
			}),
			onUpdateTab: undefined,
		});

		expect(await screen.findByText('Project root fallback session')).toBeInTheDocument();
		expect(window.maestro.agentSessions.listPaginated).toHaveBeenCalledWith(
			'claude-code',
			'/project-root-fallback',
			{ limit: 100 },
			'remote-project-root'
		);

		act(() => {
			projectStatsListener?.({
				projectPath: '/elsewhere',
				totalSessions: 99,
				totalMessages: 99,
				totalCostUsd: 99,
				totalSizeBytes: 99,
				oldestTimestamp: '2026-01-01T00:00:00Z',
				isComplete: true,
			});
			projectStatsListener?.({
				projectPath: '/project-root-fallback',
				totalSessions: 3,
				totalMessages: 4,
				totalCostUsd: 0,
				totalSizeBytes: 0,
				oldestTimestamp: '2026-01-01T00:00:00Z',
				isComplete: true,
			});
		});
		expect(screen.queryByText('99 sessions')).not.toBeInTheDocument();
		expect(screen.getByText('3 sessions')).toBeInTheDocument();
		expect(screen.getByText('4 messages')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Add session name'));
		const renameInput = await screen.findByPlaceholderText('Enter session name...');
		expect(renameInput).toHaveValue('');
		fireEvent.change(renameInput, { target: { value: '   ' } });
		fireEvent.keyDown(renameInput, { key: 'Enter' });
		await waitFor(() =>
			expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
				'/project-root-fallback',
				'project-root-fallback-0008',
				''
			)
		);

		fireEvent.click(screen.getByText('Project root fallback session'));
		expect(await screen.findByText('User content with no generated uuid')).toBeInTheDocument();
		expect(screen.getByText('$0.00')).toBeInTheDocument();
		expect(screen.getByText('1m 1s')).toBeInTheDocument();
		fireEvent.keyDown(screen.getByRole('region', { name: 'Session messages' }), {
			key: 'ArrowDown',
		});
		fireEvent.keyDown(document, { key: 'f', metaKey: true });
		expect(screen.queryByPlaceholderText('Search all content...')).not.toBeInTheDocument();
	});

	it('covers generic blank rename, missing active jump, and loading pagination state', async () => {
		const firstSession = agentSession({
			sessionId: 'generic-blank-0009',
			sessionName: 'Generic blank',
			firstMessage: 'Generic blank item',
			modifiedAt: '2026-01-06T10:00:00Z',
		});
		const secondSession = agentSession({
			sessionId: 'generic-more-0010',
			sessionName: 'Generic more',
			firstMessage: 'Loaded after pagination',
			modifiedAt: '2026-01-06T09:00:00Z',
		});
		let resolveMore!: (value: {
			sessions: ClaudeSession[];
			hasMore: boolean;
			totalCount: number;
			nextCursor: string | null;
		}) => void;
		const loadMore = new Promise<{
			sessions: ClaudeSession[];
			hasMore: boolean;
			totalCount: number;
			nextCursor: string | null;
		}>((resolve) => {
			resolveMore = resolve;
		});
		vi.mocked(window.maestro.agentSessions.listPaginated)
			.mockResolvedValueOnce({
				sessions: [firstSession],
				hasMore: true,
				totalCount: 2,
				nextCursor: 'next-page',
			})
			.mockReturnValueOnce(loadMore);

		const { props } = renderBrowser({
			activeAgentSessionId: 'missing-active-session',
			activeSession: activeSession({ toolType: 'opencode', projectRoot: '/repo' }),
		});

		expect(await screen.findByText('Generic blank')).toBeInTheDocument();
		expect(window.maestro.agentSessions.read).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTitle('Rename session'));
		const renameInput = await screen.findByPlaceholderText('Enter session name...');
		fireEvent.change(renameInput, { target: { value: '   ' } });
		fireEvent.keyDown(renameInput, { key: 'Enter' });
		await waitFor(() =>
			expect(window.maestro.agentSessions.setSessionName).toHaveBeenCalledWith(
				'opencode',
				'/repo',
				'generic-blank-0009',
				null
			)
		);
		expect(props.onUpdateTab).toHaveBeenCalledWith('generic-blank-0009', { name: null });

		expect(await screen.findByText('Loading more sessions...')).toBeInTheDocument();
		act(() => {
			resolveMore({
				sessions: [secondSession],
				hasMore: false,
				totalCount: 2,
				nextCursor: null,
			});
		});
		expect(await screen.findByText('Generic more')).toBeInTheDocument();
	});

	it('keeps empty-list keyboard no-ops and ctrl-f graph reopening stable', async () => {
		setInitialSessions([]);
		renderBrowser();

		const searchInput = await screen.findByPlaceholderText('Search all content...');
		fireEvent.keyDown(searchInput, { key: 'Escape' });
		fireEvent.keyDown(searchInput, { key: 'Tab' });
		fireEvent.keyDown(searchInput, { key: 'Enter' });
		expect(screen.getByText('No Claude sessions found for this project')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Show activity graph'));
		expect(screen.queryByPlaceholderText('Search all content...')).not.toBeInTheDocument();
		fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
		expect(await screen.findByPlaceholderText('Search all content...')).toBeInTheDocument();
	});
});
