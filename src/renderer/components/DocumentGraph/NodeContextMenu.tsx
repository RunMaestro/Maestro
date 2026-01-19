/**
 * NodeContextMenu - Right-click context menu for document graph nodes.
 *
 * Provides actions:
 * - Open: Opens the document file or external URL
 * - Copy Path/URL: Copies the file path or URL to clipboard
 * - Focus: Centers the view on the selected node
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { FileText, ExternalLink, Copy, Focus } from 'lucide-react';
import type { Theme } from '../../types';
import type { GraphNodeData } from './graphDataBuilder';
import { useClickOutside } from '../../hooks/ui';

/**
 * Props for the NodeContextMenu component
 */
export interface NodeContextMenuProps {
	/** X position for the menu */
	x: number;
	/** Y position for the menu */
	y: number;
	/** Current theme */
	theme: Theme;
	/** Node data for the right-clicked node */
	nodeData: GraphNodeData;
	/** Node ID */
	nodeId: string;
	/** Callback to open a document file */
	onOpen: (filePath: string) => void;
	/** Callback to open an external URL */
	onOpenExternal: (url: string) => void;
	/** Callback to focus/center view on a node */
	onFocus: (nodeId: string) => void;
	/** Callback to dismiss the context menu */
	onDismiss: () => void;
}

/**
 * NodeContextMenu component for document graph nodes
 */
export function NodeContextMenu({
	x,
	y,
	theme,
	nodeData,
	nodeId,
	onOpen,
	onOpenExternal,
	onFocus,
	onDismiss,
}: NodeContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);

	// Use ref to avoid re-registering listener when onDismiss changes
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	// Close on click outside
	useClickOutside(menuRef, onDismiss);

	// Close on Escape
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onDismissRef.current();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, []);

	// Adjust menu position to stay within viewport
	const adjustedPosition = {
		left: Math.min(x, window.innerWidth - 180),
		top: Math.min(y, window.innerHeight - 150),
	};

	const isDocument = nodeData.nodeType === 'document';
	const isExternal = nodeData.nodeType === 'external';

	/**
	 * Handle Open action
	 */
	const handleOpen = useCallback(() => {
		if (isDocument) {
			onOpen(nodeData.filePath);
		} else if (isExternal && nodeData.urls.length > 0) {
			onOpenExternal(nodeData.urls[0]);
		}
		onDismiss();
	}, [isDocument, isExternal, nodeData, onOpen, onOpenExternal, onDismiss]);

	/**
	 * Handle Copy Path/URL action
	 */
	const handleCopy = useCallback(async () => {
		try {
			if (isDocument) {
				await navigator.clipboard.writeText(nodeData.filePath);
			} else if (isExternal) {
				// Copy all URLs if multiple, or just the single URL
				const textToCopy = nodeData.urls.length > 1 ? nodeData.urls.join('\n') : nodeData.urls[0];
				await navigator.clipboard.writeText(textToCopy);
			}
		} catch (err) {
			console.error('Failed to copy to clipboard:', err);
		}
		onDismiss();
	}, [isDocument, isExternal, nodeData, onDismiss]);

	/**
	 * Handle Focus action (center view on node)
	 */
	const handleFocus = useCallback(() => {
		onFocus(nodeId);
		onDismiss();
	}, [nodeId, onFocus, onDismiss]);

	return (
		<div
			ref={menuRef}
			className="fixed z-[10000] py-1 rounded-md shadow-xl border"
			style={{
				left: adjustedPosition.left,
				top: adjustedPosition.top,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '160px',
			}}
		>
			{/* Open */}
			<button
				onClick={handleOpen}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				{isDocument ? (
					<FileText className="w-3.5 h-3.5" />
				) : (
					<ExternalLink className="w-3.5 h-3.5" />
				)}
				Open
			</button>

			{/* Copy Path/URL */}
			<button
				onClick={handleCopy}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Copy className="w-3.5 h-3.5" />
				{isDocument
					? 'Copy Path'
					: isExternal && nodeData.urls.length > 1
						? 'Copy URLs'
						: 'Copy URL'}
			</button>

			{/* Divider */}
			<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

			{/* Focus (center view) */}
			<button
				onClick={handleFocus}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Focus className="w-3.5 h-3.5" />
				Focus
			</button>
		</div>
	);
}

export default NodeContextMenu;
