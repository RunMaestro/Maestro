import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { gitService } from '../../../../renderer/services/git';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { spawnWorktreeAgentAndDispatch } from '../../../../renderer/utils/worktreeSpawn';
import type { Session } from '../../../../renderer/types';

vi.mock('../../../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn(),
		getBranches: vi.fn(),
		getTags: vi.fn(),
	},
}));

vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));

type MutableDeps = Parameters<typeof useAppRemoteEventListeners>[0];

const responseMethods = [
	'sendRemoteOpenBrowserTabResponse',
	'sendRemoteOpenTerminalTabResponse',
	'sendRemoteSetAutoRunFolderResponse',
	'sendRemoteConfigureAutoRunResponse',
	'sendRemoteGetAutoRunDocsResponse',
	'sendRemoteGetAutoRunDocContentResponse',
	'sendRemoteSaveAutoRunDocResponse',
	'sendRemoteResetAutoRunDocTasksResponse',
	'sendRemoteResumeAutoRunErrorResponse',
	'sendRemoteSkipAutoRunDocumentResponse',
	'sendRemoteAbortAutoRunErrorResponse',
	'sendRemoteListPlaybooksResponse',
	'sendRemoteCreatePlaybookResponse',
	'sendRemoteUpdatePlaybookResponse',
	'sendRemoteDeletePlaybookResponse',
	'sendRemoteCreateSessionResponse',
	'sendRemoteCreateWorktreeSessionResponse',
	'sendRemoteUpdateSessionCwdResponse',
	'sendRemoteUpdateSessionSshResponse',
	'sendRemoteRenameSessionResponse',
	'sendRemoteCreateGroupResponse',
	'sendRemoteRenameGroupResponse',
	'sendRemoteMoveSessionToGroupResponse',
] as const;

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Agent One',
		toolType: 'claude-code',
		state: 'idle',
		createdAt: 1,
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		isGitRepo: true,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3001,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: '/repo',
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [
			{
				id: 'ai-tab-1',
				agentSessionId: null,
				name: null,
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: 1,
				state: 'idle',
				saveToHistory: true,
				showThinking: true,
			},
		],
		activeTabId: 'ai-tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		browserTabs: [],
		activeBrowserTabId: null,
		terminalTabs: [],
		activeTerminalTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: 'ai-tab-1' }],
		unifiedClosedTabHistory: [],
		autoRunFolderPath: '/repo/.maestro/playbooks',
		autoRunSelectedFile: 'plan',
		autoRunContent: '- [x] Done',
		autoRunContentVersion: 1,
		...overrides,
	} as Session;
}

function createHarness(
	initialSessions: Session[] = [makeSession()],
	depOverrides: Partial<MutableDeps> = {}
) {
	let sessions = initialSessions;
	let groups: Array<{ id: string; name: string; emoji?: string; collapsed?: boolean }> = [];
	const sessionsRef = { current: sessions } as React.MutableRefObject<Session[]>;
	const setActiveSessionId = vi.fn();
	const setSessions = vi.fn((updater: Session[] | ((prev: Session[]) => Session[])) => {
		sessions = typeof updater === 'function' ? updater(sessions) : updater;
		sessionsRef.current = sessions;
	});
	const setGroups = vi.fn((updater) => {
		groups = typeof updater === 'function' ? updater(groups) : updater;
	});
	const deps: MutableDeps = {
		sessionsRef,
		setActiveSessionId,
		setSessions,
		setGroups,
		handleOpenFileTab: vi.fn(),
		refreshFileTree: vi.fn(),
		handleAutoRunRefresh: vi.fn(),
		startBatchRun: vi.fn().mockResolvedValue(undefined),
		stopBatchRun: vi.fn(),
		resumeAfterError: vi.fn(),
		skipCurrentDocument: vi.fn(),
		abortBatchOnError: vi.fn(),
		...depOverrides,
	};
	renderHook(() => useAppRemoteEventListeners(deps));
	return {
		deps,
		get sessions() {
			return sessions;
		},
		get groups() {
			return groups;
		},
	};
}

function dispatch(type: string, detail: unknown) {
	act(() => {
		window.dispatchEvent(new CustomEvent(type, { detail }));
	});
}

function maestro() {
	return (window as any).maestro;
}

