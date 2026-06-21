import { beforeEach, describe, expect, it } from 'vitest';

import { useSessionStore } from '../../renderer/stores/sessionStore';
import {
	getTabActions,
	getTabState,
	selectActiveFileTab,
	selectActiveTab,
	selectAllFileTabs,
	selectAllTabs,
	selectFileTabById,
	selectTabById,
	selectTabCount,
	selectUnifiedTabs,
	useTabStore,
} from '../../renderer/stores/tabStore';
import type { AITab, FilePreviewTab, Session } from '../../renderer/types';

function aiTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'ai-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1,
		state: 'idle',
		hasUnread: false,
		readOnlyMode: false,
		saveToHistory: true,
		showThinking: 'off',
		...overrides,
	};
}

function fileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'file-1',
		path: '/workspace/file.md',
		name: 'file.md',
		extension: '.md',
		content: '# File',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: 1,
		lastModified: 1,
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Integration Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/workspace',
		fullPath: '/workspace',
		projectRoot: '/workspace',
		createdAt: 1,
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
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	};
}

function resetStores() {
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		sessionsLoaded: false,
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
		cyclePosition: -1,
	});
	useTabStore.setState({
		tabGistContent: null,
		fileGistUrls: {},
	});
}

function seedSession(source: Session) {
	useSessionStore.getState().setSessions([source]);
	useSessionStore.getState().setActiveSessionId(source.id);
}

function activeSession(): Session {
	const state = useSessionStore.getState();
	const active = state.sessions.find((item) => item.id === state.activeSessionId);
	if (!active) throw new Error('Expected active session');
	return active;
}

