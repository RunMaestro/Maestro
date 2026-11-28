import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	fileUrlToPath,
	openFileUrl,
	pathToFileUrl,
	windowsDrivePathToFileUrl,
} from '../../../renderer/utils/openFileUrl';

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

	it('percent-decodes the path before handing it to the caller', () => {
		const onFileClick = vi.fn();
		// A `file://` href is a URL, so a space arrives as `%20` - from the agent
		// writing the link and from mdast-util-to-hast's normalizeUri. Reading the
		// literal `%20` is an ENOENT, and the file-click handler reports that by
		// returning, so the click silently did nothing.
		openFileUrl('file:///Users/me/Projects/Voice%20Cloning/audition/01-take.wav', onFileClick);

		expect(onFileClick).toHaveBeenCalledWith(
			'/Users/me/Projects/Voice Cloning/audition/01-take.wav'
		);
		expect(openPath).not.toHaveBeenCalled();
	});

	it('percent-decodes the path on the OS branch too', () => {
		openFileUrl('file:///Users/me/Quarterly%20Reports/q3.pdf', vi.fn());
		expect(openPath).toHaveBeenCalledWith('/Users/me/Quarterly Reports/q3.pdf');
	});

	it('leaves a malformed percent escape alone rather than throwing', () => {
		const onFileClick = vi.fn();
		// `100% done.md` is a real filename; decodeURIComponent throws on it.
		openFileUrl('file:///tmp/100% done.md', onFileClick);

		expect(onFileClick).toHaveBeenCalledWith('/tmp/100% done.md');
	});

	it('reports handled so callers can stop, even for the OS branch', () => {
		// The return value is the "I took this" signal, not "I played it".
		expect(openFileUrl('file:///tmp/report.pdf')).toBe(true);
	});
});

describe('fileUrlToPath', () => {
	it('drops the slash before a Windows drive letter (#2067)', () => {
		expect(fileUrlToPath('file:///D:/work/a.png')).toBe('D:/work/a.png');
		expect(fileUrlToPath('file:///c:/Users/me/My%20Shots/a.png')).toBe(
			'c:/Users/me/My Shots/a.png'
		);
	});

	it('keeps the leading slash of a POSIX path', () => {
		expect(fileUrlToPath('file:///Users/me/a.png')).toBe('/Users/me/a.png');
	});

	it('returns null for anything that is not a file URL', () => {
		expect(fileUrlToPath('D:/work/a.png')).toBeNull();
	});
});

describe('windowsDrivePathToFileUrl', () => {
	it('turns a drive path into a file:/// URL with forward slashes', () => {
		expect(windowsDrivePathToFileUrl('D:/work/a.png')).toBe('file:///D:/work/a.png');
		expect(windowsDrivePathToFileUrl('C:\\Users\\me\\a.png')).toBe('file:///C:/Users/me/a.png');
	});

	it('round-trips through fileUrlToPath', () => {
		expect(fileUrlToPath(windowsDrivePathToFileUrl('D:/work/a.png')!)).toBe('D:/work/a.png');
	});

	it('returns null for a path without a drive letter', () => {
		expect(windowsDrivePathToFileUrl('/Users/me/a.png')).toBeNull();
		expect(windowsDrivePathToFileUrl('https://example.com/a.png')).toBeNull();
		expect(windowsDrivePathToFileUrl('D:relative.png')).toBeNull();
	});
});

describe('pathToFileUrl', () => {
	it('encodes each segment of a POSIX path', () => {
		expect(pathToFileUrl('/Users/me/My Site/index.html')).toBe(
			'file:///Users/me/My%20Site/index.html'
		);
	});

	it('keeps a Windows drive colon and normalizes backslashes', () => {
		expect(pathToFileUrl('C:\\Users\\Test Project\\a.html')).toBe(
			'file:///C:/Users/Test%20Project/a.html'
		);
	});

	it('keeps a backslash that is part of a POSIX file name', () => {
		// On POSIX `a\b.html` is one file. Read as a separator it would name
		// `b.html` in a folder `a`, a different file.
		expect(pathToFileUrl('/tmp/a\\b.html')).toBe('file:///tmp/a%5Cb.html');
		expect(pathToFileUrl('/srv/..\\..\\x.html')).toBe('file:///srv/..%5C..%5Cx.html');
	});

	it('still reads a backslash as the separator in a Windows path', () => {
		expect(pathToFileUrl('D:\\site\\a b.html')).toBe('file:///D:/site/a%20b.html');
		expect(pathToFileUrl('\\\\server\\share\\a.html')).toBe('file:////server/share/a.html');
	});

	it('round-trips through fileUrlToPath', () => {
		for (const path of ['/tmp/a b/#c.html', 'D:/x y/z.html', '/tmp/a\\b.html']) {
			expect(fileUrlToPath(pathToFileUrl(path))).toBe(path);
		}
	});
});
