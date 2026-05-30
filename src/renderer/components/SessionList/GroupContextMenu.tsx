import { useEffect, useRef } from 'react';
import { Edit3, Plus, Smile, Trash2 } from 'lucide-react';
import type { Group, Theme } from '../../types';
import { useClickOutside, useContextMenuPosition } from '../../hooks';

interface GroupContextMenuProps {
	x: number;
	y: number;
	theme: Theme;
	group: Group;
	memberCount: number;
	onRename: () => void;
	onChangeEmoji?: () => void;
	onNewAgent: () => void;
	onDelete?: () => void;
	/** Override the delete button label; defaults based on memberCount. */
	deleteLabel?: string;
	onDismiss: () => void;
}

export function GroupContextMenu({
	x,
	y,
	theme,
	group,
	memberCount,
	onRename,
	onChangeEmoji,
	onNewAgent,
	onDelete,
	deleteLabel,
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
			className="fixed z-50 py-1 rounded-md shadow-xl border whitespace-nowrap"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '10rem',
			}}
		>
			<div
				className="px-3 py-1 text-[10px] uppercase tracking-wider opacity-60 flex items-center gap-2"
				style={{ color: theme.colors.textDim }}
			>
				<span>{group.emoji}</span>
				<span className="truncate max-w-[12rem]">{group.name}</span>
			</div>
			<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

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
				Rename Group...
			</button>

			{onChangeEmoji && (
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
					Change Emoji...
				</button>
			)}

			<button
				type="button"
				onClick={() => {
					onNewAgent();
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.accent }}
			>
				<Plus className="w-3.5 h-3.5" />
				New Agent in Group...
			</button>

			{onDelete && (
				<>
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
						{deleteLabel ?? (memberCount > 0 ? 'Remove Group and Agents' : 'Delete Group')}
					</button>
				</>
			)}
		</div>
	);
}
