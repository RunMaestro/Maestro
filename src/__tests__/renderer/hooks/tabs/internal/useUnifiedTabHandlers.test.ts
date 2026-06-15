import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnifiedTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useUnifiedTabHandlers';
import {
	createMockAITab,
	createMockBrowserTab,
	createMockFileTab,
	createMockTerminalTab,
	getSession,
	resetTabHandlerStores,
	setupSession,
} from './testUtils';

const inlineWizardMocks = vi.hoisted(() => ({
	endWizard: vi.fn(async () => null),
}));

vi.mock('../../../../../renderer/contexts/InlineWizardContext', () => ({
	useInlineWizardContext: () => ({
		endWizard: inlineWizardMocks.endWizard,
	}),
}));

describe('useUnifiedTabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		inlineWizardMocks.endWizard.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('reorders the unified tab order with bounds checks', () => {
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleUnifiedTabReorder(0, 1);
			result.current.handleUnifiedTabReorder(-1, 1);
		});

		expect(getSession().unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'ai-2' },
			{ type: 'ai', id: 'ai-1' },
		]);
	});

	it('returns close-current metadata for active AI tabs without closing them', () => {
		const aiTab = createMockAITab({
			id: 'ai-1',
			inputValue: 'draft',
			wizardState: { isActive: true, currentStep: 'intent' } as any,
		});
		setupSession({ aiTabs: [aiTab] });
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		expect(result.current.handleCloseCurrentTab()).toEqual({
			type: 'ai',
			tabId: 'ai-1',
			isWizardTab: true,
			hasWizardUserInteraction: true,
			hasDraft: true,
		});
		expect(getSession().aiTabs).toHaveLength(1);
	});

	it('delegates active file close to file preview handlers', () => {
		const fileTab = createMockFileTab({ id: 'file-1' });
		setupSession({ filePreviewTabs: [fileTab], activeFileTabId: 'file-1' });
		const handleCloseFileTab = vi.fn();
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab }));

		expect(result.current.handleCloseCurrentTab()).toEqual({ type: 'file', tabId: 'file-1' });
		expect(handleCloseFileTab).toHaveBeenCalledWith('file-1');
	});

	it('closes browser current tab immediately and returns browser result', () => {
		const aiTab = createMockAITab({ id: 'ai-1' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		setupSession({
			aiTabs: [aiTab],
			browserTabs: [browserTab],
			activeBrowserTabId: 'browser-1',
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'browser', id: 'browser-1' },
			],
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		expect(result.current.handleCloseCurrentTab()).toEqual({
			type: 'browser',
			tabId: 'browser-1',
		});
		expect(getSession().browserTabs).toEqual([]);
	});

	it('closes other mixed tabs, kills terminal processes, and ends closed wizard tabs', async () => {
		const active = createMockAITab({ id: 'ai-active' });
		const wizard = createMockAITab({
			id: 'wizard-1',
			wizardState: { isActive: true } as any,
		});
		const fileTab = createMockFileTab({ id: 'file-1' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		setupSession({
			aiTabs: [active, wizard],
			filePreviewTabs: [fileTab],
			browserTabs: [browserTab],
			terminalTabs: [terminalTab],
			activeTabId: active.id,
			unifiedTabOrder: [
				{ type: 'ai', id: active.id },
				{ type: 'file', id: fileTab.id },
				{ type: 'browser', id: browserTab.id },
				{ type: 'terminal', id: terminalTab.id },
				{ type: 'ai', id: wizard.id },
			],
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleCloseOtherTabs();
		});

		expect(getSession().unifiedTabOrder).toEqual([{ type: 'ai', id: 'ai-active' }]);
		expect(window.maestro.process.kill).toHaveBeenCalledWith('test-session-terminal-term-1');
		await vi.waitFor(() => {
			expect(inlineWizardMocks.endWizard).toHaveBeenCalledWith('wizard-1');
		});
	});

	it('preserves tabs with unsent drafts and closes the rest silently', () => {
		setupSession({
			aiTabs: [
				createMockAITab({ id: 'ai-1' }),
				createMockAITab({ id: 'ai-2', inputValue: 'draft' }),
				createMockAITab({ id: 'ai-3' }),
			],
			activeTabId: 'ai-1',
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleCloseTabsRight();
		});

		// ai-2 (draft) survives; ai-3 closes. No confirmation modal is opened.
		expect(getSession().aiTabs.map((t) => t.id)).toEqual(['ai-1', 'ai-2']);
	});

	it('does not close anything when the only tab in the set has a draft', () => {
		setupSession({
			aiTabs: [
				createMockAITab({ id: 'ai-1' }),
				createMockAITab({ id: 'ai-2', inputValue: 'draft' }),
			],
			activeTabId: 'ai-1',
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleCloseTabsRight();
		});

		expect(getSession().aiTabs.map((t) => t.id)).toEqual(['ai-1', 'ai-2']);
	});
});
