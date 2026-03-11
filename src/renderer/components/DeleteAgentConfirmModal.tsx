import React, { useRef, useCallback, useState } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
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
	const isEraseEnabled = confirmationText === agentName;

	const handleConfirm = useCallback(() => {
		onConfirm();
		onClose();
	}, [onConfirm, onClose]);

	const handleConfirmAndErase = useCallback(() => {
		onConfirmAndErase();
		onClose();
	}, [onConfirmAndErase, onClose]);

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
			width={540}
			zIndex={10000}
			initialFocusRef={confirmButtonRef}
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
						ref={confirmButtonRef}
						type="button"
						onClick={handleConfirm}
						onKeyDown={(e) => handleKeyDown(e, handleConfirm)}
						className="px-3 py-1.5 rounded transition-colors outline-none focus:ring-2 focus:ring-offset-1 text-xs whitespace-nowrap"
						style={{
							backgroundColor: `${theme.colors.error}99`,
							color: theme.colors.errorForeground,
						}}
					>
						Agent Only
					</button>
					<button
						type="button"
						onClick={isEraseEnabled ? handleConfirmAndErase : undefined}
						onKeyDown={isEraseEnabled ? (e) => handleKeyDown(e, handleConfirmAndErase) : undefined}
						disabled={!isEraseEnabled}
						className={`px-3 py-1.5 rounded transition-colors outline-none focus:ring-2 focus:ring-offset-1 text-xs whitespace-nowrap ${
							!isEraseEnabled ? 'opacity-50 cursor-not-allowed' : ''
						}`}
						style={{
							backgroundColor: theme.colors.error,
							color: theme.colors.errorForeground,
						}}
					>
						Agent + Working Directory
					</button>
				</div>
			}
		>
			<div className="flex gap-4">
				<div
					className="flex-shrink-0 p-2 rounded-full h-fit"
					style={{ backgroundColor: `${theme.colors.error}20` }}
				>
					<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.error }} />
				</div>
				<div className="space-y-3">
					<p className="leading-relaxed" style={{ color: theme.colors.textMain }}>
						<strong style={{ color: theme.colors.warning }}>Danger:</strong> You are about to delete
						the agent "{agentName}". This action cannot be undone.
					</p>
					<p className="text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
						<strong>Agent + Working Directory</strong> will also move the working directory to the
						trash:
					</p>
					<code
						className="block text-xs px-2 py-1 rounded break-all"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						{workingDirectory}
					</code>
					<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
						Enter agent name below to enable working directory deletion:
					</p>
					<input
						type="text"
						value={confirmationText}
						onChange={(e) => setConfirmationText(e.target.value)}
						placeholder=""
						className="block w-full text-sm px-3 py-2 rounded outline-none focus:ring-2 focus:ring-offset-1"
						style={{
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
						aria-label="Confirm agent name"
					/>
				</div>
			</div>
		</Modal>
	);
}
