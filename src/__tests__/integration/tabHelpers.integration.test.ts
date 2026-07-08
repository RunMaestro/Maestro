import { describe, expect, it } from 'vitest';

import {
	addAiTabToUnifiedHistory,
	buildUnifiedTabs,
	closeFileTab,
	closeTab,
	createMergedSession,
	createTab,
	createTabAtPosition,
	ensureInUnifiedTabOrder,
	extractQuickTabName,
	getActiveTab,
	getBusyTabs,
	getInitialRenameValue,
	getNavigableTabs,
	getRepairedUnifiedTabOrder,
	getWriteModeTab,
	hasActiveWizard,
	hasDraft,
	navigateToLastTab,
	navigateToLastUnifiedTab,
	navigateToNextTab,
	navigateToNextUnifiedTab,
	navigateToPrevTab,
	navigateToPrevUnifiedTab,
	navigateToTabByIndex,
	navigateToUnifiedTabByIndex,
	reopenClosedTab,
	reopenUnifiedClosedTab,
	setActiveTab,
} from '../../renderer/utils/tabHelpers';
import type {
	AITab,
	ClosedTab,
	ClosedTabEntry,
	FilePreviewTab,
	Session,
} from '../../renderer/types';

function aiTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 1,
		state: 'idle',
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

describe('tabHelpers integration', () => {
	it('builds and repairs unified tab order while pruning stale refs and preserving real orphaned tabs', () => {
		const aiOne = aiTab({ id: 'ai-1', name: 'Alpha' });
		const aiTwo = aiTab({ id: 'ai-2', name: 'Beta' });
		const fileOne = fileTab({ id: 'file-1', path: '/workspace/a.md', name: 'a.md' });
		const fileTwo = fileTab({ id: 'file-2', path: '/workspace/b.md', name: 'b.md' });
		const source = session({
			aiTabs: [aiOne, aiTwo],
			filePreviewTabs: [fileOne, fileTwo],
			unifiedTabOrder: [
				{ type: 'file', id: 'file-1' },
				{ type: 'ai', id: 'ai-1' },
				{ type: 'ai', id: 'missing-ai' },
			],
		});

		expect(buildUnifiedTabs(source).map((tab) => `${tab.type}:${tab.id}`)).toEqual([
			'file:file-1',
			'ai:ai-1',
			'ai:ai-2',
			'file:file-2',
		]);
		expect(getRepairedUnifiedTabOrder(source)).toEqual([
			{ type: 'file', id: 'file-1' },
			{ type: 'ai', id: 'ai-1' },
			{ type: 'ai', id: 'ai-2' },
			{ type: 'file', id: 'file-2' },
		]);
		expect(ensureInUnifiedTabOrder(source.unifiedTabOrder, 'ai', 'ai-1')).toBe(
			source.unifiedTabOrder
		);
		expect(ensureInUnifiedTabOrder(source.unifiedTabOrder, 'file', 'file-3')).toContainEqual({
			type: 'file',
			id: 'file-3',
		});
		expect(getInitialRenameValue(aiOne)).toBe('Alpha');
		expect(getInitialRenameValue(aiTab({ name: null }))).toBe('');
	});

	it('extracts quick tab names from issue trackers and leaves ordinary prompts unnamed', () => {
		expect(extractQuickTabName('review https://github.com/run/maestro/pull/123')).toBe('PR #123');
		expect(extractQuickTabName('fix https://github.com/run/maestro/issues/45')).toBe('Issue #45');
		expect(extractQuickTabName('summarize https://github.com/run/maestro/discussions/9')).toBe(
			'Discussion #9'
		);
		expect(extractQuickTabName('ship PROJ-1234 today')).toBe('PROJ-1234');
		expect(extractQuickTabName('check pull request #55')).toBe('PR #55');
		expect(extractQuickTabName('triage issue #66')).toBe('Issue #66');
		expect(extractQuickTabName('write release notes')).toBeNull();
	});

	it('creates, positions, closes, and reopens AI tabs across normal and duplicate histories', () => {
		const base = session({
			aiTabs: [aiTab({ id: 'ai-1', agentSessionId: 'agent-1' })],
			activeTabId: 'ai-1',
			unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
		});

		const created = createTab(base, {
			agentSessionId: 'agent-2',
			name: 'Feature tab',
			starred: true,
			logs: [{ id: 'log-1', timestamp: 1, source: 'user', text: 'hello' }],
			saveToHistory: false,
			showThinking: 'sticky',
		})!;
		expect(created.tab).toMatchObject({
			agentSessionId: 'agent-2',
			name: 'Feature tab',
			starred: true,
			saveToHistory: false,
			showThinking: 'sticky',
		});
		expect(created.session.activeFileTabId).toBeNull();

		const positioned = createTabAtPosition(created.session, {
			afterTabId: 'ai-1',
			name: 'Inserted tab',
		})!;
		expect(positioned.session.aiTabs[1].id).toBe(positioned.tab.id);

		const closed = closeTab(positioned.session, positioned.tab.id)!;
		expect(closed.closedTab.index).toBe(1);
		expect(closed.session.closedTabHistory[0].tab.id).toBe(positioned.tab.id);
		expect(closed.session.unifiedTabOrder.some((ref) => ref.id === positioned.tab.id)).toBe(false);

		const skipped = closeTab(positioned.session, positioned.tab.id, false, { skipHistory: true })!;
		expect(skipped.session.closedTabHistory).toHaveLength(0);

		const restored = reopenClosedTab(closed.session)!;
		expect(restored.wasDuplicate).toBe(false);
		expect(restored.session.activeTabId).toBe(restored.tab.id);
		expect(restored.session.aiTabs.map((tab) => tab.id)).toContain(restored.tab.id);

		const duplicateHistory: ClosedTab = {
			tab: aiTab({ id: 'closed-ai', agentSessionId: 'agent-1' }),
			index: 0,
			closedAt: 1,
		};
		const duplicate = reopenClosedTab({
			...base,
			closedTabHistory: [duplicateHistory],
		})!;
		expect(duplicate.wasDuplicate).toBe(true);
		expect(duplicate.tab.id).toBe('ai-1');

		const lastClosed = closeTab(
			session({ aiTabs: [aiTab({ id: 'only' })], activeTabId: 'only' }),
			'only'
		)!;
		expect(lastClosed.session.aiTabs).toHaveLength(1);
		expect(lastClosed.session.activeTabId).not.toBe('only');
	});

	it('handles AI tab guard clauses and filtered close selection fallbacks', () => {
		expect(buildUnifiedTabs(null as unknown as Session)).toEqual([]);
		expect(getNavigableTabs(null as unknown as Session)).toEqual([]);
		expect(getNavigableTabs(session({ aiTabs: [] }))).toEqual([]);
		expect(createTab(null as unknown as Session)).toBeNull();
		expect(closeTab(null as unknown as Session, 'missing')).toBeNull();
		expect(closeTab(session({ aiTabs: [] }), 'missing')).toBeNull();
		expect(closeTab(session({ aiTabs: [aiTab({ id: 'existing' })] }), 'missing')).toBeNull();
		expect(reopenClosedTab(session())).toBeNull();

		const filteredClose = closeTab(
			session({
				aiTabs: [
					aiTab({ id: 'read' }),
					aiTab({ id: 'active-unread', hasUnread: true }),
					aiTab({ id: 'next-unread', hasUnread: true }),
				],
				activeTabId: 'active-unread',
			}),
			'active-unread',
			true
		)!;
		expect(filteredClose.session.activeTabId).toBe('next-unread');

		const fallbackClose = closeTab(
			session({
				aiTabs: [aiTab({ id: 'active-unread', hasUnread: true }), aiTab({ id: 'read' })],
				activeTabId: 'active-unread',
			}),
			'active-unread',
			true
		)!;
		expect(fallbackClose.session.activeTabId).toBe('read');
	});

	it('closes and reopens file and AI tabs through unified history', () => {
		const aiOne = aiTab({ id: 'ai-1', agentSessionId: 'agent-1' });
		const fileOne = fileTab({
			id: 'file-1',
			path: '/workspace/a.md',
			name: 'a.md',
			editMode: true,
			editContent: 'dirty',
			scrollTop: 35,
		});
		const fileTwo = fileTab({ id: 'file-2', path: '/workspace/b.md', name: 'b.md' });
		const source = session({
			aiTabs: [aiOne],
			activeTabId: 'ai-1',
			filePreviewTabs: [fileOne, fileTwo],
			activeFileTabId: 'file-2',
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'file', id: 'file-1' },
				{ type: 'file', id: 'file-2' },
			],
		});

		expect(closeFileTab(session(), 'missing')).toBeNull();

		const closedFile = closeFileTab(source, 'file-2')!;
		expect(closedFile.closedTabEntry).toMatchObject({ type: 'file', unifiedIndex: 2 });
		expect(closedFile.session.activeFileTabId).toBe('file-1');

		const restoredFile = reopenUnifiedClosedTab(closedFile.session)!;
		expect(restoredFile).toMatchObject({ tabType: 'file', wasDuplicate: false });
		const restoredFileTab = restoredFile.session.filePreviewTabs.find(
			(tab) => tab.id === restoredFile.tabId
		)!;
		expect(restoredFileTab.editMode).toBe(false);
		expect(restoredFileTab.editContent).toBeUndefined();
		expect(restoredFileTab.navigationHistory).toEqual([
			{ path: '/workspace/b.md', name: 'b.md', scrollTop: 0 },
		]);

		const duplicateFileEntry: ClosedTabEntry = {
			type: 'file',
			tab: fileOne,
			unifiedIndex: 1,
			closedAt: 1,
		};
		const duplicateFile = reopenUnifiedClosedTab({
			...source,
			unifiedClosedTabHistory: [duplicateFileEntry],
		})!;
		expect(duplicateFile).toMatchObject({ tabType: 'file', tabId: 'file-1', wasDuplicate: true });

		const aiHistory = addAiTabToUnifiedHistory(source, aiTab({ id: 'closed-ai' }), 1);
		const reopenedAi = reopenUnifiedClosedTab(aiHistory)!;
		expect(reopenedAi).toMatchObject({ tabType: 'ai', wasDuplicate: false });

		const legacyFallback = reopenUnifiedClosedTab({
			...source,
			unifiedClosedTabHistory: [],
			closedTabHistory: [{ tab: aiTab({ id: 'legacy-ai' }), index: 0, closedAt: 1 }],
		})!;
		expect(legacyFallback.tabType).toBe('ai');
	});

	it('handles stale unified file history and duplicate unified AI restores', () => {
		const orphanFile = fileTab({ id: 'orphan-file', path: '/workspace/orphan.md' });
		const siblingFile = fileTab({ id: 'sibling-file', path: '/workspace/sibling.md' });
		const activeAi = aiTab({ id: 'ai-1', agentSessionId: 'agent-1' });

		const fallbackToFile = closeFileTab(
			session({
				aiTabs: [activeAi],
				activeTabId: 'ai-1',
				filePreviewTabs: [orphanFile, siblingFile],
				activeFileTabId: 'orphan-file',
				unifiedTabOrder: [{ type: 'file', id: 'sibling-file' }],
			}),
			'orphan-file'
		)!;
		expect(fallbackToFile.closedTabEntry.unifiedIndex).toBe(2);
		expect(fallbackToFile.session.activeTabId).toBe('ai-1');
		expect(fallbackToFile.session.activeFileTabId).toBeNull();

		const fallbackToAi = closeFileTab(
			session({
				aiTabs: [activeAi],
				activeTabId: 'ai-1',
				filePreviewTabs: [orphanFile],
				activeFileTabId: 'orphan-file',
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
			}),
			'orphan-file'
		)!;
		expect(fallbackToAi.session.activeTabId).toBe('ai-1');
		expect(fallbackToAi.session.activeFileTabId).toBeNull();

		const previousAi = closeFileTab(
			session({
				aiTabs: [activeAi],
				activeTabId: 'ai-1',
				filePreviewTabs: [orphanFile],
				activeFileTabId: 'orphan-file',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'orphan-file' },
				],
			}),
			'orphan-file'
		)!;
		expect(previousAi.session.activeTabId).toBe('ai-1');
		expect(previousAi.session.activeFileTabId).toBeNull();

		expect(closeFileTab({ ...session(), filePreviewTabs: [siblingFile] }, 'missing')).toBeNull();

		const noRemainingTabs = closeFileTab(
			session({
				aiTabs: [],
				activeTabId: 'missing-ai',
				filePreviewTabs: [orphanFile],
				activeFileTabId: 'orphan-file',
				unifiedTabOrder: [],
			}),
			'orphan-file'
		)!;
		expect(noRemainingTabs.session.activeFileTabId).toBeNull();

		const duplicateAi = reopenUnifiedClosedTab({
			...session({
				aiTabs: [activeAi],
				activeTabId: 'ai-1',
				unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
			}),
			unifiedClosedTabHistory: [
				{
					type: 'ai',
					tab: aiTab({ id: 'closed-ai', agentSessionId: 'agent-1' }),
					unifiedIndex: 0,
					closedAt: 1,
				},
			],
		})!;
		expect(duplicateAi).toMatchObject({ tabType: 'ai', tabId: 'ai-1', wasDuplicate: true });
		expect(reopenUnifiedClosedTab(session())).toBeNull();
	});

	it('navigates AI tabs by active, unread, draft, busy, index, and last-tab semantics', () => {
		const idle = aiTab({ id: 'idle', inputValue: '  ' });
		const unread = aiTab({ id: 'unread', hasUnread: true });
		const draft = aiTab({ id: 'draft', inputValue: 'pending prompt' });
		const imageDraft = aiTab({ id: 'image-draft', stagedImages: ['data:image/png;base64,abc'] });
		const busy = aiTab({ id: 'busy', state: 'busy' });
		const wizard = aiTab({ id: 'wizard', wizardState: { isActive: true } as AITab['wizardState'] });
		const source = session({
			aiTabs: [idle, unread, draft, imageDraft, busy, wizard],
			activeTabId: 'idle',
			activeFileTabId: 'file-1',
		});

		expect(getActiveTab(source)).toBe(idle);
		expect(getActiveTab({ ...source, activeTabId: 'missing' })).toBe(idle);
		expect(hasDraft(idle)).toBe(false);
		expect(hasDraft(draft)).toBe(true);
		expect(hasDraft(imageDraft)).toBe(true);
		expect(hasActiveWizard(wizard)).toBe(true);
		expect(getNavigableTabs(source, true).map((tab) => tab.id)).toEqual([
			'unread',
			'draft',
			'image-draft',
			'busy',
		]);
		expect(getWriteModeTab(source)).toBe(busy);
		expect(getBusyTabs(source)).toEqual([busy]);

		expect(setActiveTab(source, 'unread')!.session).toMatchObject({
			activeTabId: 'unread',
			activeFileTabId: null,
		});
		const alreadyActive = { ...source, activeFileTabId: null };
		expect(setActiveTab(alreadyActive, 'idle')!.session).toMatchObject({
			activeTabId: 'idle',
			activeFileTabId: null,
			activeBrowserTabId: null,
			activeTerminalTabId: null,
		});
		expect(setActiveTab(source, 'missing')).toBeNull();

		expect(navigateToNextTab(source)!.tab.id).toBe('unread');
		expect(navigateToPrevTab(source)!.tab.id).toBe('wizard');
		expect(navigateToNextTab({ ...source, activeTabId: 'busy' }, true)!.tab.id).toBe('unread');
		expect(navigateToPrevTab({ ...source, activeTabId: 'busy' }, true)!.tab.id).toBe('image-draft');
		expect(navigateToTabByIndex(source, 2)!.tab.id).toBe('draft');
		expect(navigateToTabByIndex(source, 1, true)!.tab.id).toBe('draft');
		expect(navigateToTabByIndex(source, -1)).toBeNull();
		expect(navigateToLastTab(source)!.tab.id).toBe('wizard');
		expect(navigateToLastTab(source, true)!.tab.id).toBe('busy');
		expect(navigateToNextTab(session({ aiTabs: [idle], activeTabId: 'idle' }))).toBeNull();
	});

	it('handles AI navigation guard clauses and filtered empty states', () => {
		const readOne = aiTab({ id: 'read-1' });
		const readTwo = aiTab({ id: 'read-2' });
		const unread = aiTab({ id: 'unread', hasUnread: true });
		const empty = session({ aiTabs: [], activeTabId: 'missing' });
		const readOnly = session({ aiTabs: [readOne, readTwo], activeTabId: 'read-1' });
		const singleUnread = session({ aiTabs: [unread, readTwo], activeTabId: 'unread' });

		expect(getActiveTab(null as unknown as Session)).toBeUndefined();
		expect(getActiveTab(empty)).toBeUndefined();
		expect(setActiveTab(null as unknown as Session, 'missing')).toBeNull();
		expect(setActiveTab(empty, 'missing')).toBeNull();
		expect(getWriteModeTab(null as unknown as Session)).toBeUndefined();
		expect(getWriteModeTab(empty)).toBeUndefined();
		expect(getBusyTabs(null as unknown as Session)).toEqual([]);
		expect(getBusyTabs(empty)).toEqual([]);
		expect(navigateToNextTab(empty)).toBeNull();
		expect(navigateToPrevTab(empty)).toBeNull();
		expect(navigateToNextTab(readOnly, true)).toBeNull();
		expect(navigateToPrevTab(readOnly, true)).toBeNull();
		expect(navigateToNextTab(singleUnread, true)).toBeNull();
		expect(navigateToPrevTab(singleUnread, true)).toBeNull();
		expect(navigateToTabByIndex(empty, 0)).toBeNull();
		expect(navigateToTabByIndex(readOnly, 0)!.session).toBe(readOnly);
		expect(navigateToLastTab(readOnly, true)).toBeNull();
	});

	it('navigates unified AI and file tabs with repair, wraparound, unread filtering, and invalid refs', () => {
		const aiOne = aiTab({ id: 'ai-1' });
		const aiTwo = aiTab({ id: 'ai-2', hasUnread: true });
		const aiDraft = aiTab({ id: 'ai-draft', inputValue: 'draft' });
		const fileOne = fileTab({ id: 'file-1', path: '/workspace/a.md', name: 'a.md' });
		const source = session({
			aiTabs: [aiOne, aiTwo, aiDraft],
			activeTabId: 'ai-1',
			filePreviewTabs: [fileOne],
			activeFileTabId: null,
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'file', id: 'missing-file' },
				{ type: 'file', id: 'file-1' },
				{ type: 'ai', id: 'ai-2' },
			],
		});

		expect(navigateToUnifiedTabByIndex(source, -1)).toBeNull();
		expect(navigateToUnifiedTabByIndex(source, 10)).toBeNull();
		expect(navigateToUnifiedTabByIndex(source, 0)!.session.unifiedTabOrder).toHaveLength(4);

		const fileResult = navigateToUnifiedTabByIndex(source, 1)!;
		expect(fileResult).toMatchObject({ type: 'file', id: 'file-1' });
		expect(fileResult.session.activeFileTabId).toBe('file-1');

		const aiResult = navigateToUnifiedTabByIndex({ ...source, activeFileTabId: 'file-1' }, 2)!;
		expect(aiResult).toMatchObject({ type: 'ai', id: 'ai-2' });
		expect(aiResult.session.activeFileTabId).toBeNull();

		expect(navigateToLastUnifiedTab(source)!.id).toBe('ai-draft');
		expect(navigateToNextUnifiedTab(source)!.id).toBe('file-1');
		expect(navigateToPrevUnifiedTab(source)!.id).toBe('ai-draft');
		expect(navigateToNextUnifiedTab({ ...source, activeTabId: 'ai-1' }, true)!.id).toBe('ai-2');
		expect(navigateToPrevUnifiedTab({ ...source, activeTabId: 'ai-1' }, true)!.id).toBe('ai-draft');
		expect(
			navigateToNextUnifiedTab(session({ unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }] }))
		).toBeNull();
	});

	it('handles unified navigation guard clauses, stale refs, and filtered fallbacks', () => {
		const aiOne = aiTab({ id: 'ai-1' });
		const aiTwo = aiTab({ id: 'ai-2', hasUnread: true });
		const readAi = aiTab({ id: 'read-ai' });
		const fileOne = fileTab({ id: 'file-1', path: '/workspace/a.md', name: 'a.md' });
		const empty = session({ aiTabs: [], filePreviewTabs: [], unifiedTabOrder: [] });

		expect(navigateToUnifiedTabByIndex(empty, 0)).toBeNull();
		expect(navigateToLastUnifiedTab(empty)).toBeNull();
		expect(navigateToNextUnifiedTab(empty)).toBeNull();
		expect(navigateToPrevUnifiedTab(empty)).toBeNull();

		const invalidAiRef = session({
			aiTabs: [aiOne],
			activeTabId: 'ai-1',
			unifiedTabOrder: [{ type: 'ai', id: 'missing-ai' }],
		});
		const repairedAiRef = navigateToUnifiedTabByIndex(invalidAiRef, 0)!;
		expect(repairedAiRef).toMatchObject({ type: 'ai', id: 'ai-1' });
		expect(repairedAiRef.session.unifiedTabOrder).toEqual([{ type: 'ai', id: 'ai-1' }]);

		const activeFile = session({
			aiTabs: [aiOne],
			activeTabId: 'ai-1',
			filePreviewTabs: [fileOne],
			activeFileTabId: 'file-1',
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'file', id: 'file-1' },
			],
		});
		expect(navigateToUnifiedTabByIndex(activeFile, 1)!.session).toMatchObject({
			activeFileTabId: 'file-1',
			activeBrowserTabId: null,
			activeTerminalTabId: null,
		});
		expect(navigateToNextUnifiedTab(activeFile)!.id).toBe('ai-1');

		const onlyInvalidRefs = session({
			aiTabs: [],
			activeTabId: 'missing-current',
			filePreviewTabs: [],
			unifiedTabOrder: [
				{ type: 'ai', id: 'missing-ai' },
				{ type: 'file', id: 'missing-file' },
			],
		});
		expect(navigateToLastUnifiedTab(onlyInvalidRefs)).toBeNull();
		expect(navigateToNextUnifiedTab(onlyInvalidRefs)).toBeNull();
		expect(navigateToPrevUnifiedTab(onlyInvalidRefs)).toBeNull();

		const currentMissing = session({
			aiTabs: [aiOne],
			activeTabId: 'missing-current',
			filePreviewTabs: [fileOne],
			activeFileTabId: null,
			unifiedTabOrder: [
				{ type: 'file', id: 'file-1' },
				{ type: 'ai', id: 'ai-1' },
			],
		});
		expect(navigateToNextUnifiedTab(currentMissing)!.id).toBe('file-1');
		expect(navigateToPrevUnifiedTab(currentMissing)!.id).toBe('ai-1');

		const unreadNavigation = session({
			aiTabs: [aiOne, readAi, aiTwo],
			activeTabId: 'ai-1',
			filePreviewTabs: [fileOne],
			activeFileTabId: null,
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'ai', id: 'read-ai' },
				{ type: 'ai', id: 'ai-2' },
				{ type: 'file', id: 'file-1' },
			],
		});
		expect(navigateToNextUnifiedTab(unreadNavigation, true)!.id).toBe('ai-2');
		expect(navigateToPrevUnifiedTab({ ...unreadNavigation, activeTabId: 'ai-2' }, true)).toBeNull();

		const noFilteredUnifiedTarget = session({
			aiTabs: [aiOne, readAi],
			activeTabId: 'ai-1',
			filePreviewTabs: [],
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'ai', id: 'read-ai' },
				{ type: 'file', id: 'missing-file' },
			],
		});
		expect(navigateToNextUnifiedTab(noFilteredUnifiedTarget, true)).toBeNull();
		expect(navigateToPrevUnifiedTab(noFilteredUnifiedTarget, true)).toBeNull();

		const noNormalUnifiedTarget = session({
			aiTabs: [aiOne],
			activeTabId: 'ai-1',
			filePreviewTabs: [],
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'ai', id: 'missing-ai' },
				{ type: 'file', id: 'missing-file' },
			],
		});
		expect(navigateToNextUnifiedTab(noNormalUnifiedTarget)).toBeNull();
		expect(navigateToPrevUnifiedTab(noNormalUnifiedTarget)).toBeNull();
	});

	it('keeps createTabAtPosition stable when creation or anchor lookup fails', () => {
		expect(
			createTabAtPosition(null as unknown as Session, {
				afterTabId: 'missing',
			})
		).toBeNull();

		const source = session({
			aiTabs: [aiTab({ id: 'ai-1' })],
			activeTabId: 'ai-1',
			unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
		});
		const result = createTabAtPosition(source, { afterTabId: 'missing-anchor' })!;
		expect(result.session.aiTabs.at(-1)).toBe(result.tab);
	});

	it('creates merged sessions with real defaults and merged context logs', () => {
		const merged = createMergedSession({
			name: 'Merged Context',
			projectRoot: '/workspace/project',
			toolType: 'codex',
			groupId: 'group-1',
			mergedLogs: [{ id: 'log-1', timestamp: 1, source: 'user', text: 'summarize' }],
			usageStats: {
				inputTokens: 10,
				outputTokens: 20,
				cacheReadInputTokens: 1,
				cacheCreationInputTokens: 2,
				totalCostUsd: 0.03,
				contextWindow: 200000,
			},
			saveToHistory: false,
			showThinking: 'on',
		});

		expect(merged.session).toMatchObject({
			name: 'Merged Context',
			groupId: 'group-1',
			toolType: 'codex',
			cwd: '/workspace/project',
			projectRoot: '/workspace/project',
			inputMode: 'ai',
			activeTabId: merged.tabId,
			activeFileTabId: null,
			autoRunFolderPath: '/workspace/project/.maestro/playbooks',
		});
		expect(merged.session.aiTabs[0]).toMatchObject({
			id: merged.tabId,
			logs: [{ id: 'log-1', timestamp: 1, source: 'user', text: 'summarize' }],
			saveToHistory: false,
			showThinking: 'on',
		});
		expect(merged.session.shellLogs[0].text).toBe('Merged Context Session Ready.');
		expect(merged.session.unifiedTabOrder).toEqual([
			{ type: 'ai', id: merged.tabId },
			{ type: 'terminal', id: merged.session.terminalTabs[0].id },
		]);
	});
});
