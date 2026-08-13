import { useMemo, useCallback } from 'react';
import type { Session, FilePreviewTab } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';

interface UseFilePreviewHandlersParams {
	activeSession: Session | null;
	activeFileTabId: string | null | undefined;
	activeFileTab: FilePreviewTab | null | undefined;
	onFileTabClose?: (tabId: string) => void;
	onFileTabEditModeChange?: (tabId: string, editMode: boolean) => void;
	onFileTabEditContentChange?: (
		tabId: string,
		editContent: string | undefined,
		savedContent?: string
	) => void;
	onFileTabScrollPositionChange?: (tabId: string, scrollTop: number) => void;
	onFileTabSearchQueryChange?: (tabId: string, searchQuery: string) => void;
	onReloadFileTab?: (tabId: string) => void;
}

/**
 * Memoized file preview callbacks and derived values.
 *
 * All callbacks delegate to parent-provided handlers with the active file tab ID
 * pre-applied, preventing unnecessary prop drilling of the tab ID.
 */
export function useFilePreviewHandlers({
	activeSession,
	activeFileTabId,
	activeFileTab,
	onFileTabClose,
	onFileTabEditModeChange,
	onFileTabEditContentChange,
	onFileTabScrollPositionChange,
	onFileTabSearchQueryChange,
	onReloadFileTab,
}: UseFilePreviewHandlersParams) {
	// Memoized props for FilePreview to prevent re-renders that cause image flickering
	// The file object must be stable - recreating it on each render causes the <img> to remount
	const memoizedFilePreviewFile = useMemo(() => {
		if (!activeFileTab) return null;
		return {
			name: activeFileTab.name + activeFileTab.extension,
			content: activeFileTab.content,
			path: activeFileTab.path,
		};
	}, [activeFileTab?.name, activeFileTab?.extension, activeFileTab?.content, activeFileTab?.path]);

	const handleFilePreviewClose = useCallback(() => {
		if (activeFileTabId) {
			onFileTabClose?.(activeFileTabId);
		}
	}, [activeFileTabId, onFileTabClose]);

	const handleFilePreviewEditModeChange = useCallback(
		(editMode: boolean) => {
			if (activeFileTabId) {
				onFileTabEditModeChange?.(activeFileTabId, editMode);
			}
		},
		[activeFileTabId, onFileTabEditModeChange]
	);

	// Memoize sshRemoteId to prevent object recreation - defined early so save handler can use it
	const filePreviewSshRemoteId = useMemo(
		() =>
			activeSession?.sshRemoteId ||
			(activeSession?.sessionSshRemoteConfig?.enabled
				? activeSession.sessionSshRemoteConfig.remoteId
				: undefined) ||
			undefined,
		[
			activeSession?.sshRemoteId,
			activeSession?.sessionSshRemoteConfig?.enabled,
			activeSession?.sessionSshRemoteConfig?.remoteId,
		]
	);

	const handleFilePreviewSave = useCallback(
		async (path: string, content: string): Promise<boolean> => {
			let savePath = path;

			// Untitled file - prompt for save location
			if (!path) {
				const chosen = await window.maestro.dialog.saveFile({
					title: 'Save File',
					defaultPath: activeSession?.fullPath ? `${activeSession.fullPath}/Untitled` : undefined,
				});
				if (!chosen) return false; // User cancelled
				savePath = chosen;
			} else {
				// Existing file: the cached path may be stale if the file was moved,
				// renamed, or deleted on disk since it was opened. A blind writeFile
				// would silently recreate a ghost at the old location. Stat first; if
				// it's gone, prompt for a destination instead of resurrecting it.
				let stillExists = true;
				try {
					// stat returns null for a missing path (ENOENT) and throws only on
					// genuine errors; treat both as "gone" so we never resurrect a ghost.
					const st = await window.maestro.fs.stat(path, filePreviewSshRemoteId);
					if (!st) stillExists = false;
				} catch {
					stillExists = false;
				}
				if (!stillExists) {
					const chosen = await window.maestro.dialog.saveFile({
						title: 'File moved or deleted on disk - choose where to save',
						defaultPath: path,
					});
					if (!chosen) return false; // User cancelled
					savePath = chosen;
				}
			}

			await window.maestro.fs.writeFile(savePath, content, filePreviewSshRemoteId);

			if (activeFileTabId) {
				// Path changed (untitled save, or redirect after a move/delete): refresh
				// the tab's metadata so it now tracks the real on-disk location.
				if (savePath !== path) {
					const fileName = savePath.split('/').pop() || 'Untitled';
					const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';
					const nameWithoutExt = ext ? fileName.slice(0, -ext.length) : fileName;
					const { setSessions } = useSessionStore.getState();
					const sessionId = activeSession?.id;
					setSessions((prev: Session[]) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							return {
								...s,
								filePreviewTabs: s.filePreviewTabs.map((tab) =>
									tab.id === activeFileTabId
										? {
												...tab,
												path: savePath,
												name: nameWithoutExt,
												extension: ext,
												content,
												editContent: undefined,
												lastModified: Date.now(),
											}
										: tab
								),
							};
						})
					);

					// A file just landed at a new on-disk location (untitled save, or
					// redirect after a move/delete). The Files panel won't show it until
					// its next refresh, so nudge the tree to pick it up now. Reuse the
					// existing CustomEvent the remote/CLI path already dispatches, so we
					// avoid prop-drilling refreshFileTree into this deeply-nested hook.
					if (sessionId) {
						window.dispatchEvent(
							new CustomEvent('maestro:refreshFileTree', {
								detail: { sessionId },
							})
						);
					}
				} else {
					onFileTabEditContentChange?.(activeFileTabId, undefined, content);
				}
			}
			return true;
		},
		[
			activeFileTabId,
			activeSession?.id,
			activeSession?.fullPath,
			onFileTabEditContentChange,
			filePreviewSshRemoteId,
		]
	);

	// Compute cwd for FilePreview - memoized to prevent recalculation on every render
	const filePreviewCwd = useMemo(() => {
		if (!activeSession?.fullPath || !activeFileTab?.path) return '';
		const fullPathWithSep = activeSession.fullPath.endsWith('/')
			? activeSession.fullPath
			: activeSession.fullPath + '/';
		if (
			!activeFileTab.path.startsWith(fullPathWithSep) &&
			activeFileTab.path !== activeSession.fullPath
		)
			return '';
		const relativePath = activeFileTab.path.slice(fullPathWithSep.length);
		const lastSlash = relativePath.lastIndexOf('/');
		return lastSlash > 0 ? relativePath.slice(0, lastSlash) : '';
	}, [activeSession?.fullPath, activeFileTab?.path]);

	const handleFilePreviewEditContentChange = useCallback(
		(content: string) => {
			if (activeFileTabId && activeFileTab) {
				const hasChanges = content !== activeFileTab.content;
				onFileTabEditContentChange?.(activeFileTabId, hasChanges ? content : undefined);
			}
		},
		[activeFileTabId, activeFileTab?.content, onFileTabEditContentChange]
	);

	const handleFilePreviewScrollPositionChange = useCallback(
		(scrollTop: number) => {
			if (activeFileTabId) {
				onFileTabScrollPositionChange?.(activeFileTabId, scrollTop);
			}
		},
		[activeFileTabId, onFileTabScrollPositionChange]
	);

	const handleFilePreviewSearchQueryChange = useCallback(
		(query: string) => {
			if (activeFileTabId) {
				onFileTabSearchQueryChange?.(activeFileTabId, query);
			}
		},
		[activeFileTabId, onFileTabSearchQueryChange]
	);

	const handleFilePreviewReload = useCallback(() => {
		if (activeFileTabId) {
			onReloadFileTab?.(activeFileTabId);
		}
	}, [activeFileTabId, onReloadFileTab]);

	return {
		memoizedFilePreviewFile,
		filePreviewCwd,
		filePreviewSshRemoteId,
		handleFilePreviewClose,
		handleFilePreviewEditModeChange,
		handleFilePreviewSave,
		handleFilePreviewEditContentChange,
		handleFilePreviewScrollPositionChange,
		handleFilePreviewSearchQueryChange,
		handleFilePreviewReload,
	};
}
