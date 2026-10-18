/**
 * QuickChatPicker - the fuzzy list picker the Quick Chat window opens for the
 * agent (QuickChatAgentPicker) and for the tab a message goes to
 * (QuickChatTabPicker).
 *
 * Replaces a native <select>. A native popup menu is unreliable inside the
 * Quick Chat window (a transparent, non-activating macOS panel), offers no
 * filter, and is unusable past a few dozen rows. This is the HeadingPalette
 * shape instead: a fuzzy filter over the list, arrow keys to move, Enter to
 * pick, Escape to back out without picking.
 *
 * It renders INSIDE the window, just below the header that holds its trigger,
 * because the window is an OS window and nothing can be drawn outside it;
 * QuickChatRoot grows the window while a picker is open so a composer-only
 * window has room for it.
 *
 * With no query the list keeps the order it is given, so it reads as the rows
 * the user already knows. With a query it sorts best match first, because a
 * picker is used to land on ONE row.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { fuzzyMatchWithIndices, fuzzyMatchWithScore, renderFuzzyHighlight } from '../utils/search';
import { useListNavigation } from '../hooks/keyboard/useListNavigation';
import { useScrollIntoView } from '../hooks/ui/useScrollIntoView';
import { useElementHeight } from '../hooks/ui/useElementWidth';
import { useFocusOnMount } from '../hooks/utils/useFocusAfterRender';
import { EscCloseButton } from '../components/ui/EscCloseButton';
import type { Theme } from '../types';

export interface QuickChatPickerItem {
	id: string;
	/** Shown, matched, and highlighted. */
	name: string;
	/** Shown dim at the right of the row. */
	detail?: string;
	/** Also matched, never highlighted (an agent's group and provider). */
	extras?: (string | undefined)[];
}

export interface QuickChatPickerHit<T extends QuickChatPickerItem = QuickChatPickerItem> {
	item: T;
	nameIndices: Set<number>;
	score: number;
}

/**
 * Match one row against the query. The name is what gets highlighted; the
 * extras also count, so a group or provider narrows the list even when no row
 * is named after it. A name hit outranks an extra hit.
 */
export function matchQuickChatPickerItem<T extends QuickChatPickerItem>(
	item: T,
	query: string
): QuickChatPickerHit<T> | null {
	if (!query) return { item, nameIndices: new Set(), score: 0 };
	const byName = fuzzyMatchWithScore(item.name, query);
	if (byName.matches) {
		return {
			item,
			nameIndices: new Set(fuzzyMatchWithIndices(item.name, query)),
			score: byName.score + 1000,
		};
	}
	for (const extra of item.extras ?? []) {
		if (!extra) continue;
		const hit = fuzzyMatchWithScore(extra, query);
		if (hit.matches) return { item, nameIndices: new Set(), score: hit.score };
	}
	return null;
}

/** Filter and order the rows for a query (see the file header for the order rule). */
export function filterQuickChatPickerItems<T extends QuickChatPickerItem>(
	items: T[],
	query: string
): QuickChatPickerHit<T>[] {
	const hits = items
		.map((item) => matchQuickChatPickerItem(item, query))
		.filter((hit): hit is QuickChatPickerHit<T> => hit !== null);
	if (query) hits.sort((a, b) => b.score - a.score);
	return hits;
}

interface QuickChatPickerProps {
	theme: Theme;
	items: QuickChatPickerItem[];
	/** The row in effect now, checked and selected first. */
	currentId: string | null;
	onPick: (id: string) => void;
	/** Close without picking. */
	onClose: () => void;
	placeholder: string;
	/** What the rows are, for screen readers ("Agents", "Tabs"). */
	listLabel: string;
	/** Shown when there are no rows at all. */
	emptyText: string;
	/** Shown when the query matches no row. */
	noMatchText: (query: string) => string;
	/** `<prefix>-picker`, `<prefix>-filter`, `<prefix>-row`. */
	testIdPrefix: string;
}

