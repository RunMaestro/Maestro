import React, { useRef } from 'react';
import type { Theme, Session } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';
import { FormInput } from './ui/FormInput';
import { logger } from '../utils/logger';

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

			// Native OMP owns its session title over the first-party RPC adapter.
			// Unlike CLI-backed agents it is addressed by Maestro's session id.
			if (targetSession?.toolType === 'omp') {
				void window.maestro.process
					.setAgentControl(sessionIdToRename, 'session-name', trimmedName)
					.catch((err) =>
						logger.error('Failed to update native OMP session name:', undefined, err)
					);
			} else if (targetSession?.agentSessionId && targetSession.projectRoot) {
				// Use projectRoot (not cwd) for consistent session storage access.
				const agentId = targetSession.toolType || 'claude-code';
				if (agentId === 'claude-code') {
					window.maestro.claude
						.updateSessionName(targetSession.projectRoot, targetSession.agentSessionId, trimmedName)
						.catch((err) => logger.error('Failed to update agent session name:', undefined, err));
				} else {
					window.maestro.agentSessions
						.setSessionName(
							agentId,
							targetSession.projectRoot,
							targetSession.agentSessionId,
							trimmedName
						)
						.catch((err) => logger.error('Failed to update agent session name:', undefined, err));
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
