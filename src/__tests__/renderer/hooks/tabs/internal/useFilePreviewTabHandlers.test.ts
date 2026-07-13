import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFilePreviewTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useFilePreviewTabHandlers';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import {
	createMockAITab,
	createMockBrowserTab,
	createMockFileTab,
	getSession,
	resetTabHandlerStores,
	setupSession,
} from './testUtils';

describe('useFilePreviewTabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
	});

	afterEach(() => {
		cleanup();
	});

	it('opens a new file tab next to the active tab', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/src/app.ts',
				name: 'app.ts',
				content: 'content',
				lastModified: 55,
			});
		});

		const session = getSession();
		expect(session.filePreviewTabs[0]).toMatchObject({
			path: '/repo/src/app.ts',
			name: 'app',
			extension: '.ts',
			content: 'content',
			lastModified: 55,
		});
		expect(session.activeFileTabId).toBe(session.filePreviewTabs[0].id);
		expect(session.unifiedTabOrder.map((ref) => ref.type)).toEqual(['ai', 'file']);
	});

	// Opening a file must take over the panel; a stale activeGroupId would keep the
	// tiled group winning the render precedence so the file never shows / gets focus.
	it('leaves an active tiled group when opening a new file tab (double-click default)', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })], activeGroupId: 'group-1' });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({ path: '/repo/b.ts', name: 'b.ts', content: 'b' });
		});

		expect(getSession().activeGroupId).toBeNull();
		expect(getSession().activeFileTabId).toBe(getSession().filePreviewTabs[0].id);
	});

	it('leaves an active tiled group when re-opening an existing file tab by path', () => {
		const existing = createMockFileTab({ id: 'file-1', path: '/repo/a.ts', name: 'a' });
		setupSession({ filePreviewTabs: [existing], activeGroupId: 'group-1' });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({ path: '/repo/a.ts', name: 'a.ts', content: 'a2' });
		});

		expect(getSession().activeGroupId).toBeNull();
		expect(getSession().activeFileTabId).toBe('file-1');
	});

	// A file already open but tiled INSIDE a group has no standalone chip (it lives
	// only as a leaf in the group layout). Re-opening it (e.g. double-clicking it in
	// the file explorer) must activate its group and focus that pane, NOT clear
	// activeGroupId - otherwise focus is stranded and nothing appears to happen.
	it('focuses the group pane when re-opening a file already tiled into a group', () => {
		const tiled = createMockFileTab({ id: 'file-1', path: '/repo/a.ts', name: 'a' });
		setupSession({
			filePreviewTabs: [tiled],
			activeGroupId: null,
			activeTabId: 'ai-1',
			// The file lives only inside the group; its standalone ref is not in the order.
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'group', id: 'g1' },
			],
			tabGroups: [
				{
					id: 'g1',
					name: 'Group',
					createdAt: 0,
					focusedPaneId: 'leaf-ai',
					layout: {
						kind: 'split',
						id: 'split-1',
						direction: 'row',
						sizes: [0.5, 0.5],
						children: [
							{ kind: 'leaf', id: 'leaf-ai', tab: { type: 'ai', id: 'ai-1' } },
							{ kind: 'leaf', id: 'leaf-file', tab: { type: 'file', id: 'file-1' } },
						],
					},
				},
			] as never,
		});
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({ path: '/repo/a.ts', name: 'a.ts', content: 'a2' });
		});

		const s = getSession();
		// Group is activated and its focused pane points at the file's leaf.
		expect(s.activeGroupId).toBe('g1');
		expect(s.tabGroups[0].focusedPaneId).toBe('leaf-file');
		expect(s.activeFileTabId).toBe('file-1');
		expect(s.inputMode).toBe('ai');
		// The file must NOT be resurrected as a standalone ref in the strip order.
		expect(s.unifiedTabOrder.some((ref) => ref.type === 'file' && ref.id === 'file-1')).toBe(false);
		// Content is still refreshed on the tiled tab.
		expect(s.filePreviewTabs.find((t) => t.id === 'file-1')?.content).toBe('a2');
	});

	it('leaves an active tiled group when replacing the current file tab in place', () => {
		const existing = createMockFileTab({ id: 'file-1', path: '/repo/a.ts', name: 'a' });
		setupSession({
			filePreviewTabs: [existing],
			activeFileTabId: 'file-1',
			activeGroupId: 'group-1',
		});
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab(
				{ path: '/repo/c.ts', name: 'c.ts', content: 'c' },
				{ openInNewTab: false }
			);
		});

		expect(getSession().activeGroupId).toBeNull();
	});

	it('leaves an active tiled group when creating a new untitled file tab', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })], activeGroupId: 'group-1' });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleNewFileTab();
		});

		expect(getSession().activeGroupId).toBeNull();
		expect(getSession().activeFileTabId).toBe(getSession().filePreviewTabs[0].id);
	});

	it('clears the active browser tab when opening a new file tab', () => {
		setupSession({
			browserTabs: [createMockBrowserTab({ id: 'browser-1' })],
			activeBrowserTabId: 'browser-1',
		});
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/src/app.ts',
				name: 'app.ts',
				content: 'content',
			});
		});

		const session = getSession();
		expect(session.activeBrowserTabId).toBeNull();
		expect(session.activeFileTabId).toBe(session.filePreviewTabs[0].id);
		expect(session.inputMode).toBe('ai');
	});

	it('clears the active browser tab when re-opening an existing file tab', () => {
		const fileTab = createMockFileTab({ id: 'file-1', path: '/repo/src/app.ts' });
		setupSession({
			filePreviewTabs: [fileTab],
			browserTabs: [createMockBrowserTab({ id: 'browser-1' })],
			activeBrowserTabId: 'browser-1',
		});
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/src/app.ts',
				name: 'app.ts',
				content: 'new',
			});
		});

		const session = getSession();
		expect(session.activeBrowserTabId).toBeNull();
		expect(session.activeFileTabId).toBe('file-1');
		expect(session.inputMode).toBe('ai');
	});

	it('clears the active browser tab when replacing the current file tab in place', () => {
		const fileTab = createMockFileTab({ id: 'file-1', path: '/repo/b.ts', name: 'b' });
		setupSession({
			filePreviewTabs: [fileTab],
			activeFileTabId: 'file-1',
			browserTabs: [createMockBrowserTab({ id: 'browser-1' })],
			activeBrowserTabId: 'browser-1',
		});
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab(
				{ path: '/repo/d.ts', name: 'd.ts', content: 'd' },
				{ openInNewTab: false }
			);
		});

		const session = getSession();
		expect(session.activeBrowserTabId).toBeNull();
		expect(session.activeFileTabId).toBe('file-1');
		expect(session.filePreviewTabs[0].path).toBe('/repo/d.ts');
		expect(session.inputMode).toBe('ai');
	});

	it('updates and selects an existing file tab by path', () => {
		const fileTab = createMockFileTab({
			id: 'file-1',
			path: '/repo/src/app.ts',
			content: 'old',
			isLoading: true,
			loadRequestId: 'load-1',
		});
		setupSession({ filePreviewTabs: [fileTab] });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab({
				path: '/repo/src/app.ts',
				name: 'app.ts',
				content: 'new',
				lastModified: 99,
			});
		});

		expect(getSession().filePreviewTabs[0]).toMatchObject({
			content: 'new',
			lastModified: 99,
			isLoading: false,
			loadRequestId: undefined,
		});
		expect(getSession().activeFileTabId).toBe('file-1');
	});

	it('replaces the active file tab and truncates forward history', () => {
		const fileTab = createMockFileTab({
			id: 'file-1',
			path: '/repo/b.ts',
			name: 'b',
			navigationHistory: [
				{ path: '/repo/a.ts', name: 'a', scrollTop: 1 },
				{ path: '/repo/b.ts', name: 'b', scrollTop: 2 },
				{ path: '/repo/c.ts', name: 'c', scrollTop: 3 },
			],
			navigationIndex: 1,
		});
		setupSession({ filePreviewTabs: [fileTab], activeFileTabId: 'file-1' });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleOpenFileTab(
				{ path: '/repo/d.ts', name: 'd.ts', content: 'd' },
				{ openInNewTab: false }
			);
		});

		expect(getSession().filePreviewTabs[0]).toMatchObject({
			path: '/repo/d.ts',
			name: 'd',
			navigationIndex: 2,
		});
		expect(getSession().filePreviewTabs[0].navigationHistory).toEqual([
			{ path: '/repo/a.ts', name: 'a', scrollTop: 1 },
			{ path: '/repo/b.ts', name: 'b', scrollTop: 2 },
			{ path: '/repo/d.ts', name: 'd', scrollTop: 0 },
		]);
	});

	it('confirms before closing an edited file tab and cancels a loading read on confirm', () => {
		const fileTab = createMockFileTab({
			id: 'file-1',
			name: 'app',
			extension: '.ts',
			editContent: 'dirty',
			isLoading: true,
			loadRequestId: 'load-1',
		});
		setupSession({ filePreviewTabs: [fileTab], activeFileTabId: 'file-1' });
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		act(() => {
			result.current.handleCloseFileTab('file-1');
		});

		const modal = useModalStore.getState().modals.get('confirm');
		expect(modal?.data?.message).toContain('has unsaved changes');

		act(() => {
			modal?.data?.onConfirm();
		});

		expect(window.maestro.fs.cancelReadFile).toHaveBeenCalledWith('load-1');
		expect(getSession().filePreviewTabs).toHaveLength(0);
	});

	it('auto-refreshes stale file content on selection when enabled', async () => {
		const fileTab = createMockFileTab({
			id: 'file-1',
			path: '/repo/app.ts',
			content: 'old',
			lastModified: 1,
		});
		setupSession({ filePreviewTabs: [fileTab] });
		useSettingsStore.setState({ fileTabAutoRefreshEnabled: true } as any);
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			modifiedAt: new Date(5000).toISOString(),
		} as any);
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue('fresh');
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		await act(async () => {
			await result.current.handleSelectFileTab('file-1');
		});

		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/app.ts', undefined);
		expect(getSession().activeFileTabId).toBe('file-1');
		expect(getSession().filePreviewTabs[0].content).toBe('fresh');
	});

	it('navigates to an arbitrary file history index using the current SSH remote', async () => {
		const fileTab = createMockFileTab({
			id: 'file-1',
			sshRemoteId: 'remote-1',
			navigationHistory: [
				{ path: '/repo/a.ts', name: 'a', scrollTop: 1 },
				{ path: '/repo/b.ts', name: 'b', scrollTop: 2 },
			],
			navigationIndex: 0,
		});
		setupSession({ filePreviewTabs: [fileTab], activeFileTabId: 'file-1' });
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue('b-content');
		const { result } = renderHook(() => useFilePreviewTabHandlers());

		await act(async () => {
			await result.current.handleFileTabNavigateToIndex(1);
		});

		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/b.ts', 'remote-1');
		expect(getSession().filePreviewTabs[0]).toMatchObject({
			path: '/repo/b.ts',
			content: 'b-content',
			scrollTop: 2,
			navigationIndex: 1,
		});
	});
});
