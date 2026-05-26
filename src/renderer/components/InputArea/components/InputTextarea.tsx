import React, { memo } from 'react';
import type { Session, Theme } from '../../../types';
import { getProviderDisplayName } from '../../../utils/sessionValidation';

interface InputTextareaProps {
	session: Session;
	theme: Theme;
	isTerminalMode: boolean;
	inputValue: string;
	spellCheckEnabled: boolean;
	inputRef: React.RefObject<HTMLTextAreaElement>;
	onInputFocus: () => void;
	onInputBlur?: () => void;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	handleDrop: (e: React.DragEvent<HTMLElement>) => void;
}

export const InputTextarea = memo(function InputTextarea({
	session,
	theme,
	isTerminalMode,
	inputValue,
	spellCheckEnabled,
	inputRef,
	onInputFocus,
	onInputBlur,
	onChange,
	handleInputKeyDown,
	handlePaste,
	handleDrop,
}: InputTextareaProps) {
	return (
		<div className="flex items-start">
			{isTerminalMode && (
				<span
					className="text-sm font-mono font-bold select-none pl-3 pt-3"
					style={{ color: theme.colors.accent }}
				>
					$
				</span>
			)}
			<textarea
				ref={inputRef}
				className={`flex-1 bg-transparent text-sm outline-none ${isTerminalMode ? 'pl-1.5' : 'pl-3'} pt-3 pr-3 resize-none min-h-[3.5rem] scrollbar-thin`}
				style={{ color: theme.colors.textMain, maxHeight: '11rem' }}
				placeholder={
					isTerminalMode
						? 'Run shell command...'
						: `Talking to ${session.name} powered by ${getProviderDisplayName(session.toolType)}`
				}
				value={inputValue}
				spellCheck={spellCheckEnabled}
				onFocus={onInputFocus}
				onBlur={onInputBlur}
				onChange={onChange}
				onKeyDown={handleInputKeyDown}
				onPaste={handlePaste}
				onDrop={(e) => {
					e.stopPropagation();
					handleDrop(e);
				}}
				onDragOver={(e) => e.preventDefault()}
				rows={2}
			/>
		</div>
	);
});
