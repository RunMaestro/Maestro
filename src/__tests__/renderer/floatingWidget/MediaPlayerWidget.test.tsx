/**
 * Tests for MediaPlayerWidget, the media player's desktop-window body. This
 * window is the authority: it owns the one media element, shows and hides its
 * window from the store, dismisses on its X, applies commands the primary
 * window forwards, hydrates the persisted queue, sizes its window to the
 * media until the user resizes it, and borrows room past the card while a
 * queue or history list is open.
 */
import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	MEDIA_WINDOW_BASELINE_STORAGE_KEY,
	MediaPlayerWidget,
} from '../../../renderer/floatingWidget/MediaPlayerWidget';
import { mediaWindowSizeFor } from '../../../renderer/floatingWidget/mediaWindowSize';
import {
	MEDIA_QUEUE_SETTINGS_KEY,
	setMediaQueuePersistEnabled,
	useMediaPlaybackStore,
} from '../../../renderer/stores/mediaPlaybackStore';
import { loadAllSettings } from '../../../renderer/stores/settingsStore';
import type { MediaItem } from '../../../renderer/utils/mediaItems';
import { mockTheme } from '../../helpers/mockTheme';

/** Counts constructions of the player element; a re-render reuses it. */
const mountCount = vi.fn();

vi.mock('../../../renderer/components/FilePreview/MediaViewer', () => ({
	MediaViewer: () => {
		useEffect(() => {
			mountCount();
		}, []);
		return <div data-testid="media-viewer" />;
	},
}));

const maestro = window.maestro as unknown as Record<string, unknown>;
const originalWidgets = maestro.floatingWidgets;

const podcast: MediaItem = {
	id: 's1::/files/podcast.mp3',
	path: '/files/podcast.mp3',
	name: 'podcast.mp3',
	sessionId: 's1',
	sessionName: 'Agent One',
	kind: 'audio',
};

const movie: MediaItem = {
	id: 's1::/files/movie.mp4',
	path: '/files/movie.mp4',
	name: 'movie.mp4',
	sessionId: 's1',
	sessionName: 'Agent One',
	kind: 'video',
};

/** The size the widget asks for before the transport is measured (the mock never reports it). */
const audioSize = mediaWindowSizeFor({ kind: 'audio', transportHeight: null });
const videoSize = mediaWindowSizeFor({ kind: 'video', transportHeight: null });

let bounds: { x: number; y: number; width: number; height: number };

let api: {
	show: ReturnType<typeof vi.fn>;
	hide: ReturnType<typeof vi.fn>;
	publishState: ReturnType<typeof vi.fn>;
	onCommand: ReturnType<typeof vi.fn>;
	getBounds: ReturnType<typeof vi.fn>;
	setBounds: ReturnType<typeof vi.fn>;
	setOverflow: ReturnType<typeof vi.fn>;
};
/** What main grants the next time the widget asks for list room. */
let grant: { above: number; below: number };
let commandHandler: ((command: unknown) => void) | null;

function resetStore() {
	useMediaPlaybackStore.setState({
		items: [],
		activeItemId: null,
		history: [],
		playing: false,
		dismissed: false,
		dormant: false,
		pendingAutoplay: false,
		toggleRequest: 0,
		focusRequest: 0,
		resumeTimes: {},
		durations: {},
		aspects: {},
	});
}

function load(item: MediaItem, dismissed = false) {
	useMediaPlaybackStore.setState({ items: [item], activeItemId: item.id, dismissed });
}

const renderWidget = () => render(<MediaPlayerWidget theme={mockTheme} />);

beforeEach(() => {
	vi.clearAllMocks();
	commandHandler = null;
	api = {
		show: vi.fn().mockResolvedValue(true),
		hide: vi.fn().mockResolvedValue(false),
		publishState: vi.fn(),
		onCommand: vi.fn((_id: string, handler: (command: unknown) => void) => {
			commandHandler = handler;
			return () => {
				commandHandler = null;
			};
		}),
		// A real window: setBounds resizes it and reports where it ended up.
		getBounds: vi.fn(() => Promise.resolve({ ...bounds })),
		setBounds: vi.fn((_id: string, next: { width: number; height: number }) => {
			bounds = { ...bounds, ...next };
			return Promise.resolve({ ...bounds });
		}),
		setOverflow: vi.fn((_id: string, need: { above: number; below: number }) =>
			Promise.resolve(need.above === 0 && need.below === 0 ? need : grant)
		),
	};
	grant = { above: 0, below: 0 };
	bounds = { x: 100, y: 100, width: 420, height: 96 };
	maestro.floatingWidgets = api;
	localStorage.removeItem(MEDIA_WINDOW_BASELINE_STORAGE_KEY);
	resetStore();
});

