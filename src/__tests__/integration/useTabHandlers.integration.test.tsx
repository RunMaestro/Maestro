/**
 * @file useTabHandlers.integration.test.tsx
 * @description Integration tests for tab handler workflows across stores and IPC boundaries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTabHandlers } from '../../renderer/hooks/tabs/useTabHandlers';
import { useModalStore } from '../../renderer/stores/modalStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { logger } from '../../renderer/utils/logger';
import { captureException } from '../../renderer/utils/sentry';
import type { AITab, FilePreviewTab, LogEntry, Session } from '../../renderer/types';

const mockEndInlineWizard = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../renderer/contexts/InlineWizardContext', () => ({
	useInlineWizardContext: () => ({
		endWizard: mockEndInlineWizard,
	}),
}));

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

function aiTab(overrides: Partial<AITab> = {}): AITab {
	const id = overrides.id ?? 'ai-tab';
	return {
		id,
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1000,
		state: 'idle',
		hasUnread: false,
		isAtBottom: true,
		saveToHistory: true,
		showThinking: 'off',
		...overrides,
	};
}

function fileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	const id = overrides.id ?? 'file-tab';
	const path = overrides.path ?? `/repo/${id}.md`;
	const name =
		overrides.name ??
		path
			.split('/')
			.pop()!
			.replace(/\.[^.]+$/, '');
	return {
		id,
		path,
		name,
		extension: overrides.extension ?? '.md',
		content: overrides.content ?? `${name} content`,
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: 1000,
		lastModified: 1000,
		isLoading: false,
		navigationHistory: [{ path, name, scrollTop: 0 }],
		navigationIndex: 0,
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	const aiTabs = overrides.aiTabs ?? [aiTab({ id: 'ai-a' })];
	const filePreviewTabs = overrides.filePreviewTabs ?? [];
	const unifiedTabOrder = overrides.unifiedTabOrder ?? [
		...aiTabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		...filePreviewTabs.map((tab) => ({ type: 'file' as const, id: tab.id })),
	];

	return {
		id: overrides.id ?? 'session-a',
		name: 'Integration Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		createdAt: 1000,
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
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs,
		activeTabId: overrides.activeTabId ?? aiTabs[0]?.id ?? '',
		closedTabHistory: [],
		filePreviewTabs,
		activeFileTabId: overrides.activeFileTabId ?? null,
		unifiedTabOrder,
		unifiedClosedTabHistory: [],
		...overrides,
	};
}

function setActiveSession(nextSession: Session) {
	useSessionStore.setState({
		sessions: [nextSession],
		activeSessionId: nextSession.id,
		groups: [],
	});
}

function activeSession(): Session {
	const state = useSessionStore.getState();
	return state.sessions.find((item) => item.id === state.activeSessionId)!;
}

function renderHandlers(initialSession: Session) {
	const hook = renderHook(() => useTabHandlers());
	act(() => setActiveSession(initialSession));
	return hook;
}

function logEntry(id: string, source: LogEntry['source'], text: string): LogEntry {
	return { id, source, text, timestamp: 1000 };
}

describe('useTabHandlers integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSessionStore.setState({
			sessions: [],
			activeSessionId: '',
			groups: [],
			sessionsLoaded: false,
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
			cyclePosition: -1,
		});
		useModalStore.setState({ modals: new Map() });
		useSettingsStore.setState({
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
			fileTabAutoRefreshEnabled: false,
		});
		vi.mocked(window.maestro.fs.readFile).mockImplementation(
			async (path: string) => `disk:${path}`
		);
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			size: 100,
			createdAt: '2026-05-01T00:00:00.000Z',
			modifiedAt: '2026-05-01T00:00:00.000Z',
		});
		(window.maestro.claude as any).deleteMessagePair = vi.fn().mockResolvedValue({ success: true });
	});

	afterEach(() => {
		cleanup();
	});

	it('opens, replaces, navigates, edits, and confirms closing a file tab', async () => {
		const ai = aiTab({ id: 'ai-a' });
		const { result } = renderHandlers(session({ aiTabs: [ai] }));

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/docs/alpha.md',
				name: 'alpha.md',
				content: 'alpha from tree',
				lastModified: 1000,
			});
		});

		const openedFileId = activeSession().activeFileTabId!;
		expect(result.current.activeFileTab?.path).toBe('/repo/docs/alpha.md');
		expect(result.current.unifiedTabs.map((tab) => tab.type)).toEqual(['ai', 'file']);

		act(() => result.current.handleFileTabScrollPositionChange(openedFileId, 40));
		act(() => {
			result.current.handleOpenFileTab(
				{ path: '/repo/docs/beta.md', name: 'beta.md', content: 'beta from jump' },
				{ openInNewTab: false }
			);
		});
		act(() => {
			result.current.handleOpenFileTab(
				{ path: '/repo/docs/gamma.md', name: 'gamma.md', content: 'gamma from jump' },
				{ openInNewTab: false }
			);
		});

		expect(result.current.fileTabCanGoBack).toBe(true);
		expect(result.current.activeFileTabNavIndex).toBe(2);

		await act(async () => result.current.handleFileTabNavigateBack());
		expect(activeSession().filePreviewTabs[0]).toMatchObject({
			path: '/repo/docs/beta.md',
			content: 'disk:/repo/docs/beta.md',
			navigationIndex: 1,
		});

		await act(async () => result.current.handleFileTabNavigateToIndex(0));
		expect(activeSession().filePreviewTabs[0]).toMatchObject({
			path: '/repo/docs/alpha.md',
			scrollTop: 40,
			navigationIndex: 0,
		});

		await act(async () => result.current.handleFileTabNavigateForward());
		expect(activeSession().filePreviewTabs[0]).toMatchObject({
			path: '/repo/docs/beta.md',
			navigationIndex: 1,
		});

		act(() => result.current.handleFileTabEditModeChange(openedFileId, true));
		act(() => result.current.handleFileTabEditContentChange(openedFileId, 'unsaved draft'));
		act(() => result.current.handleFileTabSearchQueryChange(openedFileId, 'needle'));
		expect(activeSession().filePreviewTabs[0]).toMatchObject({
			editMode: true,
			editContent: 'unsaved draft',
			searchQuery: 'needle',
		});

		act(() => result.current.handleCloseFileTab(openedFileId));
		expect(useModalStore.getState().isOpen('confirm')).toBe(true);
		expect(activeSession().filePreviewTabs).toHaveLength(1);

		act(() => useModalStore.getState().getData('confirm')!.onConfirm());
		expect(activeSession().filePreviewTabs).toHaveLength(0);
		expect(activeSession().activeFileTabId).toBeNull();
	});

	it('selects and reloads file tabs through IPC-backed freshness checks', async () => {
		const preview = fileTab({
			id: 'file-a',
			path: '/repo/src/App.tsx',
			name: 'App',
			extension: '.tsx',
			content: 'stale app',
			lastModified: 1000,
		});
		const { result } = renderHandlers(
			session({
				aiTabs: [aiTab({ id: 'ai-a' })],
				filePreviewTabs: [preview],
				activeTabId: 'ai-a',
				activeFileTabId: null,
			})
		);
		useSettingsStore.setState({ fileTabAutoRefreshEnabled: true });
		vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
			size: 128,
			createdAt: '2026-05-01T00:00:00.000Z',
			modifiedAt: '2026-05-02T00:00:00.000Z',
		});
		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('fresh app');

		await act(async () => result.current.handleSelectFileTab('file-a'));
		expect(activeSession().activeFileTabId).toBe('file-a');
		expect(activeSession().filePreviewTabs[0].content).toBe('fresh app');

		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('reloaded app');
		vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
			size: 256,
			createdAt: '2026-05-01T00:00:00.000Z',
			modifiedAt: '2026-05-03T00:00:00.000Z',
		});

		await act(async () => result.current.handleReloadFileTab('file-a'));
		expect(activeSession().filePreviewTabs[0]).toMatchObject({
			content: 'reloaded app',
			editContent: undefined,
		});
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/src/App.tsx', undefined);

		act(() => result.current.handleClearFilePreviewHistory());
		expect(activeSession()).toMatchObject({
			filePreviewHistory: [],
			filePreviewHistoryIndex: -1,
		});
	});

	it('coordinates AI tab creation, rename, star persistence, and per-tab flags', async () => {
		const alpha = aiTab({
			id: 'ai-alpha',
			agentSessionId: 'claude-alpha',
			name: 'Alpha',
			isGeneratingName: true,
			logs: [
				logEntry('thinking-a', 'thinking', 'thinking'),
				logEntry('tool-a', 'tool', 'tool call'),
				logEntry('ai-a', 'ai', 'answer'),
			],
		});
		const beta = aiTab({ id: 'ai-beta', inputValue: 'draft prompt' });
		const { result } = renderHandlers(session({ aiTabs: [alpha, beta], activeTabId: alpha.id }));
		useSettingsStore.setState({ defaultSaveToHistory: false, defaultShowThinking: 'sticky' });

		act(() => useModalStore.getState().openModal('agentSessions', { activeAgentSessionId: null }));
		act(() => result.current.handleNewAgentSession());
		expect(useModalStore.getState().isOpen('agentSessions')).toBe(false);
		const created = activeSession().aiTabs.at(-1)!;
		expect(created).toMatchObject({ saveToHistory: false, showThinking: 'sticky' });

		act(() => result.current.handleTabSelect(alpha.id));
		expect(activeSession().activeTabId).toBe(alpha.id);

		act(() => result.current.handleRequestTabRename(alpha.id));
		expect(useModalStore.getState().getData('renameTab')).toEqual({
			tabId: alpha.id,
			initialName: 'Alpha',
		});
		expect(activeSession().aiTabs.find((tab) => tab.id === alpha.id)?.isGeneratingName).toBe(false);

		act(() => result.current.handleUpdateTabByClaudeSessionId('claude-alpha', { name: 'Renamed' }));
		expect(activeSession().aiTabs.find((tab) => tab.id === alpha.id)?.name).toBe('Renamed');

		act(() => result.current.handleTabStar(alpha.id, true));
		expect(activeSession().aiTabs.find((tab) => tab.id === alpha.id)?.starred).toBe(true);
		expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
			'/repo',
			'claude-alpha',
			true
		);

		act(() => result.current.handleToggleTabReadOnlyMode());
		act(() => result.current.handleToggleTabSaveToHistory());
		act(() => result.current.handleToggleTabShowThinking());
		act(() => result.current.handleToggleTabShowThinking());
		act(() => result.current.handleToggleTabShowThinking());
		act(() => result.current.handleTabMarkUnread(alpha.id));
		act(() => result.current.handleAtBottomChange(true));
		act(() => result.current.handleScrollPositionChange(88));

		const updatedAlpha = activeSession().aiTabs.find((tab) => tab.id === alpha.id)!;
		expect(updatedAlpha).toMatchObject({
			readOnlyMode: true,
			saveToHistory: false,
			showThinking: 'off',
			hasUnread: false,
			scrollTop: 88,
		});
		expect(updatedAlpha.logs.map((log) => log.source)).toEqual(['ai']);

		await Promise.resolve();
	});

	it('routes mixed tab close commands through confirmation state and unified ordering', () => {
		const left = aiTab({ id: 'ai-left' });
		const draft = aiTab({ id: 'ai-draft', inputValue: 'keep me honest' });
		const right = aiTab({ id: 'ai-right' });
		const fileA = fileTab({ id: 'file-a', path: '/repo/a.md', name: 'a' });
		const fileB = fileTab({ id: 'file-b', path: '/repo/b.md', name: 'b' });
		const { result } = renderHandlers(
			session({
				aiTabs: [left, draft, right],
				filePreviewTabs: [fileA, fileB],
				activeTabId: right.id,
				activeFileTabId: fileB.id,
				unifiedTabOrder: [
					{ type: 'ai', id: left.id },
					{ type: 'file', id: fileA.id },
					{ type: 'ai', id: draft.id },
					{ type: 'file', id: fileB.id },
					{ type: 'ai', id: right.id },
				],
			})
		);

		act(() => result.current.handleCloseOtherTabs());
		expect(useModalStore.getState().isOpen('confirm')).toBe(false);
		expect(activeSession().filePreviewTabs.map((tab) => tab.id)).toEqual([fileB.id]);
		expect(activeSession().aiTabs.map((tab) => tab.id)).toEqual([draft.id]);
		expect(activeSession().aiTabs[0]).toMatchObject({ inputValue: 'keep me honest' });
		expect(activeSession().unifiedTabOrder.map((tab) => tab.id)).toEqual([draft.id, fileB.id]);

		act(() =>
			setActiveSession(
				session({
					aiTabs: [left, draft, right],
					filePreviewTabs: [fileA, fileB],
					activeTabId: draft.id,
					activeFileTabId: null,
					unifiedTabOrder: [
						{ type: 'ai', id: left.id },
						{ type: 'file', id: fileA.id },
						{ type: 'ai', id: draft.id },
						{ type: 'file', id: fileB.id },
						{ type: 'ai', id: right.id },
					],
				})
			)
		);

		act(() => result.current.handleCloseTabsLeft());
		expect(activeSession().aiTabs.map((tab) => tab.id)).toEqual([draft.id, right.id]);
		expect(activeSession().filePreviewTabs.map((tab) => tab.id)).toEqual([fileB.id]);

		act(() => result.current.handleCloseTabsRight());
		expect(activeSession().aiTabs.map((tab) => tab.id)).toEqual([draft.id]);
		expect(activeSession().filePreviewTabs).toHaveLength(0);
		expect(result.current.handleCloseCurrentTab()).toMatchObject({
			type: 'ai',
			tabId: draft.id,
			hasDraft: true,
		});
	});

	it('deletes AI and terminal command groups while updating persisted histories', async () => {
		const ai = aiTab({
			id: 'ai-a',
			agentSessionId: 'claude-a',
			logs: [
				logEntry('u1', 'user', 'first command'),
				logEntry('think1', 'thinking', 'thinking'),
				logEntry('answer1', 'ai', 'answer'),
				logEntry('u2', 'user', 'second command'),
				logEntry('answer2', 'ai', 'second answer'),
			],
		});
		const { result } = renderHandlers(
			session({
				aiTabs: [ai],
				activeTabId: ai.id,
				aiCommandHistory: ['first command', 'second command'],
			})
		);

		let nextIndex: number | null = null;
		act(() => {
			nextIndex = result.current.handleDeleteLog('u1');
		});

		expect(nextIndex).toBe(0);
		expect(activeSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['u2', 'answer2']);
		expect(activeSession().aiCommandHistory).toEqual(['second command']);
		expect((window.maestro.claude as any).deleteMessagePair).toHaveBeenCalledWith(
			'/repo',
			'claude-a',
			'u1',
			'first command'
		);

		act(() =>
			useSessionStore.getState().setSessions((prev) =>
				prev.map((item) =>
					item.id === activeSession().id
						? {
								...item,
								inputMode: 'terminal',
								shellLogs: [
									logEntry('s1', 'user', 'ls'),
									logEntry('sout', 'stdout', 'file.txt'),
									logEntry('s2', 'user', 'pwd'),
								],
								shellCommandHistory: ['ls', 'pwd'],
							}
						: item
				)
			)
		);

		act(() => {
			nextIndex = result.current.handleDeleteLog('s1');
		});

		expect(nextIndex).toBe(0);
		expect(activeSession().shellLogs.map((log) => log.id)).toEqual(['s2']);
		expect(activeSession().shellCommandHistory).toEqual(['pwd']);
		await Promise.resolve();
	});

	it('handles duplicate and adjacent file tabs plus reload and select guard paths', async () => {
		const fileA = fileTab({
			id: 'file-a',
			path: '/repo/a.md',
			name: 'a',
			content: 'old a',
			navigationHistory: [
				{ path: '/repo/a.md', name: 'a', scrollTop: 0 },
				{ path: '/repo/b.md', name: 'b', scrollTop: 10 },
			],
			navigationIndex: 0,
		});
		const { result } = renderHandlers(
			session({
				aiTabs: [aiTab({ id: 'ai-a' })],
				filePreviewTabs: [fileA],
				activeFileTabId: fileA.id,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-a' },
					{ type: 'file', id: fileA.id },
				],
			})
		);

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/a.md',
				name: 'a.md',
				content: 'updated a',
				lastModified: 2000,
			});
		});
		expect(activeSession().filePreviewTabs[0]).toMatchObject({
			content: 'updated a',
			lastModified: 2000,
		});

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/c.md',
				name: 'c.md',
				content: 'new c',
			});
		});
		const newFileId = activeSession().activeFileTabId!;
		expect(activeSession().unifiedTabOrder.map((ref) => ref.id)).toEqual([
			'ai-a',
			'file-a',
			newFileId,
		]);

		act(() => result.current.handleFileTabEditContentChange(newFileId, undefined, 'saved c'));
		expect(activeSession().filePreviewTabs.find((tab) => tab.id === newFileId)).toMatchObject({
			content: 'saved c',
			editContent: undefined,
		});

		await act(async () => result.current.handleReloadFileTab('missing-file'));
		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce(null);
		await act(async () => result.current.handleReloadFileTab(newFileId));
		expect(activeSession().filePreviewTabs.find((tab) => tab.id === newFileId)?.content).toBe(
			'saved c'
		);

		const debugSpy = vi.mocked(logger.debug);
		vi.mocked(window.maestro.fs.readFile).mockRejectedValueOnce(new Error('disk unavailable'));
		await act(async () => result.current.handleReloadFileTab(newFileId));
		expect(debugSpy).toHaveBeenCalledWith(
			'[handleReloadFileTab] Failed to reload:',
			undefined,
			expect.any(Error)
		);
		debugSpy.mockClear();

		await act(async () => result.current.handleSelectFileTab('missing-file'));
		expect(activeSession().activeFileTabId).toBe(newFileId);
	});

	it('covers AI tab close confirmations, current-tab returns, reorders, and non-Claude star persistence', async () => {
		const wizard = aiTab({ id: 'wizard', wizardState: { isActive: true } as AITab['wizardState'] });
		const draft = aiTab({ id: 'draft', inputValue: 'draft prompt' });
		const plain = aiTab({ id: 'plain', agentSessionId: 'codex-plain', name: 'Plain' });
		const fileA = fileTab({ id: 'file-a', path: '/repo/a.md', name: 'a' });
		const { result } = renderHandlers(
			session({
				toolType: 'codex',
				aiTabs: [wizard, draft, plain],
				activeTabId: plain.id,
				filePreviewTabs: [fileA],
				activeFileTabId: fileA.id,
				unifiedTabOrder: [
					{ type: 'ai', id: wizard.id },
					{ type: 'ai', id: draft.id },
					{ type: 'file', id: fileA.id },
					{ type: 'ai', id: plain.id },
				],
			})
		);

		act(() => result.current.handleTabClose(wizard.id));
		expect(useModalStore.getState().isOpen('confirm')).toBe(false);
		expect(activeSession().aiTabs.some((tab) => tab.id === wizard.id)).toBe(false);
		expect(mockEndInlineWizard).toHaveBeenCalledWith(wizard.id);

		act(() => result.current.handleTabClose(draft.id));
		expect(useModalStore.getState().getData('confirm')?.message).toContain('unsent draft');

		act(() => result.current.handleUnifiedTabReorder(-1, 1));
		expect(activeSession().unifiedTabOrder.map((ref) => ref.id)).toContain(fileA.id);
		act(() => result.current.handleUnifiedTabReorder(1, 0));
		expect(activeSession().unifiedTabOrder[0].id).toBe(fileA.id);

		let closeCurrentResult: ReturnType<typeof result.current.handleCloseCurrentTab> | undefined;
		act(() => {
			closeCurrentResult = result.current.handleCloseCurrentTab();
		});
		expect(closeCurrentResult).toEqual({ type: 'file', tabId: fileA.id });
		expect(activeSession().activeFileTabId).toBeNull();

		act(() => result.current.handleTabSelect(plain.id));
		expect(result.current.handleCloseCurrentTab()).toMatchObject({
			type: 'ai',
			tabId: plain.id,
			isWizardTab: false,
			hasDraft: false,
		});

		act(() => result.current.handleTabReorder(1, 0));
		expect(activeSession().aiTabs[0].id).toBe(plain.id);

		act(() => result.current.handleTabStar(plain.id, true));
		expect(window.maestro.agentSessions.setSessionStarred).toHaveBeenCalledWith(
			'codex',
			'/repo',
			'codex-plain',
			true
		);

		act(() => result.current.handleRequestTabRename('missing-tab'));
		expect(useModalStore.getState().isOpen('renameTab')).toBe(false);
	});

	it('covers scroll state, read-state guards, and delete-log failure branches', async () => {
		const warnSpy = vi.mocked(logger.warn);
		const errorSpy = vi.mocked(logger.error);
		const ai = aiTab({
			id: 'ai-a',
			agentSessionId: 'claude-a',
			hasUnread: true,
			logs: [
				logEntry('ai-only', 'ai', 'answer'),
				logEntry('u1', 'user', 'delete me'),
				logEntry('answer1', 'ai', 'answer'),
			],
		});
		const { result } = renderHandlers(
			session({
				aiTabs: [ai],
				activeTabId: ai.id,
				aiCommandHistory: ['delete me'],
			})
		);

		expect(result.current.handleDeleteLog('missing-log')).toBeNull();
		expect(result.current.handleDeleteLog('ai-only')).toBeNull();

		(window.maestro.claude as any).deleteMessagePair.mockResolvedValueOnce({
			success: false,
			error: 'delete failed',
		});
		act(() => {
			result.current.handleDeleteLog('u1');
		});
		await Promise.resolve();
		expect(warnSpy).toHaveBeenCalledWith(
			'[handleDeleteLog] Failed to delete from Claude session:',
			undefined,
			'delete failed'
		);

		act(() => result.current.handleTabMarkUnread(ai.id));
		act(() => result.current.handleAtBottomChange(false));
		expect(activeSession().aiTabs[0].hasUnread).toBe(true);

		act(() =>
			useSessionStore.getState().setSessions((prev) =>
				prev.map((item) =>
					item.id === activeSession().id
						? {
								...item,
								inputMode: 'terminal',
							}
						: item
				)
			)
		);
		act(() => result.current.handleScrollPositionChange(123));
		expect(activeSession().terminalScrollTop).toBe(123);

		(window.maestro.claude as any).deleteMessagePair.mockRejectedValueOnce(new Error('boom'));
		act(() =>
			useSessionStore.getState().setSessions((prev) =>
				prev.map((item) =>
					item.id === activeSession().id
						? {
								...item,
								inputMode: 'ai',
								aiCommandHistory: ['delete again'],
								aiTabs: [
									{
										...item.aiTabs[0],
										logs: [logEntry('u2', 'user', 'delete again')],
									},
								],
							}
						: item
				)
			)
		);
		act(() => {
			result.current.handleDeleteLog('u2');
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(errorSpy).toHaveBeenCalledWith(
			'[handleDeleteLog] Error deleting from Claude session:',
			undefined,
			expect.any(Error)
		);

		warnSpy.mockClear();
		errorSpy.mockClear();
	});

	it('covers multi-session updates, close-all flows, and missing active-session guards', async () => {
		const active = session({
			id: 'active-session',
			aiTabs: [
				aiTab({ id: 'ai-a', agentSessionId: 'claude-a' }),
				aiTab({ id: 'ai-b', wizardState: { isActive: true } as AITab['wizardState'] }),
			],
			activeTabId: 'ai-a',
			filePreviewTabs: [fileTab({ id: 'file-a', path: '/repo/a.md', name: 'a' })],
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-a' },
				{ type: 'file', id: 'file-a' },
				{ type: 'ai', id: 'ai-b' },
			],
		});
		const other = session({
			id: 'other-session',
			aiTabs: [aiTab({ id: 'other-ai' })],
			activeTabId: 'other-ai',
		});
		const hook = renderHook(() => useTabHandlers());
		act(() => {
			useSessionStore.setState({
				sessions: [active, other],
				activeSessionId: active.id,
				groups: [],
			});
		});

		act(() => hook.result.current.handleNewAgentSession());
		act(() => hook.result.current.handleNewTab());
		act(() => hook.result.current.handleTabSelect('ai-b'));
		act(() => {
			hook.result.current.handleOpenFileTab({
				path: '/repo/new.md',
				name: 'new.md',
				content: 'new content',
			});
		});
		await act(async () => hook.result.current.handleReloadFileTab('file-a'));

		const beforeCloseAll = activeSession();
		expect(beforeCloseAll.aiTabs.length).toBeGreaterThan(2);
		expect(
			useSessionStore.getState().sessions.find((item) => item.id === other.id)?.aiTabs[0].id
		).toBe('other-ai');

		act(() => hook.result.current.handleCloseAllTabs());
		expect(activeSession().aiTabs).toHaveLength(1);

		act(() => {
			useSessionStore.setState({ activeSessionId: 'missing-session' });
		});
		expect(hook.result.current.handleCloseCurrentTab()).toEqual({
			type: 'file',
			tabId: 'file-a',
		});
		expect(hook.result.current.handleDeleteLog('missing')).toBeNull();
		act(() => hook.result.current.handleNewAgentSession());
		act(() => hook.result.current.handleCloseAllTabs());
		act(() => hook.result.current.handleCloseOtherTabs());
		act(() => hook.result.current.handleCloseTabsLeft());
		act(() => hook.result.current.handleCloseTabsRight());
		act(() => hook.result.current.handleRequestTabRename('missing'));
		act(() => hook.result.current.handleTabStar('missing', true));
		act(() => hook.result.current.handleToggleTabReadOnlyMode());
		act(() => hook.result.current.handleToggleTabSaveToHistory());
		act(() => hook.result.current.handleToggleTabShowThinking());
		act(() => hook.result.current.handleScrollPositionChange(10));
		act(() => hook.result.current.handleAtBottomChange(false));
		act(() => hook.result.current.handleClearFilePreviewHistory());
		await act(async () => hook.result.current.handleFileTabNavigateBack());
		await act(async () => hook.result.current.handleFileTabNavigateForward());
		await act(async () => hook.result.current.handleFileTabNavigateToIndex(0));
	});

	it('covers file-tab replacement history, insertion fallback, and auto-refresh edges', async () => {
		const fileA = fileTab({
			id: 'file-a',
			path: '/repo/a',
			name: 'a',
			extension: '',
			navigationHistory: [],
			navigationIndex: -1,
		});
		const fileB = fileTab({ id: 'file-b', path: '/repo/b.md', name: 'b' });
		const { result } = renderHandlers(
			session({
				aiTabs: [aiTab({ id: 'ai-a' })],
				filePreviewTabs: [fileA, fileB],
				activeFileTabId: fileA.id,
				unifiedTabOrder: [{ type: 'ai', id: 'ai-a' }],
			})
		);

		act(() => {
			result.current.handleOpenFileTab(
				{ path: '/repo/replaced.ts', name: 'replaced.ts', content: 'replacement' },
				{ openInNewTab: false }
			);
		});
		expect(activeSession().filePreviewTabs.find((tab) => tab.id === fileA.id)).toMatchObject({
			path: '/repo/replaced.ts',
			name: 'replaced',
			extension: '.ts',
			navigationHistory: [
				{ path: '/repo/a', name: 'a', scrollTop: 0 },
				{ path: '/repo/replaced.ts', name: 'replaced', scrollTop: 0 },
			],
			navigationIndex: 1,
		});
		expect(activeSession().filePreviewTabs.find((tab) => tab.id === fileB.id)?.path).toBe(
			'/repo/b.md'
		);

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/fallback.txt',
				name: 'fallback.txt',
				content: 'fallback',
			});
		});
		const fallbackId = activeSession().activeFileTabId!;
		expect(activeSession().unifiedTabOrder.at(-1)).toEqual({ type: 'file', id: fallbackId });

		useSettingsStore.setState({ fileTabAutoRefreshEnabled: true });
		vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce(null);
		await act(async () => result.current.handleSelectFileTab(fallbackId));

		vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
			size: 1,
			createdAt: '2026-05-01T00:00:00.000Z',
			modifiedAt: undefined as unknown as string,
		});
		await act(async () => result.current.handleSelectFileTab(fallbackId));

		vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
			size: 1,
			createdAt: '2026-05-01T00:00:00.000Z',
			modifiedAt: '2026-04-01T00:00:00.000Z',
		});
		await act(async () => result.current.handleSelectFileTab(fallbackId));

		vi.mocked(window.maestro.fs.stat).mockImplementation(async (path: string) => ({
			size: 1,
			createdAt: '2026-05-01T00:00:00.000Z',
			modifiedAt: path === cleanFile.path ? '2026-06-01T00:00:00.000Z' : '2026-05-01T00:00:00.000Z',
		}));
		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce(null);
		await act(async () => result.current.handleSelectFileTab(fallbackId));

		const debugSpy = vi.mocked(logger.debug);
		vi.mocked(window.maestro.fs.stat).mockRejectedValueOnce(new Error('stat failed'));
		await act(async () => result.current.handleSelectFileTab(fallbackId));
		expect(debugSpy).toHaveBeenCalledWith(
			'[handleSelectFileTab] Auto-refresh failed:',
			undefined,
			expect.any(Error)
		);
		debugSpy.mockClear();
	});

	it('covers tab close confirmations, range guards, and tab property guard branches', () => {
		const draft = aiTab({ id: 'draft', inputValue: 'draft text' });
		const plain = aiTab({ id: 'plain', agentSessionId: null });
		const fileA = fileTab({ id: 'file-a' });
		const { result } = renderHandlers(
			session({
				toolType: 'opencode',
				aiTabs: [draft, plain],
				activeTabId: draft.id,
				filePreviewTabs: [fileA],
				activeFileTabId: null,
				unifiedTabOrder: [
					{ type: 'ai', id: draft.id },
					{ type: 'file', id: fileA.id },
					{ type: 'ai', id: plain.id },
				],
			})
		);

		act(() => result.current.handleCloseAllTabs());
		expect(useModalStore.getState().getData('confirm')?.message).toContain('close all tabs');
		act(() => useModalStore.getState().getData('confirm')!.onConfirm());
		expect(activeSession().aiTabs).toHaveLength(1);

		act(() => result.current.performTabClose('missing-tab'));
		expect(activeSession().aiTabs).toHaveLength(1);

		act(() => result.current.handleCloseFileTab('missing-file'));
		expect(activeSession().filePreviewTabs).toHaveLength(1);

		act(() =>
			setActiveSession(
				session({
					toolType: 'opencode',
					aiTabs: [plain],
					activeTabId: plain.id,
					filePreviewTabs: [fileA],
					activeFileTabId: null,
					unifiedTabOrder: [
						{ type: 'ai', id: plain.id },
						{ type: 'file', id: fileA.id },
					],
				})
			)
		);
		act(() => result.current.handleCloseTabsLeft());
		expect(activeSession().filePreviewTabs).toHaveLength(1);

		act(() =>
			setActiveSession(
				session({
					toolType: 'opencode',
					aiTabs: [plain],
					activeTabId: plain.id,
					filePreviewTabs: [],
					activeFileTabId: null,
					unifiedTabOrder: [{ type: 'ai', id: plain.id }],
				})
			)
		);
		act(() => result.current.handleCloseTabsRight());
		expect(activeSession().aiTabs).toHaveLength(1);

		act(() =>
			result.current.handleUpdateTabByClaudeSessionId('missing-session-id', { starred: true })
		);
		act(() => result.current.handleTabStar('plain', true));
		expect(window.maestro.agentSessions.setSessionStarred).not.toHaveBeenCalled();

		act(() =>
			useSessionStore
				.getState()
				.setSessions((prev) =>
					prev.map((item) =>
						item.id === activeSession().id
							? { ...item, activeTabId: 'not-present', activeFileTabId: null }
							: item
					)
				)
		);
		act(() => result.current.handleToggleTabReadOnlyMode());
		act(() => result.current.handleToggleTabSaveToHistory());
		act(() => result.current.handleToggleTabShowThinking());
		act(() => result.current.handleScrollPositionChange(44));
		act(() => result.current.handleAtBottomChange(true));
		expect(activeSession().aiTabs[0].id).toBeTruthy();
	});

	it('covers inactive-session updates, close callbacks, and persistence failures', async () => {
		const other = session({ id: 'other-session', aiTabs: [aiTab({ id: 'other-ai' })] });
		const aiA = aiTab({
			id: 'ai-a',
			agentSessionId: 'claude-a',
			name: 'Alpha',
			isGeneratingName: true,
			logs: [
				logEntry('u1', 'user', 'one'),
				logEntry('a1', 'ai', 'answer one'),
				logEntry('u2', 'user', 'two'),
				logEntry('a2', 'ai', 'answer two'),
				logEntry('u3', 'user', 'three'),
				logEntry('a3', 'ai', 'answer three'),
			],
		});
		const aiB = aiTab({ id: 'ai-b', inputValue: 'draft right' });
		const fileA = fileTab({
			id: 'file-a',
			path: '/repo/b.md',
			name: 'b',
			navigationHistory: [
				{ path: '/repo/a.md', name: 'a', scrollTop: 1 },
				{ path: '/repo/b.md', name: 'b', scrollTop: 2 },
				{ path: '/repo/c.md', name: 'c', scrollTop: 3 },
			],
			navigationIndex: 1,
		});
		const fileB = fileTab({ id: 'file-b', path: '/repo/other.md', name: 'other' });
		const hook = renderHook(() => useTabHandlers());
		const setDualSession = (next: Session) => {
			useSessionStore.setState({
				sessions: [next, other],
				activeSessionId: next.id,
				groups: [],
			});
		};

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA, aiB],
					activeTabId: aiA.id,
					filePreviewTabs: [fileA, fileB],
					activeFileTabId: fileA.id,
					unifiedTabOrder: [
						{ type: 'ai', id: aiA.id },
						{ type: 'file', id: fileA.id },
						{ type: 'file', id: fileB.id },
						{ type: 'ai', id: aiB.id },
					],
				})
			)
		);

		act(() => hook.result.current.handleFileTabEditModeChange(fileA.id, true));
		act(() => hook.result.current.handleFileTabEditContentChange(fileA.id, 'draft'));
		act(() => hook.result.current.handleFileTabScrollPositionChange(fileA.id, 77));
		act(() => hook.result.current.handleFileTabSearchQueryChange(fileA.id, 'needle'));
		expect(activeSession().filePreviewTabs.find((tab) => tab.id === fileA.id)).toMatchObject({
			editMode: true,
			editContent: 'draft',
			scrollTop: 77,
			searchQuery: 'needle',
		});

		act(() => hook.result.current.handleUnifiedTabReorder(0, 1));
		expect(activeSession().unifiedTabOrder[1]).toEqual({ type: 'ai', id: aiA.id });

		act(() => hook.result.current.handleRequestTabRename(aiA.id));
		expect(activeSession().aiTabs.find((tab) => tab.id === aiA.id)?.isGeneratingName).toBe(false);
		act(() => hook.result.current.handleTabReorder(1, 0));
		expect(activeSession().aiTabs[0].id).toBe(aiB.id);
		act(() =>
			hook.result.current.handleUpdateTabByClaudeSessionId('claude-a', { name: 'Updated' })
		);
		expect(activeSession().aiTabs.find((tab) => tab.id === aiA.id)?.name).toBe('Updated');
		act(() => hook.result.current.handleTabMarkUnread(aiA.id));
		expect(activeSession().aiTabs.find((tab) => tab.id === aiA.id)?.hasUnread).toBe(true);

		act(() => hook.result.current.handleToggleTabReadOnlyMode());
		act(() => hook.result.current.handleToggleTabSaveToHistory());
		act(() => hook.result.current.handleToggleTabShowThinking());
		act(() => hook.result.current.handleScrollPositionChange(222));
		act(() => hook.result.current.handleAtBottomChange(false));
		const toggled = activeSession().aiTabs.find((tab) => tab.id === activeSession().activeTabId)!;
		expect(toggled).toMatchObject({
			readOnlyMode: true,
			saveToHistory: false,
			showThinking: 'on',
			scrollTop: 222,
		});

		act(() => hook.result.current.handleTabClose(aiB.id));
		expect(useModalStore.getState().getData('confirm')?.message).toContain('unsent draft');
		act(() => useModalStore.getState().getData('confirm')!.onConfirm());
		expect(activeSession().aiTabs.some((tab) => tab.id === aiB.id)).toBe(false);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA, aiB],
					activeTabId: aiA.id,
					filePreviewTabs: [fileA],
					activeFileTabId: null,
					unifiedTabOrder: [
						{ type: 'ai', id: aiA.id },
						{ type: 'file', id: fileA.id },
						{ type: 'ai', id: aiB.id },
					],
				})
			)
		);
		act(() => hook.result.current.handleTabClose(aiA.id));
		expect(activeSession().aiTabs.some((tab) => tab.id === aiA.id)).toBe(false);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA],
					activeTabId: aiA.id,
					filePreviewTabs: [],
					activeFileTabId: 'missing-file',
				})
			)
		);
		expect(hook.result.current.handleCloseCurrentTab()).toEqual({
			type: 'file',
			tabId: 'missing-file',
		});

		vi.mocked(window.maestro.claude.updateSessionStarred).mockRejectedValueOnce(
			new Error('claude persist failed')
		);
		act(() => hook.result.current.handleTabStar(aiA.id, true));
		await Promise.resolve();
		await Promise.resolve();
		expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
			'/repo',
			'claude-a',
			true
		);
		expect(captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({
				extra: expect.objectContaining({
					agentType: 'claude-code',
					operation: 'persist-tab-starred',
				}),
			})
		);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					toolType: 'codex',
					aiTabs: [aiTab({ id: 'codex-a', agentSessionId: 'codex-a' })],
					activeTabId: 'codex-a',
				})
			)
		);
		vi.mocked(window.maestro.agentSessions.setSessionStarred).mockRejectedValueOnce(
			new Error('agent persist failed')
		);
		act(() => hook.result.current.handleTabStar('codex-a', true));
		await Promise.resolve();
		await Promise.resolve();
		expect(window.maestro.agentSessions.setSessionStarred).toHaveBeenCalledWith(
			'codex',
			'/repo',
			'codex-a',
			true
		);
		expect(captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({
				extra: expect.objectContaining({
					agentType: 'codex',
					operation: 'persist-tab-starred',
				}),
			})
		);
		vi.mocked(captureException).mockClear();

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [
						aiTab({ id: 'ai-prev' }),
						aiTab({
							id: 'ai-delete',
							logs: [
								logEntry('u1', 'user', 'one'),
								logEntry('a1', 'ai', 'answer one'),
								logEntry('u2', 'user', 'two'),
								logEntry('a2', 'ai', 'answer two'),
								logEntry('u3', 'user', 'three'),
							],
						}),
					],
					activeTabId: 'ai-delete',
					aiCommandHistory: ['one', 'two', 'three'],
				})
			)
		);
		let deletedIndex: number | null = null;
		act(() => {
			deletedIndex = hook.result.current.handleDeleteLog('u3');
		});
		expect(deletedIndex).toBe(2);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					inputMode: 'terminal',
					shellLogs: [
						logEntry('s1', 'user', 'one'),
						logEntry('out1', 'stdout', 'out'),
						logEntry('s2', 'user', 'two'),
					],
					shellCommandHistory: ['one', 'two'],
				})
			)
		);
		act(() => {
			deletedIndex = hook.result.current.handleDeleteLog('s1');
		});
		expect(deletedIndex).toBe(0);

		act(() => useSessionStore.setState({ activeSessionId: 'missing-session' }));
		await act(async () => hook.result.current.handleReloadFileTab(fileA.id));
		await act(async () => hook.result.current.handleSelectFileTab(fileA.id));
	});

	it('covers remaining no-op guards and close-range confirmation branches', async () => {
		const hook = renderHook(() => useTabHandlers());
		const other = session({ id: 'other-session', aiTabs: [aiTab({ id: 'other-ai' })] });
		const setDualSession = (next: Session) => {
			useSessionStore.setState({
				sessions: [next, other],
				activeSessionId: next.id,
				groups: [],
			});
		};
		const cleanFile = fileTab({ id: 'clean-file', editContent: undefined });
		const aiA = aiTab({ id: 'ai-a' });
		const aiB = aiTab({ id: 'ai-b' });
		const draft = aiTab({ id: 'draft', inputValue: 'draft' });

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA],
					activeTabId: aiA.id,
					filePreviewTabs: [cleanFile],
					activeFileTabId: cleanFile.id,
					unifiedTabOrder: [
						{ type: 'ai', id: aiA.id },
						{ type: 'file', id: cleanFile.id },
					],
				})
			)
		);
		act(() => hook.result.current.handleCloseFileTab(cleanFile.id));
		expect(activeSession().filePreviewTabs).toHaveLength(0);

		act(() => useSessionStore.setState({ activeSessionId: 'missing-session' }));
		act(() => hook.result.current.handleCloseFileTab('missing-file'));

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA],
					activeTabId: aiA.id,
					filePreviewTabs: [cleanFile],
					activeFileTabId: null,
				})
			)
		);
		await act(async () => hook.result.current.handleSelectFileTab(cleanFile.id));
		expect(activeSession().activeFileTabId).toBe(cleanFile.id);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA, aiB],
					activeTabId: aiA.id,
					filePreviewTabs: [cleanFile],
					activeFileTabId: null,
					unifiedTabOrder: [
						{ type: 'ai', id: aiA.id },
						{ type: 'file', id: cleanFile.id },
						{ type: 'ai', id: aiB.id },
					],
				})
			)
		);
		act(() => hook.result.current.handleCloseOtherTabs());
		expect(activeSession().aiTabs.map((tab) => tab.id)).toEqual([aiA.id]);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA, aiB],
					activeTabId: aiA.id,
					filePreviewTabs: [cleanFile],
					activeFileTabId: null,
					unifiedTabOrder: [
						{ type: 'ai', id: aiA.id },
						{ type: 'file', id: cleanFile.id },
						{ type: 'ai', id: aiB.id },
					],
				})
			)
		);
		act(() => hook.result.current.handleCloseTabsLeft());
		expect(activeSession().unifiedTabOrder).toHaveLength(3);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA, aiB],
					activeTabId: aiB.id,
					filePreviewTabs: [cleanFile],
					activeFileTabId: null,
					unifiedTabOrder: [
						{ type: 'ai', id: aiA.id },
						{ type: 'file', id: cleanFile.id },
						{ type: 'ai', id: aiB.id },
					],
				})
			)
		);
		act(() => hook.result.current.handleCloseTabsLeft());
		expect(activeSession().aiTabs.map((tab) => tab.id)).toEqual([aiB.id]);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [draft, aiB],
					activeTabId: aiB.id,
					unifiedTabOrder: [
						{ type: 'ai', id: draft.id },
						{ type: 'ai', id: aiB.id },
					],
				})
			)
		);
		act(() => hook.result.current.handleCloseTabsLeft());
		expect(useModalStore.getState().isOpen('confirm')).toBe(false);
		expect(activeSession().aiTabs.map((tab) => tab.id)).toEqual([draft.id, aiB.id]);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA],
					activeTabId: aiA.id,
					unifiedTabOrder: [{ type: 'ai', id: aiA.id }],
				})
			)
		);
		act(() => hook.result.current.handleCloseTabsRight());
		expect(activeSession().aiTabs).toHaveLength(1);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA, aiB],
					activeTabId: aiA.id,
					unifiedTabOrder: [
						{ type: 'ai', id: aiA.id },
						{ type: 'ai', id: aiB.id },
					],
				})
			)
		);
		act(() => hook.result.current.handleCloseTabsRight());
		expect(activeSession().aiTabs.map((tab) => tab.id)).toEqual([aiA.id]);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA, draft],
					activeTabId: aiA.id,
					unifiedTabOrder: [
						{ type: 'ai', id: aiA.id },
						{ type: 'ai', id: draft.id },
					],
				})
			)
		);
		act(() => hook.result.current.handleCloseTabsRight());
		expect(useModalStore.getState().isOpen('confirm')).toBe(false);
		expect(activeSession().aiTabs.map((tab) => tab.id)).toEqual([aiA.id, draft.id]);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [],
					activeTabId: '',
					activeFileTabId: null,
				})
			)
		);
		expect(hook.result.current.handleCloseCurrentTab()).toEqual({ type: 'none' });
		act(() => hook.result.current.handleToggleTabReadOnlyMode());
		act(() => hook.result.current.handleToggleTabSaveToHistory());
		act(() => hook.result.current.handleToggleTabShowThinking());
		act(() => hook.result.current.handleScrollPositionChange(50));
		act(() => hook.result.current.handleAtBottomChange(true));

		const originalSetSessions = useSessionStore.getState().setSessions;
		const precheckSession = session({
			id: 'active-session',
			aiTabs: [aiTab({ id: 'star-target', agentSessionId: 'precheck-agent' })],
			activeTabId: 'star-target',
		});
		const updaterSession = session({
			id: 'active-session',
			aiTabs: [aiTab({ id: 'star-target', agentSessionId: null })],
			activeTabId: 'star-target',
		});
		act(() => {
			useSessionStore.setState({
				sessions: [precheckSession],
				activeSessionId: precheckSession.id,
				setSessions: ((updater) => {
					const nextSessions = typeof updater === 'function' ? updater([updaterSession]) : updater;
					useSessionStore.setState({ sessions: nextSessions });
				}) as typeof originalSetSessions,
			});
		});
		try {
			vi.mocked(window.maestro.claude.updateSessionStarred).mockClear();
			vi.mocked(window.maestro.agentSessions.setSessionStarred).mockClear();
			act(() => hook.result.current.handleTabStar('star-target', true));
			expect(activeSession().aiTabs[0].starred).toBe(true);
			expect(window.maestro.claude.updateSessionStarred).not.toHaveBeenCalled();
			expect(window.maestro.agentSessions.setSessionStarred).not.toHaveBeenCalled();
		} finally {
			act(() => {
				useSessionStore.setState({ setSessions: originalSetSessions });
			});
		}

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiA],
					activeTabId: aiA.id,
					filePreviewTabs: [],
					activeFileTabId: 'missing-file',
				})
			)
		);
		await act(async () => hook.result.current.handleFileTabNavigateBack());
		await act(async () => hook.result.current.handleFileTabNavigateForward());
		await act(async () => hook.result.current.handleFileTabNavigateToIndex(0));

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [aiTab({ id: 'dup' }), aiTab({ id: 'dup' })],
					activeTabId: 'dup',
				})
			)
		);
		act(() => hook.result.current.handleCloseAllTabs());
	});

	it('covers file navigation no-op, null-content, and error branches', async () => {
		const errorSpy = vi.mocked(logger.error);
		const historyFile = fileTab({
			id: 'file-history',
			path: '/repo/b.md',
			name: 'b',
			navigationHistory: [
				{ path: '/repo/a.md', name: 'a', scrollTop: 11 },
				{ path: '/repo/b.md', name: 'b', scrollTop: 22 },
				{ path: '/repo/c.md', name: 'c', scrollTop: 33 },
			],
			navigationIndex: 1,
		});
		const { result } = renderHandlers(
			session({
				aiTabs: [aiTab({ id: 'ai-a' })],
				filePreviewTabs: [historyFile],
				activeFileTabId: historyFile.id,
			})
		);

		vi.mocked(window.maestro.fs.readFile).mockImplementation(async (path: string) =>
			path === '/repo/a.md' ? null : `disk:${path}`
		);
		await act(async () => result.current.handleFileTabNavigateBack());
		expect(activeSession().filePreviewTabs[0].navigationIndex).toBe(1);

		vi.mocked(window.maestro.fs.readFile).mockImplementation(async (path: string) => {
			if (path === '/repo/a.md') throw new Error('back failed');
			return `disk:${path}`;
		});
		await act(async () => result.current.handleFileTabNavigateBack());
		expect(errorSpy).toHaveBeenCalledWith('Failed to navigate back:', undefined, expect.any(Error));

		vi.mocked(window.maestro.fs.readFile).mockImplementation(async (path: string) =>
			path === '/repo/c.md' ? null : `disk:${path}`
		);
		await act(async () => result.current.handleFileTabNavigateForward());
		expect(activeSession().filePreviewTabs[0].navigationIndex).toBe(1);

		vi.mocked(window.maestro.fs.readFile).mockImplementation(async (path: string) => {
			if (path === '/repo/c.md') throw new Error('forward failed');
			return `disk:${path}`;
		});
		await act(async () => result.current.handleFileTabNavigateForward());
		expect(errorSpy).toHaveBeenCalledWith(
			'Failed to navigate forward:',
			undefined,
			expect.any(Error)
		);

		vi.mocked(window.maestro.fs.readFile).mockImplementation(async (path: string) =>
			path === '/repo/a.md' ? null : `disk:${path}`
		);
		await act(async () => result.current.handleFileTabNavigateToIndex(0));
		expect(activeSession().filePreviewTabs[0].navigationIndex).toBe(1);

		vi.mocked(window.maestro.fs.readFile).mockImplementation(async (path: string) => {
			if (path === '/repo/a.md') throw new Error('index failed');
			return `disk:${path}`;
		});
		await act(async () => result.current.handleFileTabNavigateToIndex(0));
		expect(errorSpy).toHaveBeenCalledWith(
			'Failed to navigate to index:',
			undefined,
			expect.any(Error)
		);

		await act(async () => result.current.handleFileTabNavigateToIndex(99));
		act(() =>
			useSessionStore
				.getState()
				.setSessions((prev) =>
					prev.map((item) =>
						item.id === activeSession().id
							? { ...item, activeFileTabId: null, filePreviewTabs: [] }
							: item
					)
				)
		);
		await act(async () => result.current.handleFileTabNavigateBack());
		await act(async () => result.current.handleFileTabNavigateForward());
		await act(async () => result.current.handleFileTabNavigateToIndex(0));
		errorSpy.mockClear();
	});

	it('covers file-tab fallback names, history defaults, reloads, and scroll history guards', async () => {
		const existing = fileTab({
			id: 'existing-file',
			path: '/repo/existing.md',
			name: 'existing',
			content: 'old existing',
			lastModified: 123,
		});
		const sibling = fileTab({ id: 'sibling-file', path: '/repo/sibling.md', name: 'sibling' });
		const replaceNoHistory = fileTab({
			id: 'replace-no-history',
			path: '/repo/old',
			name: 'old',
			extension: '',
			navigationHistory: undefined,
			navigationIndex: undefined,
		});
		const { result } = renderHandlers(
			session({
				aiTabs: [aiTab({ id: 'ai-a' })],
				filePreviewTabs: [existing, sibling, replaceNoHistory],
				activeFileTabId: replaceNoHistory.id,
			})
		);

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/existing.md',
				name: 'existing.md',
				content: 'updated existing',
			});
		});
		expect(activeSession().filePreviewTabs.find((tab) => tab.id === existing.id)).toMatchObject({
			content: 'updated existing',
			lastModified: 123,
		});
		expect(activeSession().filePreviewTabs.find((tab) => tab.id === sibling.id)?.content).toBe(
			'sibling content'
		);

		act(() =>
			useSessionStore
				.getState()
				.setSessions((prev) =>
					prev.map((item) =>
						item.id === activeSession().id
							? { ...item, activeFileTabId: replaceNoHistory.id }
							: item
					)
				)
		);
		act(() => {
			result.current.handleOpenFileTab(
				{ path: '/repo/README', name: 'README', content: 'readme content' },
				{ openInNewTab: false }
			);
		});
		expect(
			activeSession().filePreviewTabs.find((tab) => tab.id === replaceNoHistory.id)
		).toMatchObject({
			path: '/repo/README',
			name: 'README',
			extension: '',
			navigationIndex: 1,
		});

		act(() =>
			setActiveSession(
				session({
					aiTabs: [aiTab({ id: 'ai-a' })],
					filePreviewTabs: [
						fileTab({
							id: 'replace-forward',
							path: '/repo/forward-current',
							name: 'forward-current',
							extension: '',
							navigationHistory: [
								{ path: '/repo/a', name: 'a', scrollTop: 1 },
								{ path: '/repo/b', name: 'b', scrollTop: 2 },
							],
							navigationIndex: 0,
						}),
					],
					activeFileTabId: 'replace-forward',
				})
			)
		);
		act(() => {
			result.current.handleOpenFileTab(
				{ path: '/repo/NOTICE', name: 'NOTICE', content: 'notice content' },
				{ openInNewTab: false }
			);
		});
		expect(
			activeSession().filePreviewTabs[0].navigationHistory?.map((entry) => entry.path)
		).toEqual(['/repo/a', '/repo/forward-current', '/repo/NOTICE']);

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/LICENSE',
				name: 'LICENSE',
				content: 'license content',
			});
		});
		expect(activeSession().filePreviewTabs.at(-1)).toMatchObject({
			path: '/repo/LICENSE',
			name: 'LICENSE',
			extension: '',
		});

		const noHistoryScroll = fileTab({
			id: 'no-history-scroll',
			navigationHistory: undefined,
			navigationIndex: undefined,
		});
		const fallbackIndexScroll = fileTab({
			id: 'fallback-index-scroll',
			path: '/repo/fallback.md',
			name: 'fallback',
			lastModified: 0,
			navigationHistory: [{ path: '/repo/fallback.md', name: 'fallback', scrollTop: 0 }],
			navigationIndex: undefined,
		});
		const invalidIndexScroll = fileTab({
			id: 'invalid-index-scroll',
			navigationHistory: [{ path: '/repo/invalid.md', name: 'invalid', scrollTop: 0 }],
			navigationIndex: 99,
		});
		const untouched = fileTab({ id: 'untouched-file', path: '/repo/untouched.md' });
		act(() =>
			setActiveSession(
				session({
					aiTabs: [aiTab({ id: 'ai-a' })],
					filePreviewTabs: [noHistoryScroll, fallbackIndexScroll, invalidIndexScroll, untouched],
					activeFileTabId: fallbackIndexScroll.id,
				})
			)
		);
		act(() => result.current.handleFileTabScrollPositionChange(noHistoryScroll.id, 10));
		act(() => result.current.handleFileTabScrollPositionChange(fallbackIndexScroll.id, 20));
		act(() => result.current.handleFileTabScrollPositionChange(invalidIndexScroll.id, 30));
		expect(
			activeSession().filePreviewTabs.find((tab) => tab.id === fallbackIndexScroll.id)
				?.navigationHistory?.[0].scrollTop
		).toBe(20);
		expect(
			activeSession().filePreviewTabs.find((tab) => tab.id === invalidIndexScroll.id)
				?.navigationHistory?.[0].scrollTop
		).toBe(0);

		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('reload fallback');
		vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
			size: 1,
			createdAt: '2026-05-01T00:00:00.000Z',
			modifiedAt: undefined as unknown as string,
		});
		await act(async () => result.current.handleReloadFileTab(fallbackIndexScroll.id));
		expect(
			activeSession().filePreviewTabs.find((tab) => tab.id === fallbackIndexScroll.id)
		).toMatchObject({ content: 'reload fallback' });

		useSettingsStore.setState({ fileTabAutoRefreshEnabled: true });
		vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({
			size: 1,
			createdAt: '2026-05-01T00:00:00.000Z',
			modifiedAt: '2026-07-01T00:00:00.000Z',
		});
		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('selected fallback');
		await act(async () => result.current.handleSelectFileTab(fallbackIndexScroll.id));
		expect(
			activeSession().filePreviewTabs.find((tab) => tab.id === fallbackIndexScroll.id)
		).toMatchObject({ content: 'selected fallback' });
		expect(activeSession().filePreviewTabs.find((tab) => tab.id === untouched.id)?.content).toBe(
			'untouched content'
		);
	});

	it('covers active-file close ranges and stale AI tab refs', () => {
		const hook = renderHook(() => useTabHandlers());
		const activeFile = fileTab({ id: 'active-file', path: '/repo/active.md' });
		const setFileActiveSession = (order: Array<{ type: 'ai' | 'file'; id: string }>) => {
			act(() =>
				setActiveSession(
					session({
						aiTabs: [],
						activeTabId: '',
						filePreviewTabs: [activeFile],
						activeFileTabId: activeFile.id,
						unifiedTabOrder: order,
					})
				)
			);
		};

		setFileActiveSession([
			{ type: 'ai', id: 'ghost-left' },
			{ type: 'file', id: activeFile.id },
			{ type: 'ai', id: 'ghost-right' },
		]);
		act(() => hook.result.current.handleCloseOtherTabs());
		expect(activeSession().filePreviewTabs.map((tab) => tab.id)).toEqual([activeFile.id]);

		setFileActiveSession([
			{ type: 'ai', id: 'ghost-left' },
			{ type: 'file', id: activeFile.id },
		]);
		act(() => hook.result.current.handleCloseTabsLeft());
		expect(activeSession().filePreviewTabs.map((tab) => tab.id)).toEqual([activeFile.id]);

		setFileActiveSession([
			{ type: 'file', id: activeFile.id },
			{ type: 'ai', id: 'ghost-right' },
		]);
		act(() => hook.result.current.handleCloseTabsRight());
		expect(activeSession().filePreviewTabs.map((tab) => tab.id)).toEqual([activeFile.id]);
	});

	it('covers missing active AI tab, history defaults, and tab property fallbacks', async () => {
		const hook = renderHook(() => useTabHandlers());
		const other = session({ id: 'other-session', aiTabs: [aiTab({ id: 'other-ai' })] });
		const setDualSession = (next: Session) => {
			useSessionStore.setState({
				sessions: [next, other],
				activeSessionId: next.id,
				groups: [],
			});
		};
		const alpha = aiTab({
			id: 'alpha',
			agentSessionId: 'agent-alpha',
			name: 'Alpha',
			logs: [logEntry('u-alpha', 'user', 'run alpha')],
		});
		const beta = aiTab({ id: 'beta' });

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [alpha, beta],
					activeTabId: 'missing-ai',
					activeFileTabId: null,
					aiCommandHistory: undefined,
				})
			)
		);
		expect(hook.result.current.handleCloseCurrentTab()).toEqual({
			type: 'ai',
			tabId: 'missing-ai',
			isWizardTab: false,
			hasWizardUserInteraction: false,
			hasDraft: false,
		});
		act(() => hook.result.current.handleTabSelect('missing-select'));
		expect(activeSession().activeTabId).toBe('missing-ai');
		expect(hook.result.current.handleDeleteLog('u-alpha')).toBeNull();

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [
						aiTab({
							id: 'logs-missing',
							logs: undefined as unknown as LogEntry[],
						}),
					],
					activeTabId: 'logs-missing',
				})
			)
		);
		expect(hook.result.current.handleDeleteLog('missing-log')).toBeNull();

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [alpha],
					activeTabId: alpha.id,
					aiCommandHistory: undefined,
				})
			)
		);
		expect(hook.result.current.handleDeleteLog('u-alpha')).toBeNull();
		expect(activeSession().aiCommandHistory).toEqual([]);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					inputMode: 'terminal',
					shellLogs: [logEntry('s-alpha', 'user', 'pwd')],
					shellCommandHistory: undefined,
				})
			)
		);
		expect(hook.result.current.handleDeleteLog('s-alpha')).toBeNull();
		expect(activeSession().shellCommandHistory).toEqual([]);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					aiTabs: [alpha],
					activeTabId: alpha.id,
				})
			)
		);
		act(() => hook.result.current.handleRequestTabRename(alpha.id));
		expect(useModalStore.getState().getData('renameTab')).toEqual({
			tabId: alpha.id,
			initialName: 'Alpha',
		});

		act(() =>
			hook.result.current.handleUpdateTabByClaudeSessionId('agent-alpha', { starred: true })
		);
		expect(activeSession().aiTabs[0]).toMatchObject({ name: 'Alpha', starred: true });

		const fallbackAgent = aiTab({ id: 'fallback-agent', agentSessionId: 'fallback-session' });
		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					toolType: undefined as unknown as Session['toolType'],
					aiTabs: [fallbackAgent],
					activeTabId: fallbackAgent.id,
				})
			)
		);
		act(() => hook.result.current.handleTabStar(fallbackAgent.id, true));
		expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
			'/repo',
			'fallback-session',
			true
		);

		act(() =>
			setDualSession(
				session({
					id: 'active-session',
					inputMode: 'terminal',
					shellLogs: [],
					terminalScrollTop: 0,
				})
			)
		);
		act(() => hook.result.current.handleScrollPositionChange(321));
		expect(activeSession().terminalScrollTop).toBe(321);
		expect(
			useSessionStore.getState().sessions.find((item) => item.id === other.id)?.terminalScrollTop
		).toBeUndefined();
		act(() => hook.result.current.handleAtBottomChange(false));

		act(() => hook.result.current.handleClearFilePreviewHistory());
		expect(
			useSessionStore.getState().sessions.find((item) => item.id === other.id)?.filePreviewHistory
		).toBeUndefined();
	});

	it('covers file navigation fallback defaults with sparse history metadata', async () => {
		const hook = renderHook(() => useTabHandlers());
		const other = session({ id: 'other-session', aiTabs: [aiTab({ id: 'other-ai' })] });
		const setFileSession = (tab: FilePreviewTab) => {
			act(() => {
				useSessionStore.setState({
					sessions: [
						session({
							id: 'active-session',
							aiTabs: [aiTab({ id: 'ai-a' })],
							filePreviewTabs: [tab],
							activeFileTabId: tab.id,
						}),
						other,
					],
					activeSessionId: 'active-session',
					groups: [],
				});
			});
		};

		setFileSession(
			fileTab({
				id: 'back-no-history',
				navigationHistory: undefined,
				navigationIndex: undefined,
			})
		);
		await act(async () => hook.result.current.handleFileTabNavigateBack());

		setFileSession(
			fileTab({
				id: 'back-default-index',
				navigationHistory: [
					{ path: '/repo/back-a.md', name: 'back-a', scrollTop: undefined as unknown as number },
					{ path: '/repo/back-b.md', name: 'back-b', scrollTop: 2 },
				],
				navigationIndex: undefined,
			})
		);
		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('back sparse content');
		await act(async () => hook.result.current.handleFileTabNavigateBack());
		expect(activeSession().filePreviewTabs[0]).toMatchObject({
			path: '/repo/back-a.md',
			scrollTop: 0,
			navigationIndex: 0,
		});

		setFileSession(
			fileTab({
				id: 'forward-no-history',
				navigationHistory: undefined,
				navigationIndex: undefined,
			})
		);
		await act(async () => hook.result.current.handleFileTabNavigateForward());

		setFileSession(
			fileTab({
				id: 'forward-sparse-scroll',
				navigationHistory: [
					{ path: '/repo/forward-a.md', name: 'forward-a', scrollTop: 1 },
					{
						path: '/repo/forward-b.md',
						name: 'forward-b',
						scrollTop: undefined as unknown as number,
					},
				],
				navigationIndex: 0,
			})
		);
		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('forward sparse content');
		await act(async () => hook.result.current.handleFileTabNavigateForward());
		expect(activeSession().filePreviewTabs[0]).toMatchObject({
			path: '/repo/forward-b.md',
			scrollTop: 0,
			navigationIndex: 1,
		});

		setFileSession(
			fileTab({
				id: 'index-no-history',
				navigationHistory: undefined,
			})
		);
		await act(async () => hook.result.current.handleFileTabNavigateToIndex(0));

		setFileSession(
			fileTab({
				id: 'index-sparse-scroll',
				navigationHistory: [
					{ path: '/repo/index-a.md', name: 'index-a', scrollTop: undefined as unknown as number },
				],
				navigationIndex: 0,
			})
		);
		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('index sparse content');
		await act(async () => hook.result.current.handleFileTabNavigateToIndex(0));
		expect(activeSession().filePreviewTabs[0]).toMatchObject({
			path: '/repo/index-a.md',
			scrollTop: 0,
			navigationIndex: 0,
		});
	});
});
