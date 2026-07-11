import { useEffect, useRef, useState } from 'react';
import { Edit3, FolderInput, FolderPlus, FolderUp, Plus, Trash2 } from 'lucide-react';
import type { Group, Theme } from '../../types';
import { useClickOutside, useContextMenuPosition } from '../../hooks';

interface GroupContextMenuProps {
	x: number;
	y: number;
	theme: Theme;
	group: Group;
	/** Enables hierarchy-specific menu actions. */
	groupsPlusEnabled?: boolean;
	memberCount: number;
	onRename: () => void;
	onNewAgent: () => void;
	onDelete?: () => void;
	/** Override the delete button label; defaults based on memberCount. */
	deleteLabel?: string;
	/** Root groups this group can safely be moved into. */
	eligibleParentGroups?: Group[];
	onMoveInto?: (parentGroupId: string) => void;
	onMoveToTopLevel?: () => void;
	onNewGroupInside?: () => void;
	onDismiss: () => void;
}

export function GroupContextMenu({
	x,
	y,
	theme,
	group,
	groupsPlusEnabled = false,
	memberCount,
	onRename,
	onNewAgent,
	onDelete,
	deleteLabel,
	eligibleParentGroups = [],
	onMoveInto,
	onMoveToTopLevel,
	onNewGroupInside,
	onDismiss,
}: GroupContextMenuProps) {
	const [moveSubmenuOpen, setMoveSubmenuOpen] = useState(false);
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

	const { left, top, ready } = useContextMenuPosition(menuRef, x, y, 8, moveSubmenuOpen);

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
				maxHeight: 'calc(100vh - 1rem)',
				overflowY: 'auto',
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

			{groupsPlusEnabled && eligibleParentGroups.length > 0 && onMoveInto && (
				<div>
					<button
						type="button"
						aria-expanded={moveSubmenuOpen}
						aria-haspopup="menu"
						onClick={() => setMoveSubmenuOpen((open) => !open)}
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
						style={{ color: theme.colors.textMain }}
					>
						<FolderInput className="w-3.5 h-3.5" />
						Move into...
					</button>
					{moveSubmenuOpen &&
						eligibleParentGroups.map((parentGroup) => (
							<button
								key={parentGroup.id}
								type="button"
								onClick={() => {
									onMoveInto(parentGroup.id);
									onDismiss();
								}}
								className="w-full text-left pl-8 pr-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								<span>{parentGroup.emoji}</span>
								<span className="truncate">{parentGroup.name}</span>
							</button>
						))}
				</div>
			)}

			{groupsPlusEnabled && group.parentGroupId && onMoveToTopLevel && (
				<button
					type="button"
					onClick={() => {
						onMoveToTopLevel();
						onDismiss();
					}}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<FolderUp className="w-3.5 h-3.5" />
					Move to top level
				</button>
			)}

			{groupsPlusEnabled && !group.parentGroupId && onNewGroupInside && (
				<button
					type="button"
					onClick={() => {
						onNewGroupInside();
						onDismiss();
					}}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.accent }}
				>
					<FolderPlus className="w-3.5 h-3.5" />
					New group inside...
				</button>
			)}

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
