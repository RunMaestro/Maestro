import React, { memo } from 'react';
import type { MutableRefObject } from 'react';
import type { Theme } from '../../../types';
import { highlightSlashCommand } from '../../../utils/search';
import type { SlashCommand } from '../types';

interface SlashCommandPopoverProps {
	isOpen: boolean;
	commands: SlashCommand[];
	inputValueLower: string;
	selectedIndex: number;
	itemRefs: MutableRefObject<(HTMLButtonElement | null)[]>;
	theme: Theme;
	setInputValue: (value: string) => void;
	setSlashCommandOpen: (open: boolean) => void;
	setSelectedSlashCommandIndex: (index: number) => void;
	inputRef: React.RefObject<HTMLTextAreaElement>;
}

export const SlashCommandPopover = memo(function SlashCommandPopover({
	isOpen,
	commands,
	inputValueLower,
	selectedIndex,
	itemRefs,
	theme,
	setInputValue,
	setSlashCommandOpen,
	setSelectedSlashCommandIndex,
	inputRef,
}: SlashCommandPopoverProps) {
	if (!isOpen || commands.length === 0) {
		return null;
	}

	return (
		<div
			className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl overflow-hidden"
			style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
		>
			<div
				className="overflow-y-auto max-h-96 scrollbar-thin"
				style={{ overscrollBehavior: 'contain' }}
			>
				{commands.map((cmd, idx) => (
					<button
						type="button"
						key={cmd.command}
						ref={(el) => (itemRefs.current[idx] = el)}
						className={`w-full px-3 py-1 text-left transition-colors ${
							idx === selectedIndex ? 'font-semibold' : ''
						}`}
						style={{
							backgroundColor: idx === selectedIndex ? theme.colors.accent : 'transparent',
							color: idx === selectedIndex ? theme.colors.bgMain : theme.colors.textMain,
						}}
						onClick={() => {
							setSelectedSlashCommandIndex(idx);
						}}
						onDoubleClick={() => {
							setInputValue(cmd.command);
							setSlashCommandOpen(false);
							inputRef.current?.focus();
						}}
						onMouseEnter={() => setSelectedSlashCommandIndex(idx)}
					>
						<div className="font-mono text-sm leading-tight">
							{highlightSlashCommand(cmd.command, inputValueLower.replace(/^\//, ''))}
						</div>
						<div className="text-[11px] opacity-70 leading-tight">{cmd.description}</div>
					</button>
				))}
			</div>
		</div>
	);
});
