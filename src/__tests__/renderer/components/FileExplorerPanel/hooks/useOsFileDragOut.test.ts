import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOsFileDragOut } from '../../../../../renderer/components/FileExplorerPanel/hooks/useOsFileDragOut';
import { isWebDesktop } from '../../../../../renderer/utils/runtimeContext';
import type { FileNode } from '../../../../../renderer/types/fileTree';
import {
	__resetFileActionsForTests,
	fetchLocalCopy,
} from '../../../../../renderer/services/fileActions';
import { AGENT_MODES, createModeSession } from '../../../../helpers';

vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
}));

const session = {
	id: 'sess-1',
	fullPath: '/project',
	fileTree: [
		{ name: 'src', type: 'folder', children: [{ name: 'a.ts', type: 'file' }] },
		{ name: 'notes.md', type: 'file' },
		{ name: 'report.pdf', type: 'file' },
	] as FileNode[],
} as any;

const startDragOut = vi.fn();
const downloadRemoteFile = vi.fn();
const downloadRemoteFolder = vi.fn();
(window as any).maestro = { fs: { startDragOut, downloadRemoteFile, downloadRemoteFolder } };

/** Let the fire-and-forget fetch inside the drag handler settle. */
async function settleFetch(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function makeDragEvent(altKey: boolean): React.DragEvent {
	return {
		altKey,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	} as unknown as React.DragEvent;
}

describe('useOsFileDragOut', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isWebDesktop).mockReturnValue(false);
		__resetFileActionsForTests();
	});

	it('web-desktop: never takes over the gesture, even for an Alt-drag', () => {
		// The web-server bridge cannot dispatch the `fs:startDragOut` ipcMain.on
		// channel and there is no host desktop to drop onto, so the hook must fall
		// through to the normal in-app drag instead of erroring.
		vi.mocked(isWebDesktop).mockReturnValue(true);
		const { result } = renderHook(() =>
			useOsFileDragOut({ session, sshRemoteId: undefined, onShowFlash: vi.fn() })
		);
		const e = makeDragEvent(true);
		let handled = true;
		act(() => {
			handled = result.current.handleOsDragStart(e, ['src/a.ts', 'notes.md']);
		});
		expect(handled).toBe(false);
		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(startDragOut).not.toHaveBeenCalled();
	});

	it('returns false and does nothing for a plain (non-Alt) drag', () => {
		const { result } = renderHook(() =>
			useOsFileDragOut({ session, sshRemoteId: undefined, onShowFlash: vi.fn() })
		);
		const e = makeDragEvent(false);
		let handled = true;
		act(() => {
			handled = result.current.handleOsDragStart(e, ['notes.md']);
		});
		expect(handled).toBe(false);
		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(startDragOut).not.toHaveBeenCalled();
	});

	it('local: hands absolute paths straight to the OS and takes over the gesture', () => {
		const { result } = renderHook(() =>
			useOsFileDragOut({ session, sshRemoteId: undefined, onShowFlash: vi.fn() })
		);
		const e = makeDragEvent(true);
		let handled = false;
		act(() => {
			handled = result.current.handleOsDragStart(e, ['src/a.ts', 'notes.md']);
		});
		expect(handled).toBe(true);
		expect(e.preventDefault).toHaveBeenCalled();
		expect(startDragOut).toHaveBeenCalledWith(['/project/src/a.ts', '/project/notes.md']);
	});

	it('remote (uncached): downloads to temp, flashes, and does not startDrag yet', async () => {
		downloadRemoteFile.mockResolvedValue({ success: true, path: '/tmp/notes.md' });
		const onShowFlash = vi.fn();
		const { result } = renderHook(() =>
			useOsFileDragOut({ session, sshRemoteId: 'remote-1', onShowFlash })
		);
		await act(async () => {
			result.current.handleOsDragStart(makeDragEvent(true), ['notes.md']);
			// let the fire-and-forget download microtasks resolve
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(downloadRemoteFile).toHaveBeenCalledWith('/project/notes.md', 'remote-1');
		expect(startDragOut).not.toHaveBeenCalled();
		expect(onShowFlash).toHaveBeenCalledWith(expect.stringContaining('Preparing'));
		expect(onShowFlash).toHaveBeenCalledWith(expect.stringContaining('Ready'));
	});

	it('remote (cached): a second drag hands the temp path to the OS', async () => {
		downloadRemoteFile.mockResolvedValue({ success: true, path: '/tmp/report.pdf' });
		const { result } = renderHook(() =>
			useOsFileDragOut({ session, sshRemoteId: 'remote-1', onShowFlash: vi.fn() })
		);
		// First drag primes the cache.
		await act(async () => {
			result.current.handleOsDragStart(makeDragEvent(true), ['report.pdf']);
			await Promise.resolve();
			await Promise.resolve();
		});
		startDragOut.mockClear();
		// Second drag is now seamless.
		act(() => {
			result.current.handleOsDragStart(makeDragEvent(true), ['report.pdf']);
		});
		expect(startDragOut).toHaveBeenCalledWith(['/tmp/report.pdf']);
		expect(downloadRemoteFile).toHaveBeenCalledTimes(1);
	});

	it('remote: a file another action already fetched drags out on the first gesture', async () => {
		// Open in Default App, Reveal, or Play fetched it first (services/fileActions).
		downloadRemoteFile.mockResolvedValue({ success: true, path: '/tmp/k/report.pdf' });
		await fetchLocalCopy({ path: '/project/report.pdf', sshRemoteId: 'remote-1' }, { quiet: true });
		downloadRemoteFile.mockClear();
		const { result } = renderHook(() =>
			useOsFileDragOut({ session, sshRemoteId: 'remote-1', onShowFlash: vi.fn() })
		);
		act(() => {
			result.current.handleOsDragStart(makeDragEvent(true), ['report.pdf']);
		});
		expect(startDragOut).toHaveBeenCalledWith(['/tmp/k/report.pdf']);
		expect(downloadRemoteFile).not.toHaveBeenCalled();
	});

	it('remote: a folder is fetched whole, then drags out from its local copy', async () => {
		downloadRemoteFolder.mockResolvedValue({ success: true, path: '/tmp/k/src', fileCount: 1 });
		const onShowFlash = vi.fn();
		const { result } = renderHook(() =>
			useOsFileDragOut({ session, sshRemoteId: 'remote-1', onShowFlash })
		);
		await act(async () => {
			result.current.handleOsDragStart(makeDragEvent(true), ['src']);
			await settleFetch();
		});
		expect(downloadRemoteFolder).toHaveBeenCalledWith('/project/src', 'remote-1');
		expect(downloadRemoteFile).not.toHaveBeenCalled();
		expect(startDragOut).not.toHaveBeenCalled();
		expect(onShowFlash).toHaveBeenCalledWith('Ready - drag "src" to Finder again');

		act(() => {
			result.current.handleOsDragStart(makeDragEvent(true), ['src']);
		});
		expect(startDragOut).toHaveBeenCalledWith(['/tmp/k/src']);
		expect(downloadRemoteFolder).toHaveBeenCalledTimes(1);
	});

	it('remote: a folder too large to copy says why instead of dragging', async () => {
		downloadRemoteFolder.mockRejectedValue(new Error('The folder has more than 2000 files'));
		const onShowFlash = vi.fn();
		const { result } = renderHook(() =>
			useOsFileDragOut({ session, sshRemoteId: 'remote-1', onShowFlash })
		);
		await act(async () => {
			result.current.handleOsDragStart(makeDragEvent(true), ['src']);
			await settleFetch();
		});
		expect(startDragOut).not.toHaveBeenCalled();
		expect(onShowFlash).toHaveBeenLastCalledWith(
			'Failed to prepare for drag-out: The folder has more than 2000 files'
		);
	});

	describe.each(AGENT_MODES)('in %s mode', (mode) => {
		it('drags a folder and a file out to the OS, named as they are in the tree', async () => {
			const modeSession = createModeSession(mode, {
				fullPath: '/project',
				fileTree: session.fileTree,
			});
			const sshRemoteId =
				modeSession.sshRemoteId || modeSession.sessionSshRemoteConfig?.remoteId || undefined;
			downloadRemoteFolder.mockResolvedValue({ success: true, path: '/tmp/k/src', fileCount: 1 });
			downloadRemoteFile.mockResolvedValue({ success: true, path: '/tmp/k/notes.md' });
			const { result } = renderHook(() =>
				useOsFileDragOut({ session: modeSession, sshRemoteId, onShowFlash: vi.fn() })
			);

			// A remote copy is fetched on the first gesture and handed over on the
			// next; a local one is handed over at once. Either way the OS gets the
			// same folder and file, never a partial one.
			await act(async () => {
				result.current.handleOsDragStart(makeDragEvent(true), ['src', 'notes.md']);
				await settleFetch();
			});
			if (startDragOut.mock.calls.length === 0) {
				act(() => {
					result.current.handleOsDragStart(makeDragEvent(true), ['src', 'notes.md']);
				});
			}
			expect(startDragOut).toHaveBeenCalledTimes(1);
			const dragged = startDragOut.mock.calls[0][0] as string[];
			expect(dragged.map((p) => p.split('/').pop())).toEqual(['src', 'notes.md']);
		});
	});
});
