import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session } from '../../../../renderer/types';

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

function createHarness(initialSessions: Session[] = [makeSession()]) {
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
		maestro().fs.readFile.mockResolvedValue('file contents');
		maestro().fs.stat.mockResolvedValue({ modifiedAt: '2026-06-18T10:00:00.000Z' });
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

	it('creates, renames, deletes, and moves groups from remote events', () => {
		const harness = createHarness([makeSession({ groupId: 'group-old' })]);

		dispatch('maestro:remoteCreateGroup', {
			name: ' launch ',
			emoji: '*',
			responseChannel: 'create-group-response',
		});
		const createdGroupId = harness.groups[0].id;
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
		expect(harness.groups).toEqual([]);
		expect(harness.sessions[0].groupId).toBeUndefined();
	});
});
