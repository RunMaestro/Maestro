import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFilePreviewTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useFilePreviewTabHandlers';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { useMediaPlaybackStore } from '../../../../../renderer/stores/mediaPlaybackStore';
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
		useMediaPlaybackStore.setState({
			items: [],
			activeItemId: null,
			history: [],
			playing: false,
			dismissed: false,
			pendingAutoplay: false,
			resumeTimes: {},
		});
	});

	afterEach(() => {
		cleanup();
	});

	describe('media diversion', () => {
		// Media is not a document. It never gets a tab, a main panel view, or any
		// other placement: opening an audio or video file hands it to the floating
		// player and nothing else.
		const STREAM = 'maestro-media://stream/tok3n/2f66696c65732f612e6d7033';

		it('opens a media file in the player without creating a tab', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({
					path: '/files/podcast.mp3',
					name: 'podcast.mp3',
					content: STREAM,
				});
			});

			const session = getSession();
			expect(session.filePreviewTabs).toHaveLength(0);
			expect(session.activeFileTabId).toBeFalsy();
			expect(session.unifiedTabOrder.map((ref) => ref.type)).toEqual(['ai']);

			const media = useMediaPlaybackStore.getState();
			expect(media.items).toHaveLength(1);
			expect(media.items[0]).toMatchObject({
				path: '/files/podcast.mp3',
				name: 'podcast.mp3',
				kind: 'audio',
			});
			expect(media.pendingAutoplay).toBe(true);
		});

		it('queues a second file instead of taking the player over', () => {
			// Queueing an mp4 behind a playing mp3 must leave the mp3 loaded and
			// audible - the whole point of "Add to Play Queue".
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({
					path: '/files/podcast.mp3',
					name: 'podcast.mp3',
					content: STREAM,
				});
			});
			act(() => {
				useMediaPlaybackStore.getState().consumeAutoplay();
				useMediaPlaybackStore.getState().setPlaying(true);
			});
			const playingId = useMediaPlaybackStore.getState().activeItemId;

			act(() => {
				result.current.handleOpenFileTab(
					{ path: '/files/clip.mp4', name: 'clip.mp4', content: STREAM },
					{ mediaMode: 'queue' }
				);
			});

			const media = useMediaPlaybackStore.getState();
			expect(media.items).toHaveLength(2);
			expect(media.activeItemId).toBe(playingId);
			expect(media.playing).toBe(true);
			expect(media.pendingAutoplay).toBe(false);
		});

		it('queues without playing even when the loaded track is paused', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({
					path: '/files/podcast.mp3',
					name: 'podcast.mp3',
					content: STREAM,
				});
			});
			act(() => {
				useMediaPlaybackStore.getState().consumeAutoplay();
				useMediaPlaybackStore.getState().setPlaying(false);
			});
			const pausedId = useMediaPlaybackStore.getState().activeItemId;

			act(() => {
				result.current.handleOpenFileTab(
					{ path: '/files/clip.mp4', name: 'clip.mp4', content: STREAM },
					{ mediaMode: 'queue' }
				);
			});

			const media = useMediaPlaybackStore.getState();
			expect(media.activeItemId).toBe(pausedId);
			expect(media.pendingAutoplay).toBe(false);
			expect(media.playing).toBe(false);
		});

		it('stamps the owning agent, so the player says where the file came from', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({
					path: '/files/clip.mp4',
					name: 'clip.mp4',
					content: STREAM,
				});
			});

			const item = useMediaPlaybackStore.getState().items[0];
			expect(item.kind).toBe('video');
			expect(item.sessionId).toBe(getSession().id);
			expect(item.sessionName).toBe(getSession().name);
		});

		it('still opens a tab for remote media, which has no playable stream', () => {
			// Only local files get a maestro-media:// URL, so a remote .mp3 keeps the
			// binary "download and open externally" preview.
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({
					path: '/files/podcast.mp3',
					name: 'podcast.mp3',
					content: '<binary>',
					sshRemoteId: 'remote-1',
				});
			});

			expect(getSession().filePreviewTabs).toHaveLength(1);
			expect(useMediaPlaybackStore.getState().items).toHaveLength(0);
		});
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

	// `open-file --background`. This is the choke point every open path funnels
	// through, so the promise has to hold HERE rather than only at the CLI: the
	// tab lands in the strip and stays addressable, while every pointer that
	// decides what is on screen is left exactly as it was.
	describe('background opens', () => {
		it('adds the tab to the strip without taking the panel', () => {
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				browserTabs: [createMockBrowserTab({ id: 'browser-1' })],
				activeBrowserTabId: 'browser-1',
			});
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab(
					{ path: '/repo/a.ts', name: 'a.ts', content: 'a' },
					{ background: true }
				);
			});

			const session = getSession();
			expect(session.filePreviewTabs).toHaveLength(1);
			// Reachable: it is in the unified strip, so the user can click to it.
			expect(session.unifiedTabOrder).toContainEqual({
				type: 'file',
				id: session.filePreviewTabs[0].id,
			});
			// Invisible: nothing that decides the rendered surface moved. This is
			// exactly what `--no-switch` does NOT deliver, which is why the two
			// flags are separate.
			expect(session.activeFileTabId).toBeNull();
			expect(session.activeBrowserTabId).toBe('browser-1');
		});

		it('still activates the new tab without the flag', () => {
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				browserTabs: [createMockBrowserTab({ id: 'browser-1' })],
				activeBrowserTabId: 'browser-1',
			});
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab({ path: '/repo/a.ts', name: 'a.ts', content: 'a' });
			});

			const session = getSession();
			expect(session.activeFileTabId).toBe(session.filePreviewTabs[0].id);
			expect(session.activeBrowserTabId).toBeNull();
		});

		it('refreshes an already-open file in place without activating it', () => {
			// Re-opening a file that already has a tab must not become a back door
			// to the same focus steal.
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				filePreviewTabs: [createMockFileTab({ id: 'file-1', path: '/repo/a.ts' })],
				activeFileTabId: null,
			});
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab(
					{ path: '/repo/a.ts', name: 'a.ts', content: 'fresh' },
					{ background: true }
				);
			});

			const session = getSession();
			expect(session.filePreviewTabs).toHaveLength(1);
			expect(session.filePreviewTabs[0].content).toBe('fresh');
			expect(session.activeFileTabId).toBeNull();
		});

		it('forces a new tab rather than replacing the visible one', () => {
			// openInNewTab:false rewrites the ACTIVE tab in place, which is the
			// opposite of the promise - background has to win over it.
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				filePreviewTabs: [createMockFileTab({ id: 'file-1', path: '/repo/a.ts' })],
				activeFileTabId: 'file-1',
			});
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			act(() => {
				result.current.handleOpenFileTab(
					{ path: '/repo/b.ts', name: 'b.ts', content: 'b' },
					{ background: true, openInNewTab: false }
				);
			});

			const session = getSession();
			expect(session.filePreviewTabs).toHaveLength(2);
			// The tab the user was looking at still shows the file it showed before.
			expect(session.filePreviewTabs.find((t) => t.id === 'file-1')?.path).toBe('/repo/a.ts');
			expect(session.activeFileTabId).toBe('file-1');
		});
	});

	// A tiled file pane is not the active file tab (focusing a pane does not set
	// activeFileTabId), so back / forward / breadcrumb-jump all take an explicit tab
	// id. Without it a pane would navigate whichever other file tab was active.
	describe('navigation addressed by tab id', () => {
		const withTwoFileTabs = () => {
			const history = [
				{ path: '/repo/a.ts', name: 'a' },
				{ path: '/repo/b.ts', name: 'b' },
				{ path: '/repo/c.ts', name: 'c' },
			];
			setupSession({
				filePreviewTabs: [
					createMockFileTab({ id: 'active-tab', navigationHistory: history, navigationIndex: 0 }),
					createMockFileTab({ id: 'pane-tab', navigationHistory: history, navigationIndex: 1 }),
				],
				activeFileTabId: 'active-tab',
			});
			vi.mocked(window.maestro.fs.readFile).mockResolvedValue('loaded');
		};

		it('navigates back on the addressed tab, leaving the active one alone', async () => {
			withTwoFileTabs();
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			await act(async () => {
				await result.current.handleFileTabNavigateBack('pane-tab');
			});

			expect(getSession().filePreviewTabs[1]).toMatchObject({
				path: '/repo/a.ts',
				navigationIndex: 0,
			});
			expect(getSession().filePreviewTabs[0].navigationIndex).toBe(0);
		});

		it('navigates forward on the addressed tab', async () => {
			withTwoFileTabs();
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			await act(async () => {
				await result.current.handleFileTabNavigateForward('pane-tab');
			});

			expect(getSession().filePreviewTabs[1]).toMatchObject({
				path: '/repo/c.ts',
				navigationIndex: 2,
			});
		});

		it('still defaults to the active file tab when no id is given', async () => {
			withTwoFileTabs();
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			await act(async () => {
				await result.current.handleFileTabNavigateForward();
			});

			expect(getSession().filePreviewTabs[0]).toMatchObject({
				path: '/repo/b.ts',
				navigationIndex: 1,
			});
			expect(getSession().filePreviewTabs[1].navigationIndex).toBe(1);
		});

		it('does nothing at either end of the history', async () => {
			withTwoFileTabs();
			const { result } = renderHook(() => useFilePreviewTabHandlers());

			await act(async () => {
				// active-tab sits at index 0 (no back), pane-tab walked to the end below.
				await result.current.handleFileTabNavigateBack('active-tab');
				await result.current.handleFileTabNavigateToIndex(2, 'pane-tab');
				await result.current.handleFileTabNavigateForward('pane-tab');
			});

			expect(getSession().filePreviewTabs[0].navigationIndex).toBe(0);
			expect(getSession().filePreviewTabs[1].navigationIndex).toBe(2);
		});
	});
});