export function QuickChatPicker({
	theme,
	items,
	currentId,
	onPick,
	onClose,
	placeholder,
	listLabel,
	emptyText,
	noMatchText,
	testIdPrefix,
}: QuickChatPickerProps) {
	const [query, setQuery] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);
	const c = theme.colors;

	useFocusOnMount(inputRef, 0);

	const filtered = useMemo(() => filterQuickChatPickerItems(items, query), [items, query]);

	const pick = (index: number) => {
		const hit = filtered[index];
		if (hit) onPick(hit.item.id);
	};

	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: filtered.length,
		onSelect: pick,
		initialIndex: Math.max(
			0,
			items.findIndex((item) => item.id === currentId)
		),
		enablePageNavigation: true,
		wrap: true,
	});

	const itemRefs = useScrollIntoView<HTMLButtonElement>(
		true,
		selectedIndex,
		filtered.length,
		'auto'
	);

	// The window grows to make room for the picker only AFTER it mounts, so the
	// first scroll to the selected row ran against a list one row tall and left
	// the rows above it (New tab, above the default Any tab) scrolled out of
	// view. Each time the list changes height, fit it again from the top: the
	// first rows show whenever the selected row fits under them.
	const listRef = useRef<HTMLDivElement>(null);
	const listHeight = useElementHeight(listRef);
	const selectedIndexRef = useRef(selectedIndex);
	selectedIndexRef.current = selectedIndex;
	useEffect(() => {
		const list = listRef.current;
		if (!list || listHeight === 0) return;
		list.scrollTop = 0;
		itemRefs.current[selectedIndexRef.current]?.scrollIntoView({ block: 'nearest' });
	}, [listHeight, itemRefs]);

	// Hover moves the selection only when the pointer really moves. The list
	// opens, and the window grows, under a pointer that is standing still, and
	// Chromium answers that with a mousemove at the same spot: taken at face
	// value it moved the selection off the row in effect (the checked one) to
	// whatever row happened to slide under the cursor.
	const lastPointer = useRef<{ x: number; y: number } | null>(null);
	const onRowMouseMove = (index: number, e: React.MouseEvent) => {
		const prev = lastPointer.current;
		lastPointer.current = { x: e.screenX, y: e.screenY };
		if (!prev || (prev.x === e.screenX && prev.y === e.screenY)) return;
		setSelectedIndex(index);
	};

	const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		// Every plain key typed here is the picker's. Escape especially: the
		// window's own Escape hides Quick Chat, and backing out of a picker must
		// not. Cmd/Ctrl chords (the one that closes the picker, Cmd+S, Cmd+P)
		// still reach the window, which ignores any chord it does not own.
		if (!(e.metaKey || e.ctrlKey)) e.stopPropagation();
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			pick(selectedIndex);
			return;
		}
		// Home/End belong to the text field while there is text to move through.
		if ((e.key === 'Home' || e.key === 'End') && query) return;
		handleKeyDown(e);
	};

	return (
		<div
			className="flex-1 min-h-0 mx-3 mb-2 rounded-2xl flex flex-col overflow-hidden"
			style={{ backgroundColor: c.bgSidebar, border: `1px solid ${c.border}` }}
			data-testid={`${testIdPrefix}-picker`}
		>
			<div
				className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0"
				style={{ borderColor: c.border }}
			>
				<input
					ref={inputRef}
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setSelectedIndex(0);
					}}
					onKeyDown={onInputKeyDown}
					placeholder={placeholder}
					aria-label={`Filter ${listLabel.toLowerCase()}`}
					spellCheck={false}
					className="flex-1 bg-transparent border-none outline-none text-sm"
					style={{ color: c.textMain }}
					data-testid={`${testIdPrefix}-filter`}
				/>
				<span className="text-xs shrink-0" style={{ color: c.textDim }}>
					{filtered.length} of {items.length}
				</span>
				<EscCloseButton onClose={onClose} theme={theme} />
			</div>
			<div
				ref={listRef}
				className="overflow-y-auto flex-1 min-h-0 py-1"
				style={{ overscrollBehavior: 'contain' }}
				role="listbox"
				aria-label={listLabel}
			>
				{filtered.length === 0 ? (
					<div className="px-3 py-6 text-center text-sm" style={{ color: c.textDim }}>
						{items.length === 0 ? emptyText : noMatchText(query)}
					</div>
				) : (
					filtered.map(({ item, nameIndices }, index) => {
						const isSelected = index === selectedIndex;
						const isCurrent = item.id === currentId;
						const { detail } = item;
						return (
							<button
								key={item.id}
								ref={(el) => {
									itemRefs.current[index] = el;
								}}
								type="button"
								role="option"
								aria-selected={isSelected}
								data-testid={`${testIdPrefix}-row`}
								onMouseMove={(e) => onRowMouseMove(index, e)}
								onClick={() => pick(index)}
								className="w-full px-3 py-1.5 text-left flex items-center gap-2 focus:outline-none"
								style={{
									backgroundColor: isSelected ? `${c.accent}25` : undefined,
									boxShadow: isSelected ? `inset 2px 0 0 ${c.accent}` : undefined,
								}}
								title={detail ? `${item.name} (${detail})` : item.name}
							>
								<span className="w-4 shrink-0 flex justify-center">
									{isCurrent && <Check className="w-3.5 h-3.5" style={{ color: c.accent }} />}
								</span>
								<span className="truncate text-sm" style={{ color: c.textMain }}>
									{renderFuzzyHighlight(item.name, nameIndices, {
										match: { fontWeight: 700, color: c.accent },
										rest: {},
									})}
								</span>
								{detail && (
									<span
										className="ml-auto pl-3 shrink-0 text-xs truncate"
										style={{ color: c.textDim }}
									>
										{detail}
									</span>
								)}
							</button>
						);
					})
				)}
			</div>
		</div>
	);
}
