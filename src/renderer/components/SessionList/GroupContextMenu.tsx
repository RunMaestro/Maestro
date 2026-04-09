import { useEffect, useRef } from 'react';
import { Edit3, Trash2, ChevronDown, ChevronRight, Smile } from 'lucide-react';
import type { Group, Theme } from '../../types';
import { useClickOutside, useContextMenuPosition } from '../../hooks';

interface GroupContextMenuProps {
	x: number;
	y: number;
	theme: Theme;
	group: Group;
	onRename: () => void;
	onDelete: () => void;
	onToggleCollapse: () => void;
	onChangeEmoji: () => void;
	onDismiss: () => void;
}

export function GroupContextMenu({
	x,
	y,
	theme,
	group,
	onRename,
	onDelete,
	onToggleCollapse,
	onChangeEmoji,
	onDismiss,
}: GroupContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);

	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	useClickOutside(menuRef, onDismiss);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onDismissRef.current();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, []);

	const { left, top, ready } = useContextMenuPosition(menuRef, x, y);

	return (
		<div
			ref={menuRef}
			className="fixed z-50 py-1 rounded-md shadow-xl border"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '160px',
			}}
		>
			<button
				type="button"
				onClick={() => {
					onRename();
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Edit3 className="w-3.5 h-3.5" />
				Rename
			</button>

			<button
				type="button"
				onClick={() => {
					onChangeEmoji();
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Smile className="w-3.5 h-3.5" />
				Change Emoji
			</button>

			<button
				type="button"
				onClick={() => {
					onToggleCollapse();
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				{group.collapsed ? (
					<ChevronDown className="w-3.5 h-3.5" />
				) : (
					<ChevronRight className="w-3.5 h-3.5" />
				)}
				{group.collapsed ? 'Expand' : 'Collapse'}
			</button>

			<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

			<button
				type="button"
				onClick={() => {
					onDelete();
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.error }}
			>
				<Trash2 className="w-3.5 h-3.5" />
				Delete Group
			</button>
		</div>
	);
}
