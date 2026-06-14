import React, { memo, useCallback } from 'react';
import type { Theme } from '../../../types';

interface CommandHistoryPopoverProps {
	isOpen: boolean;
	isTerminalMode: boolean;
	filter: string;
	selectedIndex: number;
	filteredHistory: string[];
	theme: Theme;
	setFilter: (filter: string) => void;
	setOpen: (open: boolean) => void;
	setSelectedIndex: (index: number) => void;
	setInputValue: (value: string) => void;
	inputRef: React.RefObject<HTMLTextAreaElement>;
}

export const CommandHistoryPopover = memo(function CommandHistoryPopover({
	isOpen,
	isTerminalMode,
	filter,
	selectedIndex,
	filteredHistory,
	theme,
	setFilter,
	setOpen,
	setSelectedIndex,
	setInputValue,
	inputRef,
}: CommandHistoryPopoverProps) {
	const focusFilterRef = useCallback((el: HTMLInputElement | null) => {
		el?.focus();
	}, []);

	if (!isOpen) {
		return null;
	}

	const closeAndFocusInput = () => {
		setOpen(false);
		setFilter('');
		setTimeout(() => inputRef.current?.focus(), 0);
	};
	const visibleHistory = filteredHistory.slice(0, 5);

	return (
		<div
			className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl max-h-64 overflow-hidden"
			style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
		>
			<div className="p-2">
				<input
					ref={focusFilterRef}
					tabIndex={0}
					type="text"
					className="w-full bg-transparent outline-none text-sm p-2 border-b"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					placeholder={isTerminalMode ? 'Filter commands...' : 'Filter messages...'}
					value={filter}
					onChange={(e) => {
						setFilter(e.target.value);
						setSelectedIndex(0);
					}}
					onKeyDown={(e) => {
						if (e.key === 'ArrowDown') {
							e.preventDefault();
							setSelectedIndex(Math.min(selectedIndex + 1, Math.max(visibleHistory.length - 1, 0)));
						} else if (e.key === 'ArrowUp') {
							e.preventDefault();
							setSelectedIndex(Math.max(selectedIndex - 1, 0));
						} else if (e.key === 'Enter') {
							e.preventDefault();
							if (visibleHistory[selectedIndex]) {
								setInputValue(visibleHistory[selectedIndex]);
								closeAndFocusInput();
							}
						} else if (e.key === 'Escape') {
							e.preventDefault();
							e.stopPropagation();
							closeAndFocusInput();
						}
					}}
				/>
			</div>
			<div className="max-h-48 overflow-y-auto scrollbar-thin">
				{visibleHistory.map((cmd, idx) => {
					const isSelected = idx === selectedIndex;
					const isMostRecent = idx === 0;

					return (
						<button
							type="button"
							key={cmd}
							className={`w-full px-3 py-2 text-left text-sm font-mono ${isSelected ? 'ring-1 ring-inset' : ''} ${isMostRecent ? 'font-semibold' : ''}`}
							style={
								{
									backgroundColor: isSelected
										? theme.colors.bgActivity
										: isMostRecent
											? theme.colors.accent + '15'
											: 'transparent',
									'--tw-ring-color': theme.colors.accent,
									color: theme.colors.textMain,
									borderLeft: isMostRecent ? `2px solid ${theme.colors.accent}` : 'none',
								} as React.CSSProperties
							}
							onClick={() => {
								setInputValue(cmd);
								setOpen(false);
								setFilter('');
								inputRef.current?.focus();
							}}
							onMouseEnter={() => setSelectedIndex(idx)}
						>
							{cmd}
						</button>
					);
				})}
				{filteredHistory.length === 0 && (
					<div className="px-3 py-4 text-center text-sm opacity-50">
						{isTerminalMode ? 'No matching commands' : 'No matching messages'}
					</div>
				)}
			</div>
		</div>
	);
});
