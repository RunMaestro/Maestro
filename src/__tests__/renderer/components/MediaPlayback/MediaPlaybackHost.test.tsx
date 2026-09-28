import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MediaPlaybackHost } from '../../../../renderer/components/MediaPlayback/MediaPlaybackHost';
import { useMediaPlaybackStore } from '../../../../renderer/stores/mediaPlaybackStore';
import type { MediaItem } from '../../../../renderer/utils/mediaItems';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * Counts how many times the player element was constructed. Minimizing must
 * NOT increment it: React unmounting a media element runs the HTML spec's
 * internal pause steps, which silently stops the audio that minimizing is
 * supposed to preserve.
 */
const mountCount = vi.fn();

vi.mock('../../../../renderer/components/FilePreview/MediaViewer', () => ({
	MediaViewer: () => {
		// Fires on mount only - a re-render of the same element reuses it.
		useEffect(() => {
			mountCount();
		}, []);
		return <div data-testid="media-viewer" />;
	},
}));

const podcast: MediaItem = {
	id: 's1::/files/podcast.mp3',
	path: '/files/podcast.mp3',
	name: 'podcast.mp3',
	sessionId: 's1',
	sessionName: 'Agent One',
	kind: 'audio',
};

function seed(dismissed: boolean) {
	useMediaPlaybackStore.setState({
		items: [podcast],
		activeItemId: podcast.id,
		history: [],
		playing: true,
		dismissed,
		pendingAutoplay: false,
		toggleRequest: 0,
		resumeTimes: {},
		durations: {},
		floatPosition: null,
		floatWidths: {},
		aspects: {},
	});
}

describe('MediaPlaybackHost', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		seed(false);
		(window as unknown as { maestro?: unknown }).maestro = { settings: { set: vi.fn() } };
	});

	it('keeps the same element mounted across minimize and restore', () => {
		const { rerender } = render(<MediaPlaybackHost theme={mockTheme} />);
		expect(mountCount).toHaveBeenCalledTimes(1);

		// Minimize. Rendering the player under a different wrapper here would
		// remount it and stop the audio - the bug this test exists to catch.
		seed(true);
		rerender(<MediaPlaybackHost theme={mockTheme} />);
		expect(mountCount).toHaveBeenCalledTimes(1);

		seed(false);
		rerender(<MediaPlaybackHost theme={mockTheme} />);
		expect(mountCount).toHaveBeenCalledTimes(1);
	});

	it('hides the frame rather than unmounting it while minimized', () => {
		seed(true);
		render(<MediaPlaybackHost theme={mockTheme} />);

		const frame = screen.getByTestId('floating-media-player');
		expect(frame.style.visibility).toBe('hidden');
		expect(frame.getAttribute('aria-hidden')).toBe('true');
		// Still in the document, so the decode pipeline stays alive.
		expect(screen.getByTestId('media-viewer')).toBeTruthy();
	});

	it('shows the frame normally when not minimized', () => {
		render(<MediaPlaybackHost theme={mockTheme} />);
		const frame = screen.getByTestId('floating-media-player');
		expect(frame.style.visibility).toBe('');
		expect(frame.getAttribute('aria-hidden')).toBeNull();
	});

	it('renders nothing when no track is loaded', () => {
		useMediaPlaybackStore.setState({ items: [], activeItemId: null });
		render(<MediaPlaybackHost theme={mockTheme} />);
		expect(screen.queryByTestId('floating-media-player')).toBeNull();
	});
});
