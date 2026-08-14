import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FloatingMediaPlayer } from '../../../../renderer/components/MediaPlayback/FloatingMediaPlayer';
import { useMediaPlaybackStore } from '../../../../renderer/stores/mediaPlaybackStore';
import {
	MEDIA_FLOAT_DEFAULT_WIDTH,
	mediaFloatChromeHeight,
} from '../../../../renderer/utils/mediaFloatGeometry';
import type { MediaItem } from '../../../../renderer/utils/mediaItems';
import { mockTheme } from '../../../helpers/mockTheme';

function item(overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: 's1::/files/podcast.mp3',
		path: '/files/podcast.mp3',
		name: 'podcast.mp3',
		sessionId: 's1',
		sessionName: 'Agent One',
		kind: 'audio',
		...overrides,
	};
}

interface PlayerOverrides {
	kind?: 'audio' | 'video';
	aspect?: number;
	transportHeight?: number | null;
}

function playerElement(overrides: PlayerOverrides = {}) {
	return (
		<FloatingMediaPlayer
			title="podcast.mp3"
			subtitle="Agent One"
			kind={overrides.kind ?? 'audio'}
			aspect={overrides.aspect}
			transportHeight={overrides.transportHeight ?? null}
			theme={mockTheme}
		>
			<div data-testid="player-body">player</div>
		</FloatingMediaPlayer>
	);
}

function renderPlayer(overrides: PlayerOverrides = {}) {
	return render(playerElement(overrides));
}

/** Frame height with nothing measured yet: title bar plus the fallback strip. */
const CHROME = mediaFloatChromeHeight(null);
const frame = () => screen.getByTestId('floating-media-player') as HTMLElement;

