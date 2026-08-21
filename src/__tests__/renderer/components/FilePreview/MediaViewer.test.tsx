/**
 * MediaViewer failure-state tests.
 *
 * The point of interest is the split between "gone" and "undecodable". Both
 * reach the media element as the same failure, and the card used to blame the
 * codec for either - which reads as a broken build rather than a deleted file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { MediaViewer } from '../../../../renderer/components/FilePreview/MediaViewer';
import { mockTheme } from '../../../helpers/mockTheme';
import { buildMediaStreamUrl } from '../../../../shared/mediaTypes';

const readFile = vi.fn();
const stat = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		fs: { readFile, stat },
		shell: { openPath: vi.fn() },
	};
});

const renderViewer = (path: string) =>
	render(
		<MediaViewer
			kind="audio"
			name={path.split('/').pop() as string}
			path={path}
			theme={mockTheme}
		/>
	);

describe('MediaViewer failure states', () => {
	it('reports a deleted file as missing rather than an unsupported codec', async () => {
		readFile.mockResolvedValue(null);

		renderViewer('/tmp/gone.mp3');

		expect(await screen.findByText('File Not Found')).toBeInTheDocument();
		expect(screen.queryByText(/codec/i)).not.toBeInTheDocument();
		// Nothing for the OS to open either, so no escape-hatch button.
		expect(screen.queryByText('Open in Default App')).not.toBeInTheDocument();
	});

	it('blames the codec when the file is on disk but the element rejects it', async () => {
		readFile.mockResolvedValue(buildMediaStreamUrl('token', '/tmp/weird.mp3'));
		stat.mockResolvedValue({ size: 1024, isDirectory: false });

		const { container } = renderViewer('/tmp/weird.mp3');

		const audio = await waitFor(() => {
			const el = container.querySelector('audio');
			expect(el).not.toBeNull();
			return el as HTMLAudioElement;
		});
		audio.dispatchEvent(new Event('error'));

		expect(await screen.findByText('Cannot Play This File')).toBeInTheDocument();
		expect(screen.getByText(/codec/i)).toBeInTheDocument();
	});

	it('re-classifies an element error as missing when the file vanished mid-play', async () => {
		readFile.mockResolvedValue(buildMediaStreamUrl('token', '/tmp/vanished.mp3'));
		stat.mockResolvedValue(null);

		const { container } = renderViewer('/tmp/vanished.mp3');

		const audio = await waitFor(() => {
			const el = container.querySelector('audio');
			expect(el).not.toBeNull();
			return el as HTMLAudioElement;
		});
		audio.dispatchEvent(new Event('error'));

		expect(await screen.findByText('File Not Found')).toBeInTheDocument();
	});

	it('keeps a non-streamable file (SSH remote) on the codec card', async () => {
		readFile.mockResolvedValue('raw file contents, not a stream url');

		renderViewer('/tmp/remote.mp3');

		expect(await screen.findByText('Cannot Play This File')).toBeInTheDocument();
	});
});
