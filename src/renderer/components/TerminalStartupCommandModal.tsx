import React, { memo, useRef, useState, useEffect } from 'react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';
import { FormInput } from './ui/FormInput';

interface TerminalStartupCommandModalProps {
	theme: Theme;
	isOpen: boolean;
	/** Currently configured startup command, if any. */
	initialCommand: string;
	/** Currently configured cwd override, if any. */
	initialCwd: string;
	/** Default cwd shown as placeholder - typically the agent's working directory. */
	defaultCwd: string;
	onSave: (command: string, cwd: string) => void;
	onClose: () => void;
}

export const TerminalStartupCommandModal = memo(function TerminalStartupCommandModal(
	props: TerminalStartupCommandModalProps
) {
	const { theme, isOpen, initialCommand, initialCwd, defaultCwd, onSave, onClose } = props;
	const commandInputRef = useRef<HTMLInputElement>(null);
	const [command, setCommand] = useState(initialCommand);
	const [cwd, setCwd] = useState(initialCwd);

	useEffect(() => {
		if (isOpen) {
			setCommand(initialCommand);
			setCwd(initialCwd);
		}
	}, [isOpen, initialCommand, initialCwd]);

	if (!isOpen) return null;

	const handleSave = () => {
		onSave(command.trim(), cwd.trim());
		onClose();
	};

	return (
		<Modal
			theme={theme}
			title="Terminal Startup Command"
			priority={MODAL_PRIORITIES.TERMINAL_STARTUP_COMMAND}
			onClose={onClose}
			width={520}
			initialFocusRef={commandInputRef as React.RefObject<HTMLElement>}
			footer={
				<ModalFooter theme={theme} onCancel={onClose} onConfirm={handleSave} confirmLabel="Save" />
			}
		>
			<FormInput
				ref={commandInputRef}
				theme={theme}
				label="Command"
				value={command}
				onChange={setCommand}
				onSubmit={handleSave}
				placeholder="e.g. npm run dev"
				monospace
			/>
			<div className="mt-3">
				<FormInput
					theme={theme}
					label="Working directory"
					value={cwd}
					onChange={setCwd}
					onSubmit={handleSave}
					placeholder={defaultCwd || 'Agent working directory'}
					monospace
				/>
			</div>
			<p className="mt-3 text-xs" style={{ color: theme.colors.textDim }}>
				Runs each time this terminal&apos;s shell is started - including after you quit and reopen
				the app. Leave the command empty to disable.
			</p>
		</Modal>
	);
});
