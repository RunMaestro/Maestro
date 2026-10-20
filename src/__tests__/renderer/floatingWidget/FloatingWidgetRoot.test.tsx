import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { FloatingWidgetRoot } from '../../../renderer/floatingWidget/FloatingWidgetRoot';
import { useMediaPlaybackStore } from '../../../renderer/stores/mediaPlaybackStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { logger } from '../../../renderer/utils/logger';

const maestro = window.maestro as unknown as Record<string, unknown>;
const original = maestro.floatingWidgets;

let ready: ReturnType<typeof vi.fn>;

function openAs(search: string) {
	window.history.replaceState(null, '', `/${search}`);
}

async function renderRoot() {
	const result = render(
		<StrictMode>
			<FloatingWidgetRoot />
		</StrictMode>
	);
	await act(async () => {});
	return result;
}

beforeEach(() => {
	ready = vi.fn();
	maestro.floatingWidgets = {
		ready,
		show: vi.fn().mockResolvedValue(true),
		hide: vi.fn().mockResolvedValue(false),
		// The gauge body mirrors the primary window's readings.
		onState: vi.fn(() => () => {}),
		getState: vi.fn().mockResolvedValue(null),
		sendCommand: vi.fn(),
		// The media body is the authority: it publishes and takes commands.
		publishState: vi.fn(),
		onCommand: vi.fn(() => () => {}),
	};
	useMediaPlaybackStore.setState({ items: [], activeItemId: null, history: [], dismissed: false });
});

afterEach(() => {
	maestro.floatingWidgets = original;
	window.history.replaceState(null, '', '/');
	vi.restoreAllMocks();
});

describe('FloatingWidgetRoot', () => {
	it('renders nothing and logs for an unknown id', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		openAs('?floatingWidget=not-a-widget');
		const { container } = await renderRoot();
		expect(container).toBeEmptyDOMElement();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('not-a-widget'), 'FloatingWidget');
		expect(ready).not.toHaveBeenCalled();
	});

	it('renders nothing when the parameter is empty', async () => {
		vi.spyOn(logger, 'warn').mockImplementation(() => {});
		openAs('?floatingWidget=');
		const { container } = await renderRoot();
		expect(container).toBeEmptyDOMElement();
		expect(ready).not.toHaveBeenCalled();
	});

	it('renders the body for a known id', async () => {
		openAs('?floatingWidget=throughput-gauge');
		await renderRoot();
		expect(screen.getByTestId('floating-widget-frame')).toBeInTheDocument();
		expect(screen.getByTestId('floating-widget-title-strip')).toHaveTextContent('Throughput');
		expect(screen.getByTestId('throughput-gauge-widget')).toBeInTheDocument();
	});

	it('renders the media player body for its id', async () => {
		useMediaPlaybackStore.setState({
			items: [
				{
					id: 's1::/files/podcast.mp3',
					path: '/files/podcast.mp3',
					name: 'podcast.mp3',
					sessionId: 's1',
					sessionName: 'Agent One',
					kind: 'audio',
				},
			],
			activeItemId: 's1::/files/podcast.mp3',
		});
		openAs('?floatingWidget=media-player');
		await renderRoot();
		expect(screen.getByTestId('floating-widget-title-strip')).toHaveTextContent('podcast.mp3');
		expect(screen.getByTestId('media-player-widget')).toBeInTheDocument();
	});

	it('calls ready once with the id, even under StrictMode', async () => {
		openAs('?floatingWidget=media-player');
		const { rerender } = await renderRoot();
		await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
		rerender(
			<StrictMode>
				<FloatingWidgetRoot />
			</StrictMode>
		);
		await act(async () => {});
		expect(ready).toHaveBeenCalledTimes(1);
		expect(ready).toHaveBeenCalledWith('media-player');
	});

	// Main holds commands until ready, and the media queue hydrates in the
	// settings load, so a held open-file must not land before that load.
	it('waits for the settings load before calling ready', async () => {
		// StrictMode runs the load twice, so every read stays pending until released.
		let finishLoad: () => void = () => {};
		const pending = new Promise<Record<string, unknown>>((resolve) => {
			finishLoad = () => resolve({});
		});
		const settings = window.maestro.settings as unknown as { getAll: ReturnType<typeof vi.fn> };
		settings.getAll.mockImplementation(() => pending);
		useSettingsStore.setState({ settingsLoaded: false });
		try {
			openAs('?floatingWidget=media-player');
			await renderRoot();
			expect(ready).not.toHaveBeenCalled();

			await act(async () => finishLoad());
			await waitFor(() => expect(ready).toHaveBeenCalledWith('media-player'));
		} finally {
			settings.getAll.mockImplementation(() => Promise.resolve({}));
		}
	});
});
