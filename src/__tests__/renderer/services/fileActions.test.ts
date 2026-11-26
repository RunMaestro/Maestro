/**
 * @fileoverview The one fetch-then-act step behind every file action. A local
 * path is acted on in place; a path on the agent's SSH remote (an SSH or a
 * hosted agent) is fetched to this machine first and the same action gets the
 * fetched copy. A remote folder, which has no location here, goes to the Files
 * panel with a flash.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	__resetFileActionsForTests,
	cachedLocalCopy,
	fetchLocalCopy,
	fetchLocalFolderCopy,
	openFileInDefaultApp,
	openFileInMaestroBrowser,
	openFolderInFileManager,
	resolveOpenSource,
	revealInFileManager,
	saveCopyOfFile,
} from '../../../renderer/services/fileActions';
import { useCenterFlashStore } from '../../../renderer/stores/centerFlashStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers';

const LOCAL_COPY = '/tmp/maestro-remote-downloads/abc/report.pdf';
const remoteIdFor = (mode: AgentMode) => (mode === 'local' ? undefined : 'r1');

let downloadRemoteFile: ReturnType<typeof vi.fn>;
let downloadRemoteFolder: ReturnType<typeof vi.fn>;
let openPath: ReturnType<typeof vi.fn>;
let showItemInFolder: ReturnType<typeof vi.fn>;
let copyPath: ReturnType<typeof vi.fn>;
let readFile: ReturnType<typeof vi.fn>;
let saveFile: ReturnType<typeof vi.fn>;
const original = (window as any).maestro;

beforeEach(() => {
	__resetFileActionsForTests();
	useCenterFlashStore.getState().setActive(null);
	downloadRemoteFile = vi.fn().mockResolvedValue({ success: true, path: LOCAL_COPY });
	downloadRemoteFolder = vi.fn().mockResolvedValue({
		success: true,
		path: '/tmp/maestro-remote-downloads/abc/src',
		fileCount: 3,
	});
	openPath = vi.fn().mockResolvedValue(undefined);
	showItemInFolder = vi.fn().mockResolvedValue(undefined);
	copyPath = vi.fn().mockResolvedValue({ success: true });
	readFile = vi.fn().mockResolvedValue('<p>A page that stands alone.</p>');
	saveFile = vi.fn().mockResolvedValue('/Users/me/Desktop/report.pdf');
	(window as any).maestro = {
		...original,
		shell: { ...original.shell, openPath, showItemInFolder },
		fs: { ...original.fs, downloadRemoteFile, downloadRemoteFolder, copyPath, readFile },
		dialog: { ...original.dialog, saveFile },
	};
});

afterEach(() => {
	(window as any).maestro = original;
});

describe.each(AGENT_MODES)('file actions in %s mode', (mode) => {
	const sshRemoteId = remoteIdFor(mode);
	const target = { path: '/work/report.pdf', sshRemoteId };
	const expected = mode === 'local' ? '/work/report.pdf' : LOCAL_COPY;

	it('opens the file in the default app from a path on this machine', async () => {
		await expect(openFileInDefaultApp(target)).resolves.toBe(true);
		expect(openPath).toHaveBeenCalledWith(expected);
		expect(downloadRemoteFile).toHaveBeenCalledTimes(mode === 'local' ? 0 : 1);
	});

	it('reveals the file (its fetched copy when remote)', async () => {
		await revealInFileManager(target);
		expect(showItemInFolder).toHaveBeenCalledWith(expected);
	});

	it('opens the file in the Maestro Browser as a file:// URL on this machine', async () => {
		const openBrowserTabAt = vi.fn();
		await openFileInMaestroBrowser(target, openBrowserTabAt, 'report.pdf');
		expect(openBrowserTabAt).toHaveBeenCalledWith(`file://${expected}`, { title: 'report.pdf' });
	});

	it('opens an HTML page with the files it points at beside it', async () => {
		const PAGE_COPY = '/tmp/maestro-remote-downloads/abc/index.html';
		const SITE_COPY = '/tmp/maestro-remote-downloads/def/site';
		downloadRemoteFile.mockResolvedValue({ success: true, path: PAGE_COPY });
		downloadRemoteFolder.mockResolvedValue({ success: true, path: SITE_COPY, fileCount: 3 });
		readFile.mockResolvedValue(
			'<link rel="stylesheet" href="css/site.css"><script src="./app.js"></script>'
		);
		const openBrowserTabAt = vi.fn();
		await expect(
			openFileInMaestroBrowser(
				{ path: '/work/site/index.html', sshRemoteId },
				openBrowserTabAt,
				'index.html'
			)
		).resolves.toBe(true);

		if (mode === 'local') {
			// Already beside its files: opened in place, nothing fetched or read.
			expect(openBrowserTabAt).toHaveBeenCalledWith('file:///work/site/index.html', {
				title: 'index.html',
			});
			expect(readFile).not.toHaveBeenCalled();
			expect(downloadRemoteFolder).not.toHaveBeenCalled();
		} else {
			// The page's whole folder is fetched, and the page opens from inside it.
			expect(readFile).toHaveBeenCalledWith(PAGE_COPY);
			expect(downloadRemoteFolder).toHaveBeenCalledWith('/work/site', 'r1');
			expect(openBrowserTabAt).toHaveBeenCalledWith(`file://${SITE_COPY}/index.html`, {
				title: 'index.html',
			});
		}
	});

	it('saves a copy to the chosen path', async () => {
		await expect(saveCopyOfFile(target, 'report.pdf')).resolves.toBe(
			'/Users/me/Desktop/report.pdf'
		);
		expect(saveFile).toHaveBeenCalledWith({ defaultPath: 'report.pdf', title: 'Save a Copy' });
		if (mode === 'local') {
			expect(copyPath).toHaveBeenCalledWith('/work/report.pdf', '/Users/me/Desktop/report.pdf', {
				overwrite: true,
			});
		} else {
			expect(downloadRemoteFile).toHaveBeenCalledWith(
				'/work/report.pdf',
				'r1',
				'/Users/me/Desktop/report.pdf'
			);
		}
	});

	it('plays media from a copy on this machine and reads other files in place', async () => {
		await expect(resolveOpenSource({ path: '/work/a.mp3', sshRemoteId }, 'a.mp3')).resolves.toEqual(
			mode === 'local' ? { path: '/work/a.mp3', sshRemoteId: undefined } : { path: LOCAL_COPY }
		);
		await expect(resolveOpenSource({ path: '/work/a.md', sshRemoteId }, 'a.md')).resolves.toEqual({
			path: '/work/a.md',
			sshRemoteId,
		});
	});

	it('remembers the fetched copy so a drag can name it synchronously', async () => {
		if (mode !== 'local') expect(cachedLocalCopy(target)).toBeUndefined();
		await fetchLocalCopy(target, { quiet: true });
		expect(cachedLocalCopy(target)).toBe(expected);
	});

	it('fetches a folder whole and remembers its copy for a drag', async () => {
		const folder = { path: '/work/src', sshRemoteId };
		const expectedFolder = mode === 'local' ? '/work/src' : '/tmp/maestro-remote-downloads/abc/src';
		await expect(fetchLocalFolderCopy(folder, { quiet: true })).resolves.toBe(expectedFolder);
		expect(cachedLocalCopy(folder)).toBe(expectedFolder);
		expect(downloadRemoteFolder).toHaveBeenCalledTimes(mode === 'local' ? 0 : 1);
		expect(downloadRemoteFile).not.toHaveBeenCalled();
	});

	it('opens a folder: in the file manager locally, in the Files panel when remote', async () => {
		const session = createModeSession(mode, { id: 'a1', fullPath: '/work', projectRoot: '/work' });
		useSessionStore.setState({ sessions: [session], activeSessionId: 'a1' });
		await openFolderInFileManager({ path: '/work', sshRemoteId }, { sessionId: 'a1' });
		if (mode === 'local') {
			expect(openPath).toHaveBeenCalledWith('/work');
		} else {
			// 🔒 A remote folder has no location on this computer.
			expect(openPath).not.toHaveBeenCalled();
			expect(useUIStore.getState().activeRightTab).toBe('files');
			expect(useCenterFlashStore.getState().active?.message).toBe(
				'Showing the folder in the Files panel'
			);
		}
	});
});

describe('a remote page in the Maestro Browser', () => {
	const PAGE_COPY = '/tmp/maestro-remote-downloads/abc/index.html';
	const page = { path: '/work/site/index.html', sshRemoteId: 'r1' };

	beforeEach(() => {
		downloadRemoteFile.mockResolvedValue({ success: true, path: PAGE_COPY });
	});

	it('opens a page that stands alone from its own copy, without fetching its folder', async () => {
		// None of these is read from the page's folder.
		readFile.mockResolvedValue(
			[
				'<script src="https://cdn.example.com/app.js"></script>',
				'<script src="//cdn.example.com/app.js"></script>',
				'<link rel="stylesheet" href="/assets/site.css">',
				'<img src="data:image/png;base64,AAAA">',
				'<a href="other.html">A link is not fetched to draw the page</a>',
				'<a href="#top">Top</a>',
			].join('')
		);
		const openBrowserTabAt = vi.fn();
		await expect(openFileInMaestroBrowser(page, openBrowserTabAt)).resolves.toBe(true);
		expect(downloadRemoteFolder).not.toHaveBeenCalled();
		expect(openBrowserTabAt).toHaveBeenCalledWith(`file://${PAGE_COPY}`, undefined);
	});

	it('opens the page from its own copy when its folder is too large to copy whole', async () => {
		readFile.mockResolvedValue('<img src="img/logo.png">');
		downloadRemoteFolder.mockRejectedValue(
			new Error('The folder has more than 2000 files, too many to copy to this computer')
		);
		const toastsBefore = useNotificationStore.getState().toasts.length;
		const openBrowserTabAt = vi.fn();
		await expect(openFileInMaestroBrowser(page, openBrowserTabAt)).resolves.toBe(true);
		expect(downloadRemoteFolder).toHaveBeenCalledWith('/work/site', 'r1');
		expect(openBrowserTabAt).toHaveBeenCalledWith(`file://${PAGE_COPY}`, undefined);
		// The page opened, so nothing is reported as failed.
		expect(useNotificationStore.getState().toasts).toHaveLength(toastsBefore);
	});

	it('opens the page from its own copy when the copy cannot be read back', async () => {
		readFile.mockRejectedValue(new Error('Failed to read file'));
		const toastsBefore = useNotificationStore.getState().toasts.length;
		const openBrowserTabAt = vi.fn();
		await expect(openFileInMaestroBrowser(page, openBrowserTabAt)).resolves.toBe(true);
		expect(downloadRemoteFolder).not.toHaveBeenCalled();
		expect(openBrowserTabAt).toHaveBeenCalledWith(`file://${PAGE_COPY}`, undefined);
		expect(useNotificationStore.getState().toasts).toHaveLength(toastsBefore);
	});

	it('never fetches a folder for a file that is not a page', async () => {
		const openBrowserTabAt = vi.fn();
		await openFileInMaestroBrowser(
			{ path: '/work/site/chart.svg', sshRemoteId: 'r1' },
			openBrowserTabAt
		);
		expect(readFile).not.toHaveBeenCalled();
		expect(downloadRemoteFolder).not.toHaveBeenCalled();
	});

	it('keeps a page in the root folder on its own copy: its folder is the whole host', async () => {
		readFile.mockResolvedValue('<img src="img/logo.png">');
		const openBrowserTabAt = vi.fn();
		await openFileInMaestroBrowser({ path: '/index.html', sshRemoteId: 'r1' }, openBrowserTabAt);
		expect(downloadRemoteFolder).not.toHaveBeenCalled();
		expect(openBrowserTabAt).toHaveBeenCalledWith(`file://${PAGE_COPY}`, undefined);
	});
});

describe('fetch progress and failure', () => {
	it('shows Downloading only while a remote fetch runs', async () => {
		let finish!: (value: { success: boolean; path: string }) => void;
		downloadRemoteFile.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		const pending = openFileInDefaultApp({ path: '/work/report.pdf', sshRemoteId: 'r1' });
		expect(useCenterFlashStore.getState().active?.message).toBe('Downloading…');
		finish({ success: true, path: LOCAL_COPY });
		await pending;
		expect(useCenterFlashStore.getState().active).toBeNull();
	});

	it('never flashes for a local file', async () => {
		await openFileInDefaultApp({ path: '/work/report.pdf' });
		expect(useCenterFlashStore.getState().active).toBeNull();
	});

	it('reports a failed fetch and does not open anything', async () => {
		downloadRemoteFile.mockRejectedValue(new Error('Remote file not found'));
		await expect(openFileInDefaultApp({ path: '/work/gone.pdf', sshRemoteId: 'r1' })).resolves.toBe(
			false
		);
		expect(openPath).not.toHaveBeenCalled();
		const toasts = useNotificationStore.getState().toasts;
		expect(toasts.at(-1)).toMatchObject({ title: 'Open failed', message: 'Remote file not found' });
	});
});
