/**
 * FileContextMenu - Reusable right-click context menu for file references.
 *
 * Mirrors the file explorer panel's context menu for file items.
 * Used by MarkdownRenderer (AI chat file links) and can be adopted
 * by FileExplorerPanel in a future refactor.
 */

import { useEffect, useRef, useCallback } from 'react';
import { FileText, Target, ExternalLink, Copy } from 'lucide-react';
import type { Theme } from '../types';
import { useContextMenuPosition } from '../hooks/ui/useContextMenuPosition';
import { safeClipboardWrite } from '../utils/clipboard';
import { getRevealLabel } from '../utils/platformUtils';
import { useFileExplorerStore } from '../stores/fileExplorerStore';

export interface FileContextMenuState {
	x: number;
	y: number;
	/** Absolute path to the file */
	filePath: string;
	/** File name (basename) — used for conditional options like Document Graph */
	fileName: string;
}

interface FileContextMenuProps {
	menu: FileContextMenuState;
	theme: Theme;
	onDismiss: () => void;
	/** Open file in preview tab */
	onPreview?: (filePath: string) => void;
	/** Project root absolute path — used to derive relative path for Document Graph */
	projectRoot?: string;
	/** Whether the session is SSH remote (disables local-only actions) */
	sshRemote?: boolean;
}

function isMarkdownFile(name: string): boolean {
	return name.endsWith('.md') || name.endsWith('.markdown');
}

export function FileContextMenu({
	menu,
	theme,
	onDismiss,
	onPreview,
	projectRoot,
	sshRemote,
}: FileContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	const { left, top, ready } = useContextMenuPosition(menuRef, menu.x, menu.y);

	// Dismiss on click outside or Escape
	useEffect(() => {
		const handleMouseDown = () => onDismissRef.current();
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onDismissRef.current();
		};
		document.addEventListener('mousedown', handleMouseDown);
		document.addEventListener('keydown', handleKey);
		return () => {
			document.removeEventListener('mousedown', handleMouseDown);
			document.removeEventListener('keydown', handleKey);
		};
	}, []);

	const handlePreview = useCallback(() => {
		onPreview?.(menu.filePath);
		onDismiss();
	}, [menu.filePath, onPreview, onDismiss]);

	const handleFocusInGraph = useCallback(() => {
		// Derive relative path from absolute for the store action
		const relativePath =
			projectRoot && menu.filePath.startsWith(projectRoot)
				? menu.filePath.slice(projectRoot.length + 1)
				: menu.filePath;
		useFileExplorerStore.getState().focusFileInGraph(relativePath);
		onDismiss();
	}, [menu.filePath, projectRoot, onDismiss]);

	const handleOpenInDefaultApp = useCallback(() => {
		window.maestro?.shell?.openPath(menu.filePath);
		onDismiss();
	}, [menu.filePath, onDismiss]);

	const handleCopyPath = useCallback(() => {
		safeClipboardWrite(menu.filePath);
		onDismiss();
	}, [menu.filePath, onDismiss]);

	const handleRevealInFinder = useCallback(() => {
		window.maestro?.shell?.showItemInFolder(menu.filePath);
		onDismiss();
	}, [menu.filePath, onDismiss]);

	const showDocGraph = isMarkdownFile(menu.fileName);

	return (
		<div
			ref={menuRef}
			className="fixed z-[10000] rounded-lg shadow-xl border overflow-hidden"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '180px',
			}}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<div className="p-1">
				{/* Preview */}
				{onPreview && (
					<button
						onClick={handlePreview}
						className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textMain }}
					>
						<FileText className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
						<span>Preview</span>
					</button>
				)}

				{/* Document Graph — markdown files only */}
				{showDocGraph && (
					<button
						onClick={handleFocusInGraph}
						className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textMain }}
					>
						<Target className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
						<span>Document Graph</span>
					</button>
				)}

				{/* Open in Default App — not available over SSH */}
				{!sshRemote && (
					<button
						onClick={handleOpenInDefaultApp}
						className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textMain }}
					>
						<ExternalLink className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
						<span>Open in Default App</span>
					</button>
				)}

				{/* Divider */}
				{(onPreview || showDocGraph || !sshRemote) && (
					<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
				)}

				{/* Copy Path */}
				<button
					onClick={handleCopyPath}
					className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.textMain }}
				>
					<Copy className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
					<span>Copy Path</span>
				</button>

				{/* Reveal in Finder / Explorer */}
				{!sshRemote && (
					<button
						onClick={handleRevealInFinder}
						className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textMain }}
					>
						<ExternalLink className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
						<span>{getRevealLabel(window.maestro?.platform ?? '')}</span>
					</button>
				)}
			</div>
		</div>
	);
}
