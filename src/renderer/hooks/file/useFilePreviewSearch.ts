import { useState, useRef, useEffect, useCallback, useMemo, RefObject } from 'react';
import type {
	SearchHit,
	FilePreviewSearchAdapter,
} from '../../components/FilePreview/search/types';
import type { MarkdownEditorHandle } from '../../components/FilePreview/markdownEditor';
import {
	type SearchKind,
	SEARCH_KIND_CYCLE,
	compileSearchRegex,
	parseLineQuery,
} from '../../components/FilePreview/search/queryMatch';
import { domScrollToLine } from '../../components/FilePreview/lineSync';
import { escapeRegExp } from '../../../shared/stringUtils';

/** Maximum search query length to prevent expensive regex operations */
const MAX_SEARCH_QUERY_LENGTH = 200;

// Re-export so existing consumers that import the adapter type from this hook
// keep working. New code should import from
// `components/FilePreview/search/types` directly.
export type { SearchHit, FilePreviewSearchAdapter };

// ─── DOM walk + CSS Highlight helpers (used by count/navigate effects) ───────
//
// Kept module-private and pure(-ish) so they can be exercised end-to-end via
// hook tests without leaking to other components. Both Highlight registrations
// use stable names (`search-results` / `search-current`) so prose CSS can style
// them per-tier (see `markdownFast/proseStyles.ts`, `textFast/proseStyles.ts`).

/**
 * Class names whose subtree the search walker MUST skip - these are
 * preview-chrome containers (line-number gutters, etc.) that aren't user
 * content. Highlighting "42" against a line-number "42" would be a false
 * positive both visually and (in the Rich tier fallback) numerically.
 */
const SEARCH_EXCLUDED_CLASSES = ['text-fast-gutter', 'cm-gutters'];

function isInsideExcludedContainer(node: Node): boolean {
	let el = node.parentElement;
	while (el) {
		for (const cls of SEARCH_EXCLUDED_CLASSES) {
			if (el.classList.contains(cls)) return true;
		}
		el = el.parentElement;
	}
	return false;
}

// `pattern` is a ready-to-compile regex source (literal queries are pre-escaped
// by the caller, regex-mode queries are passed through verbatim and validated
// before reaching here).
function walkContainerForRanges(container: HTMLElement, pattern: string): Range[] {
	if (!pattern) return [];
	const ranges: Range[] = [];
	const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			return isInsideExcludedContainer(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
		},
	});
	let textNode: Node | null;
	while ((textNode = walker.nextNode())) {
		const text = (textNode as Text).textContent || '';
		if (!text) continue;
		const re = new RegExp(pattern, 'gi');
		let match: RegExpExecArray | null;
		while ((match = re.exec(text)) !== null) {
			const range = document.createRange();
			range.setStart(textNode, match.index);
			range.setEnd(textNode, match.index + match[0].length);
			ranges.push(range);
			// Guard against zero-length matches infinite-looping.
			if (match.index === re.lastIndex) re.lastIndex++;
		}
	}
	return ranges;
}

