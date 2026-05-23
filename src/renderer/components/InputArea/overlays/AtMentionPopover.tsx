import React, { memo } from 'react';
import type { MutableRefObject } from 'react';
import { File, Folder } from 'lucide-react';
import type { Theme } from '../../../types';
import type { AtMentionSuggestion } from '../types';

interface AtMentionPopoverProps {
	isOpen: boolean;
	isTerminalMode: boolean;
	suggestions: AtMentionSuggestion[];
	selectedIndex: number;
	filter: string;
	startIndex: number;
	inputValue: string;
	itemRefs: MutableRefObject<(HTMLButtonElement | null)[]>;
	theme: Theme;
	setInputValue: (value: string) => void;
	setOpen?: (open: boolean) => void;
	setFilter?: (filter: string) => void;
	setStartIndex?: (index: number) => void;
	setSelectedIndex?: (index: number) => void;
	inputRef: React.RefObject<HTMLTextAreaElement>;
}

export const AtMentionPopover = memo(function AtMentionPopover({
	isOpen,
	isTerminalMode,
	suggestions,
	selectedIndex,
	filter,
	startIndex,
	inputValue,
	itemRefs,
	theme,
	setInputValue,
	setOpen,
	setFilter,
	setStartIndex,
	setSelectedIndex,
	inputRef,
}: AtMentionPopoverProps) {
	if (!isOpen || isTerminalMode || suggestions.length === 0) {
		return null;
	}

	return (
		<div
			className="absolute bottom-full left-4 right-4 mb-1 rounded-lg border shadow-lg overflow-hidden z-50"
			style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
		>
			<div
				className="px-3 py-2 border-b text-xs font-medium"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				Files {filter && <span className="opacity-50">matching "{filter}"</span>}
			</div>
			<div className="overflow-y-auto max-h-56 scrollbar-thin">
				{suggestions.map((suggestion, idx) => {
					const isSelected = idx === selectedIndex;
					const IconComponent = suggestion.type === 'folder' ? Folder : File;

					return (
						<button
							type="button"
							key={`${suggestion.type}-${suggestion.value}`}
							ref={(el) => (itemRefs.current[idx] = el)}
							className={`w-full px-3 py-2 text-left text-sm font-mono flex items-center gap-2 ${isSelected ? 'ring-1 ring-inset' : ''}`}
							style={
								{
									backgroundColor: isSelected ? theme.colors.bgActivity : 'transparent',
									'--tw-ring-color': theme.colors.accent,
									color: theme.colors.textMain,
								} as React.CSSProperties
							}
							onClick={() => {
								const beforeAt = inputValue.substring(0, startIndex);
								const afterFilter = inputValue.substring(startIndex + 1 + filter.length);
								setInputValue(beforeAt + '@' + suggestion.value + ' ' + afterFilter);
								setOpen?.(false);
								setFilter?.('');
								setStartIndex?.(-1);
								inputRef.current?.focus();
							}}
							onMouseEnter={() => setSelectedIndex?.(idx)}
						>
							<IconComponent
								className="w-3.5 h-3.5 flex-shrink-0"
								style={{
									color: suggestion.type === 'folder' ? theme.colors.warning : theme.colors.textDim,
								}}
							/>
							<span className="flex-1 truncate">{suggestion.fullPath}</span>
							{suggestion.source === 'autorun' && (
								<span
									className="text-[9px] px-1 py-0.5 rounded flex-shrink-0"
									style={{
										backgroundColor: `${theme.colors.accent}30`,
										color: theme.colors.accent,
									}}
								>
									Auto Run
								</span>
							)}
							<span className="text-[10px] opacity-40 flex-shrink-0">{suggestion.type}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
});