describe('FloatingMediaPlayer', () => {
	beforeEach(() => {
		useMediaPlaybackStore.setState({
			items: [],
			activeItemId: null,
			history: [],
			playing: false,
			dismissed: false,
			pendingAutoplay: false,
			toggleRequest: 0,
			resumeTimes: {},
			durations: {},
			floatPosition: null,
			floatWidths: {},
			aspects: {},
		});
		(window as unknown as { maestro?: unknown }).maestro = { settings: { set: vi.fn() } };
	});

	it('shows the file name and owning agent', () => {
		renderPlayer();
		expect(screen.getByText('podcast.mp3')).toBeTruthy();
		expect(screen.getByText('Agent One')).toBeTruthy();
	});

	it('minimizes to the Left Bar without stopping playback', () => {
		useMediaPlaybackStore.setState({ items: [item()], activeItemId: item().id, playing: true });
		renderPlayer();

		fireEvent.click(screen.getByLabelText('Minimize player to the Left Bar'));

		const state = useMediaPlaybackStore.getState();
		expect(state.dismissed).toBe(true);
		// Minimizing is not stopping: the audio keeps going and the header pill
		// takes over as its transport.
		expect(state.playing).toBe(true);
		expect(state.activeItemId).toBe(item().id);
		// The queue entry survives, so restoring finds the same file loaded.
		expect(state.items).toHaveLength(1);
	});

	it('closing stops playback and releases the player', () => {
		const a = item();
		useMediaPlaybackStore.setState({ items: [a], activeItemId: a.id, playing: true });
		renderPlayer();

		fireEvent.click(screen.getByLabelText('Close player and stop playback'));

		const state = useMediaPlaybackStore.getState();
		// Unlike minimize, close releases the element - which is what actually
		// stops the sound - rather than leaving audio coming from nowhere.
		expect(state.activeItemId).toBeNull();
		expect(state.playing).toBe(false);
		expect(state.dismissed).toBe(false);
	});

	it('leaves the rest of the queue alone when closing', () => {
		const a = item();
		const b = item({ id: 's1::/files/talk.mp4', path: '/files/talk.mp4', name: 'talk.mp4' });
		useMediaPlaybackStore.setState({ items: [a, b], activeItemId: a.id });
		renderPlayer();

		fireEvent.click(screen.getByLabelText('Close player and stop playback'));

		// Close is "stop", not "throw away my playlist".
		expect(useMediaPlaybackStore.getState().items.map((i) => i.id)).toEqual([b.id]);
	});

	it('no longer owns play/pause - that moved to the header pill', () => {
		useMediaPlaybackStore.setState({ items: [item()], activeItemId: item().id });
		renderPlayer();
		// Expanded, the transport inside the player is the only play/pause.
		expect(screen.queryByLabelText(/^(Play|Pause)$/)).toBeNull();
	});

	it('seeds from the remembered position and this kind width', () => {
		useMediaPlaybackStore.setState({
			floatPosition: { top: 120, left: 240 },
			floatWidths: { audio: 420, video: 800 },
		});
		renderPlayer();
		expect(frame().style.top).toBe('120px');
		expect(frame().style.left).toBe('240px');
		expect(frame().style.width).toBe('420px');
	});

	it('moves on drag and persists only on release', () => {
		const set = vi.fn();
		(window as unknown as { maestro: unknown }).maestro = { settings: { set } };
		useMediaPlaybackStore.setState({
			floatPosition: { top: 200, left: 200 },
			floatWidths: { audio: 400 },
		});
		renderPlayer();

		const el = screen.getByTestId('floating-media-player') as HTMLElement;
		const handle = el.firstElementChild!;

		fireEvent.mouseDown(handle, { button: 0, clientX: 300, clientY: 300 });
		fireEvent.mouseMove(window, { clientX: 340, clientY: 330 });
		expect(el.style.left).toBe('240px');
		expect(el.style.top).toBe('230px');
		// A drag should be one settings write, not one per mousemove.
		expect(set).not.toHaveBeenCalled();

		fireEvent.mouseUp(window);
		expect(set).toHaveBeenCalledOnce();
		expect(useMediaPlaybackStore.getState().floatPosition).toEqual({ top: 230, left: 240 });
		expect(useMediaPlaybackStore.getState().floatWidths).toEqual({ audio: 400 });
	});

	it('drags from the title text, which is most of the handle', () => {
		useMediaPlaybackStore.setState({
			floatPosition: { top: 200, left: 200 },
			floatWidths: { audio: 400 },
		});
		renderPlayer();
		const el = screen.getByTestId('floating-media-player') as HTMLElement;

		// The title used to swallow its own mousedown, so grabbing the widget where
		// it looks most grabbable did nothing at all.
		fireEvent.mouseDown(screen.getByTitle('podcast.mp3'), {
			button: 0,
			clientX: 300,
			clientY: 300,
		});
		fireEvent.mouseMove(window, { clientX: 350, clientY: 320 });
		fireEvent.mouseUp(window);

		expect(el.style.left).toBe('250px');
		expect(el.style.top).toBe('220px');
	});

	it('ignores movement below the slop threshold, so a click does not nudge it', () => {
		useMediaPlaybackStore.setState({
			floatPosition: { top: 200, left: 200 },
			floatWidths: { audio: 400 },
		});
		renderPlayer();
		const el = screen.getByTestId('floating-media-player') as HTMLElement;

		fireEvent.mouseDown(el.firstElementChild!, { button: 0, clientX: 300, clientY: 300 });
		fireEvent.mouseMove(window, { clientX: 301, clientY: 301 });

		expect(el.style.left).toBe('200px');
		expect(el.style.top).toBe('200px');
	});

	it('ignores a non-left mouse button', () => {
		useMediaPlaybackStore.setState({
			floatPosition: { top: 200, left: 200 },
			floatWidths: { audio: 400 },
		});
		renderPlayer();
		const el = screen.getByTestId('floating-media-player') as HTMLElement;

		fireEvent.mouseDown(el.firstElementChild!, { button: 2, clientX: 300, clientY: 300 });
		fireEvent.mouseMove(window, { clientX: 400, clientY: 400 });
		expect(el.style.left).toBe('200px');
	});

	it('resizes from the grip, with the height following the picture', () => {
		useMediaPlaybackStore.setState({
			floatPosition: { top: 100, left: 100 },
			floatWidths: { video: 400 },
		});
		renderPlayer({ kind: 'video' });

		fireEvent.mouseDown(screen.getByTestId('modal-resize-grip'), {
			button: 0,
			clientX: 500,
			clientY: 340,
		});
		fireEvent.mouseMove(window, { clientX: 560, clientY: 340 });

		expect(frame().style.width).toBe('460px');
		// 16:9 of the new width, not the dragged height - a video frame that is not
		// its own shape just paints black bars.
		expect(frame().style.height).toBe(`${CHROME + Math.round((460 * 9) / 16)}px`);
	});

	describe('fitting the frame to the media', () => {
		it('collapses audio to the controls, since it has no picture', () => {
			renderPlayer();
			expect(frame().style.height).toBe(`${CHROME}px`);
			expect(frame().style.width).toBe(`${MEDIA_FLOAT_DEFAULT_WIDTH.audio}px`);
		});

		it('opens video wide enough to watch, at its own aspect ratio', () => {
			renderPlayer({ kind: 'video' });
			const width = MEDIA_FLOAT_DEFAULT_WIDTH.video;
			expect(frame().style.width).toBe(`${width}px`);
			expect(frame().style.height).toBe(`${CHROME + Math.round((width * 9) / 16)}px`);
		});

		it('fits a vertical clip rather than showing it inside black bars', () => {
			renderPlayer({ kind: 'video', aspect: 9 / 16 });
			const width = parseInt(frame().style.width, 10);
			expect(frame().style.height).toBe(`${CHROME + Math.round(width / (9 / 16))}px`);
		});

		it('reshapes as the queue steps from audio to video and back', () => {
			// The point of the whole exercise: ten mixed files should each get the
			// right form factor without the user touching the grip.
			const { rerender } = renderPlayer();
			const audioHeight = frame().style.height;

			rerender(playerElement({ kind: 'video' }));
			expect(frame().style.width).toBe(`${MEDIA_FLOAT_DEFAULT_WIDTH.video}px`);
			expect(parseInt(frame().style.height, 10)).toBeGreaterThan(parseInt(audioHeight, 10));

			rerender(playerElement({ kind: 'audio' }));
			expect(frame().style.height).toBe(audioHeight);
			expect(frame().style.width).toBe(`${MEDIA_FLOAT_DEFAULT_WIDTH.audio}px`);
		});

		it('gives each kind back the width the user chose for it', () => {
			useMediaPlaybackStore.setState({
				floatPosition: { top: 40, left: 40 },
				floatWidths: { audio: 420, video: 880 },
			});
			const { rerender } = renderPlayer();
			expect(frame().style.width).toBe('420px');

			rerender(playerElement({ kind: 'video' }));
			expect(frame().style.width).toBe('880px');
		});

		it('stays put across a kind switch, so the widget does not wander', () => {
			useMediaPlaybackStore.setState({
				floatPosition: { top: 120, left: 200 },
				floatWidths: {},
			});
			const { rerender } = renderPlayer();
			rerender(playerElement({ kind: 'video' }));
			expect(frame().style.left).toBe('200px');
			expect(frame().style.top).toBe('120px');
		});

		it('uses the measured transport height once it arrives', () => {
			const { rerender } = renderPlayer();
			expect(frame().style.height).toBe(`${CHROME}px`);
			// The real strip is shorter than the fallback on this platform; the frame
			// has to follow it, or every video below it sits in a letterbox.
			rerender(playerElement({ transportHeight: 70 }));
			expect(frame().style.height).toBe(`${mediaFloatChromeHeight(70)}px`);
		});
	});

	describe('queue and history menus', () => {
		const a = item();
		const b = item({ id: 's1::/files/talk.mp4', path: '/files/talk.mp4', name: 'talk.mp4' });

		/** b is loaded and a is queued behind it, with a also already played. */
		function seedQueue() {
			useMediaPlaybackStore.setState({
				items: [a, b],
				activeItemId: b.id,
				history: [a],
			});
		}

		it('hides both buttons when there is nothing to list', () => {
			renderPlayer();
			expect(screen.queryByLabelText('Recently played')).toBeNull();
			expect(screen.queryByLabelText(/Play queue/)).toBeNull();
		});

		it('counts only what is queued behind the loaded track', () => {
			// Two entries, one of them playing - so one thing is actually "up next".
			useMediaPlaybackStore.setState({ items: [a, b], activeItemId: a.id });
			renderPlayer();
			expect(screen.getByLabelText('Play queue, 1 item')).toBeTruthy();
			// Nothing has departed the player, so there is no history button yet.
			expect(screen.queryByLabelText('Recently played')).toBeNull();
		});

		it('hides the queue button when the only track is the one playing', () => {
			// "Play Queue (0)" is just noise: there is nothing coming next.
			useMediaPlaybackStore.setState({ items: [a], activeItemId: a.id });
			renderPlayer();
			expect(screen.queryByLabelText(/Play queue/)).toBeNull();
		});

		it('leaves the playing track out of the queue list', () => {
			seedQueue();
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Play queue, 1 item'));

			const menu = screen.getByTestId('media-queue-menu');
			expect(within(menu).getByText('podcast.mp3')).toBeTruthy();
			// talk.mp4 is loaded, so it is the now-playing line, not a queue entry.
			expect(within(menu).queryByText('talk.mp4')).toBeNull();
		});

		it('lists the queue in open order, not recency', () => {
			const c = item({ id: 's1::/files/c.mp3', path: '/files/c.mp3', name: 'c.mp3' });
			useMediaPlaybackStore.setState({ items: [a, b, c], activeItemId: b.id });
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Play queue, 2 items'));

			const menu = screen.getByTestId('media-queue-menu');
			expect(menu.textContent!.indexOf('podcast.mp3')).toBeLessThan(
				menu.textContent!.indexOf('c.mp3')
			);
		});

		it('plays a queue entry, which then leaves the queue list', () => {
			seedQueue();
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Play queue, 1 item'));
			fireEvent.click(within(screen.getByTestId('media-queue-menu')).getByText('podcast.mp3'));

			expect(useMediaPlaybackStore.getState().activeItemId).toBe(a.id);
			// The two swap places: a is now playing, b is what is queued.
			fireEvent.click(screen.getByLabelText('Play queue, 1 item'));
			const menu = screen.getByTestId('media-queue-menu');
			expect(within(menu).getByText('talk.mp4')).toBeTruthy();
			expect(within(menu).queryByText('podcast.mp3')).toBeNull();
		});

		it('removes a queued entry without touching the loaded one', () => {
			seedQueue();
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Play queue, 1 item'));
			fireEvent.click(screen.getByLabelText('Remove podcast.mp3 from the queue'));

			const state = useMediaPlaybackStore.getState();
			expect(state.items.map((i) => i.id)).toEqual([b.id]);
			expect(state.activeItemId).toBe(b.id);
		});

		it('clears what is queued without stopping the music', () => {
			useMediaPlaybackStore.setState({ playing: true });
			seedQueue();
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Play queue, 1 item'));
			fireEvent.click(screen.getByText('Clear'));

			const state = useMediaPlaybackStore.getState();
			// Clear empties what plays NEXT. Stopping is what the x button is for.
			expect(state.items.map((i) => i.id)).toEqual([b.id]);
			expect(state.activeItemId).toBe(b.id);
			expect(state.playing).toBe(true);
			expect(screen.queryByTestId('media-queue-menu')).toBeNull();
		});

		it('lists recently played entries, newest first', () => {
			const c = item({ id: 's1::/files/c.mp3', path: '/files/c.mp3', name: 'c.mp3' });
			// c is loaded; b then a departed, most recent first.
			useMediaPlaybackStore.setState({ items: [c], activeItemId: c.id, history: [b, a] });
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Recently played'));

			const menu = screen.getByTestId('media-history-menu');
			expect(menu.textContent!.indexOf('talk.mp4')).toBeLessThan(
				menu.textContent!.indexOf('podcast.mp3')
			);
			// The loaded track is never its own history.
			expect(within(menu).queryByText('c.mp3')).toBeNull();
		});

		it('re-queues a history entry the queue no longer holds', () => {
			// History outlives the queue, so its entries have to be able to bring a
			// file back rather than pointing at a queue slot that is gone.
			useMediaPlaybackStore.setState({ items: [b], activeItemId: b.id, history: [b, a] });
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Recently played'));
			const menu = screen.getByTestId('media-history-menu');
			fireEvent.click(within(menu).getByText('podcast.mp3'));

			const state = useMediaPlaybackStore.getState();
			expect(state.items.map((i) => i.id)).toEqual([b.id, a.id]);
			expect(state.activeItemId).toBe(a.id);
			expect(state.pendingAutoplay).toBe(true);
			// Choosing an entry closes the menu.
			expect(screen.queryByTestId('media-history-menu')).toBeNull();
		});

		it('removing from history leaves the queue alone', () => {
			seedQueue();
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Recently played'));
			fireEvent.click(screen.getByLabelText('Remove podcast.mp3 from the history'));

			const state = useMediaPlaybackStore.getState();
			expect(state.history).toEqual([]);
			expect(state.items).toHaveLength(2);
		});

		it('opens one list at a time', () => {
			seedQueue();
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Recently played'));
			fireEvent.click(screen.getByLabelText('Play queue, 1 item'));

			expect(screen.getByTestId('media-queue-menu')).toBeTruthy();
			expect(screen.queryByTestId('media-history-menu')).toBeNull();
		});

		it('shows how long each entry runs', () => {
			const c = item({ id: 's1::/files/c.mp3', path: '/files/c.mp3', name: 'c.mp3' });
			useMediaPlaybackStore.setState({
				items: [c],
				activeItemId: c.id,
				history: [b, a],
				durations: { [a.id]: 266, [b.id]: 95 },
			});
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Recently played'));

			const menu = screen.getByTestId('media-history-menu');
			expect(within(menu).getByText('4:26')).toBeTruthy();
			expect(within(menu).getByText('1:35')).toBeTruthy();
		});

		it('says how much is left of something part-played', () => {
			const c = item({ id: 's1::/files/c.mp3', path: '/files/c.mp3', name: 'c.mp3' });
			useMediaPlaybackStore.setState({
				items: [a, b, c],
				activeItemId: b.id,
				durations: { [a.id]: 266 },
				resumeTimes: { [a.id]: 60 },
			});
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Play queue, 2 items'));

			const menu = screen.getByTestId('media-queue-menu');
			expect(within(menu).getByText('-3:26')).toBeTruthy();
			// Nothing known about the other file, so it says so rather than lying.
			expect(within(menu).getByText('--:--')).toBeTruthy();
		});

		it('leaves off the remaining time at either end of a file', () => {
			// A second in is "not started" and a second from the end is "finished";
			// in both cases the plain length already says everything useful.
			seedQueue();
			useMediaPlaybackStore.setState({
				durations: { [a.id]: 266, [b.id]: 266 },
				resumeTimes: { [a.id]: 0.5, [b.id]: 265.8 },
			});
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Play queue, 1 item'));

			const menu = screen.getByTestId('media-queue-menu');
			expect(within(menu).queryByText(/^-/)).toBeNull();
		});

		it('closes on an outside click', () => {
			seedQueue();
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Recently played'));
			expect(screen.getByTestId('media-history-menu')).toBeTruthy();

			// The list is portaled to the body, so it is not a DOM descendant of the
			// button - the outside-click check has to know about both.
			fireEvent.mouseDown(document.body);
			expect(screen.queryByTestId('media-history-menu')).toBeNull();
		});
	});
});
