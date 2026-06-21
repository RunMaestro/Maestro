import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSessionsModal } from '../../renderer/components/AgentSessionsModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Session, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#22d3ee',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

function activeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Integration Agent',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/repo',
		projectRoot: '/repo',
		aiPid: 1,
		terminalPid: 2,
		aiLogs: [],
		shellLogs: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		...overrides,
	} as Session;
}

function agentSession(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: 'agent-session-1',
		projectPath: '/repo',
		timestamp: '2026-05-01T12:00:00.000Z',
		modifiedAt: '2026-05-02T12:00:00.000Z',
		firstMessage: 'Alpha task',
		messageCount: 2,
		sizeBytes: 1024,
		sessionName: 'Alpha Session',
		...overrides,
	};
}

function message(overrides: Record<string, unknown> = {}) {
	return {
		type: 'user',
		role: 'user',
		content: 'User prompt',
		timestamp: '2026-05-02T12:00:00.000Z',
		uuid: 'message-1',
		...overrides,
	};
}

function renderModal(props: Partial<React.ComponentProps<typeof AgentSessionsModal>> = {}) {
	return render(
		<LayerStackProvider>
			<AgentSessionsModal
				theme={theme}
				activeSession={activeSession()}
				onClose={vi.fn()}
				onResumeSession={vi.fn()}
				{...props}
			/>
		</LayerStackProvider>
	);
}