describe('useAppRemoteEventListeners', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		for (const method of responseMethods) {
			maestro().process[method] = vi.fn();
		}
		vi.mocked(gitService.isRepo).mockReset();
		vi.mocked(gitService.getBranches).mockReset();
		vi.mocked(gitService.getTags).mockReset();
		vi.mocked(spawnWorktreeAgentAndDispatch).mockReset();
		maestro().fs.readFile.mockReset();
		maestro().fs.stat.mockReset();
		maestro().process.kill.mockReset();
		maestro().sessions.setMany.mockReset();
		maestro().agents.get.mockReset();
		maestro().stats.recordSessionCreated.mockReset();
		maestro().claude.updateSessionName.mockReset();
		maestro().agentSessions.setSessionName.mockReset();
		maestro().autorun.listDocs.mockReset();
		maestro().autorun.readDoc.mockReset();
		maestro().autorun.writeDoc.mockReset();
		maestro().playbooks.list.mockReset();
		maestro().playbooks.create.mockReset();
		maestro().playbooks.update.mockReset();
		maestro().playbooks.delete.mockReset();
		vi.mocked(gitService.isRepo).mockResolvedValue(false);
		vi.mocked(gitService.getBranches).mockResolvedValue([]);
		vi.mocked(gitService.getTags).mockResolvedValue([]);
		vi.mocked(spawnWorktreeAgentAndDispatch).mockResolvedValue('worktree-session');
		maestro().fs.readFile.mockResolvedValue('file contents');
		maestro().fs.stat.mockResolvedValue({ modifiedAt: '2026-06-18T10:00:00.000Z' });
		maestro().process.kill.mockResolvedValue(undefined);
		maestro().sessions.setMany.mockResolvedValue(undefined);
		maestro().agents.get.mockResolvedValue(null);
		maestro().stats.recordSessionCreated.mockResolvedValue('lifecycle-id');
		maestro().claude.updateSessionName.mockResolvedValue(undefined);
		maestro().agentSessions.setSessionName.mockResolvedValue(undefined);
		maestro().autorun.listDocs.mockResolvedValue({ success: true, files: [] });
		maestro().autorun.readDoc.mockResolvedValue({ success: true, content: '' });
		maestro().autorun.writeDoc.mockResolvedValue({ success: true });
		maestro().playbooks.list.mockResolvedValue({ success: true, playbooks: [] });
		maestro().playbooks.create.mockResolvedValue({ success: true, playbook: { id: 'pb-1' } });
		maestro().playbooks.update.mockResolvedValue({ success: true, playbook: { id: 'pb-1' } });
		maestro().playbooks.delete.mockResolvedValue({ success: true });
		useSessionStore.setState({ activeSessionId: 'session-1', sessions: [] });
	});

	it('opens a file tab for the addressed session and preserves line deep links', async () => {
		const { deps } = createHarness([
			makeSession({
				sshRemoteId: 'remote-1',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-2' },
			}),
		]);

		dispatch('maestro:openFileTab', {
			sessionId: 'session-1',
			filePath: '/repo/src/App.tsx',
			line: 42,
		});

		await waitFor(() =>
			expect(deps.handleOpenFileTab).toHaveBeenCalledWith(
				expect.objectContaining({
					path: '/repo/src/App.tsx',
					name: 'App.tsx',
					content: 'file contents',
					sshRemoteId: 'remote-1',
					pendingScrollToLine: 42,
					lastModified: new Date('2026-06-18T10:00:00.000Z').getTime(),
				}),
				{ targetSessionId: 'session-1' }
			)
		);
		expect(maestro().fs.readFile).toHaveBeenCalledWith('/repo/src/App.tsx', 'remote-1');
		expect(deps.setActiveSessionId).toHaveBeenCalledWith('session-1');
	});

	it('handles file open fallback paths without creating stale tabs', async () => {
		maestro().fs.stat.mockRejectedValueOnce(new Error('missing stat'));
		const { deps } = createHarness();

		dispatch('maestro:openFileTab', {
			sessionId: 'session-1',
			filePath: '/repo/no-stat.ts',
		});

		await waitFor(() =>
			expect(deps.handleOpenFileTab).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'no-stat.ts',
					lastModified: undefined,
				}),
				{ targetSessionId: 'session-1' }
			)
		);

		maestro().fs.readFile.mockResolvedValueOnce(null);
		dispatch('maestro:openFileTab', {
			sessionId: 'session-1',
			filePath: '/repo/null.ts',
		});
		await waitFor(() =>
			expect(maestro().fs.readFile).toHaveBeenCalledWith('/repo/null.ts', undefined)
		);

		maestro().fs.readFile.mockRejectedValueOnce(new Error('read failed'));
		dispatch('maestro:openFileTab', {
			sessionId: 'session-1',
			filePath: '/repo/throws.ts',
		});
		await waitFor(() =>
			expect(maestro().fs.readFile).toHaveBeenCalledWith('/repo/throws.ts', undefined)
		);

		dispatch('maestro:openFileTab', {
			sessionId: 'missing',
			filePath: '/repo/missing.ts',
		});
		expect(deps.handleOpenFileTab).toHaveBeenCalledTimes(1);
	});

	it('uses fallback file names when paths do not contain basename segments', async () => {
		const { deps } = createHarness();

		dispatch('maestro:openFileTab', {
			sessionId: 'session-1',
			filePath: '',
		});

		await waitFor(() =>
			expect(deps.handleOpenFileTab).toHaveBeenCalledWith(
				expect.objectContaining({ path: '', name: '' }),
				{ targetSessionId: 'session-1' }
			)
		);
	});

	it('honors no-switch file opens', async () => {
		const { deps } = createHarness();

		dispatch('maestro:openFileTab', {
			sessionId: 'session-1',
			filePath: '/repo/README.md',
			switchToAgent: false,
		});

		await waitFor(() => expect(deps.handleOpenFileTab).toHaveBeenCalled());
		expect(deps.setActiveSessionId).not.toHaveBeenCalled();
	});

	it('opens browser and terminal tabs and acknowledges the remote caller', async () => {
		const harness = createHarness();

		dispatch('maestro:openBrowserTab', {
			sessionId: 'session-1',
			url: 'https://example.test',
			responseChannel: 'browser-response',
		});
		dispatch('maestro:openTerminalTab', {
			sessionId: 'session-1',
			config: { cwd: '/repo/packages/app', shell: '/bin/zsh', name: 'App shell' },
			responseChannel: 'terminal-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteOpenTerminalTabResponse).toHaveBeenCalledWith(
				'terminal-response',
				true
			)
		);
		expect(maestro().process.sendRemoteOpenBrowserTabResponse).toHaveBeenCalledWith(
			'browser-response',
			true
		);
		expect(harness.sessions[0].browserTabs?.[0]).toEqual(
			expect.objectContaining({ url: 'https://example.test', title: 'https://example.test' })
		);
		expect(harness.sessions[0].terminalTabs?.[0]).toEqual(
			expect.objectContaining({
				cwd: '/repo/packages/app',
				shellType: '/bin/zsh',
				name: 'App shell',
			})
		);
		expect(harness.sessions[0].inputMode).toBe('terminal');
	});

	it('leaves non-target sessions untouched when opening browser and terminal tabs', async () => {
		const harness = createHarness([
			makeSession({ id: 'session-1' }),
			makeSession({ id: 'session-2', browserTabs: undefined, terminalTabs: undefined }),
		]);

		dispatch('maestro:openBrowserTab', {
			sessionId: 'session-2',
			url: 'https://target.test',
			responseChannel: 'browser-response',
		});
		dispatch('maestro:openTerminalTab', {
			sessionId: 'session-2',
			config: {},
			responseChannel: 'terminal-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteOpenTerminalTabResponse).toHaveBeenCalledWith(
				'terminal-response',
				true
			)
		);
		expect(harness.sessions[0].browserTabs).toEqual([]);
		expect(harness.sessions[0].terminalTabs).toEqual([]);
		expect(harness.sessions[1].browserTabs).toHaveLength(1);
		expect(harness.sessions[1].terminalTabs).toHaveLength(1);
	});

	it('acknowledges missing browser and terminal targets as failures', () => {
		createHarness();

		dispatch('maestro:openBrowserTab', {
			sessionId: 'missing',
			url: 'https://example.test',
			responseChannel: 'browser-response',
		});
		dispatch('maestro:openTerminalTab', {
			sessionId: 'missing',
			config: {},
			responseChannel: 'terminal-response',
		});

		expect(maestro().process.sendRemoteOpenBrowserTabResponse).toHaveBeenCalledWith(
			'browser-response',
			false
		);
		expect(maestro().process.sendRemoteOpenTerminalTabResponse).toHaveBeenCalledWith(
			'terminal-response',
			false
		);
	});

	it('refreshes file trees and Auto Run docs for active and inactive sessions', () => {
		const { deps } = createHarness();
		useSessionStore.setState({ activeSessionId: 'session-1' });

		dispatch('maestro:refreshFileTree', { sessionId: 'session-1' });
		dispatch('maestro:refreshAutoRunDocs', { sessionId: 'session-1' });
		dispatch('maestro:refreshAutoRunDocs', { sessionId: 'session-2' });

		expect(deps.refreshFileTree).toHaveBeenCalledWith('session-1');
		expect(deps.handleAutoRunRefresh).toHaveBeenCalledTimes(1);
		expect(deps.setActiveSessionId).toHaveBeenCalledWith('session-2');
	});

	it('sets an Auto Run folder, loads the first document, and responds success', async () => {
		maestro().autorun.listDocs.mockResolvedValue({
			success: true,
			files: ['plan', 'nested/extra'],
		});
		maestro().autorun.readDoc.mockResolvedValue({ success: true, content: '- [ ] Next' });
		const harness = createHarness();

		dispatch('maestro:setAutoRunFolder', {
			sessionId: 'session-1',
			folderPath: '/repo/.maestro/playbooks',
			responseChannel: 'folder-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteSetAutoRunFolderResponse).toHaveBeenCalledWith(
				'folder-response',
				{ success: true }
			)
		);
		expect(maestro().autorun.readDoc).toHaveBeenCalledWith(
			'/repo/.maestro/playbooks',
			'plan.md',
			undefined
		);
		expect(harness.sessions[0]).toEqual(
			expect.objectContaining({
				autoRunFolderPath: '/repo/.maestro/playbooks',
				autoRunSelectedFile: 'plan',
				autoRunContent: '- [ ] Next',
				autoRunContentVersion: 2,
			})
		);
	});

	it('reports Auto Run folder failures without mutating the session', async () => {
		maestro().autorun.listDocs.mockResolvedValue({
			success: false,
			error: 'No readable docs',
		});
		const harness = createHarness();

		dispatch('maestro:setAutoRunFolder', {
			sessionId: 'session-1',
			folderPath: '/bad/path',
			responseChannel: 'folder-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteSetAutoRunFolderResponse).toHaveBeenCalledWith(
				'folder-response',
				{ success: false, error: 'No readable docs' }
			)
		);
		expect(harness.sessions[0].autoRunFolderPath).toBe('/repo/.maestro/playbooks');
	});

	it('reports Auto Run folder missing-session and thrown list errors', async () => {
		createHarness();

		dispatch('maestro:setAutoRunFolder', {
			sessionId: 'missing',
			folderPath: '/repo/.maestro/playbooks',
			responseChannel: 'missing-folder-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteSetAutoRunFolderResponse).toHaveBeenCalledWith(
				'missing-folder-response',
				{ success: false, error: 'Session missing not found' }
			)
		);

		maestro().autorun.listDocs.mockRejectedValueOnce(new Error('list exploded'));
		dispatch('maestro:setAutoRunFolder', {
			sessionId: 'session-1',
			folderPath: '/bad/path',
			responseChannel: 'thrown-folder-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteSetAutoRunFolderResponse).toHaveBeenCalledWith(
				'thrown-folder-response',
				{ success: false, error: 'list exploded' }
			)
		);
	});

	it('reports unexpected Auto Run folder mutation errors', async () => {
		createHarness([makeSession()], {
			setSessions: vi.fn(() => {
				throw new Error('set sessions failed');
			}),
		});
		maestro().autorun.listDocs.mockResolvedValue({ success: true, files: [] });

		dispatch('maestro:setAutoRunFolder', {
			sessionId: 'session-1',
			folderPath: '/repo/.maestro/playbooks',
			responseChannel: 'folder-throw-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteSetAutoRunFolderResponse).toHaveBeenCalledWith(
				'folder-throw-response',
				{ success: false, error: 'set sessions failed' }
			)
		);
	});

	it('uses default Auto Run folder errors and empty first-document content fallbacks', async () => {
		maestro()
			.autorun.listDocs.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ success: true, files: ['plan'] });
		maestro().autorun.readDoc.mockResolvedValueOnce({ success: true });
		const harness = createHarness([
			makeSession({ id: 'session-1', autoRunContentVersion: undefined }),
			makeSession({ id: 'session-2' }),
		]);

		dispatch('maestro:setAutoRunFolder', {
			sessionId: 'session-1',
			folderPath: '/bad/path',
			responseChannel: 'folder-default-error-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteSetAutoRunFolderResponse).toHaveBeenCalledWith(
				'folder-default-error-response',
				{ success: false, error: 'Could not read folder /bad/path' }
			)
		);

		dispatch('maestro:setAutoRunFolder', {
			sessionId: 'session-1',
			folderPath: '/repo/.maestro/playbooks',
			responseChannel: 'folder-empty-first-doc-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteSetAutoRunFolderResponse).toHaveBeenCalledWith(
				'folder-empty-first-doc-response',
				{ success: true }
			)
		);
		expect(harness.sessions[0]).toEqual(
			expect.objectContaining({
				autoRunContent: '',
				autoRunContentVersion: 1,
			})
		);
		expect(harness.sessions[1].autoRunFolderPath).toBe('/repo/.maestro/playbooks');
	});

	it('returns Auto Run document metadata with normalized folders and task counts', async () => {
		maestro().autorun.listDocs.mockResolvedValue({
			success: true,
			files: ['root.md', 'nested\\child.md'],
		});
		maestro()
			.autorun.readDoc.mockResolvedValueOnce({ success: true, content: '- [ ] One\n- [x] Two' })
			.mockResolvedValueOnce({ success: true, content: '- [X] Done' });
		createHarness();

		dispatch('maestro:getAutoRunDocs', {
			sessionId: 'session-1',
			responseChannel: 'docs-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteGetAutoRunDocsResponse).toHaveBeenCalledWith(
				'docs-response',
				[
					{ filename: 'root.md', path: 'root.md', taskCount: 2, completedCount: 1, folder: '' },
					{
						filename: 'child.md',
						path: 'nested/child.md',
						taskCount: 1,
						completedCount: 1,
						folder: 'nested',
					},
				]
			)
		);
	});

	it('reads, saves, stops, and resets Auto Run documents through remote events', async () => {
		maestro()
			.autorun.readDoc.mockResolvedValueOnce({ success: true, content: 'Current content' })
			.mockResolvedValueOnce({ success: true, content: '- [x] Done\n- [ ] Todo' });
		const harness = createHarness();

		dispatch('maestro:getAutoRunDocContent', {
			sessionId: 'session-1',
			filename: 'plan.md',
			responseChannel: 'read-response',
		});
		dispatch('maestro:saveAutoRunDoc', {
			sessionId: 'session-1',
			filename: 'plan.md',
			content: 'Saved content',
			responseChannel: 'save-response',
		});
		dispatch('maestro:stopAutoRun', { sessionId: 'session-1' });
		dispatch('maestro:resetAutoRunDocTasks', {
			sessionId: 'session-1',
			filename: 'plan.md',
			responseChannel: 'reset-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteResetAutoRunDocTasksResponse).toHaveBeenCalledWith(
				'reset-response',
				true
			)
		);
		expect(maestro().process.sendRemoteGetAutoRunDocContentResponse).toHaveBeenCalledWith(
			'read-response',
			'Current content'
		);
		expect(maestro().process.sendRemoteSaveAutoRunDocResponse).toHaveBeenCalledWith(
			'save-response',
			true
		);
		expect(harness.deps.stopBatchRun).toHaveBeenCalledWith('session-1');
		expect(maestro().autorun.writeDoc).toHaveBeenCalledWith(
			'/repo/.maestro/playbooks',
			'plan.md',
			'- [ ] Done\n- [ ] Todo',
			undefined
		);
		expect(harness.sessions[0].autoRunContent).toBe('- [ ] Done\n- [ ] Todo');
	});

	it('handles Auto Run document missing-folder and IPC failure fallbacks', async () => {
		createHarness([makeSession({ autoRunFolderPath: undefined })]);

		dispatch('maestro:getAutoRunDocs', {
			sessionId: 'session-1',
			responseChannel: 'docs-missing-folder',
		});
		dispatch('maestro:getAutoRunDocContent', {
			sessionId: 'session-1',
			filename: 'plan.md',
			responseChannel: 'content-missing-folder',
		});
		dispatch('maestro:saveAutoRunDoc', {
			sessionId: 'session-1',
			filename: 'plan.md',
			content: 'Saved',
			responseChannel: 'save-missing-folder',
		});
		dispatch('maestro:resetAutoRunDocTasks', {
			sessionId: 'session-1',
			filename: 'plan.md',
			responseChannel: 'reset-missing-folder',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteResetAutoRunDocTasksResponse).toHaveBeenCalledWith(
				'reset-missing-folder',
				false
			)
		);
		expect(maestro().process.sendRemoteGetAutoRunDocsResponse).toHaveBeenCalledWith(
			'docs-missing-folder',
			[]
		);
		expect(maestro().process.sendRemoteGetAutoRunDocContentResponse).toHaveBeenCalledWith(
			'content-missing-folder',
			''
		);
		expect(maestro().process.sendRemoteSaveAutoRunDocResponse).toHaveBeenCalledWith(
			'save-missing-folder',
			false
		);

		maestro().autorun.listDocs.mockRejectedValueOnce(new Error('docs failed'));
		maestro().autorun.readDoc.mockRejectedValueOnce(new Error('content failed'));
		maestro().autorun.writeDoc.mockRejectedValueOnce(new Error('save failed'));
		const harness = createHarness();
		dispatch('maestro:getAutoRunDocs', {
			sessionId: 'session-1',
			responseChannel: 'docs-thrown',
		});
		dispatch('maestro:getAutoRunDocContent', {
			sessionId: 'session-1',
			filename: 'plan.md',
			responseChannel: 'content-thrown',
		});
		dispatch('maestro:saveAutoRunDoc', {
			sessionId: 'session-1',
			filename: 'plan.md',
			content: 'Saved',
			responseChannel: 'save-thrown',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteSaveAutoRunDocResponse).toHaveBeenCalledWith(
				'save-thrown',
				false
			)
		);
		expect(maestro().process.sendRemoteGetAutoRunDocsResponse).toHaveBeenCalledWith(
			'docs-thrown',
			[]
		);
		expect(maestro().process.sendRemoteGetAutoRunDocContentResponse).toHaveBeenCalledWith(
			'content-thrown',
			''
		);
		expect(harness.sessions[0].autoRunContent).toBe('- [x] Done');
	});

	it('reports reset task no-op and read/write failure outcomes', async () => {
		const harness = createHarness();

		maestro().autorun.readDoc.mockResolvedValueOnce({ success: true, content: '- [ ] Todo' });
		dispatch('maestro:resetAutoRunDocTasks', {
			sessionId: 'session-1',
			filename: 'plan.md',
			responseChannel: 'reset-noop',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteResetAutoRunDocTasksResponse).toHaveBeenCalledWith(
				'reset-noop',
				true
			)
		);

		maestro().autorun.readDoc.mockResolvedValueOnce({ success: false });
		dispatch('maestro:resetAutoRunDocTasks', {
			sessionId: 'session-1',
			filename: 'plan.md',
			responseChannel: 'reset-read-fail',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteResetAutoRunDocTasksResponse).toHaveBeenCalledWith(
				'reset-read-fail',
				false
			)
		);

		maestro().autorun.readDoc.mockResolvedValueOnce({ success: true, content: '* [X] Done' });
		maestro().autorun.writeDoc.mockResolvedValueOnce({ success: false });
		dispatch('maestro:resetAutoRunDocTasks', {
			sessionId: 'session-1',
			filename: 'other.md',
			responseChannel: 'reset-write-fail',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteResetAutoRunDocTasksResponse).toHaveBeenCalledWith(
				'reset-write-fail',
				false
			)
		);
		expect(harness.sessions[0].autoRunContent).toBe('- [x] Done');
	});

	it('covers optional Auto Run fallback values', async () => {
		maestro()
			.autorun.listDocs.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: false });
		maestro()
			.autorun.readDoc.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: true, content: '- [ ] Only unchecked' })
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: true });
		maestro().autorun.writeDoc.mockResolvedValueOnce({});
		const harness = createHarness([makeSession({ autoRunContentVersion: undefined })]);

		dispatch('maestro:setAutoRunFolder', {
			sessionId: 'session-1',
			folderPath: '/repo/.maestro/playbooks',
			responseChannel: 'folder-empty-content-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteSetAutoRunFolderResponse).toHaveBeenCalledWith(
				'folder-empty-content-response',
				{ success: true }
			)
		);
		expect(harness.sessions[0].autoRunContentVersion).toBe(1);

		dispatch('maestro:getAutoRunDocs', {
			sessionId: 'session-1',
			responseChannel: 'docs-empty-files-response',
		});
		dispatch('maestro:getAutoRunDocContent', {
			sessionId: 'session-1',
			filename: 'missing.md',
			responseChannel: 'content-false-response',
		});
		dispatch('maestro:saveAutoRunDoc', {
			sessionId: 'session-1',
			filename: 'plan.md',
			content: 'Saved',
			responseChannel: 'save-undefined-success-response',
		});
		dispatch('maestro:resetAutoRunDocTasks', {
			sessionId: 'session-1',
			filename: 'plan.md',
			responseChannel: 'reset-empty-content-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteResetAutoRunDocTasksResponse).toHaveBeenCalledWith(
				'reset-empty-content-response',
				true
			)
		);
		expect(maestro().process.sendRemoteGetAutoRunDocsResponse).toHaveBeenCalledWith(
			'docs-empty-files-response',
			[]
		);
		expect(maestro().process.sendRemoteGetAutoRunDocContentResponse).toHaveBeenCalledWith(
			'content-false-response',
			''
		);
		expect(maestro().process.sendRemoteSaveAutoRunDocResponse).toHaveBeenCalledWith(
			'save-undefined-success-response',
			false
		);
	});

	it('covers remaining Auto Run default branch fallbacks', async () => {
		createHarness([
			makeSession({ id: 'session-1', autoRunContentVersion: undefined }),
			makeSession({ id: 'session-2', autoRunContent: 'unchanged' }),
		]);

		maestro().autorun.listDocs.mockRejectedValueOnce('raw list failure');
		dispatch('maestro:setAutoRunFolder', {
			sessionId: 'session-1',
			folderPath: '/raw-error',
			responseChannel: 'folder-string-error-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteSetAutoRunFolderResponse).toHaveBeenCalledWith(
				'folder-string-error-response',
				{ success: false, error: 'raw list failure' }
			)
		);

		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-1',
			config: { launch: true },
			responseChannel: 'launch-missing-docs-response',
		});
		expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
			'launch-missing-docs-response',
			{ success: false, error: 'No documents provided for auto-run' }
		);

		maestro().autorun.listDocs.mockResolvedValueOnce({ success: true });
		dispatch('maestro:getAutoRunDocs', {
			sessionId: 'session-1',
			responseChannel: 'docs-undefined-files-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteGetAutoRunDocsResponse).toHaveBeenCalledWith(
				'docs-undefined-files-response',
				[]
			)
		);

		maestro().autorun.listDocs.mockResolvedValueOnce({ success: true, files: ['plain.md'] });
		maestro().autorun.readDoc.mockResolvedValueOnce({ success: true, content: 'plain text' });
		dispatch('maestro:getAutoRunDocs', {
			sessionId: 'session-1',
			responseChannel: 'docs-plain-content-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteGetAutoRunDocsResponse).toHaveBeenCalledWith(
				'docs-plain-content-response',
				[{ filename: 'plain.md', path: 'plain.md', taskCount: 0, completedCount: 0, folder: '' }]
			)
		);

		maestro().autorun.readDoc.mockResolvedValueOnce({ success: false });
		dispatch('maestro:getAutoRunDocContent', {
			sessionId: 'session-1',
			filename: 'missing.md',
			responseChannel: 'content-false-branch-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteGetAutoRunDocContentResponse).toHaveBeenCalledWith(
				'content-false-branch-response',
				''
			)
		);

		maestro().autorun.readDoc.mockResolvedValueOnce({ success: true, content: '- [x] Done' });
		maestro().autorun.writeDoc.mockResolvedValueOnce({ success: true });
		dispatch('maestro:resetAutoRunDocTasks', {
			sessionId: 'session-1',
			filename: 'plan.md',
			responseChannel: 'reset-version-fallback-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteResetAutoRunDocTasksResponse).toHaveBeenCalledWith(
				'reset-version-fallback-response',
				true
			)
		);
	});

	it('reports thrown reset task failures', async () => {
		createHarness();
		maestro().autorun.readDoc.mockRejectedValueOnce(new Error('reset read failed'));

		dispatch('maestro:resetAutoRunDocTasks', {
			sessionId: 'session-1',
			filename: 'plan.md',
			responseChannel: 'reset-thrown-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteResetAutoRunDocTasksResponse).toHaveBeenCalledWith(
				'reset-thrown-response',
				false
			)
		);
	});

	it('configures Auto Run playbooks and launches immediate runs', async () => {
		const { deps } = createHarness();

		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-1',
			config: {
				saveAsPlaybook: 'Morning loop',
				documents: [{ filename: 'plan.md' }],
				loopEnabled: true,
				maxLoops: 2,
				prompt: 'Ship it',
			},
			responseChannel: 'save-playbook-response',
		});
		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-1',
			config: {
				launch: true,
				documents: [
					{ filename: '/repo/.maestro/playbooks/nested/plan.md', resetOnCompletion: true },
				],
			},
			responseChannel: 'launch-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
				'launch-response',
				{ success: true }
			)
		);
		expect(maestro().playbooks.create).toHaveBeenCalledWith('session-1', {
			name: 'Morning loop',
			documents: [{ filename: 'plan.md' }],
			loopEnabled: true,
			maxLoops: 2,
			prompt: 'Ship it',
		});
		expect(deps.startBatchRun).toHaveBeenCalledWith(
			'session-1',
			expect.objectContaining({
				documents: [
					expect.objectContaining({
						filename: 'nested/plan',
						resetOnCompletion: true,
						isDuplicate: false,
					}),
				],
			}),
			'/repo/.maestro/playbooks'
		);
	});

	it('launches Auto Run through a spawned worktree session and preserves resolved PR config', async () => {
		const parent = makeSession({ id: 'parent-session', cwd: '/repo' });
		const child = makeSession({
			id: 'session-1',
			parentSessionId: 'parent-session',
			cwd: '/repo/worktrees/child',
		});
		const { deps } = createHarness([child]);
		useSessionStore.setState({
			activeSessionId: 'session-1',
			sessions: [parent, child],
		});
		vi.mocked(spawnWorktreeAgentAndDispatch).mockImplementationOnce(async (_parent, config) => {
			config.worktree = {
				enabled: true,
				path: '/repo/worktrees/feature',
				branchName: 'feature',
				createPROnCompletion: true,
				prTargetBranch: 'develop',
			};
			return 'spawned-session';
		});

		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-1',
			config: {
				launch: true,
				documents: [{ filename: '/outside/plan.md' }],
				worktree: {
					enabled: true,
					branchName: 'feature',
					baseBranch: 'develop',
					createPROnCompletion: true,
				},
			},
			responseChannel: 'worktree-launch-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
				'worktree-launch-response',
				{ success: true }
			)
		);
		expect(spawnWorktreeAgentAndDispatch).toHaveBeenCalledWith(
			parent,
			expect.objectContaining({
				worktreeTarget: expect.objectContaining({
					newBranchName: 'feature',
					baseBranch: 'develop',
					createPROnCompletion: true,
				}),
			})
		);
		expect(deps.startBatchRun).toHaveBeenCalledWith(
			'spawned-session',
			expect.objectContaining({
				documents: [expect.objectContaining({ filename: 'plan' })],
				worktree: expect.objectContaining({ path: '/repo/worktrees/feature' }),
				worktreeTarget: expect.objectContaining({ newBranchName: 'feature' }),
			}),
			'/repo/.maestro/playbooks'
		);
	});

	it('reports worktree launch spawn failures without starting Auto Run', async () => {
		vi.mocked(spawnWorktreeAgentAndDispatch)
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error('spawn exploded'));
		const { deps } = createHarness();

		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-1',
			config: {
				launch: true,
				documents: [{ filename: 'plan.md' }],
				worktree: { enabled: true, branchName: 'feature' },
			},
			responseChannel: 'spawn-null-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
				'spawn-null-response',
				{ success: false, error: 'Failed to spawn worktree agent' }
			)
		);

		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-1',
			config: {
				launch: true,
				documents: [{ filename: 'plan.md' }],
				worktree: { enabled: true, branchName: 'feature' },
			},
			responseChannel: 'spawn-throw-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
				'spawn-throw-response',
				{ success: false, error: 'spawn exploded' }
			)
		);
		expect(deps.startBatchRun).not.toHaveBeenCalled();
	});

	it('stringifies non-Error worktree launch failures', async () => {
		vi.mocked(spawnWorktreeAgentAndDispatch).mockRejectedValueOnce('raw spawn failure');
		createHarness();

		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-1',
			config: {
				launch: true,
				documents: [{ filename: 'plan.md' }],
				worktree: { enabled: true, branchName: 'feature' },
			},
			responseChannel: 'spawn-string-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
				'spawn-string-response',
				{ success: false, error: 'raw spawn failure' }
			)
		);
	});

	it('returns configure Auto Run errors for missing sessions, folders, docs, and actions', async () => {
		createHarness([
			makeSession({ autoRunFolderPath: undefined }),
			makeSession({ id: 'session-2', autoRunFolderPath: '/repo/.maestro/playbooks' }),
		]);

		dispatch('maestro:configureAutoRun', {
			sessionId: 'missing-session',
			config: { launch: true, documents: [{ filename: 'plan.md' }] },
			responseChannel: 'missing-response',
		});
		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-1',
			config: { launch: true, documents: [{ filename: 'plan.md' }] },
			responseChannel: 'folder-response',
		});
		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-2',
			config: { launch: true, documents: [] },
			responseChannel: 'docs-response',
		});
		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-2',
			config: {},
			responseChannel: 'action-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
				'action-response',
				{
					success: false,
					error: 'Use --launch to start auto-run immediately, or --save-as to save as a playbook',
				}
			)
		);
		expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
			'missing-response',
			{ success: false, error: 'Session missing-session not found' }
		);
		expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
			'folder-response',
			{ success: false, error: 'No Auto Run folder configured for this session' }
		);
		expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
			'docs-response',
			{ success: false, error: 'No documents provided for auto-run' }
		);
	});

	it('reports unexpected configure Auto Run failures', async () => {
		createHarness();
		maestro().playbooks.create.mockRejectedValueOnce(new Error('playbook create exploded'));

		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-1',
			config: { saveAsPlaybook: 'Broken playbook' },
			responseChannel: 'configure-thrown-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
				'configure-thrown-response',
				{ success: false, error: 'Error: playbook create exploded' }
			)
		);
	});

	it('logs asynchronous Auto Run launch failures after acknowledging success', async () => {
		const startBatchRun = vi.fn().mockRejectedValue(new Error('batch failed'));
		createHarness([makeSession()], { startBatchRun });

		dispatch('maestro:configureAutoRun', {
			sessionId: 'session-1',
			config: { launch: true, documents: [{ filename: 'plan.md' }] },
			responseChannel: 'launch-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteConfigureAutoRunResponse).toHaveBeenCalledWith(
				'launch-response',
				{ success: true }
			)
		);
		await waitFor(() => expect(startBatchRun).toHaveBeenCalled());
	});

	it('handles Auto Run recovery and playbook CRUD response events', async () => {
		const { deps } = createHarness();

		dispatch('maestro:resumeAutoRunError', {
			sessionId: 'session-1',
			responseChannel: 'resume-response',
		});
		dispatch('maestro:skipAutoRunDocument', {
			sessionId: 'session-1',
			responseChannel: 'skip-response',
		});
		dispatch('maestro:abortAutoRunError', {
			sessionId: 'session-1',
			responseChannel: 'abort-response',
		});
		dispatch('maestro:listPlaybooks', {
			sessionId: 'session-1',
			responseChannel: 'list-response',
		});
		dispatch('maestro:createPlaybook', {
			sessionId: 'session-1',
			playbook: { name: 'Created' },
			responseChannel: 'create-response',
		});
		dispatch('maestro:updatePlaybook', {
			sessionId: 'session-1',
			playbookId: 'pb-1',
			updates: { name: 'Updated' },
			responseChannel: 'update-response',
		});
		dispatch('maestro:deletePlaybook', {
			sessionId: 'session-1',
			playbookId: 'pb-1',
			responseChannel: 'delete-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteDeletePlaybookResponse).toHaveBeenCalledWith(
				'delete-response',
				true
			)
		);
		expect(deps.resumeAfterError).toHaveBeenCalledWith('session-1');
		expect(deps.skipCurrentDocument).toHaveBeenCalledWith('session-1');
		expect(deps.abortBatchOnError).toHaveBeenCalledWith('session-1');
		expect(maestro().process.sendRemoteResumeAutoRunErrorResponse).toHaveBeenCalledWith(
			'resume-response',
			true
		);
		expect(maestro().process.sendRemoteSkipAutoRunDocumentResponse).toHaveBeenCalledWith(
			'skip-response',
			true
		);
		expect(maestro().process.sendRemoteAbortAutoRunErrorResponse).toHaveBeenCalledWith(
			'abort-response',
			true
		);
		expect(maestro().process.sendRemoteListPlaybooksResponse).toHaveBeenCalledWith(
			'list-response',
			[]
		);
		expect(maestro().process.sendRemoteCreatePlaybookResponse).toHaveBeenCalledWith(
			'create-response',
			{ id: 'pb-1' }
		);
		expect(maestro().process.sendRemoteUpdatePlaybookResponse).toHaveBeenCalledWith(
			'update-response',
			{ id: 'pb-1' }
		);
	});

	it('returns fallback responses when recovery and playbook handlers fail', async () => {
		const resumeAfterError = vi.fn(() => {
			throw new Error('resume failed');
		});
		const skipCurrentDocument = vi.fn(() => {
			throw new Error('skip failed');
		});
		const abortBatchOnError = vi.fn(() => {
			throw new Error('abort failed');
		});
		createHarness([makeSession()], {
			resumeAfterError,
			skipCurrentDocument,
			abortBatchOnError,
		});
		maestro().playbooks.list.mockRejectedValueOnce(new Error('list failed'));
		maestro().playbooks.create.mockRejectedValueOnce(new Error('create failed'));
		maestro().playbooks.update.mockRejectedValueOnce(new Error('update failed'));
		maestro()
			.playbooks.delete.mockResolvedValueOnce({ success: false, error: 'delete failed' })
			.mockRejectedValueOnce(new Error('delete thrown'));

		dispatch('maestro:resumeAutoRunError', {
			sessionId: 'session-1',
			responseChannel: 'resume-response',
		});
		dispatch('maestro:skipAutoRunDocument', {
			sessionId: 'session-1',
			responseChannel: 'skip-response',
		});
		dispatch('maestro:abortAutoRunError', {
			sessionId: 'session-1',
			responseChannel: 'abort-response',
		});
		dispatch('maestro:listPlaybooks', {
			sessionId: 'session-1',
			responseChannel: 'list-response',
		});
		dispatch('maestro:createPlaybook', {
			sessionId: 'session-1',
			playbook: { name: 'Created' },
			responseChannel: 'create-response',
		});
		dispatch('maestro:updatePlaybook', {
			sessionId: 'session-1',
			playbookId: 'pb-1',
			updates: { name: 'Updated' },
			responseChannel: 'update-response',
		});
		dispatch('maestro:deletePlaybook', {
			sessionId: 'session-1',
			playbookId: 'pb-1',
			responseChannel: 'delete-false-response',
		});
		dispatch('maestro:deletePlaybook', {
			sessionId: 'session-1',
			playbookId: 'pb-2',
			responseChannel: 'delete-thrown-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteDeletePlaybookResponse).toHaveBeenCalledWith(
				'delete-thrown-response',
				false
			)
		);
		expect(maestro().process.sendRemoteResumeAutoRunErrorResponse).toHaveBeenCalledWith(
			'resume-response',
			false
		);
		expect(maestro().process.sendRemoteSkipAutoRunDocumentResponse).toHaveBeenCalledWith(
			'skip-response',
			false
		);
		expect(maestro().process.sendRemoteAbortAutoRunErrorResponse).toHaveBeenCalledWith(
			'abort-response',
			false
		);
		expect(maestro().process.sendRemoteListPlaybooksResponse).toHaveBeenCalledWith(
			'list-response',
			[]
		);
		expect(maestro().process.sendRemoteCreatePlaybookResponse).toHaveBeenCalledWith(
			'create-response',
			null
		);
		expect(maestro().process.sendRemoteUpdatePlaybookResponse).toHaveBeenCalledWith(
			'update-response',
			null
		);
		expect(maestro().process.sendRemoteDeletePlaybookResponse).toHaveBeenCalledWith(
			'delete-false-response',
			false
		);
	});

	it('normalizes malformed playbook IPC responses', async () => {
		maestro().playbooks.list.mockResolvedValueOnce({ success: true, playbooks: null });
		maestro().playbooks.create.mockResolvedValueOnce({ success: true });
		maestro().playbooks.update.mockResolvedValueOnce({ success: true });
		createHarness();

		dispatch('maestro:listPlaybooks', {
			sessionId: 'session-1',
			responseChannel: 'list-malformed-response',
		});
		dispatch('maestro:createPlaybook', {
			sessionId: 'session-1',
			playbook: { name: 'Created' },
			responseChannel: 'create-malformed-response',
		});
		dispatch('maestro:updatePlaybook', {
			sessionId: 'session-1',
			playbookId: 'pb-1',
			updates: { name: 'Updated' },
			responseChannel: 'update-malformed-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteUpdatePlaybookResponse).toHaveBeenCalledWith(
				'update-malformed-response',
				null
			)
		);
		expect(maestro().process.sendRemoteListPlaybooksResponse).toHaveBeenCalledWith(
			'list-malformed-response',
			[]
		);
		expect(maestro().process.sendRemoteCreatePlaybookResponse).toHaveBeenCalledWith(
			'create-malformed-response',
			null
		);
	});

	it('creates local and remote sessions with git metadata and persistence fallbacks', async () => {
		maestro().agents.get.mockResolvedValue({ id: 'claude-code' });
		vi.mocked(gitService.isRepo).mockResolvedValueOnce(true);
		vi.mocked(gitService.getBranches).mockResolvedValueOnce(['main', 'feature']);
		vi.mocked(gitService.getTags).mockResolvedValueOnce(['v1']);
		const harness = createHarness([]);

		dispatch('maestro:remoteCreateSession', {
			name: 'Local Agent',
			toolType: 'claude-code',
			cwd: '/repo/local',
			groupId: 'group-1',
			config: {
				nudgeMessage: 'nudge',
				customPath: '/bin/claude',
				autoRunFolderPath: '/repo/local/playbooks',
			},
			responseChannel: 'create-local-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteCreateSessionResponse).toHaveBeenCalledWith(
				'create-local-response',
				expect.objectContaining({ sessionId: expect.any(String) })
			)
		);
		expect(gitService.isRepo).toHaveBeenCalledWith('/repo/local');
		expect(harness.sessions[0]).toEqual(
			expect.objectContaining({
				name: 'Local Agent',
				cwd: '/repo/local',
				isGitRepo: true,
				gitBranches: ['main', 'feature'],
				gitTags: ['v1'],
				groupId: 'group-1',
				nudgeMessage: 'nudge',
				customPath: '/bin/claude',
				autoRunFolderPath: '/repo/local/playbooks',
			})
		);
		expect(maestro().sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ name: 'Local Agent' })],
			[]
		);

		maestro().sessions.setMany.mockRejectedValueOnce(new Error('persist failed'));
		dispatch('maestro:remoteCreateSession', {
			name: 'Remote Agent',
			toolType: 'codex',
			cwd: '/repo/remote',
			config: { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } },
			responseChannel: 'create-remote-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteCreateSessionResponse).toHaveBeenCalledWith(
				'create-remote-response',
				expect.objectContaining({ sessionId: expect.any(String) })
			)
		);
		expect(harness.sessions[1]).toEqual(
			expect.objectContaining({
				name: 'Remote Agent',
				isGitRepo: false,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			})
		);
		expect(gitService.isRepo).toHaveBeenCalledTimes(1);
	});

	it('creates terminal sessions with optional custom configuration fields', async () => {
		maestro().agents.get.mockResolvedValue({ id: 'terminal' });
		const harness = createHarness([]);

		dispatch('maestro:remoteCreateSession', {
			name: 'Terminal Agent',
			toolType: 'terminal',
			cwd: '/repo/terminal',
			config: {
				newSessionMessage: 'hello',
				customArgs: '--flag',
				customEnvVars: { NODE_ENV: 'test' },
				customModel: 'model-a',
				customEffort: 'high',
				customContextWindow: 123456,
				customProviderPath: '/provider',
			},
			responseChannel: 'create-terminal-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteCreateSessionResponse).toHaveBeenCalledWith(
				'create-terminal-response',
				expect.objectContaining({ sessionId: expect.any(String) })
			)
		);
		expect(harness.sessions[0]).toEqual(
			expect.objectContaining({
				name: 'Terminal Agent',
				inputMode: 'terminal',
				newSessionMessage: 'hello',
				customArgs: '--flag',
				customEnvVars: { NODE_ENV: 'test' },
				customModel: 'model-a',
				customEffort: 'high',
				customContextWindow: 123456,
				customProviderPath: '/provider',
			})
		);
	});

	it('reports create-session validation and unexpected failures', async () => {
		createHarness([]);

		dispatch('maestro:remoteCreateSession', {
			name: 'Missing Agent',
			toolType: 'unknown',
			cwd: '/repo',
			responseChannel: 'missing-agent-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteCreateSessionResponse).toHaveBeenCalledWith(
				'missing-agent-response',
				null
			)
		);

		maestro().agents.get.mockRejectedValueOnce(new Error('agent lookup failed'));
		dispatch('maestro:remoteCreateSession', {
			name: 'Thrown Agent',
			toolType: 'claude-code',
			cwd: '/repo',
			responseChannel: 'create-thrown-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteCreateSessionResponse).toHaveBeenCalledWith(
				'create-thrown-response',
				null
			)
		);
	});

	it('creates worktree sessions and reports missing, null, and thrown spawn outcomes', async () => {
		const parent = makeSession({ id: 'parent-session', cwd: '/repo' });
		const child = makeSession({
			id: 'child-session',
			parentSessionId: 'parent-session',
			cwd: '/repo/wt',
		});
		createHarness([parent, child]);
		useSessionStore.setState({ activeSessionId: 'child-session', sessions: [parent, child] });
		vi.mocked(spawnWorktreeAgentAndDispatch)
			.mockResolvedValueOnce('new-worktree-session')
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error('worktree exploded'));

		dispatch('maestro:createWorktreeSession', {
			parentSessionId: 'child-session',
			config: { branchName: 'feature', baseBranch: 'main' },
			responseChannel: 'worktree-success-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteCreateWorktreeSessionResponse).toHaveBeenCalledWith(
				'worktree-success-response',
				{ success: true, sessionId: 'new-worktree-session' }
			)
		);
		expect(spawnWorktreeAgentAndDispatch).toHaveBeenCalledWith(
			parent,
			expect.objectContaining({
				worktreeTarget: expect.objectContaining({ newBranchName: 'feature', baseBranch: 'main' }),
			})
		);

		dispatch('maestro:createWorktreeSession', {
			parentSessionId: 'missing',
			config: { branchName: 'feature' },
			responseChannel: 'worktree-missing-response',
		});
		expect(maestro().process.sendRemoteCreateWorktreeSessionResponse).toHaveBeenCalledWith(
			'worktree-missing-response',
			{ success: false, error: 'Parent agent missing not found' }
		);

		dispatch('maestro:createWorktreeSession', {
			parentSessionId: 'parent-session',
			config: { branchName: 'feature' },
			responseChannel: 'worktree-null-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteCreateWorktreeSessionResponse).toHaveBeenCalledWith(
				'worktree-null-response',
				{ success: false, error: 'Failed to create worktree agent' }
			)
		);

		dispatch('maestro:createWorktreeSession', {
			parentSessionId: 'parent-session',
			config: { branchName: 'feature' },
			responseChannel: 'worktree-thrown-response',
		});
		await waitFor(() =>
			expect(maestro().process.sendRemoteCreateWorktreeSessionResponse).toHaveBeenCalledWith(
				'worktree-thrown-response',
				{ success: false, error: 'worktree exploded' }
			)
		);
	});

	it('stringifies non-Error create-worktree failures', async () => {
		createHarness([makeSession({ id: 'parent-session' })]);
		vi.mocked(spawnWorktreeAgentAndDispatch).mockRejectedValueOnce('raw worktree failure');

		dispatch('maestro:createWorktreeSession', {
			parentSessionId: 'parent-session',
			config: { branchName: 'feature' },
			responseChannel: 'worktree-string-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteCreateWorktreeSessionResponse).toHaveBeenCalledWith(
				'worktree-string-response',
				{ success: false, error: 'raw worktree failure' }
			)
		);
	});

	it('deletes sessions, kills owned processes, switches active session, and persists removal', async () => {
		maestro()
			.process.kill.mockRejectedValueOnce(new Error('ai already gone'))
			.mockResolvedValue(undefined);
		const harness = createHarness([
			makeSession({
				terminalTabs: [
					{
						id: 'terminal-tab-1',
						name: 'Shell',
						cwd: '/repo',
						shellType: '/bin/zsh',
						createdAt: 1,
					},
				] as any,
			}),
			makeSession({ id: 'session-2', name: 'Second Agent' }),
		]);
		useSessionStore.setState({ activeSessionId: 'session-1' });

		dispatch('maestro:remoteDeleteSession', { sessionId: 'session-1' });

		await waitFor(() => expect(maestro().sessions.setMany).toHaveBeenCalledWith([], ['session-1']));
		expect(maestro().process.kill).toHaveBeenCalledWith('session-1-ai');
		expect(maestro().process.kill).toHaveBeenCalledWith('session-1-terminal');
		expect(maestro().process.kill).toHaveBeenCalledWith('session-1-terminal-terminal-tab-1');
		expect(harness.sessions.map((session) => session.id)).toEqual(['session-2']);
		expect(harness.deps.setActiveSessionId).toHaveBeenCalledWith('session-2');

		dispatch('maestro:remoteDeleteSession', { sessionId: 'missing' });
		expect(maestro().sessions.setMany).toHaveBeenCalledTimes(1);
	});

	it('keeps session deletion local state when removal persistence fails', async () => {
		maestro().sessions.setMany.mockRejectedValueOnce(new Error('delete persist failed'));
		const harness = createHarness([makeSession(), makeSession({ id: 'session-2' })]);

		dispatch('maestro:remoteDeleteSession', { sessionId: 'session-1' });

		await waitFor(() => expect(maestro().sessions.setMany).toHaveBeenCalledWith([], ['session-1']));
		expect(harness.sessions.map((session) => session.id)).toEqual(['session-2']);
	});

	it('deletes sessions with undefined terminal tab collections', async () => {
		const harness = createHarness([makeSession({ terminalTabs: undefined })]);

		dispatch('maestro:remoteDeleteSession', { sessionId: 'session-1' });

		await waitFor(() => expect(maestro().sessions.setMany).toHaveBeenCalledWith([], ['session-1']));
		expect(maestro().process.kill).toHaveBeenCalledWith('session-1-ai');
		expect(harness.sessions).toEqual([]);
	});

	it('updates session cwd and SSH config with running-process guards', async () => {
		const harness = createHarness([makeSession(), makeSession({ id: 'running', aiPid: 123 })]);

		dispatch('maestro:remoteUpdateSessionCwd', {
			sessionId: 'session-1',
			newCwd: '/repo/new',
			responseChannel: 'cwd-response',
		});
		dispatch('maestro:remoteUpdateSessionCwd', {
			sessionId: 'running',
			newCwd: '/repo/nope',
			responseChannel: 'cwd-running-response',
		});
		dispatch('maestro:remoteUpdateSessionSsh', {
			sessionId: 'session-1',
			sshPatch: { enabled: true, remoteId: 'remote-1', syncHistory: true },
			responseChannel: 'ssh-response',
		});
		dispatch('maestro:remoteUpdateSessionSsh', {
			sessionId: 'running',
			sshPatch: { enabled: false },
			responseChannel: 'ssh-running-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteUpdateSessionSshResponse).toHaveBeenCalledWith(
				'ssh-response',
				{ success: true }
			)
		);
		expect(maestro().process.sendRemoteUpdateSessionCwdResponse).toHaveBeenCalledWith(
			'cwd-response',
			{ success: true }
		);
		expect(maestro().process.sendRemoteUpdateSessionCwdResponse).toHaveBeenCalledWith(
			'cwd-running-response',
			{ success: false, error: 'Agent process is running; stop it before changing cwd' }
		);
		expect(maestro().process.sendRemoteUpdateSessionSshResponse).toHaveBeenCalledWith(
			'ssh-running-response',
			{ success: false, error: 'Agent process is running; stop it before changing SSH config' }
		);
		expect(harness.sessions[0]).toEqual(
			expect.objectContaining({
				cwd: '/repo/new',
				fullPath: '/repo/new',
				shellCwd: '/repo/new',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1', syncHistory: true },
			})
		);
		expect(maestro().sessions.setMany).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					sessionSshRemoteConfig: expect.objectContaining({ remoteId: 'remote-1' }),
				}),
			],
			[]
		);
	});

	it('reports missing update targets and keeps successful SSH updates despite persistence errors', async () => {
		maestro().sessions.setMany.mockRejectedValueOnce(new Error('ssh persist failed'));
		createHarness();

		dispatch('maestro:remoteUpdateSessionCwd', {
			sessionId: 'missing',
			newCwd: '/repo/missing',
			responseChannel: 'cwd-missing-response',
		});
		dispatch('maestro:remoteUpdateSessionSsh', {
			sessionId: 'missing',
			sshPatch: { enabled: true },
			responseChannel: 'ssh-missing-response',
		});
		dispatch('maestro:remoteUpdateSessionSsh', {
			sessionId: 'session-1',
			sshPatch: { syncHistory: true },
			responseChannel: 'ssh-persist-error-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteUpdateSessionSshResponse).toHaveBeenCalledWith(
				'ssh-persist-error-response',
				{ success: true }
			)
		);
		expect(maestro().process.sendRemoteUpdateSessionCwdResponse).toHaveBeenCalledWith(
			'cwd-missing-response',
			{ success: false, error: 'Agent not found' }
		);
		expect(maestro().process.sendRemoteUpdateSessionSshResponse).toHaveBeenCalledWith(
			'ssh-missing-response',
			{ success: false, error: 'Agent not found' }
		);
	});

	it('renames sessions and mirrors names to provider storage when available', async () => {
		const harness = createHarness([
			makeSession({
				agentSessionId: 'provider-session-1',
				projectRoot: '/repo',
			} as Partial<Session>),
		]);

		dispatch('maestro:remoteRenameSession', {
			sessionId: 'session-1',
			newName: 'Renamed Agent',
			responseChannel: 'rename-response',
		});
		dispatch('maestro:remoteRenameSession', {
			sessionId: 'missing',
			newName: 'Missing',
			responseChannel: 'missing-rename-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteRenameSessionResponse).toHaveBeenCalledWith(
				'rename-response',
				true
			)
		);
		expect(harness.sessions[0].name).toBe('Renamed Agent');
		expect(maestro().claude.updateSessionName).toHaveBeenCalledWith(
			'/repo',
			'provider-session-1',
			'Renamed Agent'
		);
		expect(maestro().process.sendRemoteRenameSessionResponse).toHaveBeenCalledWith(
			'missing-rename-response',
			false
		);
	});

	it('renames Claude provider sessions when provider storage rejects', async () => {
		maestro().claude.updateSessionName.mockRejectedValueOnce(new Error('provider failed'));
		const harness = createHarness([
			makeSession({
				agentSessionId: 'provider-session-1',
				projectRoot: '/repo',
			} as Partial<Session>),
		]);

		dispatch('maestro:remoteRenameSession', {
			sessionId: 'session-1',
			newName: 'Renamed Despite Provider Failure',
			responseChannel: 'rename-provider-failure-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteRenameSessionResponse).toHaveBeenCalledWith(
				'rename-provider-failure-response',
				true
			)
		);
		await Promise.resolve();
		expect(harness.sessions[0].name).toBe('Renamed Despite Provider Failure');
		expect(maestro().claude.updateSessionName).toHaveBeenCalledWith(
			'/repo',
			'provider-session-1',
			'Renamed Despite Provider Failure'
		);
	});

	it('renames non-Claude provider sessions and tolerates provider and persistence failures', async () => {
		maestro().agentSessions.setSessionName.mockRejectedValueOnce(new Error('provider failed'));
		maestro().sessions.setMany.mockRejectedValueOnce(new Error('persist failed'));
		const harness = createHarness([
			makeSession({
				toolType: 'codex',
				projectRoot: '/repo',
				agentSessionId: undefined,
				activeTabId: 'ai-tab-1',
				aiTabs: [
					{
						id: 'ai-tab-1',
						agentSessionId: 'provider-session-2',
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: 1,
						state: 'idle',
						saveToHistory: true,
						showThinking: true,
					},
				],
			} as Partial<Session>),
		]);

		dispatch('maestro:remoteRenameSession', {
			sessionId: 'session-1',
			newName: 'Renamed Codex',
			responseChannel: 'rename-codex-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteRenameSessionResponse).toHaveBeenCalledWith(
				'rename-codex-response',
				true
			)
		);
		await Promise.resolve();
		expect(harness.sessions[0].name).toBe('Renamed Codex');
		expect(maestro().agentSessions.setSessionName).toHaveBeenCalledWith(
			'codex',
			'/repo',
			'provider-session-2',
			'Renamed Codex'
		);
	});

	it('renames sessions using first-tab provider and default agent fallbacks', async () => {
		const harness = createHarness([
			makeSession({
				toolType: undefined,
				projectRoot: '/repo',
				agentSessionId: undefined,
				activeTabId: 'missing-tab',
				aiTabs: [
					{
						id: 'ai-tab-1',
						agentSessionId: 'fallback-provider-session',
						name: null,
						starred: false,
						logs: [],
						inputValue: '',
						stagedImages: [],
						createdAt: 1,
						state: 'idle',
						saveToHistory: true,
						showThinking: true,
					},
				],
			} as Partial<Session>),
			makeSession({ id: 'session-2', name: 'Second Agent' }),
		]);

		dispatch('maestro:remoteRenameSession', {
			sessionId: 'session-1',
			newName: 'Fallback Provider Name',
			responseChannel: 'rename-fallback-provider-response',
		});

		await waitFor(() =>
			expect(maestro().process.sendRemoteRenameSessionResponse).toHaveBeenCalledWith(
				'rename-fallback-provider-response',
				true
			)
		);
		expect(harness.sessions[0].name).toBe('Fallback Provider Name');
		expect(harness.sessions[1].name).toBe('Second Agent');
		expect(maestro().claude.updateSessionName).toHaveBeenCalledWith(
			'/repo',
			'fallback-provider-session',
			'Fallback Provider Name'
		);
	});

	it('creates, renames, deletes, and moves groups from remote events', () => {
		const harness = createHarness([
			makeSession({ groupId: 'group-old' }),
			makeSession({ id: 'session-2', groupId: 'group-other' }),
		]);

		dispatch('maestro:remoteCreateGroup', {
			name: ' launch ',
			emoji: '*',
			responseChannel: 'create-group-response',
		});
		const createdGroupId = harness.groups[0].id;
		dispatch('maestro:remoteCreateGroup', {
			name: ' keep ',
			responseChannel: 'create-second-group-response',
		});
		const secondGroupId = harness.groups[1].id;
		dispatch('maestro:remoteRenameGroup', {
			groupId: createdGroupId,
			name: ' done ',
			responseChannel: 'rename-group-response',
		});
		dispatch('maestro:remoteMoveSessionToGroup', {
			sessionId: 'session-1',
			groupId: createdGroupId,
			responseChannel: 'move-response',
		});
		dispatch('maestro:remoteMoveSessionToGroup', {
			sessionId: 'session-1',
			groupId: '',
			responseChannel: 'clear-group-response',
		});
		dispatch('maestro:remoteMoveSessionToGroup', {
			sessionId: 'session-1',
			groupId: createdGroupId,
			responseChannel: 'move-again-response',
		});
		dispatch('maestro:remoteDeleteGroup', { groupId: createdGroupId });
		dispatch('maestro:remoteCreateGroup', {
			name: '   ',
			responseChannel: 'blank-create-response',
		});
		dispatch('maestro:remoteRenameGroup', {
			groupId: createdGroupId,
			name: '   ',
			responseChannel: 'blank-rename-response',
		});
		dispatch('maestro:remoteMoveSessionToGroup', {
			sessionId: 'missing',
			groupId: createdGroupId,
			responseChannel: 'missing-move-response',
		});

		expect(maestro().process.sendRemoteCreateGroupResponse).toHaveBeenCalledWith(
			'create-group-response',
			{ id: createdGroupId }
		);
		expect(maestro().process.sendRemoteRenameGroupResponse).toHaveBeenCalledWith(
			'rename-group-response',
			true
		);
		expect(maestro().process.sendRemoteMoveSessionToGroupResponse).toHaveBeenCalledWith(
			'move-response',
			true
		);
		expect(maestro().process.sendRemoteMoveSessionToGroupResponse).toHaveBeenCalledWith(
			'clear-group-response',
			true
		);
		expect(maestro().process.sendRemoteCreateGroupResponse).toHaveBeenCalledWith(
			'blank-create-response',
			null
		);
		expect(maestro().process.sendRemoteRenameGroupResponse).toHaveBeenCalledWith(
			'blank-rename-response',
			false
		);
		expect(maestro().process.sendRemoteMoveSessionToGroupResponse).toHaveBeenCalledWith(
			'missing-move-response',
			false
		);
		expect(harness.groups).toEqual([
			expect.objectContaining({ id: secondGroupId, name: 'KEEP', emoji: '\u{1F4C2}' }),
		]);
		expect(harness.sessions[0].groupId).toBeUndefined();
		expect(harness.sessions[1].groupId).toBe('group-other');
	});
});
