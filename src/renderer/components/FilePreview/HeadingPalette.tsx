/**
 * HeadingPalette - a Cmd+K style jump list over a markdown document's headings.
 *
 * Opened with a bare `#` while reading a markdown preview. It is the same list
 * the Table of Contents overlay shows, in the same document order, with a fuzzy
 * filter on top: type a few characters of a section name, press Enter, land
 * there. Long documents (the archives this was built for run to hundreds of
 * headings) are what make the filter worth having - scanning a 55-entry ToC by
 * eye is slower than typing three letters.
 *
 * Entries stay in DOCUMENT order rather than re-sorting by match score. The list
 * doubles as a map of the file, and a map that reshuffles under you stops being
 * one.
 */

import React, { useMemo, useRef, useState } from 'react';
import { Hash } from 'lucide-react';
import type { TocEntry } from './types';
import { headingLevelColor } from './shared/headings';
import {
	fuzzyMatchWithIndices,
	fuzzyMatchWithScore,
	renderFuzzyHighlight,
} from '../../utils/search';
import { useListNavigation } from '../../hooks/keyboard/useListNavigation';
import { useScrollIntoView } from '../../hooks/ui/useScrollIntoView';
import { useFocusOnMount } from '../../hooks/utils/useFocusAfterRender';
import { EscCloseButton } from '../ui/EscCloseButton';

interface HeadingPaletteProps {
	theme: any;
	/** Every heading in the document, in the order it appears. */
	entries: TocEntry[];
	/** Jump to a heading. Behavior is the caller's to decide. */
	onJump: (entry: TocEntry, behavior: ScrollBehavior) => void;
	/** Close the palette and hand focus back to the preview. */
	onClose: () => void;
}

/** One heading plus the character positions the query matched. */
interface FilteredHeading {
	entry: TocEntry;
	matchIndices: Set<number>;
}

export const HeadingPalette = React.memo(function HeadingPalette({
	theme,
	entries,
	onJump,
	onClose,
}: HeadingPaletteProps) {
	const [query, setQuery] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);

	useFocusOnMount(inputRef, 0);

	const filtered = useMemo<FilteredHeading[]>(() => {
		if (!query) return entries.map((entry) => ({ entry, matchIndices: new Set<number>() }));
		const results: FilteredHeading[] = [];
		for (const entry of entries) {
			// Score decides membership only; order stays as authored.
			if (!fuzzyMatchWithScore(entry.text, query).matches) continue;
			results.push({
				entry,
				matchIndices: new Set(fuzzyMatchWithIndices(entry.text, query)),
			});
		}
		return results;
	}, [entries, query]);

	const jumpTo = (index: number) => {
		const hit = filtered[index];
		if (!hit) return;
		onJump(hit.entry, 'smooth');
		onClose();
	};

	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: filtered.length,
		onSelect: jumpTo,
		enablePageNavigation: true,
		wrap: true,
	});

	const itemRefs = useScrollIntoView<HTMLButtonElement>(
		true,
		selectedIndex,
		filtered.length,
		'auto'
	);

	const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		// Everything typed here belongs to the palette. Without this the preview
		// container underneath also sees the key and scrolls the document, and a
		// bare `-` or `0` would zoom the pane out from under the search box.
		e.stopPropagation();
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			jumpTo(selectedIndex);
			return;
		}
		// Home/End belong to the text field while there is text to move through.
		if ((e.key === 'Home' || e.key === 'End') && query) return;
		handleKeyDown(e);
	};

	return (
		<div
			className="absolute inset-0 z-30 flex justify-center pt-[12vh] px-4 select-none"
			style={{ backgroundColor: 'rgba(0, 0, 0, 0.45)' }}
			onMouseDown={(e) => {
				// Backdrop only - a mousedown that started on the panel must not close it.
				if (e.target === e.currentTarget) onClose();
			}}
			onWheel={(e) => e.stopPropagation()}
		>
			<div
				className="w-full max-w-xl max-h-[70%] rounded-lg shadow-2xl overflow-hidden flex flex-col animate-in fade-in slide-in-from-top-2 duration-150"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				{/* Query row */}
				<div
					className="flex items-center gap-2 px-3 py-2.5 border-b flex-shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<Hash className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.accent }} />
					<input
						ref={inputRef}
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setSelectedIndex(0);
						}}
						onKeyDown={onInputKeyDown}
						placeholder="Jump to heading..."
						spellCheck={false}
						className="flex-1 bg-transparent border-none outline-none text-sm"
						style={{ color: theme.colors.textMain }}
						data-testid="heading-palette-input"
					/>
					<span className="text-2xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
						{filtered.length} of {entries.length}
					</span>
					<EscCloseButton onClose={onClose} theme={theme} />
				</div>

				{/* Results */}
				<div
					className="overflow-y-auto flex-1 min-h-0 py-1"
					style={{ overscrollBehavior: 'contain' }}
				>
					{filtered.length === 0 ? (
						<div className="px-3 py-6 text-center text-sm" style={{ color: theme.colors.textDim }}>
							No heading matches "{query}"
						</div>
					) : (
						filtered.map(({ entry, matchIndices }, index) => {
							const isSelected = index === selectedIndex;
							return (
								<button
									key={`${entry.slug}-${index}`}
									ref={(el) => {
										itemRefs.current[index] = el;
									}}
									type="button"
									data-testid="heading-palette-row"
									onMouseMove={() => setSelectedIndex(index)}
									onClick={() => jumpTo(index)}
									className="w-full px-3 py-1.5 text-left flex items-baseline gap-2 focus:outline-none"
									style={{
										color: headingLevelColor(theme, entry.level),
										// Indent by level so the list reads as an outline, exactly
										// like the ToC overlay it mirrors.
										paddingLeft: `${(entry.level - 1) * 12 + 12}px`,
										fontSize:
											entry.level === 1 ? '0.875rem' : entry.level === 2 ? '0.8125rem' : '0.75rem',
										opacity: entry.level > 3 ? 0.85 : 1,
										backgroundColor: isSelected ? `${theme.colors.accent}25` : undefined,
										boxShadow: isSelected ? `inset 2px 0 0 ${theme.colors.accent}` : undefined,
									}}
									title={entry.text}
								>
									<span
										className="text-2xs flex-shrink-0 font-mono"
										style={{ color: theme.colors.textDim }}
									>
										{'#'.repeat(entry.level)}
									</span>
									<span className="truncate">
										{renderFuzzyHighlight(entry.text, matchIndices, {
											match: { fontWeight: 700, color: theme.colors.accent },
											rest: {},
										})}
									</span>
								</button>
							);
						})
					)}
				</div>

				{/* Hints */}
				<div
					className="px-3 py-1.5 border-t flex items-center gap-3 text-2xs flex-shrink-0"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					<span>Up/Down to move</span>
					<span>Enter to jump</span>
					<span>PgUp/PgDn to skip</span>
				</div>
			</div>
		</div>
	);
});
