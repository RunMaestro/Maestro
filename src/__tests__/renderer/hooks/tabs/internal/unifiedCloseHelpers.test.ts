import { beforeEach, describe, expect, it } from 'vitest';
import {
	applyUnifiedTabClosures,
	excludeDraftRefs,
	getActiveUnifiedRef,
	getRefsExceptActive,
	getRefsLeftOfActive,
	getRefsRightOfActive,
	getTerminalTabIds,
	getWizardTabIds,
} from '../../../../../renderer/hooks/tabs/internal/unifiedCloseHelpers';
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
});
