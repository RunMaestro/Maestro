import React, { memo } from 'react';
import type { MutableRefObject } from 'react';
import { File, Folder, GitBranch, History, Tag } from 'lucide-react';
import type { TabCompletionFilter, TabCompletionSuggestion } from '../../../hooks';
import type { Theme } from '../../../types';

interface TabCompletionPopoverProps {
	isOpen: boolean;
	isTerminalMode: boolean;
	isGitRepo?: boolean;
	suggestions: TabCompletionSuggestion[];
	selectedIndex: number;
	filter: TabCompletionFilter;
	itemRefs: MutableRefObject<(HTMLButtonElement | null)[]>;
	theme: Theme;
	setInputValue: (value: string) => void;
	setOpen?: (open: boolean) => void;
	setFilter?: (filter: TabCompletionFilter) => void;
	setSelectedIndex?: (index: number) => void;
	inputRef: React.RefObject<HTMLTextAreaElement>;
}

const TAB_COMPLETION_FILTERS: TabCompletionFilter[] = ['all', 'history', 'branch', 'tag', 'file'];

function getFilterIcon(filterType: TabCompletionFilter) {
	if (filterType === 'history') return History;
	if (filterType === 'branch') return GitBranch;
	if (filterType === 'tag') return Tag;
	if (filterType === 'file') return File;
	return null;
}

function getFilterLabel(filterType: TabCompletionFilter): string {
	if (filterType === 'all') return 'All';
	if (filterType === 'history') return 'History';
	if (filterType === 'branch') return 'Branches';
	if (filterType === 'tag') return 'Tags';
	return 'Files';
}

function getEmptyLabel(filter: TabCompletionFilter): string {
	if (filter === 'all') return 'suggestions';
	if (filter === 'history') return 'history';
	if (filter === 'branch') return 'branches';
	if (filter === 'tag') return 'tags';
	return 'files';
}

function getSuggestionIcon(type: TabCompletionSuggestion['type']) {
	if (type === 'history') return History;
	if (type === 'branch') return GitBranch;
	if (type === 'tag') return Tag;
	if (type === 'folder') return Folder;
	return File;
}

function getSuggestionColor(type: TabCompletionSuggestion['type'], theme: Theme): string {
	if (type === 'history') return theme.colors.accent;
	if (type === 'branch') return theme.colors.success;
	if (type === 'tag') return theme.colors.accentText;
	if (type === 'folder') return theme.colors.warning;
	return theme.colors.textDim;
}

export const TabCompletionPopover = memo(function TabCompletionPopover({
	isOpen,
	isTerminalMode,
	isGitRepo,
	suggestions,
	selectedIndex,
	filter,
	itemRefs,
	theme,
	setInputValue,
	setOpen,
	setFilter,
	setSelectedIndex,
	inputRef,
}: TabCompletionPopoverProps) {
	if (!isOpen || !isTerminalMode) {
		return null;
	}

	return (
		<div
			className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl max-h-64 overflow-hidden"
			style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
		>
			<div
				className="px-3 py-2 border-b flex items-center justify-between"
				style={{ borderColor: theme.colors.border }}
			>
				<span className="text-xs opacity-60" style={{ color: theme.colors.textDim }}>
					Tab Completion
				</span>
				{isGitRepo && setFilter && (
					<div className="flex gap-1">
						{TAB_COMPLETION_FILTERS.map((filterType) => {
							const isActive = filter === filterType;
							const Icon = getFilterIcon(filterType);
							return (
								<button
									key={filterType}
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										setFilter(filterType);
										setSelectedIndex?.(0);
									}}
									className={`px-2 py-0.5 text-[10px] rounded flex items-center gap-1 transition-colors ${
										isActive ? 'font-medium' : 'opacity-60 hover:opacity-100'
									}`}
									style={{
										backgroundColor: isActive ? theme.colors.accent + '30' : 'transparent',
										color: isActive ? theme.colors.accent : theme.colors.textDim,
										border: isActive
											? `1px solid ${theme.colors.accent}50`
											: '1px solid transparent',
									}}
								>
									{Icon && <Icon className="w-3 h-3" />}
									{getFilterLabel(filterType)}
								</button>
							);
						})}
					</div>
				)}
			</div>
			<div className="overflow-y-auto max-h-56 scrollbar-thin">
				{suggestions.length > 0 ? (
					suggestions.map((suggestion, idx) => {
						const isSelected = idx === selectedIndex;
						const IconComponent = getSuggestionIcon(suggestion.type);

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
									setInputValue(suggestion.value);
									setOpen?.(false);
									inputRef.current?.focus();
								}}
								onMouseEnter={() => setSelectedIndex?.(idx)}
							>
								<IconComponent
									className="w-3.5 h-3.5 flex-shrink-0"
									style={{ color: getSuggestionColor(suggestion.type, theme) }}
								/>
								<span className="flex-1 truncate">{suggestion.displayText}</span>
								<span className="text-[10px] opacity-40 flex-shrink-0">{suggestion.type}</span>
							</button>
						);
					})
				) : (
					<div
						className="px-3 py-4 text-center text-sm opacity-50"
						style={{ color: theme.colors.textDim }}
					>
						No matching {getEmptyLabel(filter)}
					</div>
				)}
			</div>
		</div>
	);
});
