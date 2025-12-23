import React, { useRef, useState } from 'react';
import { Trash2, Loader2 } from 'lucide-react';
import type { Theme, Session } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';

interface DeleteWorktreeModalProps {
  theme: Theme;
  session: Session;
  onClose: () => void;
  onConfirm: () => void;
  onConfirmAndDelete: () => Promise<void>;
}

/**
 * DeleteWorktreeModal - Confirmation modal for deleting a worktree session
 *
 * Provides three options:
 * - Cancel: Close without action
 * - Confirm: Remove the sub-agent but keep the worktree directory on disk
 * - Confirm and Delete on Disk: Remove the sub-agent AND delete the worktree directory
 */
export function DeleteWorktreeModal({
  theme,
  session,
  onClose,
  onConfirm,
  onConfirmAndDelete,
}: DeleteWorktreeModalProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  const handleConfirmAndDelete = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await onConfirmAndDelete();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete worktree');
      setIsDeleting(false);
    }
  };

  return (
    <Modal
      theme={theme}
      title="Delete Worktree"
      priority={MODAL_PRIORITIES.CONFIRM}
      onClose={onClose}
      width={500}
      zIndex={10000}
      initialFocusRef={confirmButtonRef}
      headerIcon={<Trash2 className="w-4 h-4" style={{ color: theme.colors.error }} />}
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none focus:ring-2 focus:ring-offset-1"
            style={{
              borderColor: theme.colors.border,
              color: theme.colors.textMain,
            }}
          >
            Cancel
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={handleConfirm}
            disabled={isDeleting}
            className="px-4 py-2 rounded transition-colors outline-none focus:ring-2 focus:ring-offset-1"
            style={{
              backgroundColor: theme.colors.error,
              color: '#ffffff',
            }}
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={handleConfirmAndDelete}
            disabled={isDeleting}
            className="px-3 py-2 rounded transition-colors outline-none focus:ring-2 focus:ring-offset-1 flex items-center gap-1.5 text-xs whitespace-nowrap"
            style={{
              backgroundColor: theme.colors.error,
              color: '#ffffff',
              opacity: isDeleting ? 0.7 : 1,
            }}
          >
            {isDeleting ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Deleting...
              </>
            ) : (
              'Confirm and Delete on Disk'
            )}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
          Delete worktree session "<span className="font-semibold">{session.name}</span>"?
        </p>
        <div className="text-xs space-y-2" style={{ color: theme.colors.textDim }}>
          <p>
            <strong style={{ color: theme.colors.textMain }}>Confirm:</strong> Removes the sub-agent from Maestro but keeps the git worktree directory on disk.
          </p>
          <p>
            <strong style={{ color: theme.colors.textMain }}>Confirm and Delete on Disk:</strong> Removes the sub-agent AND permanently deletes the worktree directory from disk.
          </p>
        </div>
        {session.cwd && (
          <p
            className="text-xs font-mono px-2 py-1.5 rounded truncate"
            style={{
              backgroundColor: theme.colors.bgActivity,
              color: theme.colors.textDim,
            }}
            title={session.cwd}
          >
            {session.cwd}
          </p>
        )}
        {error && (
          <p className="text-xs" style={{ color: theme.colors.error }}>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export default DeleteWorktreeModal;
