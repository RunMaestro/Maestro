import { beforeEach, describe, expect, it } from 'vitest';
import {
	applyUnifiedTabClosures,
	getActiveUnifiedRef,
	getRefsExceptActive,
	getRefsLeftOfActive,
	getRefsRightOfActive,
	getTerminalTabIds,
	getWizardTabIds,
	hasDraftInRefs,
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

	it('checks drafts only for AI refs in the close set', () => {
		const ai1 = createMockAITab({ id: 'ai-1' });
		const ai2 = createMockAITab({ id: 'ai-2' });
		setupSession({ aiTabs: [ai1, ai2] });
		setLiveDraft('ai-2', 'pending text');

		expect(hasDraftInRefs(getSession(), [{ type: 'ai', id: 'ai-1' }])).toBe(false);
		expect(hasDraftInRefs(getSession(), [{ type: 'ai', id: 'ai-2' }])).toBe(true);
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
		expect(nextSession.unifiedClosedTabHistory?.[0].type).toBe('browser');
	});
});
