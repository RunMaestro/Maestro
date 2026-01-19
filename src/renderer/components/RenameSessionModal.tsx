import React, { useRef } from 'react';
import type { Theme, Session } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';
import { FormInput } from './ui/FormInput';

interface RenameSessionModalProps {
	theme: Theme;
	value: string;
	setValue: (value: string) => void;
	onClose: () => void;
	sessions: Session[];
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	activeSessionId: string;
	/** Optional: specific session ID to rename (overrides activeSessionId) */
	targetSessionId?: string;
	/** Optional: callback to flush persistence immediately after rename (for debounced persistence) */
	onAfterRename?: () => void;
}

export function RenameSessionModal(props: RenameSessionModalProps) {
	const {
		theme,
		value,
		setValue,
		onClose,
		sessions,
		setSessions,
		activeSessionId,
		targetSessionId,
		onAfterRename,
	} = props;
	// Use targetSessionId if provided, otherwise fall back to activeSessionId
	const sessionIdToRename = targetSessionId || activeSessionId;
	const inputRef = useRef<HTMLInputElement>(null);

	const handleRename = () => {
		if (value.trim()) {
			const trimmedName = value.trim();

			// Find the target session to check for Claude session association
			const targetSession = sessions.find((s) => s.id === sessionIdToRename);

			// Update local state
			setSessions((prev) =>
				prev.map((s) => (s.id === sessionIdToRename ? { ...s, name: trimmedName } : s))
			);

			// Also update the agent session name if this session has an associated agent session
			// Use projectRoot (not cwd) for consistent session storage access
			if (targetSession?.agentSessionId && targetSession?.projectRoot) {
				const agentId = targetSession.toolType || 'claude-code';
				if (agentId === 'claude-code') {
					window.maestro.claude
						.updateSessionName(targetSession.projectRoot, targetSession.agentSessionId, trimmedName)
						.catch((err) => console.error('Failed to update agent session name:', err));
				} else {
					window.maestro.agentSessions
						.setSessionName(
							agentId,
							targetSession.projectRoot,
							targetSession.agentSessionId,
							trimmedName
						)
						.catch((err) => console.error('Failed to update agent session name:', err));
				}
			}

			// Flush persistence immediately for critical operation (session rename)
			if (onAfterRename) {
				setTimeout(() => onAfterRename(), 0);
			}

			onClose();
		}
	};

	return (
		<Modal
			theme={theme}
			title="Rename Agent"
			priority={MODAL_PRIORITIES.RENAME_INSTANCE}
			onClose={onClose}
			initialFocusRef={inputRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleRename}
					confirmLabel="Rename"
					confirmDisabled={!value.trim()}
				/>
			}
		>
			<FormInput
				ref={inputRef}
				theme={theme}
				value={value}
				onChange={setValue}
				onSubmit={handleRename}
				placeholder="Enter agent name..."
			/>
		</Modal>
	);
}
