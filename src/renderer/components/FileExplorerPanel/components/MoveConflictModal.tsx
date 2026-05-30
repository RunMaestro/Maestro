import React, { useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '../../ui/Modal';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import type { Theme } from '../../../types';
import type { PendingMove } from '../types';

interface MoveConflictModalProps {
	theme: Theme;
	destFolderLabel: string;
	conflicts: PendingMove[];
	nonConflictingCount: number;
	isMoving: boolean;
	/** 'move' (in-tree drag) or 'copy' (OS file import). Controls the verbs. */
	operation?: 'move' | 'copy';
	onCancel: () => void;
	onOverwriteAll: () => void;
	onAutoRenameAll: () => void;
	onSkipConflicts: () => void;
}

export function MoveConflictModal({
	theme,
	destFolderLabel,
	conflicts,
	nonConflictingCount,
	isMoving,
	operation = 'move',
	onCancel,
	onOverwriteAll,
	onAutoRenameAll,
	onSkipConflicts,
}: MoveConflictModalProps) {
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	const isSingle = conflicts.length === 1 && nonConflictingCount === 0;
	const conflictCount = conflicts.length;
	// Verb varies with the operation: rows moved within the tree vs. OS files
	// imported (copied) in from Finder/Explorer.
	const verb = operation === 'copy' ? 'import' : 'move';

	let title: string;
	let bodyText: React.ReactNode;
	let autoRenameLabel: React.ReactNode;
	let overwriteLabel: React.ReactNode;
	let autoRenameDescription: string;
	let overwriteDescription: string;

	if (isSingle) {
		const only = conflicts[0];
		title = 'Name conflict';
		bodyText = (
			<>
				"{only.sourceName}" already exists in {destFolderLabel}. How do you want to proceed?
			</>
		);
		autoRenameLabel = <>Rename to "{only.autoRenameName}"</>;
		overwriteLabel = <>Overwrite existing</>;
		autoRenameDescription = `${verb === 'import' ? 'Import' : 'Move'} the file with an auto-suffixed name so nothing is overwritten.`;
		overwriteDescription = 'Replace the file already at the destination. Cannot be undone.';
	} else {
		title = `Name conflicts (${conflictCount})`;
		bodyText = (
			<>
				{conflictCount} item{conflictCount === 1 ? '' : 's'} already exist
				{conflictCount === 1 ? 's' : ''} in {destFolderLabel}
				{nonConflictingCount > 0 && (
					<>
						{' '}
						({nonConflictingCount} other{nonConflictingCount === 1 ? '' : 's'} can {verb} without
						conflict)
					</>
				)}
				. How do you want to proceed?
			</>
		);
		autoRenameLabel = (
			<>
				Auto-rename {conflictCount} conflicting item{conflictCount === 1 ? '' : 's'}
			</>
		);
		overwriteLabel = (
			<>
				Overwrite all {conflictCount} existing item{conflictCount === 1 ? '' : 's'}
			</>
		);
		autoRenameDescription = `${verb === 'import' ? 'Import' : 'Move'} conflicting items with auto-suffixed names so nothing is overwritten.`;
		overwriteDescription = 'Replace the existing items at the destination. Cannot be undone.';
	}

	return (
		<Modal
			theme={theme}
			title={title}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={isMoving ? () => {} : onCancel}
			headerIcon={<AlertTriangle className="w-4 h-4" style={{ color: theme.colors.warning }} />}
			initialFocusRef={cancelButtonRef}
		>
			<div className="flex flex-col gap-4">
				<p style={{ color: theme.colors.textMain }}>{bodyText}</p>
				{!isSingle && conflictCount > 0 && (
					<div
						className="text-xs rounded border px-2 py-1.5 max-h-32 overflow-auto"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textDim,
							backgroundColor: theme.colors.bgActivity,
						}}
					>
						{conflicts.map((c) => (
							<div key={c.sourceRelativePath} className="truncate" title={c.sourceName}>
								{c.sourceName} → {c.autoRenameName}
							</div>
						))}
					</div>
				)}
				<div className="flex flex-col gap-2">
					<button
						type="button"
						disabled={isMoving}
						onClick={onAutoRenameAll}
						className="px-3 py-2 rounded text-sm text-left disabled:opacity-50 hover:bg-white/5 transition-colors"
						style={{
							border: `1px solid ${theme.colors.border}`,
							color: theme.colors.textMain,
						}}
					>
						<div className="font-medium">{autoRenameLabel}</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							{autoRenameDescription}
						</div>
					</button>
					<button
						type="button"
						disabled={isMoving}
						onClick={onOverwriteAll}
						className="px-3 py-2 rounded text-sm text-left disabled:opacity-50 hover:bg-white/5 transition-colors"
						style={{
							border: `1px solid ${theme.colors.border}`,
							color: theme.colors.error,
						}}
					>
						<div className="font-medium">{overwriteLabel}</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							{overwriteDescription}
						</div>
					</button>
					{nonConflictingCount > 0 && (
						<button
							type="button"
							disabled={isMoving}
							onClick={onSkipConflicts}
							className="px-3 py-2 rounded text-sm text-left disabled:opacity-50 hover:bg-white/5 transition-colors"
							style={{
								border: `1px solid ${theme.colors.border}`,
								color: theme.colors.textMain,
							}}
						>
							<div className="font-medium">
								Skip conflicts, {verb} {nonConflictingCount} other
								{nonConflictingCount === 1 ? '' : 's'}
							</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Leave the existing items alone and only {verb} the non-conflicting selection.
							</div>
						</button>
					)}
					<button
						ref={cancelButtonRef}
						type="button"
						disabled={isMoving}
						onClick={onCancel}
						className="px-3 py-2 rounded text-sm text-left disabled:opacity-50 hover:bg-white/5 transition-colors"
						style={{
							border: `1px solid ${theme.colors.border}`,
							color: theme.colors.textDim,
						}}
					>
						<div className="font-medium">Cancel</div>
					</button>
				</div>
			</div>
		</Modal>
	);
}
