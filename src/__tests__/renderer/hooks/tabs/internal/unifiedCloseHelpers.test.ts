import { beforeEach, describe, expect, it } from 'vitest';
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
	createMockAITab,
	createMockBrowserTab,
	createMockFileTab,
	createMockTerminalTab,
	setupSession,
	getSession,
	resetTabHandlerStores,
} from './testUtils';

describe('unifiedCloseHelpers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
	});

	it('resolves the active unified ref using terminal only when terminal mode is active', () => {
		const aiTab = createMockAITab({ id: 'ai-1' });
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		setupSession({
			aiTabs: [aiTab],
			terminalTabs: [terminalTab],
			activeTerminalTabId: terminalTab.id,
			inputMode: 'ai',
		});

		expect(getActiveUnifiedRef(getSession())).toEqual({ type: 'ai', id: 'ai-1' });

		setupSession({
			aiTabs: [aiTab],
			terminalTabs: [terminalTab],
			activeTerminalTabId: terminalTab.id,
			inputMode: 'terminal',
		});

		expect(getActiveUnifiedRef(getSession())).toEqual({ type: 'terminal', id: 'term-1' });
	});

	it('returns refs left, right, and except active in unified order', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const fileTab = createMockFileTab({ id: 'file-1' });
		setupSession({
			aiTabs: [ai1, ai2],
			filePreviewTabs: [fileTab],
			activeFileTabId: fileTab.id,
			unifiedTabOrder: [
				{ type: 'ai', id: ai1.id },
				{ type: 'file', id: fileTab.id },
				{ type: 'ai', id: ai2.id },
			],
		});

		expect(getRefsLeftOfActive(getSession())).toEqual([{ type: 'ai', id: 'ai-1' }]);
		expect(getRefsRightOfActive(getSession())).toEqual([{ type: 'ai', id: 'ai-2' }]);
		expect(getRefsExceptActive(getSession())).toEqual([
			{ type: 'ai', id: 'ai-1' },
			{ type: 'ai', id: 'ai-2' },
		]);
	});

	it('pivots on an explicit clicked tab id, not the active tab', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const ai3 = createMockAITab({ id: 'ai-3' });
		setupSession({
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
		expect(getRefsRightOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-3' }]);
		expect(getRefsLeftOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-1' }]);
		expect(getRefsExceptActive(getSession(), 'ai-2')).toEqual([
			{ type: 'ai', id: 'ai-1' },
			{ type: 'ai', id: 'ai-3' },
		]);
	});

	it('computes close sets against the repaired order, ignoring stale unified refs', () => {
		// Raw unifiedTabOrder carries a stale ref ('ghost', no live tab) plus a
		// duplicate. The repaired order the tab bar renders is [ai-1, ai-2, ai-3].
		// Slicing the raw order (the old behavior) would mis-place the pivot and
		// could close the wrong set; the repaired order keeps it correct.
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const ai3 = createMockAITab({ id: 'ai-3' });
		setupSession({
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
		expect(getRefsRightOfActive(getSession(), 'ai-1')).toEqual([
			{ type: 'ai', id: 'ai-2' },
			{ type: 'ai', id: 'ai-3' },
		]);
		expect(getRefsLeftOfActive(getSession(), 'ai-1')).toEqual([]);
		// Pivot ai-2 (visually middle) → exactly ai-3 to the right, ai-1 to the left.
		expect(getRefsRightOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-3' }]);
		expect(getRefsLeftOfActive(getSession(), 'ai-2')).toEqual([{ type: 'ai', id: 'ai-1' }]);
	});

	it('collects terminal and wizard tab ids from refs', () => {
		const wizardTab = createMockAITab({
			id: 'wizard',
			wizardState: { isActive: true } as any,
		});
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		setupSession({
			aiTabs: [wizardTab],
			terminalTabs: [terminalTab],
		});
		const refs = [
			{ type: 'ai' as const, id: 'wizard' },
			{ type: 'terminal' as const, id: 'term-1' },
		];

		expect(getTerminalTabIds(refs)).toEqual(['term-1']);
		expect(getWizardTabIds(getSession(), refs)).toEqual(['wizard']);
	});

	it('excludes only AI refs that hold an unsent draft from the close set', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const fileTab = createMockFileTab({ id: 'file-1' });
		setupSession({ aiTabs: [ai1, ai2], filePreviewTabs: [fileTab] });
		setLiveDraft('ai-2', 'pending text');

		const refs = [
			{ type: 'ai' as const, id: 'ai-1' },
			{ type: 'ai' as const, id: 'ai-2' },
			{ type: 'file' as const, id: 'file-1' },
		];

		// ai-2 (the draft tab) is preserved; ai-1 and the file tab still close.
		expect(excludeDraftRefs(getSession(), refs)).toEqual([
			{ type: 'ai', id: 'ai-1' },
			{ type: 'file', id: 'file-1' },
		]);
	});

	it('returns the same ref array when no tab has a draft', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		setupSession({ aiTabs: [ai1] });
		const refs = [{ type: 'ai' as const, id: 'ai-1' }];
		expect(excludeDraftRefs(getSession(), refs)).toBe(refs);
	});

	it('excludes hidden consult tabs from the close set', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const consult = createMockAITab({ id: 'consult', hidden: true });
		setupSession({ aiTabs: [ai1, consult] });

		const refs = [
			{ type: 'ai' as const, id: 'ai-1' },
			{ type: 'ai' as const, id: 'consult' },
		];

		expect(excludeHiddenAiRefs(getSession(), refs)).toEqual([{ type: 'ai', id: 'ai-1' }]);
	});

	it('returns the same ref array when no tab is hidden', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		setupSession({ aiTabs: [ai1] });
		const refs = [{ type: 'ai' as const, id: 'ai-1' }];
		expect(excludeHiddenAiRefs(getSession(), refs)).toBe(refs);
	});

	it('preserves both drafts and hidden consult tabs in one pass', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const consult = createMockAITab({ id: 'consult', hidden: true });
		setupSession({ aiTabs: [ai1, ai2, consult] });
		setLiveDraft('ai-2', 'pending text');

		const refs = [
			{ type: 'ai' as const, id: 'ai-1' },
			{ type: 'ai' as const, id: 'ai-2' },
			{ type: 'ai' as const, id: 'consult' },
		];

		expect(excludePreservedRefs(getSession(), refs)).toEqual([{ type: 'ai', id: 'ai-1' }]);
	});

	it('closes mixed tab refs while preserving browser unified history', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		const fileTab = createMockFileTab({ id: 'file-1' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		setupSession({
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

		const nextSession = applyUnifiedTabClosures(getSession(), [
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
		const ai1 = createMockAITab({ id: 'ai-1' });
		const wizardTab = createMockAITab({ id: 'wizard', wizardState: { isActive: true } as any });
		setupSession({
			aiTabs: [ai1, wizardTab],
			activeTabId: ai1.id,
			unifiedTabOrder: [
				{ type: 'ai', id: ai1.id },
				{ type: 'ai', id: wizardTab.id },
			],
		});

		const nextSession = applyUnifiedTabClosures(getSession(), [{ type: 'ai', id: wizardTab.id }]);

		expect(nextSession.aiTabs.map((tab) => tab.id)).toEqual(['ai-1']);
		expect(nextSession.unifiedClosedTabHistory ?? []).toEqual([]);
	});

	describe('closeTabGroup', () => {
		it('closes every member, drops the group, and lands on the chip to its left', () => {
			const before = createMockAITab({ id: 'ai-before' });
			const member = createMockAITab({ id: 'ai-member' });
			const file = createMockFileTab({ id: 'file-member' });
			const after = createMockAITab({ id: 'ai-after' });
			const group = createGroupFromTabRefs(
				[
					{ type: 'ai', id: member.id },
					{ type: 'file', id: file.id },
				],
				'Pair'
			);
			setupSession({
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

			expect(getTabGroupMemberRefs(getSession(), group.id)).toEqual([
				{ type: 'ai', id: member.id },
				{ type: 'file', id: file.id },
			]);

			const next = closeTabGroup(getSession(), group.id);

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
			expect((next.unifiedClosedTabHistory ?? []).some((e) => e.tab.id === 'ai-member')).toBe(true);
		});

		it('lands on the chip to its right when the group led the strip', () => {
			const member1 = createMockAITab({ id: 'ai-m1' });
			const member2 = createMockAITab({ id: 'ai-m2' });
			const after = createMockAITab({ id: 'ai-after' });
			const group = createGroupFromTabRefs(
				[
					{ type: 'ai', id: member1.id },
					{ type: 'ai', id: member2.id },
				],
				'Pair'
			);
			setupSession({
				aiTabs: [member1, member2, after],
				tabGroups: [group],
				activeGroupId: group.id,
				activeTabId: member1.id,
				unifiedTabOrder: [
					{ type: 'group', id: group.id },
					{ type: 'ai', id: after.id },
				],
			});

			const next = closeTabGroup(getSession(), group.id);

			expect(next.aiTabs.map((t) => t.id)).toEqual(['ai-after']);
			expect(next.activeTabId).toBe('ai-after');
			expect(next.activeGroupId).toBeNull();
		});

		it('leaves the current view alone when the group is in the background', () => {
			const member1 = createMockAITab({ id: 'ai-m1' });
			const member2 = createMockAITab({ id: 'ai-m2' });
			const file = createMockFileTab({ id: 'file-open' });
			const group = createGroupFromTabRefs(
				[
					{ type: 'ai', id: member1.id },
					{ type: 'ai', id: member2.id },
				],
				'Pair'
			);
			// activeTabId still points at a member: focusing a file tab leaves it alone.
			setupSession({
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

			const next = closeTabGroup(getSession(), group.id);

			expect(next.aiTabs).toEqual([]);
			expect(next.activeFileTabId).toBe('file-open');
			expect(next.unifiedTabOrder).toEqual([{ type: 'file', id: 'file-open' }]);
		});

		it('mints a fresh AI tab when the group held every tab the agent had', () => {
			const file = createMockFileTab({ id: 'file-m' });
			const terminal = createMockTerminalTab({ id: 'term-m' });
			const group = createGroupFromTabRefs(
				[
					{ type: 'file', id: file.id },
					{ type: 'terminal', id: terminal.id },
				],
				'Tools'
			);
			setupSession({
				aiTabs: [],
				filePreviewTabs: [file],
				terminalTabs: [terminal],
				tabGroups: [group],
				activeGroupId: group.id,
				unifiedTabOrder: [{ type: 'group', id: group.id }],
			});

			const next = closeTabGroup(getSession(), group.id);

			expect(next.filePreviewTabs).toEqual([]);
			expect(next.terminalTabs).toEqual([]);
			expect(next.aiTabs).toHaveLength(1);
			expect(next.activeTabId).toBe(next.aiTabs[0].id);
			expect(next.unifiedTabOrder).toEqual([{ type: 'ai', id: next.aiTabs[0].id }]);
		});

		it('does not count a hidden consult tab as a surviving tab', () => {
			const consult = createMockAITab({ id: 'consult-1', hidden: true });
			const file = createMockFileTab({ id: 'file-m' });
			const terminal = createMockTerminalTab({ id: 'term-m' });
			const group = createGroupFromTabRefs(
				[
					{ type: 'file', id: file.id },
					{ type: 'terminal', id: terminal.id },
				],
				'Tools'
			);
			setupSession({
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

			const next = closeTabGroup(getSession(), group.id);

			const fresh = next.aiTabs.find((t) => t.id !== 'consult-1');
			expect(fresh).toBeDefined();
			expect(fresh!.hidden).toBeFalsy();
			expect(next.activeTabId).toBe(fresh!.id);
			expect(next.aiTabs.some((t) => t.id === 'consult-1')).toBe(true);
		});

		it('is a no-op for an unknown group id', () => {
			setupSession();
			const session = getSession();
			expect(closeTabGroup(session, 'missing')).toBe(session);
		});
	});
});