describe('AgentSessionsModal integration', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(globalThis.console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(globalThis.console, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({});
		vi.mocked(window.maestro.claude.updateSessionStarred).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agentSessions.getOrigins).mockResolvedValue({});
		vi.mocked(window.maestro.agentSessions.setSessionStarred).mockResolvedValue(undefined);
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
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('loads, searches, stars, previews, paginates messages, and resumes Claude sessions', async () => {
		const onClose = vi.fn();
		const onResumeSession = vi.fn();
		const alpha = agentSession({
			sessionId: 'alpha-session',
			firstMessage: 'Alpha task',
			sessionName: 'Alpha Session',
			modifiedAt: '2026-05-03T12:00:00.000Z',
		});
		const beta = agentSession({
			sessionId: 'beta-session',
			firstMessage: 'Beta task',
			sessionName: 'Beta Session',
			modifiedAt: '2026-05-04T12:00:00.000Z',
		});
		vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
			'alpha-session': { starred: true },
		});
		vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
			sessions: [beta, alpha],
			hasMore: false,
			totalCount: 2,
			nextCursor: null,
		});
		vi.mocked(window.maestro.agentSessions.read)
			.mockResolvedValueOnce({
				messages: [
					message({ uuid: 'message-1', type: 'user', content: 'User prompt' }),
					message({
						uuid: 'message-2',
						type: 'assistant',
						content: 'Assistant answer',
					}),
				],
				total: 3,
				hasMore: true,
			})
			.mockResolvedValueOnce({
				messages: [message({ uuid: 'message-0', type: 'assistant', content: 'Older answer' })],
				total: 3,
				hasMore: false,
			});

		renderModal({ onClose, onResumeSession });

		await waitFor(() =>
			expect(window.maestro.agentSessions.listPaginated).toHaveBeenCalledWith(
				'claude-code',
				'/repo',
				{
					limit: 100,
				},
				undefined
			)
		);
		expect(screen.getByText('Alpha Session')).toBeInTheDocument();
		expect(screen.getByText('Beta Session')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search Integration Agent sessions...'), {
			target: { value: 'beta' },
		});
		expect(screen.getByText('Beta Session')).toBeInTheDocument();
		expect(screen.queryByText('Alpha Session')).not.toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search Integration Agent sessions...'), {
			target: { value: '' },
		});
		fireEvent.click(screen.getByTitle('Remove from favorites'));
		expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
			'/repo',
			'alpha-session',
			false
		);

		fireEvent.click(screen.getByText('Alpha Session'));
		await waitFor(() =>
			expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
				'claude-code',
				'/repo',
				'alpha-session',
				{ offset: 0, limit: 20 },
				undefined
			)
		);
		expect(screen.getByText('User prompt')).toBeInTheDocument();
		expect(screen.getByText('Assistant answer')).toBeInTheDocument();
		expect(screen.getByText(/3 messages/)).toBeInTheDocument();

		fireEvent.click(screen.getByText('Load earlier messages...'));
		await waitFor(() =>
			expect(window.maestro.agentSessions.read).toHaveBeenLastCalledWith(
				'claude-code',
				'/repo',
				'alpha-session',
				{ offset: 2, limit: 20 },
				undefined
			)
		);
		expect(screen.getByText('Older answer')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Resume'));
		expect(onResumeSession).toHaveBeenCalledWith('alpha-session');
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(logSpy).toHaveBeenCalled();
	});

	it('loads more session rows on scroll and uses generic origin storage for non-Claude agents', async () => {
		const codexSession = activeSession({ toolType: 'codex' });
		vi.mocked(window.maestro.agentSessions.getOrigins).mockResolvedValue({
			'beta-session': { starred: true },
		});
		vi.mocked(window.maestro.agentSessions.listPaginated)
			.mockResolvedValueOnce({
				sessions: [
					agentSession({ sessionId: 'alpha-session', sessionName: 'Alpha Session' }),
					agentSession({ sessionId: 'beta-session', sessionName: 'Beta Session' }),
				],
				hasMore: true,
				totalCount: 3,
				nextCursor: 'cursor-2',
			})
			.mockResolvedValueOnce({
				sessions: [
					agentSession({ sessionId: 'gamma-session', sessionName: 'Gamma Session' }),
					agentSession({ sessionId: 'beta-session', sessionName: 'Beta Session duplicate' }),
				],
				hasMore: false,
				totalCount: 3,
				nextCursor: null,
			});

		renderModal({ activeSession: codexSession });

		await waitFor(() => expect(screen.getByText('2 of 3 sessions loaded')).toBeInTheDocument());
		fireEvent.click(screen.getByTitle('Remove from favorites'));
		expect(window.maestro.agentSessions.setSessionStarred).toHaveBeenCalledWith(
			'codex',
			'/repo',
			'beta-session',
			false
		);

		const scroller = screen
			.getByText('2 of 3 sessions loaded')
			.closest('.overflow-y-auto') as HTMLElement;
		Object.defineProperties(scroller, {
			scrollTop: { configurable: true, value: 80 },
			scrollHeight: { configurable: true, value: 100 },
			clientHeight: { configurable: true, value: 20 },
		});
		fireEvent.scroll(scroller);

		await waitFor(() =>
			expect(window.maestro.agentSessions.listPaginated).toHaveBeenLastCalledWith(
				'codex',
				'/repo',
				{
					cursor: 'cursor-2',
					limit: 100,
				},
				undefined
			)
		);
		expect(screen.getByText('Gamma Session')).toBeInTheDocument();
		expect(screen.getAllByText(/Beta Session/)).toHaveLength(1);
	});

	it('handles missing projects and recoverable load failures without throwing', async () => {
		renderModal({ activeSession: activeSession({ cwd: undefined, projectRoot: undefined }) });
		await waitFor(() =>
			expect(screen.getByText('No sessions found for this project')).toBeInTheDocument()
		);

		cleanup();
		vi.mocked(window.maestro.agentSessions.listPaginated).mockRejectedValueOnce(
			new Error('storage unavailable')
		);
		renderModal();

		await waitFor(() =>
			expect(errorSpy).toHaveBeenCalledWith('Failed to load sessions:', expect.any(Error))
		);
		expect(screen.getByText('No sessions found for this project')).toBeInTheDocument();
	});

	it('adds favorites, opens by keyboard, handles list failures, and scroll-loads messages', async () => {
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		const first = agentSession({
			sessionId: 'first-session',
			sessionName: 'First Session',
			modifiedAt: '2026-05-06T12:00:00.000Z',
		});
		const second = agentSession({
			sessionId: 'second-session',
			sessionName: 'Second Session',
			modifiedAt: '2026-05-05T12:00:00.000Z',
		});
		vi.mocked(window.maestro.agentSessions.listPaginated)
			.mockResolvedValueOnce({
				sessions: [first, second],
				hasMore: true,
				totalCount: 3,
				nextCursor: 'cursor-2',
			})
			.mockRejectedValueOnce(new Error('page failed'));
		vi.mocked(window.maestro.agentSessions.read)
			.mockResolvedValueOnce({
				messages: [message({ uuid: 'message-new', content: 'Newest answer' })],
				total: 2,
				hasMore: true,
			})
			.mockResolvedValueOnce({
				messages: [message({ uuid: 'message-old', content: 'Older answer' })],
				total: 2,
				hasMore: false,
			});

		renderModal();
		await screen.findByText('First Session');

		fireEvent.click(screen.getAllByTitle('Add to favorites')[0]!);
		expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
			'/repo',
			'first-session',
			true
		);

		const sessionScroller = screen
			.getByText('2 of 3 sessions loaded')
			.closest('.overflow-y-auto') as HTMLElement;
		Object.defineProperties(sessionScroller, {
			scrollTop: { configurable: true, value: 80 },
			scrollHeight: { configurable: true, value: 100 },
			clientHeight: { configurable: true, value: 20 },
		});
		fireEvent.scroll(sessionScroller);
		await waitFor(() =>
			expect(errorSpy).toHaveBeenCalledWith('Failed to load more sessions:', expect.any(Error))
		);

		fireEvent.keyDown(screen.getByPlaceholderText('Search Integration Agent sessions...'), {
			key: 'Enter',
		});
		await screen.findByText('Newest answer');

		const messageScroller = screen
			.getByText('Load earlier messages...')
			.closest('.overflow-y-auto') as HTMLElement;
		Object.defineProperties(messageScroller, {
			scrollTop: { configurable: true, value: 0, writable: true },
			scrollHeight: { configurable: true, value: 300, writable: true },
			clientHeight: { configurable: true, value: 100 },
		});
		fireEvent.scroll(messageScroller);
		await waitFor(() =>
			expect(window.maestro.agentSessions.read).toHaveBeenLastCalledWith(
				'claude-code',
				'/repo',
				'first-session',
				{ offset: 1, limit: 20 },
				undefined
			)
		);
		expect(screen.getByText('Older answer')).toBeInTheDocument();

		fireEvent.click(document.querySelector('button.p-1') as HTMLButtonElement);
		expect(screen.getByPlaceholderText('Search Integration Agent sessions...')).toBeInTheDocument();
	});

	it('uses projectRoot for preview when the active session loses cwd', async () => {
		const preview = agentSession({
			sessionId: 'preview-session',
			sessionName: 'Preview Session',
		});
		vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValueOnce({
			sessions: [preview],
			hasMore: false,
			totalCount: 1,
			nextCursor: null,
		});
		const { rerender } = renderModal();
		await screen.findByText('Preview Session');

		vi.mocked(window.maestro.agentSessions.read).mockClear();
		rerender(
			<LayerStackProvider>
				<AgentSessionsModal
					theme={theme}
					activeSession={activeSession({ cwd: undefined })}
					onClose={vi.fn()}
					onResumeSession={vi.fn()}
				/>
			</LayerStackProvider>
		);

		fireEvent.click(screen.getByText('Preview Session'));
		await waitFor(() =>
			expect(window.maestro.agentSessions.read).toHaveBeenCalledWith(
				'claude-code',
				'/repo',
				'preview-session',
				{ offset: 0, limit: 20 },
				undefined
			)
		);
	});

	it('skips load-more without a cursor and reports message read failures', async () => {
		vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValueOnce({
			sessions: [
				agentSession({
					sessionId: 'error-session',
					sessionName: 'Error Session',
				}),
			],
			hasMore: true,
			totalCount: 2,
			nextCursor: null,
		});
		vi.mocked(window.maestro.agentSessions.read).mockRejectedValueOnce(new Error('read failed'));

		renderModal();
		await screen.findByText('Error Session');

		const sessionScroller = screen
			.getByText('1 of 2 sessions loaded')
			.closest('.overflow-y-auto') as HTMLElement;
		Object.defineProperties(sessionScroller, {
			scrollTop: { configurable: true, value: 80 },
			scrollHeight: { configurable: true, value: 100 },
			clientHeight: { configurable: true, value: 20 },
		});
		fireEvent.scroll(sessionScroller);
		expect(window.maestro.agentSessions.listPaginated).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByText('Error Session'));
		await waitFor(() =>
			expect(errorSpy).toHaveBeenCalledWith('Failed to load messages:', expect.any(Error))
		);
	});
});
