import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openFileUrl } from '../../../renderer/utils/openFileUrl';

const openPath = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	(window as unknown as { maestro: unknown }).maestro = { shell: { openPath } };
});

describe('openFileUrl', () => {
	it('ignores anything that is not a file:// href', () => {
		expect(openFileUrl('https://example.com', vi.fn())).toBe(false);
		expect(openFileUrl('maestro-file://src/app.ts', vi.fn())).toBe(false);
		expect(openPath).not.toHaveBeenCalled();
	});

	it('routes playable media back through the caller instead of the OS', () => {
		const onFileClick = vi.fn();
		expect(openFileUrl('file:///Users/me/Scratch/podcast.mp3', onFileClick)).toBe(true);

		// The caller's handler funnels into handleOpenFileTab, the single choke
		// point that diverts media to the floating player.
		expect(onFileClick).toHaveBeenCalledWith('/Users/me/Scratch/podcast.mp3');
		expect(openPath).not.toHaveBeenCalled();
	});

	it('opens a previewable file in Maestro instead of the OS', () => {
		const onFileClick = vi.fn();
		// A JSON outside the project root used to be handed to the system editor.
		expect(openFileUrl('file:///Users/me/.config/app/creds.json', onFileClick)).toBe(true);

		expect(onFileClick).toHaveBeenCalledWith('/Users/me/.config/app/creds.json');
		expect(openPath).not.toHaveBeenCalled();
	});

	it('previews text, config, and source files too', () => {
		const onFileClick = vi.fn();
		for (const path of ['/tmp/notes.txt', '/etc/hosts.yaml', '/tmp/main.py', '/tmp/app.log']) {
			openFileUrl(`file://${path}`, onFileClick);
			expect(onFileClick).toHaveBeenCalledWith(path);
		}
		expect(openPath).not.toHaveBeenCalled();
	});

	it('leaves OS-owned file types to the OS default app', () => {
		const onFileClick = vi.fn();
		expect(openFileUrl('file:///tmp/report.pdf', onFileClick)).toBe(true);
		openFileUrl('file:///tmp/archive.zip', onFileClick);

		expect(openPath).toHaveBeenCalledWith('/tmp/report.pdf');
		expect(openPath).toHaveBeenCalledWith('/tmp/archive.zip');
		expect(onFileClick).not.toHaveBeenCalled();
	});

	it('ignores dots in parent directories when reading the extension', () => {
		const onFileClick = vi.fn();
		// getBasename first: a `.pdf` folder holding a text file is not a PDF.
		openFileUrl('file:///tmp/exports.pdf/summary.json', onFileClick);

		expect(onFileClick).toHaveBeenCalledWith('/tmp/exports.pdf/summary.json');
		expect(openPath).not.toHaveBeenCalled();
	});

	it('opens a container Chromium cannot decode in the OS', () => {
		// mkv/avi/wmv are deliberately absent from the playable list, so there is
		// no player to route them to.
		openFileUrl('file:///tmp/movie.mkv', vi.fn());
		expect(openPath).toHaveBeenCalledWith('/tmp/movie.mkv');
	});

	it('falls back to the OS for media when the surface has no handler', () => {
		expect(openFileUrl('file:///tmp/song.mp3')).toBe(true);
		expect(openPath).toHaveBeenCalledWith('/tmp/song.mp3');
	});

	it('reports handled so callers can stop, even for the OS branch', () => {
		// The return value is the "I took this" signal, not "I played it".
		expect(openFileUrl('file:///tmp/report.pdf')).toBe(true);
	});
});
