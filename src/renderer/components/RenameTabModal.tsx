import React, { memo, useRef, useState } from 'react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { FormInput } from './ui/FormInput';
import { isMacOS } from '../../shared/platformDetection';

interface RenameTabModalProps {
	theme: Theme;
	initialName: string;
	agentSessionId?: string | null;
	onClose: () => void;
	onRename: (newName: string) => void;
	/** Callback to trigger auto-naming (dismisses modal, shows spinner in tab) */
	onAutoName?: () => void;
	/** Whether the tab has conversation logs (controls Auto button visibility) */
	hasLogs?: boolean;
}

export const RenameTabModal = memo(function RenameTabModal(props: RenameTabModalProps) {
	const { theme, initialName, agentSessionId, onClose, onRename, onAutoName, hasLogs } = props;
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(initialName);

	// Generate placeholder with UUID octet if available
	const placeholder = agentSessionId
		? `Rename ${agentSessionId.split('-')[0].toUpperCase()}...`
		: 'Enter tab name...';

	const handleRename = () => {
		onRename(value.trim());
		onClose();
	};

	const showAutoButton = !!onAutoName && !!hasLogs;

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (showAutoButton && e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			e.stopPropagation();
			onAutoName?.();
		}
	};

	return (
		<Modal
			theme={theme}
			title="Rename Tab"
			priority={MODAL_PRIORITIES.RENAME_TAB}
			onClose={onClose}
			width={400}
			initialFocusRef={inputRef as React.RefObject<HTMLElement>}
			footer={
				<>
					{showAutoButton && (
						<button
							type="button"
							onClick={onAutoName}
							title={`Auto-rename (${isMacOS() ? '⌘' : 'Ctrl'}+Shift+Enter)`}
							className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none focus:ring-2 focus:ring-offset-1 mr-auto"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.accent,
							}}
						>
							Auto
						</button>
					)}
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 rounded border hover:bg-white/5 transition-colors outline-none focus:ring-2 focus:ring-offset-1"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleRename}
						className="px-4 py-2 rounded transition-colors outline-none focus:ring-2 focus:ring-offset-1"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						Rename
					</button>
				</>
			}
		>
			<FormInput
				ref={inputRef}
				theme={theme}
				value={value}
				onChange={setValue}
				onSubmit={handleRename}
				onKeyDown={handleKeyDown}
				placeholder={placeholder}
			/>
		</Modal>
	);
});
