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
		dormant: false,
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

	it('stays hidden for a queue restored from disk until the player is used', () => {
		// Launching with yesterday's queue still loaded must not put media
		// controls in the header: nothing is playing and the user opened nothing.
		seed({ playing: false, dormant: true });
		render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.queryByTestId('now-playing-indicator')).toBeNull();
	});

	it('appears once the restored queue is woken', () => {
		seed({ playing: false, dormant: true });
		const { rerender } = render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.queryByTestId('now-playing-indicator')).toBeNull();

		useMediaPlaybackStore.getState().restore();
		useMediaPlaybackStore.setState({ dismissed: true });
		rerender(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.getByTestId('now-playing-indicator')).toBeTruthy();
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

	it('groups the two buttons into one bordered pill with a divider', () => {
		// Without the shared border and the rule between them they read as two
		// unrelated header icons that happen to sit next to each other.
		render(<NowPlayingIndicator theme={mockTheme} />);
		const pill = screen.getByTestId('now-playing-indicator');

		expect(pill.className).toContain('border');
		expect(pill.className).toContain('rounded');
		// One divider element between the two buttons.
		expect(pill.querySelectorAll('[aria-hidden]')).toHaveLength(1);
		expect(pill.querySelectorAll('button')).toHaveLength(2);
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

	// This pill used to be `shrink-0`, back when the MAESTRO wordmark carried
	// `truncate` and was the header row's shrink target. A clipped brand reads as
	// a rendering bug, so the wordmark now drops out whole and this pill inherits
	// the role: its filename is already truncated, and a clipped filename is
	// ordinary.
	it("can shrink, since it is now the header row's yield of last resort", () => {
		render(<NowPlayingIndicator theme={mockTheme} />);
		const pill = screen.getByTestId('now-playing-indicator');
		expect(pill.className).not.toContain('shrink-0');
		// It needs min-w-0 to be able to shrink at all: a flex item defaults to
		// min-width:auto and would refuse to go below its content.
		expect(pill.className).toContain('min-w-0');
		expect(screen.getByTestId('now-playing-toggle').className).toContain('min-w-0');
	});

	it('never sheds a control, only the filename', () => {
		render(<NowPlayingIndicator theme={mockTheme} />);
		// Both buttons and the divider are the entire transport a minimized player
		// has, so they must not be what gets squeezed.
		expect(screen.getByTestId('now-playing-restore').querySelector('svg, span')).toBeTruthy();
		expect(screen.getByText('podcast.mp3').className).toContain('truncate');
	});
});
