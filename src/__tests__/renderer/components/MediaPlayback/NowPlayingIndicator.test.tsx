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

	it('names the hidden file, so audio is never coming from nowhere', () => {
		render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.getByTestId('now-playing-indicator').textContent).toContain('podcast.mp3');
	});

	it('stays out of the way while the player is on screen', () => {
		seed({ dismissed: false });
		render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.queryByTestId('now-playing-indicator')).toBeNull();
	});

	it('disappears with the last queue entry', () => {
		seed({ items: [], activeItemId: null });
		render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.queryByTestId('now-playing-indicator')).toBeNull();
	});

	it('brings the player back on click', () => {
		render(<NowPlayingIndicator theme={mockTheme} />);
		fireEvent.click(screen.getByTestId('now-playing-indicator'));
		expect(useMediaPlaybackStore.getState().dismissed).toBe(false);
	});

	it('stays put while paused, rather than stranding a half-listened file', () => {
		// Vanishing on pause would leave no route back to the widget except the
		// command palette.
		seed({ playing: false });
		render(<NowPlayingIndicator theme={mockTheme} />);
		expect(screen.getByLabelText(/^Paused podcast\.mp3/)).toBeTruthy();
	});

	it('drops the label in the collapsed Left Bar, where there is no room', () => {
		render(<NowPlayingIndicator theme={mockTheme} compact />);
		expect(screen.getByTestId('now-playing-indicator').textContent).toBe('');
	});
});
