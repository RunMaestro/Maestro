import { useCallback } from 'react';
import type { Session } from '../../../types';
import { captureException } from '../../../utils/sentry';
import {
	cachedLocalCopy,
	fetchLocalCopy,
	fetchLocalFolderCopy,
} from '../../../services/fileActions';
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
 * Local files/folders drag out in a single gesture. A remote (SSH or hosted)
 * file or folder can be handed to the OS only once its bytes are on this disk:
 * the OS drag must name existing files inside the dragstart event, and a fetch
 * cannot finish inside it. So one already fetched by ANY file action (Open in
 * Default App, Reveal, Play, a previous drag) drags out on the first gesture
 * from the shared copy in `services/fileActions`; one never fetched is fetched
 * now (a folder as its whole tree), with a flash asking for a second drag.
 * Never drags a partial file or folder.
 */
export function useOsFileDragOut({
	session,
	sshRemoteId,
	onShowFlash,
}: UseOsFileDragOutArgs): UseOsFileDragOutResult {
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

			// Remote: files and folders alike are handed to the OS from their copy
			// on this machine (a folder is fetched whole, its tree file by file).
			const sources = relSources.map((r) => ({
				rel: r,
				target: { path: `${fullPath}/${r}`, sshRemoteId },
				isFolder: findNodeAtPath(session.fileTree, r)?.type === 'folder',
			}));
			const cached: string[] = [];
			const uncached: typeof sources = [];
			for (const source of sources) {
				const copy = cachedLocalCopy(source.target);
				if (copy) cached.push(copy);
				else uncached.push(source);
			}

			// All bytes are already local (fetched by a prior drag or any other file
			// action) - seamless.
			if (uncached.length === 0) {
				window.maestro.fs.startDragOut(cached);
				return true;
			}

			// Need to fetch first. The OS drag must name existing files inside this
			// dragstart event and a fetch cannot finish inside it, so fetch to the
			// shared copy cache and ask for a second drag, which hits the branch above.
			onShowFlash?.(
				uncached.length === 1
					? `Preparing "${basenameOf(uncached[0].rel)}" for drag-out…`
					: `Preparing ${uncached.length} items for drag-out…`
			);
			void (async () => {
				let ready = 0;
				let lastError: unknown;
				for (const source of uncached) {
					try {
						await (source.isFolder ? fetchLocalFolderCopy : fetchLocalCopy)(source.target, {
							quiet: true,
						});
						ready++;
					} catch (error) {
						lastError = error;
						captureException(error, {
							extra: { action: 'os-drag-out.download', relPath: source.rel, sshRemoteId },
						});
					}
				}
				if (ready === 0) {
					onShowFlash?.(
						lastError instanceof Error
							? `Failed to prepare for drag-out: ${lastError.message}`
							: 'Failed to prepare for drag-out'
					);
				} else if (sources.length === 1) {
					onShowFlash?.(`Ready - drag "${basenameOf(sources[0].rel)}" to Finder again`);
				} else {
					onShowFlash?.(`Ready - drag again to copy ${ready} item${ready > 1 ? 's' : ''} out`);
				}
			})();
			return true;
		},
		[session.fullPath, session.fileTree, sshRemoteId, onShowFlash]
	);

	return { handleOsDragStart };
}