describe('tabStore integration', () => {
	beforeEach(() => {
		resetStores();
	});

	it('manages gist UI state through non-React store actions', () => {
		const actions = getTabActions();

		actions.setTabGistContent({ filename: 'plan.md', content: '# Plan' });
		expect(getTabState().tabGistContent).toEqual({ filename: 'plan.md', content: '# Plan' });

		actions.setFileGistUrls({
			'/workspace/plan.md': {
				gistUrl: 'https://gist.github.com/one',
				isPublic: false,
				publishedAt: 1,
			},
		});
		actions.setFileGistUrl('/workspace/notes.md', {
			gistUrl: 'https://gist.github.com/two',
			isPublic: true,
			publishedAt: 2,
		});
		actions.clearFileGistUrl('/workspace/plan.md');

		expect(getTabState().fileGistUrls).toEqual({
			'/workspace/notes.md': {
				gistUrl: 'https://gist.github.com/two',
				isPublic: true,
				publishedAt: 2,
			},
		});
		expect(actions.createTab).toBe(useTabStore.getState().createTab);
	});

	it('returns null or leaves state unchanged when there is no active session', () => {
		const actions = useTabStore.getState();

		expect(actions.createTab()).toBeNull();
		expect(actions.closeTab('missing')).toBeNull();
		expect(actions.closeFileTab('missing')).toBeNull();
		expect(actions.reopenClosedTab()).toBeNull();
		expect(actions.selectTab('missing')).toBeNull();
		expect(actions.navigateToNext()).toBeNull();
		expect(actions.navigateToPrev()).toBeNull();
		expect(actions.navigateToIndex(0)).toBeNull();
		expect(actions.navigateToLast()).toBeNull();

		actions.selectFileTab('missing');
		actions.starTab('missing');
		actions.markUnread('missing');
		actions.updateTabName('missing', 'Missing');
		actions.toggleReadOnly('missing');
		actions.toggleSaveToHistory('missing');
		actions.cycleThinkingMode('missing');
		actions.reorderTabs(0, 1);
		actions.reorderUnifiedTabs(0, 1);
		actions.updateFileTabEditContent('missing', 'content');
		actions.updateFileTabScrollPosition('missing', 120);
		actions.updateFileTabSearchQuery('missing', 'needle');
		actions.toggleFileTabEditMode('missing');

		const state = useSessionStore.getState();
		expect(state.sessions).toEqual([]);
		expect(selectActiveTab(state)).toBeUndefined();
		expect(selectActiveFileTab(state)).toBeUndefined();
		expect(selectUnifiedTabs(state)).toEqual([]);
		expect(selectTabById('missing')(state)).toBeUndefined();
		expect(selectFileTabById('missing')(state)).toBeUndefined();
		expect(selectTabCount(state)).toBe(0);
		expect(selectAllTabs(state)).toEqual([]);
		expect(selectAllFileTabs(state)).toEqual([]);
	});

	it('wraps real tab helper CRUD and navigation against the active session', () => {
		seedSession(
			session({
				aiTabs: [
					aiTab({ id: 'ai-1', name: 'One' }),
					aiTab({ id: 'ai-2', name: 'Two', agentSessionId: 'agent-two', hasUnread: true }),
				],
				activeTabId: 'ai-1',
				filePreviewTabs: [
					fileTab({ id: 'file-1', path: '/workspace/a.md', name: 'a.md' }),
					fileTab({ id: 'file-2', path: '/workspace/b.md', name: 'b.md' }),
				],
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-2' },
					{ type: 'file', id: 'file-2' },
				],
			})
		);

		const actions = useTabStore.getState();

		const created = actions.createTab({ name: 'Created', agentSessionId: 'agent-created' });
		expect(created?.tab).toMatchObject({ name: 'Created', agentSessionId: 'agent-created' });
		expect(activeSession().activeTabId).toBe(created?.tab.id);
		expect(activeSession().activeFileTabId).toBeNull();

		const selected = actions.selectTab('ai-2');
		expect(selected?.tab.id).toBe('ai-2');
		expect(activeSession().activeTabId).toBe('ai-2');

		actions.selectFileTab('file-1');
		expect(activeSession().activeFileTabId).toBe('file-1');
		actions.selectFileTab('missing-file');
		expect(activeSession().activeFileTabId).toBe('file-1');

		expect(actions.navigateToNext()).toMatchObject({ type: 'ai', id: 'ai-2' });
		expect(activeSession().activeTabId).toBe('ai-2');
		expect(actions.navigateToPrev()).toMatchObject({ type: 'file', id: 'file-1' });
		expect(activeSession().activeFileTabId).toBe('file-1');
		expect(actions.navigateToIndex(0)).toMatchObject({ type: 'ai', id: 'ai-1' });
		expect(actions.navigateToIndex(99)).toBeNull();
		expect(actions.navigateToLast()).toMatchObject({ type: 'ai', id: created?.tab.id });
		expect(actions.navigateToNext(true)).toMatchObject({ type: 'ai', id: 'ai-2' });

		const closedFile = actions.closeFileTab('file-2');
		expect(closedFile?.closedTabEntry).toMatchObject({ type: 'file', tab: { id: 'file-2' } });
		expect(activeSession().filePreviewTabs.map((tab) => tab.id)).not.toContain('file-2');

		const reopenedFile = actions.reopenClosedTab();
		expect(reopenedFile).toMatchObject({ tabType: 'file', wasDuplicate: false });
		expect(activeSession().filePreviewTabs.some((tab) => tab.path === '/workspace/b.md')).toBe(
			true
		);

		const closedAi = actions.closeTab('ai-2');
		expect(closedAi?.closedTab.tab.id).toBe('ai-2');
		expect(activeSession().aiTabs.map((tab) => tab.id)).not.toContain('ai-2');

		const reopenedAi = actions.reopenClosedTab();
		expect(reopenedAi).toMatchObject({ tabType: 'ai', wasDuplicate: false });
		expect(activeSession().aiTabs.some((tab) => tab.agentSessionId === 'agent-two')).toBe(true);
	});

	it('updates tab metadata, file-tab state, ordering, and selectors in sessionStore', () => {
		seedSession(
			session({
				aiTabs: [
					aiTab({ id: 'ai-1', name: 'One' }),
					aiTab({ id: 'ai-2', name: 'Two', showThinking: 'sticky' }),
					aiTab({ id: 'ai-3', name: 'Three' }),
				],
				activeTabId: 'ai-1',
				filePreviewTabs: [
					fileTab({ id: 'file-1', path: '/workspace/a.md', name: 'a.md' }),
					fileTab({ id: 'file-2', path: '/workspace/b.md', name: 'b.md' }),
				],
				activeFileTabId: 'file-1',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-2' },
					{ type: 'file', id: 'file-2' },
					{ type: 'ai', id: 'ai-3' },
				],
			})
		);

		const actions = useTabStore.getState();

		actions.starTab('ai-1');
		actions.markUnread('ai-1');
		actions.updateTabName('ai-1', 'Renamed');
		actions.toggleReadOnly('ai-1');
		actions.toggleSaveToHistory('ai-1');
		actions.cycleThinkingMode('ai-1');
		actions.cycleThinkingMode('ai-1');
		actions.cycleThinkingMode('ai-1');
		actions.cycleThinkingMode('ai-2');
		actions.starTab('missing-ai');
		actions.toggleReadOnly('missing-ai');
		actions.toggleSaveToHistory('missing-ai');
		actions.cycleThinkingMode('missing-ai');

		const firstTab = activeSession().aiTabs.find((tab) => tab.id === 'ai-1');
		expect(firstTab).toMatchObject({
			name: 'Renamed',
			starred: true,
			hasUnread: true,
			readOnlyMode: true,
			saveToHistory: false,
			showThinking: 'off',
		});
		expect(activeSession().aiTabs.find((tab) => tab.id === 'ai-2')?.showThinking).toBe('off');

		actions.reorderTabs(0, 2);
		expect(activeSession().aiTabs.map((tab) => tab.id)).toEqual(['ai-2', 'ai-3', 'ai-1']);
		actions.reorderTabs(-1, 1);
		expect(activeSession().aiTabs.map((tab) => tab.id)).toEqual(['ai-2', 'ai-3', 'ai-1']);

		actions.reorderUnifiedTabs(0, 4);
		expect(activeSession().unifiedTabOrder.map((ref) => `${ref.type}:${ref.id}`)).toEqual([
			'file:file-1',
			'ai:ai-2',
			'file:file-2',
			'ai:ai-3',
			'ai:ai-1',
		]);
		actions.reorderUnifiedTabs(99, 0);
		expect(activeSession().unifiedTabOrder.map((ref) => `${ref.type}:${ref.id}`)).toEqual([
			'file:file-1',
			'ai:ai-2',
			'file:file-2',
			'ai:ai-3',
			'ai:ai-1',
		]);

		actions.updateFileTabEditContent('file-1', 'updated');
		actions.updateFileTabScrollPosition('file-1', 240);
		actions.updateFileTabSearchQuery('file-1', 'needle');
		actions.toggleFileTabEditMode('file-1');
		actions.toggleFileTabEditMode('missing-file');

		const file = activeSession().filePreviewTabs.find((tab) => tab.id === 'file-1');
		expect(file).toMatchObject({
			editContent: 'updated',
			scrollTop: 240,
			searchQuery: 'needle',
			editMode: true,
		});

		const state = useSessionStore.getState();
		expect(selectActiveTab(state)?.id).toBe('ai-1');
		expect(selectActiveFileTab(state)?.id).toBe('file-1');
		expect(selectUnifiedTabs(state).map((tab) => `${tab.type}:${tab.id}`)).toEqual([
			'file:file-1',
			'ai:ai-2',
			'file:file-2',
			'ai:ai-3',
			'ai:ai-1',
		]);
		expect(selectTabById('ai-3')(state)?.name).toBe('Three');
		expect(selectFileTabById('file-2')(state)?.path).toBe('/workspace/b.md');
		expect(selectTabCount(state)).toBe(3);
		expect(selectAllTabs(state)).toHaveLength(3);
		expect(selectAllFileTabs(state)).toHaveLength(2);
	});
});
