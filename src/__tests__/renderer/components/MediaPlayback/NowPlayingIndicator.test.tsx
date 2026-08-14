import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NowPlayingIndicator } from '../../../../renderer/components/MediaPlayback/NowPlayingIndicator';
import { useMediaPlaybackStore } from '../../../../renderer/stores/mediaPlaybackStore';
import type { MediaItem } from '../../../../renderer/utils/mediaItems';
import { mockTheme } from '../../../helpers/mockTheme';

const podcast: MediaItem = {
	id: 's1::/files/podcast.mp3',
	path: '/files/podcast.mp3',
	name: 'podcast.mp3',
	sessionId: 's1',
	sessionName: 'Agent One',
	kind: 'audio',
};

function seed(overrides: Partial<ReturnType<typeof useMediaPlaybackStore.getState>> = {}) {
	useMediaPlaybackStore.setState({
		items: [podcast],
		activeItemId: podcast.id,
		history: [],
		playing: true,
		dismissed: true,
		minimized: false,
		pendingAutoplay: false,
		toggleRequest: 0,
		resumeTimes: {},
		durations: {},
		floatPosition: null,
		floatWidths: {},
		aspects: {},
		...overrides,
	});
}

describe('NowPlayingIndicator', () => {
	beforeEach(() => {
		seed();
		(window as unknown as { maestro?: unknown }).maestro = { settings: { set: vi.fn() } };
	});

	it('names the minimized file, so audio is never coming from nowhere', () => {
		render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.getByTestId('now-playing-indicator').textContent).toContain('podcast.mp3');
	});

	it('stays out of the way while the player is on screen', () => {
		seed({ dismissed: false });
		render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.queryByTestId('now-playing-indicator')).toBeNull();
	});

	it('disappears when the player is closed', () => {
		seed({ items: [], activeItemId: null });
		render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.queryByTestId('now-playing-indicator')).toBeNull();
	});

	it('shows a pause button while playing, and pausing flips it to play', () => {
		// A media control shows the action, not the state - so the glyph is what
		// the click will do.
		const { rerender } = render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.getByLabelText('Pause podcast.mp3')).toBeTruthy();

		fireEvent.click(screen.getByTestId('now-playing-toggle'));
		expect(useMediaPlaybackStore.getState().toggleRequest).toBe(1);

		// The element reports back through the store, which flips the glyph.
		seed({ playing: false });
		rerender(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.getByLabelText('Play podcast.mp3')).toBeTruthy();
	});

	it('toggles through the nonce rather than holding a ref to the element', () => {
		render(<NowPlayingIndicator theme={mockTheme} />);
		fireEvent.click(screen.getByTestId('now-playing-toggle'));
		fireEvent.click(screen.getByTestId('now-playing-toggle'));
		expect(useMediaPlaybackStore.getState().toggleRequest).toBe(2);
	});

	it('toggling playback does not restore the player', () => {
		// The two are separate controls precisely so neither happens by accident.
		render(<NowPlayingIndicator theme={mockTheme} />);
		fireEvent.click(screen.getByTestId('now-playing-toggle'));
		expect(useMediaPlaybackStore.getState().dismissed).toBe(true);
	});

	it('brings the player back from its own button, without touching playback', () => {
		render(<NowPlayingIndicator theme={mockTheme} />);
		fireEvent.click(screen.getByTestId('now-playing-restore'));

		const state = useMediaPlaybackStore.getState();
		expect(state.dismissed).toBe(false);
		expect(state.toggleRequest).toBe(0);
	});

	it('stays put while paused, rather than stranding a half-listened file', () => {
		// Vanishing on pause would leave no route back to the widget except the
		// command palette.
		seed({ playing: false });
		render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.getByLabelText('Play podcast.mp3')).toBeTruthy();
	});

	it('keeps both buttons where there is no room for the label', () => {
		// A narrow sidebar must not be the one place with no way back to the
		// player, so only the filename is dropped.
		render(<NowPlayingIndicator theme={mockTheme} compact />);
		expect(screen.getByTestId('now-playing-indicator').textContent).toBe('');
		expect(screen.getByTestId('now-playing-toggle')).toBeTruthy();
		expect(screen.getByTestId('now-playing-restore')).toBeTruthy();
		// The file is still named, just not in the row itself.
		expect(screen.getByTestId('now-playing-toggle').getAttribute('title')).toContain('podcast.mp3');
	});

	it('never shrinks, so it cannot be the thing that squeezes the header', () => {
		render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.getByTestId('now-playing-indicator').className).toContain('shrink-0');
	});
});