function hasHighlightApi(): boolean {
	// Guarded against CSS itself being undefined - happens in jsdom tests that
	// tear down globals between cases and means the React cleanup pass can
	// fire after teardown.
	return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

function applyAllHighlight(ranges: Range[]): void {
	if (!hasHighlightApi()) return;
	if (ranges.length > 0) {
		(CSS as any).highlights.set('search-results', new (window as any).Highlight(...ranges));
	} else {
		(CSS as any).highlights.delete('search-results');
	}
}

function applyCurrentHighlight(range: Range | null): void {
	if (!hasHighlightApi()) return;
	if (range) {
		(CSS as any).highlights.set('search-current', new (window as any).Highlight(range));
	} else {
		(CSS as any).highlights.delete('search-current');
	}
}

function clearTextHighlights(): void {
	if (!hasHighlightApi()) return;
	(CSS as any).highlights.delete('search-results');
	(CSS as any).highlights.delete('search-current');
}

export interface UseFilePreviewSearchParams {
	codeContainerRef: RefObject<HTMLDivElement | null>;
	markdownContainerRef: RefObject<HTMLDivElement | null>;
	contentRef: RefObject<HTMLDivElement | null>;
	/** Imperative handle for the CM6-based edit editor. Drives match decorations and selection. */
	editorRef: RefObject<MarkdownEditorHandle | null>;
	isMarkdown: boolean;
	/** Readable-text previews (plain prose files like .txt) share the markdown search path. */
	isReadableText?: boolean;
	isImage: boolean;
	isCsv: boolean;
	isJsonl: boolean;
	isJson: boolean;
	isEditableText: boolean;
	markdownEditMode: boolean;
	editContent: string;
	fileContent: string | undefined;
	accentColor: string;
	/** When in 'jq' mode, skip DOM-based highlighting (jq filtering is handled externally) */
	searchMode: 'text' | 'jq';
	/**
	 * Whether the active view shows line numbers (code/text/edit tiers). Gates
	 * whether the 'regex'/'line' search kinds are usable; markdown/CSV/jq views
	 * fall back to plain 'text' search regardless of the chip state.
	 */
	supportsLineSearch?: boolean;
	/** Length of actually displayed content (may differ from fileContent when truncated) */
	displayedContentLength?: number;
	initialSearchQuery?: string;
	onSearchQueryChange?: (query: string) => void;
	/** Optional pluggable search source for tiers where DOM walking undercounts (Fast tier). */
	searchAdapter?: FilePreviewSearchAdapter;
}

export interface UseFilePreviewSearchReturn {
	searchQuery: string;
	setSearchQuery: (query: string) => void;
	searchOpen: boolean;
	setSearchOpen: (open: boolean) => void;
	currentMatchIndex: number;
	totalMatches: number;
	goToNextMatch: () => void;
	goToPrevMatch: () => void;
	searchInputRef: RefObject<HTMLInputElement>;
	/** Update match count from external source (e.g. CsvTableRenderer) */
	setMatchCount: (count: number) => void;
	/** Active search kind: literal text, regex, or jump-to-line. */
	searchKind: SearchKind;
	/** Set the search kind directly (e.g. reset to 'text' on close). */
	setSearchKind: (kind: SearchKind) => void;
	/** Advance to the next search kind (text → regex → line → text). */
	cycleSearchKind: () => void;
	/** Message for an invalid regex pattern in 'regex' mode, else null. */
	regexError: string | null;
}

export function useFilePreviewSearch({
	codeContainerRef,
	markdownContainerRef,
	contentRef,
	editorRef,
	isMarkdown,
	isReadableText = false,
	isImage,
	isCsv,
	isJsonl,
	isJson,
	isEditableText,
	markdownEditMode,
	editContent,
	fileContent,
	accentColor,
	searchMode,
	supportsLineSearch = false,
	displayedContentLength,
	initialSearchQuery,
	onSearchQueryChange,
	searchAdapter,
}: UseFilePreviewSearchParams): UseFilePreviewSearchReturn {
	// Search state - use initialSearchQuery if provided, and notify parent of changes
	const [internalSearchQuery, setInternalSearchQuery] = useState(
		(initialSearchQuery ?? '').slice(0, MAX_SEARCH_QUERY_LENGTH)
	);
	// Wrapper to update state and notify parent
	const setSearchQuery = useCallback(
		(query: string) => {
			const capped =
				query.length > MAX_SEARCH_QUERY_LENGTH ? query.slice(0, MAX_SEARCH_QUERY_LENGTH) : query;
			setInternalSearchQuery(capped);
			onSearchQueryChange?.(capped);
		},
		[onSearchQueryChange]
	);
	// Expose the current search query value
	const searchQuery = internalSearchQuery;
	// If initialSearchQuery is provided and non-empty, auto-open search
	const [searchOpen, setSearchOpen] = useState(Boolean(initialSearchQuery));
	const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
	const [totalMatches, setTotalMatches] = useState(0);
	// Search kind toggled by the chip left of the input. Only meaningful for
	// line-numbered views; collapses to plain 'text' elsewhere.
	const [searchKind, setSearchKindState] = useState<SearchKind>('text');

	const setSearchKind = useCallback((kind: SearchKind) => {
		setSearchKindState(kind);
	}, []);

	const cycleSearchKind = useCallback(() => {
		setSearchKindState((prev) => {
			const i = SEARCH_KIND_CYCLE.indexOf(prev);
			return SEARCH_KIND_CYCLE[(i + 1) % SEARCH_KIND_CYCLE.length];
		});
	}, []);

	// When the view can't support regex/line search (markdown, CSV, jq), force
	// the kind back to plain text so the effects below behave consistently.
	const effectiveKind: SearchKind = supportsLineSearch ? searchKind : 'text';
	const isLineMode = effectiveKind === 'line';
	const useRegex = effectiveKind === 'regex';

	// Reset the chip to plain text whenever the bar closes; a fresh open should
	// never inherit a stale regex/line mode.
	useEffect(() => {
		if (!searchOpen) setSearchKindState('text');
	}, [searchOpen]);

	// Snap back to text when the view stops supporting line search (e.g. toggling
	// from the code editor to a rendered markdown preview while the bar is open).
	useEffect(() => {
		if (!supportsLineSearch && searchKind !== 'text') setSearchKindState('text');
	}, [supportsLineSearch, searchKind]);

	// Final regex source fed to every tier. Literal queries are escaped; regex
	// queries pass through once validated. Null when empty or (in regex mode)
	// the pattern can't compile, which effects treat as "no matches".
	const searchPattern = useMemo<string | null>(() => {
		if (!searchQuery || isLineMode) return null;
		if (!useRegex) return escapeRegExp(searchQuery);
		return compileSearchRegex(searchQuery, { regex: true }).regex ? searchQuery : null;
	}, [searchQuery, useRegex, isLineMode]);

	const regexError = useMemo<string | null>(() => {
		if (!useRegex || !searchQuery) return null;
		return compileSearchRegex(searchQuery, { regex: true }).error;
	}, [useRegex, searchQuery]);

	const matchElementsRef = useRef<HTMLElement[]>([]);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const prevSearchQueryRef = useRef<string>('');
	const prevMatchIndexRef = useRef<number>(0);

	// Keep search input focused when search is open
	useEffect(() => {
		if (searchOpen && searchInputRef.current) {
			searchInputRef.current.focus();
		}
	}, [searchOpen, searchQuery]);

	// In jq mode, text-based highlighting is disabled - jq filtering is handled by JsonlViewer
	const isJqMode = searchMode === 'jq';

	// Highlight search matches in syntax-highlighted code
	useEffect(() => {
		if (
			isLineMode ||
			!searchPattern ||
			!searchQuery.trim() ||
			!codeContainerRef.current ||
			isMarkdown ||
			isReadableText ||
			isImage ||
			isCsv ||
			isJsonl ||
			(isJson && isJqMode) ||
			// Fast tier provides its own adapter - defer counting + scroll to
			// the markdown/readable-text CSS-Highlight effect below, which has
			// been widened to handle code Fast tier when an adapter is present.
			searchAdapter
		) {
			setTotalMatches(0);
			setCurrentMatchIndex(-1);
			matchElementsRef.current = [];
			return;
		}

		const container = codeContainerRef.current;
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];

		// Collect all text nodes
		let node;
		while ((node = walker.nextNode())) {
			textNodes.push(node as Text);
		}

		const regex = new RegExp(searchPattern, 'gi');
		const matchElements: HTMLElement[] = [];

		// Highlight matches using safe DOM methods
		textNodes.forEach((textNode) => {
			const text = textNode.textContent || '';
			const matches = text.match(regex);

			if (matches) {
				const fragment = document.createDocumentFragment();
				let lastIndex = 0;

				text.replace(regex, (match, offset) => {
					// Add text before match
					if (offset > lastIndex) {
						fragment.appendChild(document.createTextNode(text.substring(lastIndex, offset)));
					}

					// Add highlighted match
					const mark = document.createElement('mark');
					mark.style.backgroundColor = '#ffd700';
					mark.style.color = '#000';
					mark.style.padding = '0 2px';
					mark.style.borderRadius = '2px';
					mark.className = 'search-match';
					mark.textContent = match;
					fragment.appendChild(mark);
					matchElements.push(mark);

					lastIndex = offset + match.length;
					return match;
				});

				// Add remaining text
				if (lastIndex < text.length) {
					fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
				}

				textNode.parentNode?.replaceChild(fragment, textNode);
			}
		});

		// Store match elements and update count
		matchElementsRef.current = matchElements;
		setTotalMatches(matchElements.length);
		setCurrentMatchIndex(matchElements.length > 0 ? 0 : -1);

		// Highlight first match with different color and scroll to it
		if (matchElements.length > 0) {
			matchElements[0].style.backgroundColor = accentColor;
			matchElements[0].style.color = '#fff';
			matchElements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
		}

		// Cleanup function to remove highlights
		return () => {
			container.querySelectorAll('mark.search-match').forEach((mark) => {
				const parent = mark.parentNode;
				if (parent) {
					parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
					parent.normalize();
				}
			});
			matchElementsRef.current = [];
		};
	}, [
		searchQuery,
		searchPattern,
		isLineMode,
		fileContent,
		displayedContentLength,
		isMarkdown,
		isReadableText,
		isImage,
		isCsv,
		isJsonl,
		isJson,
		isJqMode,
		accentColor,
		// The early-return guard reads `searchAdapter` to defer to the Fast/Giant
		// tier's own search; include it in deps so flipping the tier chip
		// re-runs the effect with the fresh adapter state.
		searchAdapter,
	]);

	// Search matches in markdown / readable-text / Fast-tier preview.
	//
	// Why two effects (count + navigate):
	//   The earlier single-effect implementation listed `currentMatchIndex` in
	//   its deps. That made every prev/next button press re-run `findHits` AND
	//   re-walk the DOM - under heavy virtualization the resulting hit count
	//   could flicker between renders ("wobble"). Splitting into:
	//     1. countEffect - runs ONCE per query/content/adapter/mode change.
	//        Calls findHits, walks DOM, sets totalMatches, resets currentMatchIndex.
	//     2. navigateEffect - runs ONLY when currentMatchIndex or totalMatches
	//        changes. Reads precomputed hits / ranges from refs and dispatches
	//        scroll + current-highlight swap. NEVER calls findHits.
	//   …guarantees count stability across navigation while still updating
	//   highlights as virtuoso mounts new blocks (the navigate effect re-walks
	//   the DOM cheaply inside a rAF to refresh visible-range highlights).

	const hitsRef = useRef<SearchHit[] | null>(null);
	const rangesRef = useRef<Range[]>([]);

	useEffect(() => {
		const adapterActive = Boolean(searchAdapter);
		const isTextLike = isMarkdown || isReadableText || adapterActive;
		if (
			!isTextLike ||
			markdownEditMode ||
			isLineMode ||
			!searchPattern ||
			!searchQuery.trim() ||
			!markdownContainerRef.current
		) {
			if (isTextLike && !markdownEditMode) {
				setTotalMatches(0);
				setCurrentMatchIndex(-1);
				hitsRef.current = null;
				rangesRef.current = [];
				matchElementsRef.current = [];
				clearTextHighlights();
			}
			return;
		}

		const container = markdownContainerRef.current;

		// Adapter is the authoritative source for Fast/Giant tiers. Called
		// exactly once per query change (the whole point of splitting effects).
		// Runs regardless of CSS Highlight API support so the count + navigate
		// path stays correct even on the rare browser that lacks the API; the
		// applyAllHighlight/applyCurrentHighlight helpers below are no-ops in
		// that case.
		const adapterHits = searchAdapter
			? searchAdapter.findHits(searchQuery, { regex: useRegex })
			: null;
		const ranges = walkContainerForRanges(container, searchPattern);
		hitsRef.current = adapterHits;
		rangesRef.current = ranges;

		const totalCount = adapterHits ? adapterHits.length : ranges.length;
		setTotalMatches(totalCount);
		// New count → always reset to first match (or -1 when empty). This is
		// what the navigate effect will scroll to on its next run.
		setCurrentMatchIndex(totalCount > 0 ? 0 : -1);

		// Paint the all-matches highlight immediately. The current-match
		// highlight is owned by the navigate effect.
		applyAllHighlight(ranges);

		return () => {
			clearTextHighlights();
		};
	}, [
		searchQuery,
		searchPattern,
		isLineMode,
		useRegex,
		fileContent,
		isMarkdown,
		isReadableText,
		markdownEditMode,
		searchAdapter,
		markdownContainerRef,
	]);

	// Navigate effect: react to currentMatchIndex / totalMatches changes
	// (count change clears + repaints; nav swaps the current highlight). Never
	// re-runs findHits - that's the count effect's job.
	useEffect(() => {
		const adapterActive = Boolean(searchAdapter);
		const isTextLike = isMarkdown || isReadableText || adapterActive;
		if (
			!isTextLike ||
			markdownEditMode ||
			!markdownContainerRef.current ||
			currentMatchIndex < 0 ||
			totalMatches === 0
		) {
			return;
		}

		const container = markdownContainerRef.current;
		const hits = hitsRef.current;
		const pattern = searchPattern ?? '';

		if (hits && searchAdapter) {
			// Out-of-range guard. When a new query reduces the hit count, the
			// count effect dispatches setCurrentMatchIndex(0) AND updates
			// hitsRef in the same effect-pass. But React fires both effects of
			// the SAME render before committing the new state, so this navigate
			// effect can read the previous render's currentMatchIndex (e.g. 51)
			// while hitsRef already holds the new shorter array (e.g. 5 hits).
			// `hits[51]` is undefined → scrollToMatch would crash with
			// "Cannot read properties of undefined (reading 'blockIndex')".
			// Clamp and skip when out of range; the next render committed by
			// the count effect's setState will re-fire navigate at the correct
			// index.
			const safeIdx = Math.min(currentMatchIndex, hits.length - 1);
			if (safeIdx < 0 || !hits[safeIdx]) return;
			// Fast/Giant: tell the tier to scroll its virtualizer. After the
			// next paint, re-walk the DOM (cheap - only mounted text nodes) and
			// refresh both Highlight registrations so the user sees up-to-date
			// highlights in the newly-mounted block.
			searchAdapter.scrollToMatch(hits[safeIdx]);
			const raf = requestAnimationFrame(() => {
				if (!markdownContainerRef.current) return;
				const ranges = walkContainerForRanges(markdownContainerRef.current, pattern);
				rangesRef.current = ranges;
				applyAllHighlight(ranges);
				// First visible range after scrollToMatch is the most likely
				// match-of-interest; precise word-level current highlighting is
				// B2/B3's job (tier scroll-to-offset helpers).
				applyCurrentHighlight(ranges[0] ?? null);
			});
			return () => cancelAnimationFrame(raf);
		}

		// Rich tier: ranges array has every DOM match (no virtualization). Swap
		// the current-highlight to ranges[currentMatchIndex] and scroll.
		const ranges = rangesRef.current;
		const targetRange = ranges[Math.min(currentMatchIndex, ranges.length - 1)] ?? null;
		applyCurrentHighlight(targetRange);
		// jsdom's Range lacks getBoundingClientRect - guard the scroll path so
		// tests don't crash. Real browsers always have it.
		if (targetRange && typeof targetRange.getBoundingClientRect === 'function') {
			const rect = targetRange.getBoundingClientRect();
			const scrollParent = contentRef.current;
			if (scrollParent && rect) {
				const scrollContainerRect = scrollParent.getBoundingClientRect();
				const matchOffsetInScrollContainer =
					rect.top - scrollContainerRect.top + scrollParent.scrollTop;
				const scrollTop =
					matchOffsetInScrollContainer - scrollParent.clientHeight / 2 + rect.height / 2;
				scrollParent.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
			}
		} else if (!hasHighlightApi() && ranges.length === 0) {
			// Old-browser fallback path (count from raw string, no DOM ranges):
			// walk the DOM for the Nth match and scroll its parent into view.
			const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
			const searchRegex = new RegExp(pattern, 'gi');
			let matchCount = 0;
			let textNode: Node | null;
			while ((textNode = walker.nextNode())) {
				const text = (textNode as Text).textContent || '';
				const nodeMatches = text.match(searchRegex);
				if (nodeMatches) {
					for (let i = 0; i < nodeMatches.length; i++) {
						if (matchCount === currentMatchIndex) {
							const parentElement = (textNode as Text).parentElement;
							parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
							return;
						}
						matchCount++;
					}
				}
			}
		}
	}, [
		currentMatchIndex,
		totalMatches,
		isMarkdown,
		isReadableText,
		markdownEditMode,
		searchAdapter,
		searchQuery,
		searchPattern,
		markdownContainerRef,
		contentRef,
	]);

	// Handle search in edit mode - count matches, push CM6 decorations, and
	// reveal the active match. Counting and decoration painting are owned
	// here; the CodeMirror editor renders the highlight via its decoration
	// pipeline (no DOM walking, no CSS Custom Highlight overlay).
	useEffect(() => {
		const editor = editorRef.current;
		const clearEditDecos = () => {
			editor?.setSearchMatches([], -1);
		};

		if (
			!isEditableText ||
			!markdownEditMode ||
			isLineMode ||
			!searchPattern ||
			!searchQuery.trim() ||
			!editor
		) {
			if (isEditableText && markdownEditMode) {
				setTotalMatches(0);
				setCurrentMatchIndex(-1);
				clearEditDecos();
			}
			return;
		}

		const content = editContent;
		const regex = new RegExp(searchPattern, 'gi');

		const matches: { from: number; to: number }[] = [];
		let matchResult;
		while ((matchResult = regex.exec(content)) !== null) {
			matches.push({ from: matchResult.index, to: matchResult.index + matchResult[0].length });
			// Guard against zero-length matches infinite-looping.
			if (matchResult.index === regex.lastIndex) regex.lastIndex++;
		}

		setTotalMatches(matches.length);
		if (matches.length === 0) {
			setCurrentMatchIndex(-1);
			clearEditDecos();
			return;
		}

		// Initialize from -1 when new matches appear, or clamp if index exceeds count
		const validIndex = currentMatchIndex < 0 ? 0 : Math.min(currentMatchIndex, matches.length - 1);
		if (validIndex !== currentMatchIndex) {
			setCurrentMatchIndex(validIndex);
			return;
		}

		// Push the match decorations into the editor - paints all matches and
		// emphasizes the active one. Re-runs on every dep change so typing into
		// the query updates highlights in real time.
		editor.setSearchMatches(matches, validIndex);

		// Reveal the active match only when navigating (Enter / Shift+Enter).
		// We detect navigation by an unchanged query with a changed index - that
		// way typing doesn't yank scroll position or focus.
		const isNavigating =
			prevSearchQueryRef.current === searchQuery && prevMatchIndexRef.current !== currentMatchIndex;
		prevSearchQueryRef.current = searchQuery;
		prevMatchIndexRef.current = currentMatchIndex;

		if (isNavigating) {
			const currentMatch = matches[validIndex];
			if (currentMatch) {
				editor.setSelection(currentMatch.from, currentMatch.to, true);
				// Return focus to the search input so the user can keep typing /
				// navigating without the caret jumping into the editor.
				searchInputRef.current?.focus();
			}
		}

		return () => {
			clearEditDecos();
		};
	}, [
		searchQuery,
		searchPattern,
		isLineMode,
		currentMatchIndex,
		isEditableText,
		markdownEditMode,
		editContent,
		editorRef,
	]);

	// Line-number search: parse the query as a 1-based line and jump the active
	// tier's viewport there. Lives in its own effect so typing a number scrolls
	// live (no Enter needed) and so the text-match effects above can early-return
	// in line mode without entangling their highlight bookkeeping.
	useEffect(() => {
		if (!isLineMode) return;
		const line = parseLineQuery(searchQuery);
		if (line == null) return;

		// Edit mode (CM6): select + reveal the line.
		if (isEditableText && markdownEditMode && editorRef.current) {
			editorRef.current.scrollToLine(line, { select: true });
			return;
		}

		// Fast / Giant tiers expose a line-aware scroll on the adapter.
		if (searchAdapter?.scrollToLine) {
			searchAdapter.scrollToLine(line);
			return;
		}

		// Rich tier renders the full source (with a line-number gutter) as DOM.
		const codeContainer = codeContainerRef.current;
		if (!codeContainer) return;
		const gutter = codeContainer.querySelectorAll<HTMLElement>(
			'.react-syntax-highlighter-line-number'
		);
		const target = gutter[line - 1];
		if (target) {
			target.scrollIntoView({ behavior: 'smooth', block: 'center' });
			return;
		}
		// Fallback for renderers without numbered gutter spans: map the line to a
		// text offset and scroll its row to the top.
		if (contentRef.current && fileContent) {
			domScrollToLine(contentRef.current, codeContainer, fileContent, line);
		}
	}, [
		isLineMode,
		searchQuery,
		isEditableText,
		markdownEditMode,
		editorRef,
		searchAdapter,
		codeContainerRef,
		contentRef,
		fileContent,
	]);

	// Navigate to next search match
	const goToNextMatch = useCallback(() => {
		if (totalMatches === 0) return;

		// Move to next match (wrap around)
		const nextIndex = (currentMatchIndex + 1) % totalMatches;
		setCurrentMatchIndex(nextIndex);

		// For code files, handle DOM-based highlighting
		const matches = matchElementsRef.current;
		if (matches.length > 0) {
			// Reset previous highlight
			if (matches[currentMatchIndex]) {
				matches[currentMatchIndex].style.backgroundColor = '#ffd700';
				matches[currentMatchIndex].style.color = '#000';
			}
			// Highlight new current match and scroll to it
			if (matches[nextIndex]) {
				matches[nextIndex].style.backgroundColor = accentColor;
				matches[nextIndex].style.color = '#fff';
				matches[nextIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		}
		// For markdown edit mode, the effect will handle selecting text
	}, [totalMatches, currentMatchIndex, accentColor]);

	// Navigate to previous search match
	const goToPrevMatch = useCallback(() => {
		if (totalMatches === 0) return;

		// Move to previous match (wrap around); treat -1 as "before first" → go to last
		const base = currentMatchIndex < 0 ? totalMatches : currentMatchIndex;
		const prevIndex = (base - 1 + totalMatches) % totalMatches;
		setCurrentMatchIndex(prevIndex);

		// For code files, handle DOM-based highlighting
		const matches = matchElementsRef.current;
		if (matches.length > 0) {
			// Reset previous highlight
			if (matches[currentMatchIndex]) {
				matches[currentMatchIndex].style.backgroundColor = '#ffd700';
				matches[currentMatchIndex].style.color = '#000';
			}
			// Highlight new current match and scroll to it
			if (matches[prevIndex]) {
				matches[prevIndex].style.backgroundColor = accentColor;
				matches[prevIndex].style.color = '#fff';
				matches[prevIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		}
		// For markdown edit mode, the effect will handle selecting text
	}, [totalMatches, currentMatchIndex, accentColor]);

	const setMatchCount = useCallback((count: number) => {
		setTotalMatches(count);
		setCurrentMatchIndex(count > 0 ? 0 : -1);
	}, []);

	return {
		searchQuery,
		setSearchQuery,
		searchOpen,
		setSearchOpen,
		currentMatchIndex,
		totalMatches,
		goToNextMatch,
		goToPrevMatch,
		searchInputRef,
		setMatchCount,
		searchKind: effectiveKind,
		setSearchKind,
		cycleSearchKind,
		regexError,
	};
}
