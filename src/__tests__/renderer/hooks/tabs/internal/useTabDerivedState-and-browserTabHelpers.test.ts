import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { getTabDerivedState } from '../../../../../renderer/hooks/tabs/internal/useTabDerivedState';
import { useTabDerivedState } from '../../../../../renderer/hooks/tabs/internal/useTabDerivedState';
import { createMockAITab } from './testUtils';
import { createMockBrowserTab } from './testUtils';
import { createMockFileTab } from './testUtils';
import { createMockTerminalTab } from './testUtils';
import { resetTabHandlerStores } from './testUtils';
import { setupSession } from './testUtils';
import { vi } from 'vitest';
import { createBrowserTab } from '../../../../../renderer/hooks/tabs/internal/browserTabHelpers';
import { normalizeBrowserTabUpdates } from '../../../../../renderer/hooks/tabs/internal/browserTabHelpers';
import { DEFAULT_BROWSER_TAB_URL } from '../../../../../renderer/utils/browserTabPersistence';
__maestroMicrobenchDescribe('useTabDerivedState', () => {
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
__maestroMicrobenchDescribe('browserTabHelpers', () => {
	describe('browserTabHelpers', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('creates a home browser tab with partition and default title', () => {
			vi.spyOn(Date, 'now').mockReturnValue(1234);

			const tab = createBrowserTab('session/one', DEFAULT_BROWSER_TAB_URL, { isLoading: false });

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
			const tab = createMockBrowserTab({
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
