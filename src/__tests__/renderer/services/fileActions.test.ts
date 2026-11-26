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
let openPath: ReturnType<typeof vi.fn>;
let showItemInFolder: ReturnType<typeof vi.fn>;
let copyPath: ReturnType<typeof vi.fn>;
let saveFile: ReturnType<typeof vi.fn>;
const original = (window as any).maestro;

beforeEach(() => {
	__resetFileActionsForTests();
	useCenterFlashStore.getState().setActive(null);
	downloadRemoteFile = vi.fn().mockResolvedValue({ success: true, path: LOCAL_COPY });
	openPath = vi.fn().mockResolvedValue(undefined);
	showItemInFolder = vi.fn().mockResolvedValue(undefined);
	copyPath = vi.fn().mockResolvedValue({ success: true });
	saveFile = vi.fn().mockResolvedValue('/Users/me/Desktop/report.pdf');
	(window as any).maestro = {
		...original,
		shell: { ...original.shell, openPath, showItemInFolder },
		fs: { ...original.fs, downloadRemoteFile, copyPath },
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
