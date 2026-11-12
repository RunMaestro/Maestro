import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	getTabDerivedState,
	useTabDerivedState,
} from '../../../../../renderer/hooks/tabs/internal/useTabDerivedState';
import {
	createMockAITab,
	createMockBrowserTab,
	createMockFileTab,
	createMockTerminalTab,
	resetTabHandlerStores,
	setupSession,
} from './testUtils';

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
		resetTabHandlerStores();
	});

	afterEach(() => {
		cleanup();
	});

	it('returns empty derived state when no session exists', () => {
		const { result } = renderHook(() => useTabDerivedState());

		expect(result.current.activeTab).toBeUndefined();
		expect(result.current.unifiedTabs).toEqual([]);
		expect(result.current.activeFileTab).toBeNull();
		expect(result.current.activeBrowserTab).toBeNull();
		expect(result.current.fileTabCanGoBack).toBe(false);
		expect(result.current.fileTabCanGoForward).toBe(false);
	});

	it('computes active AI, file, browser, and unified tab order', () => {
		const aiTab = createMockAITab({ id: 'ai-1', agentSessionId: 'agent-session' });
		const fileTab = createMockFileTab({ id: 'file-1', name: 'readme' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		const { result } = renderHook(() => useTabDerivedState());

		act(() => {
			setupSession({
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
		const fileTab = createMockFileTab({
			id: 'file-1',
			navigationHistory: [
				{ path: '/a.ts', name: 'a', scrollTop: 1 },
				{ path: '/b.ts', name: 'b', scrollTop: 2 },
				{ path: '/c.ts', name: 'c', scrollTop: 3 },
			],
			navigationIndex: 1,
		});
		setupSession({
			filePreviewTabs: [fileTab],
			activeFileTabId: fileTab.id,
		});

		const { result } = renderHook(() => useTabDerivedState());

		expect(result.current.activeFileTabNavIndex).toBe(1);
		expect(result.current.fileTabBackHistory).toEqual([{ path: '/a.ts', name: 'a', scrollTop: 1 }]);
		expect(result.current.fileTabForwardHistory).toEqual([
			{ path: '/c.ts', name: 'c', scrollTop: 3 },
		]);
		expect(result.current.fileTabCanGoBack).toBe(true);
		expect(result.current.fileTabCanGoForward).toBe(true);
	});
});
