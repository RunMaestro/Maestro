import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FloatingMediaPlayer } from '../../../../renderer/components/MediaPlayback/FloatingMediaPlayer';
import { useMediaPlaybackStore } from '../../../../renderer/stores/mediaPlaybackStore';
import { mockTheme } from '../../../helpers/mockTheme';

function renderPlayer(overrides: { kind?: 'audio' | 'video'; playing?: boolean } = {}) {
	const onReturnToTab = vi.fn();
	render(
		<FloatingMediaPlayer
			title="podcast.mp3"
			subtitle="Agent One"
			kind={overrides.kind ?? 'audio'}
			playing={overrides.playing ?? false}
			onReturnToTab={onReturnToTab}
			theme={mockTheme}
		>
			<div data-testid="player-body">player</div>
		</FloatingMediaPlayer>
	);
	return { onReturnToTab };
}

describe('FloatingMediaPlayer', () => {
	beforeEach(() => {
		useMediaPlaybackStore.setState({
			activeTabId: 'tab-1',
			playing: false,
			dismissed: false,
			minimized: false,
			pendingAutoplay: false,
			toggleRequest: 0,
			slots: {},
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

	it('returns to the tab from the title and from a double-click', () => {
		const { onReturnToTab } = renderPlayer();
		fireEvent.click(screen.getByTitle("Go to this file's tab"));
		expect(onReturnToTab).toHaveBeenCalledOnce();

		fireEvent.doubleClick(screen.getByTestId('floating-media-player').firstElementChild!);
		expect(onReturnToTab).toHaveBeenCalledTimes(2);
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
});
