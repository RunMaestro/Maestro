/**
 * PipelineContextMenu — Right-click context menu for pipeline nodes.
 *
 * Purely presentational: renders Configure, Duplicate (triggers only), and Delete actions.
 */

import React, { useRef, useEffect } from 'react';
import type { Theme } from '../../types';
import { useClickOutside, useContextMenuPosition } from '../../hooks/ui';

export interface ContextMenuState {
	x: number;
	y: number;
	nodeId: string;
	pipelineId: string;
	nodeType: 'trigger' | 'agent' | 'cli_output';
}

export interface PipelineContextMenuProps {
	contextMenu: ContextMenuState;
	theme: Theme;
	onConfigure: () => void;
	onDelete: () => void;
	onDuplicate: () => void;
	onDismiss: () => void;
}

export const PipelineContextMenu = React.memo(function PipelineContextMenu({
	contextMenu,
	theme,
	onConfigure,
	onDelete,
	onDuplicate,
	onDismiss,
}: PipelineContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);

	useClickOutside(menuRef, onDismiss);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onDismiss();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [onDismiss]);

	const { left, top, ready } = useContextMenuPosition(menuRef, contextMenu.x, contextMenu.y);

	useEffect(() => {
		menuRef.current?.focus();
	}, []);

	return (
		<div
			ref={menuRef}
			className="fixed outline-none"
			tabIndex={-1}
			style={{
				left,
				top,
				zIndex: 10000,
				opacity: ready ? 1 : 0,
			}}
		>
			<div
				className="whitespace-nowrap"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					border: `1px solid ${theme.colors.border}`,
					borderRadius: 6,
					boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
					padding: '4px 0',
					minWidth: '8.75rem',
				}}
			>
				<button
					onClick={onConfigure}
					className="block w-full text-left transition-colors"
					style={{
						padding: '6px 12px',
						fontSize: 12,
						color: theme.colors.textMain,
						backgroundColor: 'transparent',
						border: 'none',
						cursor: 'pointer',
					}}
					onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = theme.colors.bgActivity)}
					onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
				>
					Configure
				</button>
				{contextMenu.nodeType === 'trigger' && (
					<button
						onClick={onDuplicate}
						className="block w-full text-left transition-colors"
						style={{
							padding: '6px 12px',
							fontSize: 12,
							color: theme.colors.textMain,
							backgroundColor: 'transparent',
							border: 'none',
							cursor: 'pointer',
						}}
						onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = theme.colors.bgActivity)}
						onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
					>
						Duplicate
					</button>
				)}
				<div
					style={{
						height: 1,
						backgroundColor: theme.colors.border,
						margin: '4px 0',
					}}
				/>
				<button
					onClick={onDelete}
					className="block w-full text-left transition-colors"
					style={{
						padding: '6px 12px',
						fontSize: 12,
						color: theme.colors.error,
						backgroundColor: 'transparent',
						border: 'none',
						cursor: 'pointer',
					}}
					onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = theme.colors.bgActivity)}
					onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
				>
					Delete
				</button>
			</div>
		</div>
	);
});
