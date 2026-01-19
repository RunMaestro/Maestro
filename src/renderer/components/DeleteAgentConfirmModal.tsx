import React, { useRef, useCallback, useState, useMemo } from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';

interface DeleteAgentConfirmModalProps {
  theme: Theme;
  agentName: string;
  workingDirectory: string;
  onConfirm: () => void;
  onConfirmAndErase: () => void;
  onClose: () => void;
}

export function DeleteAgentConfirmModal({
  theme,
  agentName,
  workingDirectory,
  onConfirm,
  onConfirmAndErase,
  onClose,
}: DeleteAgentConfirmModalProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const [confirmationText, setConfirmationText] = useState('');

  const isAgentNameMatch = useMemo(() => {
    return confirmationText.trim().toLowerCase() === agentName.trim().toLowerCase();
  }, [confirmationText, agentName]);

  const handleConfirm = useCallback(() => {
    onConfirm();
    onClose();
  }, [onConfirm, onClose]);

  const handleConfirmAndErase = useCallback(() => {
    if (!isAgentNameMatch) return;
    onConfirmAndErase();
    onClose();
  }, [isAgentNameMatch, onConfirmAndErase, onClose]);

  // Stop Enter key propagation to prevent parent handlers from triggering after modal closes
  const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter') {
      e.stopPropagation();
      action();
    }
  };

  return (
    <Modal
      theme={theme}
      title="Confirm Delete"
      priority={MODAL_PRIORITIES.CONFIRM}
      onClose={onClose}
      headerIcon={<Trash2 className="w-4 h-4" style={{ color: theme.colors.error }} />}
      width={500}
      zIndex={10000}
      initialFocusRef={confirmButtonRef}
      footer={
        <div className="flex justify-end gap-2 w-full">
          <button
            type="button"
            onClick={onClose}
            onKeyDown={(e) => handleKeyDown(e, onClose)}
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
            onKeyDown={(e) => handleKeyDown(e, handleConfirm)}
            className="px-4 py-2 rounded transition-colors outline-none focus:ring-2 focus:ring-offset-1"
            style={{
              backgroundColor: `${theme.colors.error}99`,
              color: '#ffffff',
            }}
          >
            Agent Only
          </button>
          <button
            type="button"
            onClick={handleConfirmAndErase}
            onKeyDown={(e) => handleKeyDown(e, handleConfirmAndErase)}
            className="px-4 py-2 rounded transition-colors outline-none focus:ring-2 focus:ring-offset-1"
            style={{
              backgroundColor: theme.colors.error,
              color: '#ffffff',
              opacity: isAgentNameMatch ? 1 : 0.5,
              cursor: isAgentNameMatch ? 'pointer' : 'not-allowed',
            }}
            disabled={!isAgentNameMatch}
          >
            Agent + Work Directory
          </button>
        </div>
      }
    >
      <div>
        <div className="flex gap-3 items-start">
          <div
            className="flex h-6 w-6 items-center justify-center rounded-full"
            style={{ backgroundColor: 'rgba(255, 165, 0, 0.2)' }}
          >
            <AlertTriangle className="h-4 w-4" style={{ color: '#ffa500' }} />
          </div>
          <p className="leading-relaxed" style={{ color: '#ffffff' }}>
            <span className="font-semibold" style={{ color: '#ffd700' }}>
              Danger:
            </span>{' '}
            Deleting the agent "{agentName}" cannot be undone. "Agent + Work Directory"
            will also move the working directory to the trash:
          </p>
        </div>
        <code
          className="mt-4 block text-xs px-3 py-2 rounded break-all"
          style={{
            backgroundColor: theme.colors.bgActivity,
            color: '#ffffff',
            border: `1px solid ${theme.colors.border}`,
          }}
        >
          {workingDirectory}
        </code>
        <input
          type="text"
          value={confirmationText}
          onChange={(e) => setConfirmationText(e.target.value)}
          placeholder="Type the agent name here to confirm directory deletion."
          aria-label="Type the agent name here to confirm directory deletion."
          className="mt-2.5 w-full px-3 py-2 rounded text-sm outline-none placeholder:text-[color:var(--placeholder-color)]"
          style={{
            backgroundColor: theme.colors.bgActivity,
            color: '#ffffff',
            border: `1px solid ${theme.colors.border}`,
            '--placeholder-color': theme.colors.textDim,
          } as React.CSSProperties}
        />
      </div>
    </Modal>
  );
}
