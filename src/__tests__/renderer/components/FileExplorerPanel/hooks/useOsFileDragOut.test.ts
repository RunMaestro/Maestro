import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOsFileDragOut } from '../../../../../renderer/components/FileExplorerPanel/hooks/useOsFileDragOut';
import { isWebDesktop } from '../../../../../renderer/utils/runtimeContext';
import type { FileNode } from '../../../../../renderer/types/fileTree';

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
(window as any).maestro = { fs: { startDragOut, downloadRemoteFile } };

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

	it('remote: folders are unsupported and flash an explanation instead of dragging', () => {
		const onShowFlash = vi.fn();
		const { result } = renderHook(() =>
			useOsFileDragOut({ session, sshRemoteId: 'remote-1', onShowFlash })
		);
		act(() => {
			result.current.handleOsDragStart(makeDragEvent(true), ['src']);
		});
		expect(startDragOut).not.toHaveBeenCalled();
		expect(downloadRemoteFile).not.toHaveBeenCalled();
		expect(onShowFlash).toHaveBeenCalledWith(expect.stringContaining('files, not folders'));
	});
});
