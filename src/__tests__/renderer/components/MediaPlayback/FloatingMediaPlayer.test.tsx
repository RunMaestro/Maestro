import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FloatingMediaPlayer } from '../../../../renderer/components/MediaPlayback/FloatingMediaPlayer';
import { useMediaPlaybackStore } from '../../../../renderer/stores/mediaPlaybackStore';
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

function renderPlayer(overrides: { kind?: 'audio' | 'video'; playing?: boolean } = {}) {
	render(
		<FloatingMediaPlayer
			title="podcast.mp3"
			subtitle="Agent One"
			kind={overrides.kind ?? 'audio'}
			playing={overrides.playing ?? false}
			theme={mockTheme}
		>
			<div data-testid="player-body">player</div>
		</FloatingMediaPlayer>
	);
}

describe('FloatingMediaPlayer', () => {
	beforeEach(() => {
		useMediaPlaybackStore.setState({
			items: [],
			activeItemId: null,
			history: [],
			playing: false,
			dismissed: false,
			minimized: false,
			pendingAutoplay: false,
			toggleRequest: 0,
			resumeTimes: {},
			floatRect: null,
		});
		(window as unknown as { maestro?: unknown }).maestro = { settings: { set: vi.fn() } };
	});

	it('shows the file name and owning agent', () => {
		renderPlayer();
		expect(screen.getByText('podcast.mp3')).toBeTruthy();
		expect(screen.getByText('Agent One')).toBeTruthy();
	});

	it('keeps the player mounted while minimized, so playback continues', () => {
		renderPlayer();
		fireEvent.click(screen.getByLabelText('Minimize player'));

		expect(useMediaPlaybackStore.getState().minimized).toBe(true);
		// Unmounting the element would pause the media, which is the whole thing
		// this component exists to avoid.
		expect(screen.getByTestId('player-body')).toBeTruthy();
	});

	it('offers play/pause on the pill only while minimized', () => {
		renderPlayer();
		// Expanded, the transport inside the player owns play/pause.
		expect(screen.queryByLabelText('Play')).toBeNull();

		fireEvent.click(screen.getByLabelText('Minimize player'));
		expect(screen.getByLabelText('Play')).toBeTruthy();
	});

	it('drives playback through the toggle nonce rather than a ref', () => {
		renderPlayer();
		fireEvent.click(screen.getByLabelText('Minimize player'));
		fireEvent.click(screen.getByLabelText('Play'));
		expect(useMediaPlaybackStore.getState().toggleRequest).toBe(1);
	});

	it('labels the pill button Pause when playing', () => {
		useMediaPlaybackStore.setState({ minimized: true });
		renderPlayer({ playing: true });
		expect(screen.getByLabelText('Pause')).toBeTruthy();
	});

	it('dismisses without stopping playback', () => {
		useMediaPlaybackStore.setState({ playing: true });
		renderPlayer({ playing: true });

		fireEvent.click(screen.getByLabelText('Hide player'));

		expect(useMediaPlaybackStore.getState().dismissed).toBe(true);
		expect(useMediaPlaybackStore.getState().playing).toBe(true);
	});

	it('seeds position from the persisted rect', () => {
		useMediaPlaybackStore.setState({
			floatRect: { top: 120, left: 240, width: 420, height: 260 },
		});
		renderPlayer();
		const el = screen.getByTestId('floating-media-player') as HTMLElement;
		expect(el.style.top).toBe('120px');
		expect(el.style.left).toBe('240px');
		expect(el.style.width).toBe('420px');
	});

	it('moves on drag and persists only on release', () => {
		const set = vi.fn();
		(window as unknown as { maestro: unknown }).maestro = { settings: { set } };
		useMediaPlaybackStore.setState({
			floatRect: { top: 200, left: 200, width: 400, height: 240 },
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
		expect(useMediaPlaybackStore.getState().floatRect).toEqual({
			top: 230,
			left: 240,
			width: 400,
			height: 240,
		});
	});

	it('drags from the title text, which is most of the handle', () => {
		useMediaPlaybackStore.setState({
			floatRect: { top: 200, left: 200, width: 400, height: 240 },
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
			floatRect: { top: 200, left: 200, width: 400, height: 240 },
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
			floatRect: { top: 200, left: 200, width: 400, height: 240 },
		});
		renderPlayer();
		const el = screen.getByTestId('floating-media-player') as HTMLElement;

		fireEvent.mouseDown(el.firstElementChild!, { button: 2, clientX: 300, clientY: 300 });
		fireEvent.mouseMove(window, { clientX: 400, clientY: 400 });
		expect(el.style.left).toBe('200px');
	});

	it('resizes from the grip', () => {
		useMediaPlaybackStore.setState({
			floatRect: { top: 100, left: 100, width: 400, height: 240 },
		});
		renderPlayer({ kind: 'video' });

		fireEvent.mouseDown(screen.getByTestId('modal-resize-grip'), {
			button: 0,
			clientX: 500,
			clientY: 340,
		});
		fireEvent.mouseMove(window, { clientX: 560, clientY: 380 });

		const el = screen.getByTestId('floating-media-player') as HTMLElement;
		expect(el.style.width).toBe('460px');
		expect(el.style.height).toBe('280px');
	});

	it('hides the resize grip while minimized', () => {
		useMediaPlaybackStore.setState({ minimized: true });
		renderPlayer();
		expect(screen.queryByTestId('modal-resize-grip')).toBeNull();
	});

	describe('history menu', () => {
		const a = item();
		const b = item({ id: 's1::/files/talk.mp4', path: '/files/talk.mp4', name: 'talk.mp4' });

		function seedQueue() {
			useMediaPlaybackStore.setState({
				items: [a, b],
				activeItemId: b.id,
				history: [b.id, a.id],
			});
		}

		it('lists recently played entries, newest first', () => {
			seedQueue();
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Recently played'));

			const menu = screen.getByTestId('media-history-menu');
			expect(menu.textContent).toContain('talk.mp4');
			expect(menu.textContent).toContain('podcast.mp3');
			expect(menu.textContent!.indexOf('talk.mp4')).toBeLessThan(
				menu.textContent!.indexOf('podcast.mp3')
			);
		});

		it('jumps to an earlier file and plays it', () => {
			seedQueue();
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Recently played'));
			// Scoped to the menu: the title bar names the loaded file too.
			const menu = screen.getByTestId('media-history-menu');
			fireEvent.click(within(menu).getByText('podcast.mp3'));

			const state = useMediaPlaybackStore.getState();
			expect(state.activeItemId).toBe(a.id);
			expect(state.pendingAutoplay).toBe(true);
			// Choosing an entry closes the menu.
			expect(screen.queryByTestId('media-history-menu')).toBeNull();
		});

		it('removes an entry from the queue', () => {
			seedQueue();
			renderPlayer();
			fireEvent.click(screen.getByLabelText('Recently played'));
			fireEvent.click(screen.getByLabelText('Remove podcast.mp3 from the queue'));

			expect(useMediaPlaybackStore.getState().items.map((i) => i.id)).toEqual([b.id]);
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
