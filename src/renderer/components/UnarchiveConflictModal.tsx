import React, { useRef, useCallback } from 'react';
import { AlertTriangle, ArchiveRestore } from 'lucide-react';
import type { Theme, Session } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { getAgentDisplayName } from '../services/contextGroomer';

interface UnarchiveConflictModalProps {
	theme: Theme;
	/** The archived session the user wants to unarchive */
	archivedSession: Session;
	/** The existing non-archived session that conflicts (same toolType) */
	conflictingSession: Session;
	/** Called when user chooses to archive the conflicting agent, then unarchive the target */
	onArchiveConflicting: () => void;
	/** Called when user chooses to delete the conflicting agent, then unarchive the target */
	onDeleteConflicting: () => void;
	onClose: () => void;
}

export function UnarchiveConflictModal({
	theme,
	archivedSession,
	conflictingSession,
	onArchiveConflicting,
	onDeleteConflicting,
	onClose,
}: UnarchiveConflictModalProps) {
	const archiveButtonRef = useRef<HTMLButtonElement>(null);

	const handleArchiveConflicting = useCallback(() => {
		onArchiveConflicting();
		onClose();
	}, [onArchiveConflicting, onClose]);

	const handleDeleteConflicting = useCallback(() => {
		onDeleteConflicting();
		onClose();
	}, [onDeleteConflicting, onClose]);

	const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
		if (e.key === 'Enter') {
			e.stopPropagation();
			action();
		}
	};

	const providerName = getAgentDisplayName(archivedSession.toolType);
	const conflictName = conflictingSession.name || 'Unnamed Agent';

	return (
		<Modal
			theme={theme}
			title="Unarchive Conflict"
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onClose}
			headerIcon={<ArchiveRestore className="w-4 h-4" style={{ color: theme.colors.warning }} />}
			width={500}
			zIndex={10000}
			initialFocusRef={archiveButtonRef}
			footer={
				<div className="flex gap-2 w-full flex-nowrap">
					<button
						type="button"
						onClick={onClose}
						onKeyDown={(e) => handleKeyDown(e, onClose)}
						className="px-3 py-1.5 rounded border hover:bg-white/5 transition-colors outline-none focus:ring-2 focus:ring-offset-1 text-xs whitespace-nowrap mr-auto"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						Cancel
					</button>
					<button
						ref={archiveButtonRef}
						type="button"
						onClick={handleArchiveConflicting}
						onKeyDown={(e) => handleKeyDown(e, handleArchiveConflicting)}
						className="px-3 py-1.5 rounded transition-colors outline-none focus:ring-2 focus:ring-offset-1 text-xs whitespace-nowrap"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						Archive &ldquo;{conflictName}&rdquo;
					</button>
					<button
						type="button"
						onClick={handleDeleteConflicting}
						onKeyDown={(e) => handleKeyDown(e, handleDeleteConflicting)}
						className="px-3 py-1.5 rounded transition-colors outline-none focus:ring-2 focus:ring-offset-1 text-xs whitespace-nowrap"
						style={{
							backgroundColor: theme.colors.error,
							color: '#ffffff',
						}}
					>
						Delete &ldquo;{conflictName}&rdquo;
					</button>
				</div>
			}
		>
			<div className="flex gap-4">
				<div
					className="flex-shrink-0 p-2 rounded-full h-fit"
					style={{ backgroundColor: `${theme.colors.warning}20` }}
				>
					<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.warning }} />
				</div>
				<div className="space-y-2">
					<p className="leading-relaxed" style={{ color: theme.colors.textMain }}>
						Another active <strong>{providerName}</strong> agent already exists: &ldquo;{conflictName}&rdquo;.
					</p>
					<p className="text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
						To unarchive this agent, you must first archive or delete the
						conflicting agent.
					</p>
				</div>
			</div>
		</Modal>
	);
}