afterEach(() => {
	maestro.floatingWidgets = originalWidgets;
	setMediaQueuePersistEnabled(true);
});

describe('MediaPlayerWidget', () => {
	it('renders one player element and keeps it mounted across dismiss and restore', () => {
		load(podcast);
		renderWidget();
		expect(screen.getAllByTestId('media-viewer')).toHaveLength(1);
		expect(mountCount).toHaveBeenCalledTimes(1);

		act(() => useMediaPlaybackStore.getState().dismiss());
		act(() => useMediaPlaybackStore.getState().restore());
		expect(screen.getAllByTestId('media-viewer')).toHaveLength(1);
		expect(mountCount).toHaveBeenCalledTimes(1);
	});

	it('titles the frame with the file name and the agent', () => {
		load(podcast);
		renderWidget();
		const strip = screen.getByTestId('floating-widget-title-strip');
		expect(strip).toHaveTextContent('podcast.mp3');
		expect(strip).toHaveTextContent('Agent One');
	});

	it('renders nothing and hides the window with nothing loaded', () => {
		renderWidget();
		expect(screen.queryByTestId('floating-widget-frame')).toBeNull();
		expect(api.hide).toHaveBeenCalledWith('media-player');
		expect(api.show).not.toHaveBeenCalled();
	});

	it('shows the window for a loaded item and hides it on dismiss', () => {
		load(podcast);
		renderWidget();
		expect(api.show).toHaveBeenLastCalledWith('media-player');

		act(() => useMediaPlaybackStore.getState().dismiss());
		expect(api.hide).toHaveBeenLastCalledWith('media-player');

		act(() => useMediaPlaybackStore.getState().restore());
		expect(api.show).toHaveBeenCalledTimes(2);
	});

	it('hides the window when the last item closes', () => {
		load(podcast);
		renderWidget();
		act(() => useMediaPlaybackStore.getState().closeItem(podcast.id));
		expect(api.hide).toHaveBeenLastCalledWith('media-player');
		expect(screen.queryByTestId('media-viewer')).toBeNull();
	});

	it('dismisses on its close button without stopping playback', () => {
		load(podcast);
		useMediaPlaybackStore.setState({ playing: true });
		renderWidget();

		fireEvent.click(screen.getByTestId('floating-widget-close'));

		const state = useMediaPlaybackStore.getState();
		expect(state.dismissed).toBe(true);
		expect(state.playing).toBe(true);
		expect(state.activeItemId).toBe(podcast.id);
		expect(screen.getByTestId('media-viewer')).toBeInTheDocument();
	});

	it('dismisses on Escape', () => {
		load(podcast);
		renderWidget();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(useMediaPlaybackStore.getState().dismissed).toBe(true);
	});

	it('releases the player on its stop button', () => {
		load(podcast);
		renderWidget();
		fireEvent.click(screen.getByTestId('media-stop'));
		expect(useMediaPlaybackStore.getState().activeItemId).toBeNull();
	});

	it('publishes its snapshot and applies forwarded commands as the authority', () => {
		renderWidget();
		expect(api.publishState).toHaveBeenCalledWith(
			'media-player',
			expect.objectContaining({ items: [], activeItemId: null })
		);

		const request = {
			path: podcast.path,
			name: podcast.name,
			sessionId: podcast.sessionId,
			sessionName: podcast.sessionName,
			kind: podcast.kind,
		};
		act(() => commandHandler?.({ type: 'action', action: 'openMedia', args: [request] }));
		expect(useMediaPlaybackStore.getState().activeItemId).toBe(podcast.id);
		expect(api.show).toHaveBeenLastCalledWith('media-player');

		// Anything outside the command union is dropped.
		act(() => commandHandler?.({ type: 'action', action: 'setPlaying', args: [true] }));
		expect(useMediaPlaybackStore.getState().playing).toBe(false);
	});

	describe('window size', () => {
		it('sizes the window for the loaded kind', async () => {
			load(podcast);
			renderWidget();
			await waitFor(() => expect(api.setBounds).toHaveBeenCalledWith('media-player', audioSize));
		});

		it('re-sizes when the kind changes and the user left the size alone', async () => {
			load(podcast);
			renderWidget();
			await waitFor(() => expect(api.setBounds).toHaveBeenCalledTimes(1));

			act(() =>
				useMediaPlaybackStore.setState({ items: [podcast, movie], activeItemId: movie.id })
			);
			await waitFor(() =>
				expect(api.setBounds).toHaveBeenLastCalledWith('media-player', videoSize)
			);
		});

		it('keeps the size the user chose across a kind change', async () => {
			load(podcast);
			renderWidget();
			await waitFor(() => expect(api.setBounds).toHaveBeenCalledTimes(1));

			// The user drags the window wider.
			bounds = { ...bounds, width: 640 };
			act(() =>
				useMediaPlaybackStore.setState({ items: [podcast, movie], activeItemId: movie.id })
			);
			await waitFor(() => expect(api.getBounds).toHaveBeenCalledTimes(2));
			await act(async () => {});
			expect(api.setBounds).toHaveBeenCalledTimes(1);
		});

		it('follows the video aspect once the file reports it', async () => {
			load(movie);
			renderWidget();
			await waitFor(() => expect(api.setBounds).toHaveBeenCalledWith('media-player', videoSize));

			act(() => useMediaPlaybackStore.getState().rememberAspect(movie.id, 1));
			await waitFor(() =>
				expect(api.setBounds).toHaveBeenLastCalledWith(
					'media-player',
					mediaWindowSizeFor({ kind: 'video', aspect: 1, transportHeight: null })
				)
			);
		});
	});

	describe('list room', () => {
		const frame = () => screen.getByTestId('floating-widget-frame');

		function loadWithHistory() {
			useMediaPlaybackStore.setState({
				items: [podcast],
				activeItemId: podcast.id,
				history: [movie],
			});
		}

		it('borrows room below the card while a list is open and gives it back on close', async () => {
			grant = { above: 0, below: 240 };
			loadWithHistory();
			renderWidget();
			expect(api.setOverflow).not.toHaveBeenCalled();

			fireEvent.click(screen.getByRole('button', { name: 'Recently played' }));
			await waitFor(() => expect(frame().style.bottom).toBe('240px'));
			expect(frame().style.top).toBe('0px');
			expect(api.setOverflow).toHaveBeenCalledWith(
				'media-player',
				expect.objectContaining({ above: expect.any(Number), below: expect.any(Number) })
			);

			fireEvent.click(screen.getByRole('button', { name: 'Recently played' }));
			await waitFor(() => expect(frame().style.bottom).toBe('0px'));
			expect(api.setOverflow).toHaveBeenLastCalledWith('media-player', {
				above: 0,
				below: 0,
			});
		});

		it('keeps the card in place with room borrowed above it', async () => {
			grant = { above: 300, below: 0 };
			loadWithHistory();
			renderWidget();

			fireEvent.click(screen.getByRole('button', { name: 'Recently played' }));
			await waitFor(() => expect(frame().style.top).toBe('300px'));
			expect(frame().style.bottom).toBe('0px');
			expect(screen.getByTestId('media-history-menu')).toBeInTheDocument();
		});

		it('gives the room back when the window is dismissed with a list open', async () => {
			grant = { above: 0, below: 240 };
			loadWithHistory();
			renderWidget();
			fireEvent.click(screen.getByRole('button', { name: 'Recently played' }));
			await waitFor(() => expect(frame().style.bottom).toBe('240px'));

			act(() => useMediaPlaybackStore.getState().dismiss());
			await waitFor(() =>
				expect(api.setOverflow).toHaveBeenLastCalledWith('media-player', { above: 0, below: 0 })
			);
		});
	});

	describe('persisted queue', () => {
		const settings = () =>
			window.maestro.settings as unknown as { getAll: ReturnType<typeof vi.fn> };

		afterEach(() => {
			settings().getAll.mockImplementation(() => Promise.resolve({}));
		});

		function persist() {
			settings().getAll.mockResolvedValue({
				[MEDIA_QUEUE_SETTINGS_KEY]: {
					items: [podcast],
					activeItemId: podcast.id,
					resumeTimes: { [podcast.id]: 42 },
					durations: {},
				},
			});
		}

		it('loads the persisted queue hidden, paused and dormant', async () => {
			persist();
			renderWidget();
			await act(async () => {
				await loadAllSettings();
			});

			const state = useMediaPlaybackStore.getState();
			expect(state.items).toEqual([podcast]);
			expect(state.activeItemId).toBe(podcast.id);
			expect(state.resumeTimes[podcast.id]).toBe(42);
			expect(state.dismissed).toBe(true);
			expect(state.dormant).toBe(true);
			expect(state.playing).toBe(false);
			// Loaded but dismissed: mounted, with the window still hidden.
			expect(screen.getByTestId('media-viewer')).toBeInTheDocument();
			expect(api.show).not.toHaveBeenCalled();
		});

		it('is not hydrated by a replica window', async () => {
			persist();
			setMediaQueuePersistEnabled(false);
			await loadAllSettings();
			expect(useMediaPlaybackStore.getState().items).toEqual([]);
		});
	});
});
