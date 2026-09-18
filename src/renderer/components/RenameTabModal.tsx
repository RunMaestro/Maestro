import React, { memo, useRef, useState } from 'react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, MODAL_BUTTON_BASE_CLASS, MODAL_BUTTON_SECONDARY_CLASS } from './ui/Modal';
import { FormInput } from './ui/FormInput';
import { formatMetaKey } from '../utils/shortcutFormatter';

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
	/** Modal header; defaults to "Rename Tab" (overridden for tab groups). */
	title?: string;
}

export const RenameTabModal = memo(function RenameTabModal(props: RenameTabModalProps) {
	const {
		theme,
		initialName,
		agentSessionId,
		onClose,
		onRename,
		onAutoName,
		hasLogs,
		title = 'Rename Tab',
	} = props;
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
			title={title}
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
							title={`Auto-rename (${formatMetaKey()}+Shift+Enter)`}
							className={`${MODAL_BUTTON_SECONDARY_CLASS} mr-auto`}
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
						className={MODAL_BUTTON_SECONDARY_CLASS}
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
						className={MODAL_BUTTON_BASE_CLASS}
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
