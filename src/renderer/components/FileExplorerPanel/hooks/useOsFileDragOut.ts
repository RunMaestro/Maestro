import { useCallback, useRef } from 'react';
import type { Session } from '../../../types';
import { captureException } from '../../../utils/sentry';
import { isWebDesktop } from '../../../utils/runtimeContext';
import { basenameOf, findNodeAtPath } from '../utils/pathHelpers';

interface UseOsFileDragOutArgs {
	session: Session;
	sshRemoteId: string | undefined;
	onShowFlash?: (msg: string) => void;
}

interface UseOsFileDragOutResult {
	/**
	 * Handle a row `dragstart` as a potential OS file drag-out (drag the real
	 * file to Finder/Explorer). Returns `true` when it takes over the gesture -
	 * the caller must then skip its own HTML5 drag setup. Returns `false` for a
	 * plain drag so the existing move/@mention behavior runs unchanged.
	 *
	 * `relSources` are workspace-relative paths (the same values the tree uses).
	 */
	handleOsDragStart: (e: React.DragEvent, relSources: string[]) => boolean;
}

/**
 * OS file drag-out for the file panel: drag a row out to Finder/Explorer to
 * retrieve the actual file. Gated behind Option/Alt so it never collides with
 * the plain drag (in-tree move) or the drag-to-AI-input @mention, both of which
 * rely on the HTML5 drag that `startDrag` would otherwise cancel.
 *
 * Local files/folders drag out in a single gesture. Remote (SSH) files can't be
 * handed to the OS live (the bytes aren't on disk and a download can't attach to
 * the gesture), so the first Option-drag downloads to a temp cache and flashes
 * "drag again"; the cached second drag is seamless. Never drags a partial file.
 */
export function useOsFileDragOut({
	session,
	sshRemoteId,
	onShowFlash,
}: UseOsFileDragOutArgs): UseOsFileDragOutResult {
	// Maps a remote workspace-relative path -> the local temp path it was
	// downloaded to. Lives for the panel's lifetime so a second Option-drag of
	// the same file is instant. Keyed by relative path (stable per session).
	const remoteTempCache = useRef<Map<string, string>>(new Map());

	const handleOsDragStart = useCallback(
		(e: React.DragEvent, relSources: string[]): boolean => {
			// OS drag-out fires `fs:startDragOut`, an ipcMain.on channel the
			// web-server bridge cannot dispatch (it only handles invoke-style
			// handlers). In the web-desktop build there is also no host desktop to
			// drop onto, so never take over the gesture: fall through to the normal
			// in-app drag so the interaction fails silently instead of erroring.
			if (isWebDesktop()) return false;

			// Only Option/Alt initiates an OS drag-out; anything else is a normal
			// in-app drag and must fall through untouched.
			if (!e.altKey) return false;
			if (relSources.length === 0) return false;

			// Take over the gesture: cancel the HTML5 drag so startDrag owns it.
			e.preventDefault();
			e.stopPropagation();

			const fullPath = session.fullPath;

			// Local: hand the real absolute paths straight to the OS. Files and
			// folders both drag out fine.
			if (!sshRemoteId) {
				const abs = relSources.map((r) => `${fullPath}/${r}`);
				window.maestro.fs.startDragOut(abs);
				return true;
			}

			// Remote: only files. Folders would need a recursive download/tar we
			// don't do yet, so surface that instead of silently dragging nothing.
			const fileRels = relSources.filter(
				(r) => findNodeAtPath(session.fileTree, r)?.type !== 'folder'
			);
			if (fileRels.length === 0) {
				onShowFlash?.('Drag-out over SSH supports files, not folders');
				return true;
			}

			const cached: string[] = [];
			const uncached: string[] = [];
			for (const r of fileRels) {
				const temp = remoteTempCache.current.get(r);
				if (temp) cached.push(temp);
				else uncached.push(r);
			}

			// All bytes are already local (downloaded on a prior drag) - seamless.
			if (uncached.length === 0) {
				window.maestro.fs.startDragOut(cached);
				return true;
			}

			// Need to fetch first. A download can't attach to this live gesture, so
			// download to the temp cache and prompt the user to drag again. The
			// second drag hits the cache branch above and drags the real bytes.
			onShowFlash?.(
				uncached.length === 1
					? `Preparing "${basenameOf(uncached[0])}" for drag-out…`
					: `Preparing ${uncached.length} files for drag-out…`
			);
			void (async () => {
				let ready = 0;
				for (const r of uncached) {
					try {
						const res = await window.maestro.fs.downloadRemoteFile(`${fullPath}/${r}`, sshRemoteId);
						if (res?.path) {
							remoteTempCache.current.set(r, res.path);
							ready++;
						}
					} catch (error) {
						captureException(error, {
							extra: { action: 'os-drag-out.download', relPath: r, sshRemoteId },
						});
					}
				}
				if (ready === 0) {
					onShowFlash?.('Failed to prepare file for drag-out');
				} else if (fileRels.length === 1) {
					onShowFlash?.(`Ready - drag "${basenameOf(fileRels[0])}" to Finder again`);
				} else {
					onShowFlash?.(`Ready - drag again to copy ${ready} file${ready > 1 ? 's' : ''} out`);
				}
			})();
			return true;
		},
		[session.fullPath, session.fileTree, sshRemoteId, onShowFlash]
	);

	return { handleOsDragStart };
}
