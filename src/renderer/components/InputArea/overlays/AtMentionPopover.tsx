import React, { memo } from 'react';
import type { MutableRefObject } from 'react';
import { File, Folder, Users } from 'lucide-react';
import type { Theme } from '../../../types';
import {
	buildMentionAccept,
	getMentionCategoryCycle,
	type MentionCategory,
	type MentionPickerItem,
} from '../../../hooks/input/useMentionPicker';
import { getAgentIcon } from '../../../constants/agentIcons';
import { getAgentDisplayName } from '../../../../shared/agentMetadata';

interface AtMentionPopoverProps {
	isOpen: boolean;
	isTerminalMode: boolean;
	/** Unified picker rows for the active category. */
	items: MentionPickerItem[];
	/** Per-category totals for the category bar labels. */
	counts?: Record<MentionCategory, number>;
	/** Active filter scope. */
	category: MentionCategory;
	setCategory?: (category: MentionCategory) => void;
	/**
	 * Cross-Agent Mentions Encore flag. When false the Agents category segment is
	 * dropped from the bar (files/directories stay). Defaults to true so callers
	 * that don't opt into gating keep the full picker.
	 */
	crossAgentMentionsEnabled?: boolean;
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

/** Human labels for the category bar segments. */
const CATEGORY_LABELS: Record<MentionCategory, string> = {
	all: 'All',
	files: 'Files',
	directories: 'Directories',
	agents: 'Agents',
};

/** Empty-state copy per category. */
const EMPTY_LABELS: Record<MentionCategory, string> = {
	all: 'No matches',
	files: 'No files',
	directories: 'No directories',
	agents: 'No agents available',
};

/**
 * Guidance shown for the Agents category when there are genuinely no other
 * agents to consult (empty filter + zero rows), rather than a filter miss.
 */
const NO_OTHER_AGENTS_LABEL =
	'No other agents available - open another agent in the Left Bar to consult it.';

const ZERO_COUNTS: Record<MentionCategory, number> = {
	all: 0,
	files: 0,
	directories: 0,
	agents: 0,
};

export const AtMentionPopover = memo(function AtMentionPopover({
	isOpen,
	isTerminalMode,
	items,
	counts,
	category,
	setCategory,
	crossAgentMentionsEnabled = true,
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
	// The picker stays mounted while open (even with zero rows) so the category
	// bar and empty-state row remain visible - it never silently collapses.
	if (!isOpen || isTerminalMode) {
		return null;
	}

	const safeCounts = counts ?? ZERO_COUNTS;

	const acceptItem = (item: MentionPickerItem) => {
		const accept = buildMentionAccept(inputValue, startIndex, filter, item);
		setInputValue(accept.value);
		if (accept.keepOpen) {
			// Directory drill-in: keep the picker open and re-filter inside it.
			setFilter?.(accept.nextFilter);
			setSelectedIndex?.(0);
		} else {
			setOpen?.(false);
			setFilter?.('');
			setStartIndex?.(-1);
		}
		inputRef.current?.focus();
	};

	const selectCategory = (next: MentionCategory) => {
		setCategory?.(next);
		setSelectedIndex?.(0);
		inputRef.current?.focus();
	};

	// The bar hides the Agents segment when the Encore flag is off (single source
	// of truth shared with the keyboard cycle in useInputKeyDown).
	const categoryCycle = getMentionCategoryCycle(crossAgentMentionsEnabled);

	// Distinguish "no other agents exist" (empty filter + zero rows -> actionable
	// guidance) from a plain filter miss.
	const emptyLabel =
		category === 'agents' && !filter ? NO_OTHER_AGENTS_LABEL : EMPTY_LABELS[category];

	return (
		<div
			className="absolute bottom-full left-4 right-4 mb-1 rounded-lg border shadow-lg overflow-hidden z-50 select-none"
			style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
		>
			{/* Category bar: Left/Right cycle these; each shows its live count. */}
			<div
				className="flex items-stretch border-b text-xs"
				style={{ borderColor: theme.colors.border }}
			>
				{categoryCycle.map((cat) => {
					const isActive = cat === category;
					return (
						<button
							type="button"
							key={cat}
							onClick={() => selectCategory(cat)}
							className="flex-1 px-2 py-1.5 flex items-center justify-center gap-1 transition-colors"
							style={{
								backgroundColor: isActive ? theme.colors.bgActivity : 'transparent',
								color: isActive ? theme.colors.textMain : theme.colors.textDim,
								fontWeight: isActive ? 600 : 400,
								borderBottom: isActive
									? `2px solid ${theme.colors.accent}`
									: '2px solid transparent',
							}}
						>
							<span>{CATEGORY_LABELS[cat]}</span>
							<span
								className="text-[10px] px-1 rounded"
								style={{
									backgroundColor: isActive ? `${theme.colors.accent}30` : 'transparent',
									color: isActive ? theme.colors.accent : theme.colors.textDim,
									opacity: safeCounts[cat] === 0 ? 0.4 : 1,
								}}
							>
								{safeCounts[cat]}
							</span>
						</button>
					);
				})}
			</div>

			<div className="overflow-y-auto max-h-56 scrollbar-thin">
				{items.length === 0 ? (
					<div
						className="px-3 py-3 text-sm italic text-center"
						style={{ color: theme.colors.textDim }}
					>
						{emptyLabel}
						{filter && <span className="opacity-70"> matching &quot;{filter}&quot;</span>}
					</div>
				) : (
					items.map((item, idx) => {
						const isSelected = idx === selectedIndex;
						const rowStyle = {
							backgroundColor: isSelected ? theme.colors.bgActivity : 'transparent',
							'--tw-ring-color': theme.colors.accent,
							color: theme.colors.textMain,
						} as React.CSSProperties;

						// Agent or group row (positive discriminant narrows to the
						// agent-suggestion shape, exposing toolType/displayText).
						if (item.kind === 'agent' || item.kind === 'group') {
							const isGroup = item.kind === 'group';
							return (
								<button
									type="button"
									key={`${item.kind}-${item.value}-${idx}`}
									ref={(el) => (itemRefs.current[idx] = el)}
									className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 ${isSelected ? 'ring-1 ring-inset' : ''}`}
									style={rowStyle}
									onClick={() => acceptItem(item)}
									onMouseEnter={() => setSelectedIndex?.(idx)}
								>
									{isGroup ? (
										<Users
											className="w-3.5 h-3.5 flex-shrink-0"
											style={{ color: theme.colors.accent }}
										/>
									) : (
										<span className="w-4 flex-shrink-0 text-center leading-none">
											{getAgentIcon(item.toolType ?? '')}
										</span>
									)}
									<span className="flex-1 truncate font-medium">{item.displayText}</span>
									{!isGroup && item.toolType && (
										<span className="text-[10px] opacity-50 flex-shrink-0">
											{getAgentDisplayName(item.toolType)}
										</span>
									)}
									<span
										className="text-[9px] px-1 py-0.5 rounded flex-shrink-0 uppercase tracking-wide"
										style={{
											backgroundColor: isGroup
												? `${theme.colors.accent}30`
												: `${theme.colors.textDim}25`,
											color: isGroup ? theme.colors.accent : theme.colors.textDim,
										}}
									>
										{isGroup ? 'group' : 'agent'}
									</span>
								</button>
							);
						}

						// File or directory row (positive discriminant narrows to the
						// file-suggestion shape, exposing fullPath/source).
						if (item.kind === 'file' || item.kind === 'directory') {
							const IconComponent = item.kind === 'directory' ? Folder : File;
							return (
								<button
									type="button"
									key={`${item.kind}-${item.value}-${idx}`}
									ref={(el) => (itemRefs.current[idx] = el)}
									className={`w-full px-3 py-2 text-left text-sm font-mono flex items-center gap-2 ${isSelected ? 'ring-1 ring-inset' : ''}`}
									style={rowStyle}
									onClick={() => acceptItem(item)}
									onMouseEnter={() => setSelectedIndex?.(idx)}
								>
									<IconComponent
										className="w-3.5 h-3.5 flex-shrink-0"
										style={{
											color:
												item.kind === 'directory' ? theme.colors.warning : theme.colors.textDim,
										}}
									/>
									<span className="flex-1 truncate">{item.fullPath}</span>
									{item.source === 'autorun' && (
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
									<span className="text-[10px] opacity-40 flex-shrink-0">
										{item.kind === 'directory' ? 'folder' : 'file'}
									</span>
								</button>
							);
						}

						return null;
					})
				)}
			</div>
		</div>
	);
});
