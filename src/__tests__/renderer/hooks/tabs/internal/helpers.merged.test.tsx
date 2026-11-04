// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/tabs/internal/browserTabHelpers.test.ts
// Source: src/__tests__/renderer/hooks/tabs/internal/filePreviewTabHelpers.test.ts
// Source: src/__tests__/renderer/hooks/tabs/internal/unifiedCloseHelpers.test.ts
// Source: src/__tests__/renderer/hooks/tabs/internal/useScrollLogHandlers.test.ts
// Source: src/__tests__/renderer/hooks/tabs/internal/useTabDerivedState.test.ts
// Source: src/__tests__/renderer/hooks/tabs/internal/useTerminalTabHandlers.test.ts
import { describe, afterEach, expect, it, vi, beforeEach } from 'vitest';
import {
	createBrowserTab,
	normalizeBrowserTabUpdates,
} from '../../../../../renderer/hooks/tabs/internal/browserTabHelpers';
import { DEFAULT_BROWSER_TAB_URL } from '../../../../../renderer/utils/browserTabPersistence';
import { createMockBrowserTab as s1_createMockBrowserTab } from './testUtils';
import {
	buildFileTabDisplayNames,
	buildReplacementNavigationHistory,
	getFileNameParts,
} from '../../../../../renderer/hooks/tabs/internal/filePreviewTabHelpers';
import { createMockFileTab as s2_createMockFileTab } from './testUtils';
import {
	applyUnifiedTabClosures,
	closeTabGroup,
	excludeDraftRefs,
	excludeHiddenAiRefs,
	excludePreservedRefs,
	getActiveUnifiedRef,
	getRefsExceptActive,
	getRefsLeftOfActive,
	getRefsRightOfActive,
	getTabGroupMemberRefs,
	getTerminalTabIds,
	getWizardTabIds,
} from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
import { createGroupFromTabRefs } from '../../../../../renderer/utils/panelLayout';
import { setLiveDraft } from '../../../../../renderer/utils/liveDraftStore';
import {
	createMockAITab as s3_createMockAITab,
	createMockBrowserTab as s3_createMockBrowserTab,
	createMockFileTab as s3_createMockFileTab,
	createMockTerminalTab as s3_createMockTerminalTab,
	setupSession as s3_setupSession,
	getSession as s3_getSession,
	resetTabHandlerStores as s3_resetTabHandlerStores,
} from './testUtils';
import {
	renderHook as s4_renderHook,
	act as s4_act,
	cleanup as s4_cleanup,
} from '@testing-library/react';
import { useScrollLogHandlers } from '../../../../../renderer/hooks/tabs/internal/useScrollLogHandlers';
import {
	createMockAITab as s4_createMockAITab,
	getSession as s4_getSession,
	resetTabHandlerStores as s4_resetTabHandlerStores,
	setupSession as s4_setupSession,
} from './testUtils';
import {
	renderHook as s5_renderHook,
	act as s5_act,
	cleanup as s5_cleanup,
} from '@testing-library/react';
import {
	getTabDerivedState,
	useTabDerivedState,
} from '../../../../../renderer/hooks/tabs/internal/useTabDerivedState';
import {
	createMockAITab as s5_createMockAITab,
	createMockBrowserTab as s5_createMockBrowserTab,
	createMockFileTab as s5_createMockFileTab,
	createMockTerminalTab as s5_createMockTerminalTab,
	resetTabHandlerStores as s5_resetTabHandlerStores,
	setupSession as s5_setupSession,
} from './testUtils';
import {
	renderHook as s6_renderHook,
	act as s6_act,
	cleanup as s6_cleanup,
} from '@testing-library/react';
import { useTerminalTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useTerminalTabHandlers';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import {
	createMockAITab as s6_createMockAITab,
	createMockTerminalTab as s6_createMockTerminalTab,
	getSession as s6_getSession,
	resetTabHandlerStores as s6_resetTabHandlerStores,
	setupSession as s6_setupSession,
} from './testUtils';
// Source: src/__tests__/renderer/hooks/tabs/internal/browserTabHelpers.test.ts
describe('', () => {
	describe('browserTabHelpers', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});
		it('creates a home browser tab with partition and default title', () => {
			vi.spyOn(Date, 'now').mockReturnValue(1234);
			const tab = createBrowserTab('session/one', DEFAULT_BROWSER_TAB_URL, {
				isLoading: false,
			});
			expect(tab.title).toBe('New Tab');
			expect(tab.createdAt).toBe(1234);
			expect(tab.partition).toBe('persist:maestro-browser-session-session-one');
			expect(tab.isLoading).toBe(false);
		});
		it('creates a loading browser tab for an explicit URL', () => {
			const tab = createBrowserTab('session-1', 'https://example.com/docs', {
				title: 'Docs',
				isLoading: true,
			});
			expect(tab.url).toBe('https://example.com/docs');
			expect(tab.title).toBe('Docs');
			expect(tab.isLoading).toBe(true);
		});
		it('normalizes updated URLs and derives the title when blank', () => {
			const tab = s1_createMockBrowserTab({
				url: 'https://old.example/',
				title: '',
			});
			expect(normalizeBrowserTabUpdates(tab, { url: 'example.com/path', title: '' })).toMatchObject(
				{
					url: 'https://example.com/path',
					title: 'example.com',
				}
			);
		});
	});
});
// Source: src/__tests__/renderer/hooks/tabs/internal/filePreviewTabHelpers.test.ts
describe('', () => {
	describe('filePreviewTabHelpers', () => {
		describe('getFileNameParts', () => {
			it('splits a normal filename into name and extension', () => {
				expect(getFileNameParts('index.test.ts')).toEqual({
					nameWithoutExtension: 'index.test',
					extension: '.ts',
				});
			});
			it('keeps extension empty when no dot exists', () => {
				expect(getFileNameParts('README')).toEqual({
					nameWithoutExtension: 'README',
					extension: '',
				});
			});
			it('preserves the legacy hidden-file behavior', () => {
				expect(getFileNameParts('.env')).toEqual({
					nameWithoutExtension: '',
					extension: '.env',
				});
			});
		});
		describe('buildReplacementNavigationHistory', () => {
			it('adds current file and replacement file when history is empty', () => {
				const tab = s2_createMockFileTab({ path: '/old.ts', name: 'old', scrollTop: 42 });
				expect(
					buildReplacementNavigationHistory(
						tab,
						tab,
						{ path: '/new.ts', name: 'new.ts', content: 'new' },
						'new'
					)
				).toEqual([
					{ path: '/old.ts', name: 'old', scrollTop: 42 },
					{ path: '/new.ts', name: 'new', scrollTop: 0 },
				]);
			});
			it('truncates forward history before adding the replacement file', () => {
				const tab = s2_createMockFileTab({
					path: '/b.ts',
					name: 'b',
					scrollTop: 10,
					navigationHistory: [
						{ path: '/a.ts', name: 'a', scrollTop: 1 },
						{ path: '/b.ts', name: 'b', scrollTop: 2 },
						{ path: '/c.ts', name: 'c', scrollTop: 3 },
					],
					navigationIndex: 1,
				});
				expect(
					buildReplacementNavigationHistory(
						tab,
						tab,
						{ path: '/d.ts', name: 'd.ts', content: 'd' },
						'd'
					)
				).toEqual([
					{ path: '/a.ts', name: 'a', scrollTop: 1 },
					{ path: '/b.ts', name: 'b', scrollTop: 2 },
					{ path: '/d.ts', name: 'd', scrollTop: 0 },
				]);
			});
		});
		describe('buildFileTabDisplayNames', () => {
			const tab = (id: string, path: string) => {
				const { nameWithoutExtension, extension } = getFileNameParts(
					path.split(/[/\\]+/).pop() ?? ''
				);
				return { id, path, name: nameWithoutExtension, extension };
			};
			it('leaves uniquely-named tabs as the bare filename', () => {
				const result = buildFileTabDisplayNames([tab('1', '/a/ioc.go'), tab('2', '/b/service.go')]);
				expect(result.get('1')).toBe('ioc');
				expect(result.get('2')).toBe('service');
			});
			it('prefixes the immediate folder when two filenames collide', () => {
				const result = buildFileTabDisplayNames([
					tab('1', '/proj/ioc/service.go'),
					tab('2', '/proj/api/service.go'),
				]);
				expect(result.get('1')).toBe('ioc/service');
				expect(result.get('2')).toBe('api/service');
			});
			it('deepens the prefix until labels are unique', () => {
				const result = buildFileTabDisplayNames([
					tab('1', '/proj/a/shared/service.go'),
					tab('2', '/proj/b/shared/service.go'),
				]);
				// One folder (shared) collides, so walk up another level.
				expect(result.get('1')).toBe('a/shared/service');
				expect(result.get('2')).toBe('b/shared/service');
			});
			it('does not prefix tabs that share a name but differ in extension', () => {
				const result = buildFileTabDisplayNames([
					tab('1', '/proj/service.go'),
					tab('2', '/proj/service.ts'),
				]);
				expect(result.get('1')).toBe('service');
				expect(result.get('2')).toBe('service');
			});
			it('handles paths of unequal depth without collisions', () => {
				const result = buildFileTabDisplayNames([
					tab('1', '/service.go'),
					tab('2', '/x/service.go'),
				]);
				expect(result.get('1')).toBe('service');
				expect(result.get('2')).toBe('x/service');
			});
			it('disambiguates three or more colliding files', () => {
				const result = buildFileTabDisplayNames([
					tab('1', '/proj/ioc/service.go'),
					tab('2', '/proj/api/service.go'),
					tab('3', '/proj/db/service.go'),
				]);
				expect(result.get('1')).toBe('ioc/service');
				expect(result.get('2')).toBe('api/service');
				expect(result.get('3')).toBe('db/service');
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/tabs/internal/unifiedCloseHelpers.test.ts
describe('', () => {
	describe('unifiedCloseHelpers', () => {
		beforeEach(() => {
			s3_resetTabHandlerStores();
		});
		it('resolves the active unified ref using terminal only when terminal mode is active', () => {
			const aiTab = s3_createMockAITab({ id: 'ai-1' });
			const terminalTab = s3_createMockTerminalTab({ id: 'term-1' });
			s3_setupSession({
				aiTabs: [aiTab],
				terminalTabs: [terminalTab],
				activeTerminalTabId: terminalTab.id,
				inputMode: 'ai',
			});
			expect(getActiveUnifiedRef(s3_getSession())).toEqual({ type: 'ai', id: 'ai-1' });
			s3_setupSession({
				aiTabs: [aiTab],
				terminalTabs: [terminalTab],
				activeTerminalTabId: terminalTab.id,
				inputMode: 'terminal',
			});
			expect(getActiveUnifiedRef(s3_getSession())).toEqual({ type: 'terminal', id: 'term-1' });
		});
		it('returns refs left, right, and except active in unified order', () => {
			const ai1 = s3_createMockAITab({ id: 'ai-1' });
			const ai2 = s3_createMockAITab({ id: 'ai-2' });
			const fileTab = s3_createMockFileTab({ id: 'file-1' });
			s3_setupSession({
				aiTabs: [ai1, ai2],
				filePreviewTabs: [fileTab],
				activeFileTabId: fileTab.id,
				unifiedTabOrder: [
					{ type: 'ai', id: ai1.id },
					{ type: 'file', id: fileTab.id },
					{ type: 'ai', id: ai2.id },
				],
			});
			expect(getRefsLeftOfActive(s3_getSession())).toEqual([{ type: 'ai', id: 'ai-1' }]);
			expect(getRefsRightOfActive(s3_getSession())).toEqual([{ type: 'ai', id: 'ai-2' }]);
			expect(getRefsExceptActive(s3_getSession())).toEqual([
				{ type: 'ai', id: 'ai-1' },
				{ type: 'ai', id: 'ai-2' },
			]);
		});
		it('pivots on an explicit clicked tab id, not the active tab', () => {
			const ai1 = s3_createMockAITab({ id: 'ai-1' });
			const ai2 = s3_createMockAITab({ id: 'ai-2' });
			const ai3 = s3_createMockAITab({ id: 'ai-3' });
			s3_setupSession({
				aiTabs: [ai1, ai2, ai3],
				// Active is the LAST tab - a naive "close right of active" would close nothing.
				activeTabId: ai3.id,
				unifiedTabOrder: [
					{ type: 'ai', id: ai1.id },
					{ type: 'ai', id: ai2.id },
					{ type: 'ai', id: ai3.id },
				],
			});
			// Pivot explicitly on the clicked middle tab (ai2).
			expect(getRefsRightOfActive(s3_getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-3' }]);
			expect(getRefsLeftOfActive(s3_getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-1' }]);
			expect(getRefsExceptActive(s3_getSession(), 'ai-2')).toEqual([
				{ type: 'ai', id: 'ai-1' },
				{ type: 'ai', id: 'ai-3' },
			]);
		});
		it('computes close sets against the repaired order, ignoring stale unified refs', () => {
			// Raw unifiedTabOrder carries a stale ref ('ghost', no live tab) plus a
			// duplicate. The repaired order the tab bar renders is [ai-1, ai-2, ai-3].
			// Slicing the raw order (the old behavior) would mis-place the pivot and
			// could close the wrong set; the repaired order keeps it correct.
			const ai1 = s3_createMockAITab({ id: 'ai-1' });
			const ai2 = s3_createMockAITab({ id: 'ai-2' });
			const ai3 = s3_createMockAITab({ id: 'ai-3' });
			s3_setupSession({
				aiTabs: [ai1, ai2, ai3],
				activeTabId: ai1.id,
				unifiedTabOrder: [
					{ type: 'ai', id: 'ghost' },
					{ type: 'ai', id: ai1.id },
					{ type: 'ai', id: ai1.id }, // duplicate
					{ type: 'ai', id: ai2.id },
					{ type: 'ai', id: ai3.id },
				],
			});
			// Pivot ai-1 is visually first → close-right is everything else; close-left empty.
			expect(getRefsRightOfActive(s3_getSession(), 'ai-1')).toEqual([
				{ type: 'ai', id: 'ai-2' },
				{ type: 'ai', id: 'ai-3' },
			]);
			expect(getRefsLeftOfActive(s3_getSession(), 'ai-1')).toEqual([]);
			// Pivot ai-2 (visually middle) → exactly ai-3 to the right, ai-1 to the left.
			expect(getRefsRightOfActive(s3_getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-3' }]);
			expect(getRefsLeftOfActive(s3_getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-1' }]);
		});
		it('collects terminal and wizard tab ids from refs', () => {
			const wizardTab = s3_createMockAITab({
				id: 'wizard',
				wizardState: { isActive: true } as any,
			});
			const terminalTab = s3_createMockTerminalTab({ id: 'term-1' });
			s3_setupSession({
				aiTabs: [wizardTab],
				terminalTabs: [terminalTab],
			});
			const refs = [
				{ type: 'ai' as const, id: 'wizard' },
				{ type: 'terminal' as const, id: 'term-1' },
			];
			expect(getTerminalTabIds(refs)).toEqual(['term-1']);
			expect(getWizardTabIds(s3_getSession(), refs)).toEqual(['wizard']);
		});
		it('excludes only AI refs that hold an unsent draft from the close set', () => {
			const ai1 = s3_createMockAITab({ id: 'ai-1' });
			const ai2 = s3_createMockAITab({ id: 'ai-2' });
			const fileTab = s3_createMockFileTab({ id: 'file-1' });
			s3_setupSession({ aiTabs: [ai1, ai2], filePreviewTabs: [fileTab] });
			setLiveDraft('ai-2', 'pending text');
			const refs = [
				{ type: 'ai' as const, id: 'ai-1' },
				{ type: 'ai' as const, id: 'ai-2' },
				{ type: 'file' as const, id: 'file-1' },
			];
			// ai-2 (the draft tab) is preserved; ai-1 and the file tab still close.
			expect(excludeDraftRefs(s3_getSession(), refs)).toEqual([
				{ type: 'ai', id: 'ai-1' },
				{ type: 'file', id: 'file-1' },
			]);
		});
		it('returns the same ref array when no tab has a draft', () => {
			const ai1 = s3_createMockAITab({ id: 'ai-1' });
			s3_setupSession({ aiTabs: [ai1] });
			const refs = [{ type: 'ai' as const, id: 'ai-1' }];
			expect(excludeDraftRefs(s3_getSession(), refs)).toBe(refs);
		});
		it('excludes hidden consult tabs from the close set', () => {
			const ai1 = s3_createMockAITab({ id: 'ai-1' });
			const consult = s3_createMockAITab({ id: 'consult', hidden: true });
			s3_setupSession({ aiTabs: [ai1, consult] });
			const refs = [
				{ type: 'ai' as const, id: 'ai-1' },
				{ type: 'ai' as const, id: 'consult' },
			];
			expect(excludeHiddenAiRefs(s3_getSession(), refs)).toEqual([{ type: 'ai', id: 'ai-1' }]);
		});
		it('returns the same ref array when no tab is hidden', () => {
			const ai1 = s3_createMockAITab({ id: 'ai-1' });
			s3_setupSession({ aiTabs: [ai1] });
			const refs = [{ type: 'ai' as const, id: 'ai-1' }];
			expect(excludeHiddenAiRefs(s3_getSession(), refs)).toBe(refs);
		});
		it('preserves both drafts and hidden consult tabs in one pass', () => {
			const ai1 = s3_createMockAITab({ id: 'ai-1' });
			const ai2 = s3_createMockAITab({ id: 'ai-2' });
			const consult = s3_createMockAITab({ id: 'consult', hidden: true });
			s3_setupSession({ aiTabs: [ai1, ai2, consult] });
			setLiveDraft('ai-2', 'pending text');
			const refs = [
				{ type: 'ai' as const, id: 'ai-1' },
				{ type: 'ai' as const, id: 'ai-2' },
				{ type: 'ai' as const, id: 'consult' },
			];
			expect(excludePreservedRefs(s3_getSession(), refs)).toEqual([{ type: 'ai', id: 'ai-1' }]);
		});
		it('closes mixed tab refs while preserving browser unified history', () => {
			const ai1 = s3_createMockAITab({ id: 'ai-1' });
			const ai2 = s3_createMockAITab({ id: 'ai-2' });
			const fileTab = s3_createMockFileTab({ id: 'file-1' });
			const browserTab = s3_createMockBrowserTab({ id: 'browser-1' });
			s3_setupSession({
				aiTabs: [ai1, ai2],
				filePreviewTabs: [fileTab],
				browserTabs: [browserTab],
				activeTabId: ai1.id,
				unifiedTabOrder: [
					{ type: 'ai', id: ai1.id },
					{ type: 'file', id: fileTab.id },
					{ type: 'browser', id: browserTab.id },
					{ type: 'ai', id: ai2.id },
				],
			});
			const nextSession = applyUnifiedTabClosures(s3_getSession(), [
				{ type: 'file', id: fileTab.id },
				{ type: 'browser', id: browserTab.id },
				{ type: 'ai', id: ai2.id },
			]);
			expect(nextSession.filePreviewTabs).toEqual([]);
			expect(nextSession.browserTabs).toEqual([]);
			expect(nextSession.aiTabs.map((tab) => tab.id)).toEqual(['ai-1']);
			expect(nextSession.unifiedTabOrder).toEqual([{ type: 'ai', id: 'ai-1' }]);
			// Both the browser tab and the bulk-closed AI tab are recorded so they can
			// be reopened via Cmd+Shift+T. ai-2 is closed last, so it is most-recent.
			const history = nextSession.unifiedClosedTabHistory ?? [];
			const historyTypes = history.map((e) => e.type);
			expect(historyTypes).toContain('browser');
			expect(historyTypes).toContain('ai');
			const mostRecent = history[0];
			expect(mostRecent.type).toBe('ai');
			expect(mostRecent.tab.id).toBe('ai-2');
		});
		it('does not record wizard tabs into the unified history on bulk close', () => {
			const ai1 = s3_createMockAITab({ id: 'ai-1' });
			const wizardTab = s3_createMockAITab({
				id: 'wizard',
				wizardState: { isActive: true } as any,
			});
			s3_setupSession({
				aiTabs: [ai1, wizardTab],
				activeTabId: ai1.id,
				unifiedTabOrder: [
					{ type: 'ai', id: ai1.id },
					{ type: 'ai', id: wizardTab.id },
				],
			});
			const nextSession = applyUnifiedTabClosures(s3_getSession(), [
				{ type: 'ai', id: wizardTab.id },
			]);
			expect(nextSession.aiTabs.map((tab) => tab.id)).toEqual(['ai-1']);
			expect(nextSession.unifiedClosedTabHistory ?? []).toEqual([]);
		});
		describe('closeTabGroup', () => {
			it('closes every member, drops the group, and lands on the chip to its left', () => {
				const before = s3_createMockAITab({ id: 'ai-before' });
				const member = s3_createMockAITab({ id: 'ai-member' });
				const file = s3_createMockFileTab({ id: 'file-member' });
				const after = s3_createMockAITab({ id: 'ai-after' });
				const group = createGroupFromTabRefs(
					[
						{ type: 'ai', id: member.id },
						{ type: 'file', id: file.id },
					],
					'Pair'
				);
				s3_setupSession({
					aiTabs: [before, member, after],
					filePreviewTabs: [file],
					tabGroups: [group],
					activeGroupId: group.id,
					activeTabId: member.id,
					unifiedTabOrder: [
						{ type: 'ai', id: before.id },
						{ type: 'group', id: group.id },
						{ type: 'ai', id: after.id },
					],
				});
				expect(getTabGroupMemberRefs(s3_getSession(), group.id)).toEqual([
					{ type: 'ai', id: member.id },
					{ type: 'file', id: file.id },
				]);
				const next = closeTabGroup(s3_getSession(), group.id);
				expect(next.tabGroups).toEqual([]);
				expect(next.activeGroupId).toBeNull();
				expect(next.aiTabs.map((t) => t.id)).toEqual(['ai-before', 'ai-after']);
				expect(next.filePreviewTabs).toEqual([]);
				expect(next.unifiedTabOrder).toEqual([
					{ type: 'ai', id: 'ai-before' },
					{ type: 'ai', id: 'ai-after' },
				]);
				expect(next.activeTabId).toBe('ai-before');
				expect(next.activeFileTabId).toBeNull();
				expect(next.inputMode).toBe('ai');
				// The closed AI pane can be reopened like any other closed tab.
				expect((next.unifiedClosedTabHistory ?? []).some((e) => e.tab.id === 'ai-member')).toBe(
					true
				);
			});
			it('lands on the chip to its right when the group led the strip', () => {
				const member1 = s3_createMockAITab({ id: 'ai-m1' });
				const member2 = s3_createMockAITab({ id: 'ai-m2' });
				const after = s3_createMockAITab({ id: 'ai-after' });
				const group = createGroupFromTabRefs(
					[
						{ type: 'ai', id: member1.id },
						{ type: 'ai', id: member2.id },
					],
					'Pair'
				);
				s3_setupSession({
					aiTabs: [member1, member2, after],
					tabGroups: [group],
					activeGroupId: group.id,
					activeTabId: member1.id,
					unifiedTabOrder: [
						{ type: 'group', id: group.id },
						{ type: 'ai', id: after.id },
					],
				});
				const next = closeTabGroup(s3_getSession(), group.id);
				expect(next.aiTabs.map((t) => t.id)).toEqual(['ai-after']);
				expect(next.activeTabId).toBe('ai-after');
				expect(next.activeGroupId).toBeNull();
			});
			it('leaves the current view alone when the group is in the background', () => {
				const member1 = s3_createMockAITab({ id: 'ai-m1' });
				const member2 = s3_createMockAITab({ id: 'ai-m2' });
				const file = s3_createMockFileTab({ id: 'file-open' });
				const group = createGroupFromTabRefs(
					[
						{ type: 'ai', id: member1.id },
						{ type: 'ai', id: member2.id },
					],
					'Pair'
				);
				// activeTabId still points at a member: focusing a file tab leaves it alone.
				s3_setupSession({
					aiTabs: [member1, member2],
					filePreviewTabs: [file],
					tabGroups: [group],
					activeGroupId: null,
					activeTabId: member1.id,
					activeFileTabId: file.id,
					unifiedTabOrder: [
						{ type: 'group', id: group.id },
						{ type: 'file', id: file.id },
					],
				});
				const next = closeTabGroup(s3_getSession(), group.id);
				expect(next.aiTabs).toEqual([]);
				expect(next.activeFileTabId).toBe('file-open');
				expect(next.unifiedTabOrder).toEqual([{ type: 'file', id: 'file-open' }]);
			});
			it('mints a fresh AI tab when the group held every tab the agent had', () => {
				const file = s3_createMockFileTab({ id: 'file-m' });
				const terminal = s3_createMockTerminalTab({ id: 'term-m' });
				const group = createGroupFromTabRefs(
					[
						{ type: 'file', id: file.id },
						{ type: 'terminal', id: terminal.id },
					],
					'Tools'
				);
				s3_setupSession({
					aiTabs: [],
					filePreviewTabs: [file],
					terminalTabs: [terminal],
					tabGroups: [group],
					activeGroupId: group.id,
					unifiedTabOrder: [{ type: 'group', id: group.id }],
				});
				const next = closeTabGroup(s3_getSession(), group.id);
				expect(next.filePreviewTabs).toEqual([]);
				expect(next.terminalTabs).toEqual([]);
				expect(next.aiTabs).toHaveLength(1);
				expect(next.activeTabId).toBe(next.aiTabs[0].id);
				expect(next.unifiedTabOrder).toEqual([{ type: 'ai', id: next.aiTabs[0].id }]);
			});
			it('does not count a hidden consult tab as a surviving tab', () => {
				const consult = s3_createMockAITab({ id: 'consult-1', hidden: true });
				const file = s3_createMockFileTab({ id: 'file-m' });
				const terminal = s3_createMockTerminalTab({ id: 'term-m' });
				const group = createGroupFromTabRefs(
					[
						{ type: 'file', id: file.id },
						{ type: 'terminal', id: terminal.id },
					],
					'Tools'
				);
				s3_setupSession({
					aiTabs: [consult],
					activeTabId: '',
					filePreviewTabs: [file],
					terminalTabs: [terminal],
					tabGroups: [group],
					activeGroupId: group.id,
					unifiedTabOrder: [
						{ type: 'ai', id: consult.id },
						{ type: 'group', id: group.id },
					],
				});
				const next = closeTabGroup(s3_getSession(), group.id);
				const fresh = next.aiTabs.find((t) => t.id !== 'consult-1');
				expect(fresh).toBeDefined();
				expect(fresh!.hidden).toBeFalsy();
				expect(next.activeTabId).toBe(fresh!.id);
				expect(next.aiTabs.some((t) => t.id === 'consult-1')).toBe(true);
			});
			it('is a no-op for an unknown group id', () => {
				s3_setupSession();
				const session = s3_getSession();
				expect(closeTabGroup(session, 'missing')).toBe(session);
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/tabs/internal/useScrollLogHandlers.test.ts
describe('', () => {
	describe('useScrollLogHandlers', () => {
		beforeEach(() => {
			s4_resetTabHandlerStores();
		});
		afterEach(() => {
			s4_cleanup();
		});
		it('updates active AI tab scroll and at-bottom unread state', () => {
			const tab = s4_createMockAITab({ id: 'ai-1', hasUnread: true });
			s4_setupSession({ aiTabs: [tab] });
			const { result } = s4_renderHook(() => useScrollLogHandlers());
			s4_act(() => {
				result.current.handleScrollPositionChange(123);
				result.current.handleAtBottomChange(true);
			});
			expect(s4_getSession().aiTabs[0]).toMatchObject({
				scrollTop: 123,
				isAtBottom: true,
				hasUnread: false,
			});
		});
		it('updates terminal scroll when terminal mode is active', () => {
			s4_setupSession({ inputMode: 'terminal' });
			const { result } = s4_renderHook(() => useScrollLogHandlers());
			s4_act(() => {
				result.current.handleScrollPositionChange(456);
			});
			expect(s4_getSession().terminalScrollTop).toBe(456);
		});
		it('deletes an AI user message pair and command history entry', async () => {
			const tab = s4_createMockAITab({
				id: 'ai-1',
				agentSessionId: 'agent-1',
				logs: [
					{ id: 'u1', source: 'user', text: 'run tests', timestamp: Date.now() },
					{ id: 'a1', source: 'claude', text: 'ok', timestamp: Date.now() },
					{ id: 'u2', source: 'user', text: 'next', timestamp: Date.now() },
				] as any,
			});
			s4_setupSession({
				aiTabs: [tab],
				cwd: '/repo',
				aiCommandHistory: ['run tests', 'next'],
			});
			vi.mocked(window.maestro.claude.deleteMessagePair).mockResolvedValue({ success: true });
			const { result } = s4_renderHook(() => useScrollLogHandlers());
			let nextIndex: number | null = null;
			s4_act(() => {
				nextIndex = result.current.handleDeleteLog('u1');
			});
			expect(nextIndex).toBe(0);
			expect(s4_getSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['u2']);
			expect(s4_getSession().aiCommandHistory).toEqual(['next']);
			await vi.waitFor(() => {
				expect(window.maestro.claude.deleteMessagePair).toHaveBeenCalledWith(
					'/repo',
					'agent-1',
					'u1',
					'run tests'
				);
			});
		});
		describe('deleting a command-mode card', () => {
			function cardLog(id: string, command: string) {
				return {
					id,
					source: 'stdout',
					text: 'output',
					timestamp: Date.now(),
					shellCommand: { command, cwd: '/repo', status: 'finished', exitCode: 0 },
				};
			}
			it('removes just that card and prunes its bang-prefixed recall entry', () => {
				const tab = s4_createMockAITab({
					id: 'ai-1',
					agentSessionId: 'agent-1',
					logs: [
						{ id: 'u1', source: 'user', text: 'run tests', timestamp: Date.now() },
						cardLog('c1', 'npm test'),
						{ id: 'a1', source: 'claude', text: 'ok', timestamp: Date.now() },
					] as any,
				});
				s4_setupSession({
					aiTabs: [tab],
					cwd: '/repo',
					aiCommandHistory: ['!npm test', 'run tests'],
				});
				const { result } = s4_renderHook(() => useScrollLogHandlers());
				let nextIndex: number | null = 0;
				s4_act(() => {
					nextIndex = result.current.handleDeleteLog('c1');
				});
				// Only the card goes; the surrounding conversation is untouched.
				expect(s4_getSession().aiTabs[0].logs.map((log) => log.id)).toEqual(['u1', 'a1']);
				expect(s4_getSession().aiCommandHistory).toEqual(['run tests']);
				// No scroll target - removing a card should not move the reader.
				expect(nextIndex).toBeNull();
			});
			it('never asks the provider to delete a message pair for it', () => {
				// The agent was bypassed entirely, so there is no pair in its session.
				const tab = s4_createMockAITab({
					id: 'ai-1',
					agentSessionId: 'agent-1',
					logs: [cardLog('c1', 'npm test')] as any,
				});
				s4_setupSession({ aiTabs: [tab], cwd: '/repo', aiCommandHistory: ['!npm test'] });
				const { result } = s4_renderHook(() => useScrollLogHandlers());
				s4_act(() => {
					result.current.handleDeleteLog('c1');
				});
				expect(window.maestro.claude.deleteMessagePair).not.toHaveBeenCalled();
			});
			it('keeps the recall entry while another card still shows that command', () => {
				// aiCommandHistory is per agent and deduplicated, so pruning on the
				// first delete would contradict the cards still on screen.
				const tab = s4_createMockAITab({
					id: 'ai-1',
					logs: [cardLog('c1', 'ls'), cardLog('c2', 'ls')] as any,
				});
				s4_setupSession({ aiTabs: [tab], aiCommandHistory: ['!ls'] });
				const { result } = s4_renderHook(() => useScrollLogHandlers());
				s4_act(() => {
					result.current.handleDeleteLog('c1');
				});
				expect(s4_getSession().aiCommandHistory).toEqual(['!ls']);
				s4_act(() => {
					result.current.handleDeleteLog('c2');
				});
				expect(s4_getSession().aiCommandHistory).toEqual([]);
			});
			it('counts survivors across every tab, not just the active one', () => {
				const active = s4_createMockAITab({ id: 'ai-1', logs: [cardLog('c1', 'ls')] as any });
				const other = s4_createMockAITab({ id: 'ai-2', logs: [cardLog('c2', 'ls')] as any });
				s4_setupSession({ aiTabs: [active, other], aiCommandHistory: ['!ls'] });
				const { result } = s4_renderHook(() => useScrollLogHandlers());
				s4_act(() => {
					result.current.handleDeleteLog('c1');
				});
				// Guard against a silent no-op passing this assertion: the card really
				// went, and the recall entry really survived because ai-2 still has one.
				expect(s4_getSession().aiTabs[0].logs).toEqual([]);
				expect(s4_getSession().aiCommandHistory).toEqual(['!ls']);
			});
		});
		it('deletes shell logs and returns null for non-user logs', () => {
			s4_setupSession({
				inputMode: 'terminal',
				shellLogs: [
					{ id: 's1', source: 'system', text: 'boot', timestamp: Date.now() },
					{ id: 'u1', source: 'user', text: 'pwd', timestamp: Date.now() },
					{ id: 'o1', source: 'stdout', text: '/repo', timestamp: Date.now() },
				] as any,
				shellCommandHistory: ['pwd'],
			});
			const { result } = s4_renderHook(() => useScrollLogHandlers());
			expect(result.current.handleDeleteLog('s1')).toBeNull();
			s4_act(() => {
				expect(result.current.handleDeleteLog('u1')).toBeNull();
			});
			expect(s4_getSession().shellLogs.map((log) => log.id)).toEqual(['s1']);
			expect(s4_getSession().shellCommandHistory).toEqual([]);
		});
	});
});
// Source: src/__tests__/renderer/hooks/tabs/internal/useTabDerivedState.test.ts
describe('', () => {
	describe('getTabDerivedState', () => {
		it('returns empty derived state for null session', () => {
			const result = getTabDerivedState(null);
			expect(result.activeTab).toBeUndefined();
			expect(result.unifiedTabs).toEqual([]);
			expect(result.activeFileTab).toBeNull();
			expect(result.isResumingSession).toBe(false);
		});
	});
	describe('useTabDerivedState', () => {
		beforeEach(() => {
			s5_resetTabHandlerStores();
		});
		afterEach(() => {
			s5_cleanup();
		});
		it('returns empty derived state when no session exists', () => {
			const { result } = s5_renderHook(() => useTabDerivedState());
			expect(result.current.activeTab).toBeUndefined();
			expect(result.current.unifiedTabs).toEqual([]);
			expect(result.current.activeFileTab).toBeNull();
			expect(result.current.activeBrowserTab).toBeNull();
			expect(result.current.fileTabCanGoBack).toBe(false);
			expect(result.current.fileTabCanGoForward).toBe(false);
		});
		it('computes active AI, file, browser, and unified tab order', () => {
			const aiTab = s5_createMockAITab({ id: 'ai-1', agentSessionId: 'agent-session' });
			const fileTab = s5_createMockFileTab({ id: 'file-1', name: 'readme' });
			const browserTab = s5_createMockBrowserTab({ id: 'browser-1' });
			const terminalTab = s5_createMockTerminalTab({ id: 'term-1' });
			const { result } = s5_renderHook(() => useTabDerivedState());
			s5_act(() => {
				s5_setupSession({
					aiTabs: [aiTab],
					filePreviewTabs: [fileTab],
					browserTabs: [browserTab],
					terminalTabs: [terminalTab],
					activeFileTabId: fileTab.id,
					activeBrowserTabId: browserTab.id,
					unifiedTabOrder: [
						{ type: 'terminal', id: terminalTab.id },
						{ type: 'browser', id: browserTab.id },
						{ type: 'file', id: fileTab.id },
						{ type: 'ai', id: aiTab.id },
					],
				});
			});
			expect(result.current.activeTab?.id).toBe('ai-1');
			expect(result.current.activeFileTab?.id).toBe('file-1');
			expect(result.current.activeBrowserTab?.id).toBe('browser-1');
			expect(result.current.isResumingSession).toBe(true);
			expect(result.current.unifiedTabs.map((tab) => `${tab.type}:${tab.id}`)).toEqual([
				'terminal:term-1',
				'browser:browser-1',
				'file:file-1',
				'ai:ai-1',
			]);
		});
		it('computes file tab back and forward history for the active file tab', () => {
			const fileTab = s5_createMockFileTab({
				id: 'file-1',
				navigationHistory: [
					{ path: '/a.ts', name: 'a', scrollTop: 1 },
					{ path: '/b.ts', name: 'b', scrollTop: 2 },
					{ path: '/c.ts', name: 'c', scrollTop: 3 },
				],
				navigationIndex: 1,
			});
			s5_setupSession({
				filePreviewTabs: [fileTab],
				activeFileTabId: fileTab.id,
			});
			const { result } = s5_renderHook(() => useTabDerivedState());
			expect(result.current.activeFileTabNavIndex).toBe(1);
			expect(result.current.fileTabBackHistory).toEqual([
				{ path: '/a.ts', name: 'a', scrollTop: 1 },
			]);
			expect(result.current.fileTabForwardHistory).toEqual([
				{ path: '/c.ts', name: 'c', scrollTop: 3 },
			]);
			expect(result.current.fileTabCanGoBack).toBe(true);
			expect(result.current.fileTabCanGoForward).toBe(true);
		});
	});
});
// Source: src/__tests__/renderer/hooks/tabs/internal/useTerminalTabHandlers.test.ts
describe('', () => {
	describe('useTerminalTabHandlers', () => {
		beforeEach(() => {
			s6_resetTabHandlerStores();
		});
		afterEach(() => {
			s6_cleanup();
		});
		it('opens and selects terminal tabs through tabStore', () => {
			s6_setupSession({ aiTabs: [s6_createMockAITab({ id: 'ai-1' })] });
			const { result } = s6_renderHook(() => useTerminalTabHandlers());
			s6_act(() => {
				result.current.handleOpenTerminalTab({ shell: 'bash', cwd: '/repo', name: 'Local' });
			});
			const terminalTab = s6_getSession().terminalTabs[0];
			expect(terminalTab).toMatchObject({ shellType: 'bash', cwd: '/repo', name: 'Local' });
			expect(s6_getSession().activeTerminalTabId).toBe(terminalTab.id);
		});
		it('closes idle terminal tabs immediately', async () => {
			const terminalTab = s6_createMockTerminalTab({ id: 'term-1' });
			s6_setupSession({
				terminalTabs: [terminalTab],
				activeTerminalTabId: terminalTab.id,
				inputMode: 'terminal',
			});
			vi.mocked(window.maestro.process.isTerminalBusy).mockResolvedValue(false);
			const { result } = s6_renderHook(() => useTerminalTabHandlers());
			await s6_act(async () => {
				result.current.handleCloseTerminalTab('term-1');
				await Promise.resolve();
			});
			expect(window.maestro.process.isTerminalBusy).toHaveBeenCalledWith(
				'test-session-terminal-term-1'
			);
			expect(s6_getSession().terminalTabs).toHaveLength(0);
		});
		it('opens a destructive confirmation when the terminal is busy', async () => {
			const terminalTab = s6_createMockTerminalTab({ id: 'term-1' });
			s6_setupSession({
				terminalTabs: [terminalTab],
				activeTerminalTabId: terminalTab.id,
				inputMode: 'terminal',
			});
			vi.mocked(window.maestro.process.isTerminalBusy).mockResolvedValue(true);
			const { result } = s6_renderHook(() => useTerminalTabHandlers());
			await s6_act(async () => {
				result.current.handleCloseTerminalTab('term-1');
				await Promise.resolve();
			});
			const modal = useModalStore.getState().modals.get('confirm');
			expect(modal?.data?.destructive).toBe(true);
			expect(s6_getSession().terminalTabs).toHaveLength(1);
			s6_act(() => {
				modal?.data?.onConfirm();
			});
			expect(s6_getSession().terminalTabs).toHaveLength(0);
		});
	});
});
