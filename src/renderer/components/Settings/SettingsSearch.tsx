/**
 * SettingsSearch - Cross-tab search for the Settings modal
 *
 * Two components:
 *   SettingsSearchInput - the search bar (always visible in the header)
 *   SettingsSearchResults - the results (shown when search is active, fills remaining space)
 *
 * A search is a filtered view of Settings. Every matched section appears once,
 * already open, showing only the controls that matched (`settingsSearchView`);
 * "Show all" lifts the filter for that section. A match with nothing to change
 * in place (the theme picker, the shortcut list, a feature that is off) is a
 * row that opens its tab.
 *
 * Sections mount as they near the viewport: a broad query can match most of
 * Settings, and some sections ask the main process for state when they mount.
 *
 * Keyboard: Cmd+F focuses the input; Escape clears or blurs it. Enter in the
 * input opens the top result's tab. ArrowDown moves into the results, where
 * Tab walks the controls. Escape on a tab row returns to the input; inside a
 * section it is left to the section's own controls.
 */

import React, {
	useState,
	useRef,
	useEffect,
	useLayoutEffect,
	useCallback,
	useMemo,
	type RefObject,
} from 'react';
import { ChevronRight, CornerDownLeft, Search, X } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { SkeletonBox } from '../ui/SkeletonBox';
import type { Theme } from '../../types';
import {
	searchSettings,
	MIN_SUBSTRING_QUERY_LENGTH,
	type SearchableSetting,
} from './searchableSettings';
import {
	applySettingFilter,
	groupNavigationTarget,
	groupSearchResults,
	type SettingsSearchGroup,
	type SettingsSearchPanel,
} from './settingsSearchView';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { isImeComposing } from '../../utils/ime';
import { splitOnMatches } from '../../utils/highlightMatches';
import { useSettingsStore } from '../../stores/settingsStore';

export interface SettingsSearchProps {
	theme: Theme;
	onNavigate: (tab: SearchableSetting['tab'], settingId: string) => void;
	isOpen: boolean;
	onSearchActiveChange: (active: boolean) => void;
}

/** Sections mounted at once without waiting to scroll near them (the first screen). */
const EAGER_PANEL_COUNT = 6;
/** How far below the visible results a section starts mounting. */
const PANEL_MOUNT_MARGIN = '400px';
/** Focusable controls, for ArrowDown from the input. */
const NO_ADDITIONAL_SETTINGS: SearchableSetting[] = [];
const FOCUSABLE =
	'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------
// State + keyboard
// ---------------------------------------------------------------------------

export function useSettingsSearch({
	isOpen,
	onSearchActiveChange,
	onNavigate,
	additionalSettings = NO_ADDITIONAL_SETTINGS,
}: Pick<SettingsSearchProps, 'isOpen' | 'onSearchActiveChange'> & {
	additionalSettings?: SearchableSetting[];
	onNavigate?: (tab: SearchableSetting['tab'], settingId: string) => void;
}) {
	const [query, setQuery] = useState('');
	// Sections the user opened in full with "Show all" (reset by a new query).
	const [unfiltered, setUnfiltered] = useState<ReadonlySet<string>>(new Set());
	const inputRef = useRef<HTMLInputElement>(null);
	const resultsRef = useRef<HTMLDivElement>(null);
	const encoreFeatures = useSettingsStore((s) => s.encoreFeatures);
	// Section availability reads the store; regroup only when the query or the
	// Encore flags change, not on every settings write a section makes.
	const results = useMemo(
		() => searchSettings(query, additionalSettings, encoreFeatures),
		[query, additionalSettings, encoreFeatures]
	);
	const groups = useMemo(() => groupSearchResults(results, useSettingsStore.getState()), [results]);
	const isActive = query.length > 0;

	useEffect(() => {
		onSearchActiveChange(isActive);
	}, [isActive, onSearchActiveChange]);

	useEffect(() => {
		if (!isOpen) setQuery('');
	}, [isOpen]);

	useEffect(() => {
		setUnfiltered(new Set());
	}, [query]);

	// Keep latest onNavigate without re-binding the global listener
	const onNavigateRef = useRef(onNavigate);
	useEffect(() => {
		onNavigateRef.current = onNavigate;
	}, [onNavigate]);

	const navigate = useCallback((setting: SearchableSetting) => {
		onNavigateRef.current?.(setting.tab, setting.jumpToId ?? setting.id);
	}, []);

	const toggleUnfiltered = useCallback((key: string) => {
		setUnfiltered((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
				inputRef.current?.focus();
				return;
			}

			// An IME composition owns Escape, Enter and the arrows until it ends.
			if (isImeComposing(e)) return;

			const active = document.activeElement as HTMLElement | null;
			const consume = () => {
				e.preventDefault();
				e.stopPropagation();
			};

			if (active === inputRef.current) {
				if (e.key === 'Escape') {
					consume();
					if (query) setQuery('');
					else inputRef.current?.blur();
				} else if (e.key === 'ArrowDown') {
					const first = resultsRef.current?.querySelector<HTMLElement>(FOCUSABLE);
					if (first) {
						consume();
						first.focus();
					}
				} else if (e.key === 'Enter' && groups.length > 0) {
					consume();
					navigate(groupNavigationTarget(groups[0]));
				}
				return;
			}

			// A tab row hands Escape back to the query. Inside a section Escape is
			// left to the section's own controls, exactly as on its tab.
			if (e.key === 'Escape' && active?.dataset.settingsSearchRow !== undefined) {
				consume();
				inputRef.current?.focus();
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [isOpen, query, groups, navigate]);

	const clear = useCallback(() => {
		setQuery('');
		inputRef.current?.focus();
	}, []);

	return {
		query,
		setQuery,
		inputRef,
		resultsRef,
		groups,
		isActive,
		clear,
		unfiltered,
		toggleUnfiltered,
		navigate,
	};
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Search input bar - renders inline in the modal header */
export function SettingsSearchInput({
	theme,
	query,
	setQuery,
	inputRef,
	isActive,
	resultCount,
	onClear,
}: {
	theme: Theme;
	query: string;
	setQuery: (q: string) => void;
	inputRef: React.RefObject<HTMLInputElement>;
	isActive: boolean;
	/** Sections and tab rows shown, not raw matching entries. */
	resultCount: number;
	onClear: () => void;
}) {
	return (
		<div className="flex items-center gap-2 px-4 py-2">
			<Search
				className="w-4 h-4 flex-shrink-0"
				style={{ color: isActive ? theme.colors.accent : theme.colors.textDim }}
			/>
			<div className="relative flex-1 flex items-center">
				<input
					ref={inputRef}
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search settings..."
					className="w-full bg-transparent outline-none text-sm"
					style={{ color: theme.colors.textMain }}
					aria-label="Search settings"
				/>
				{!isActive && (
					<span
						className="pointer-events-none absolute inset-y-0 left-0 flex items-center gap-2 text-sm"
						aria-hidden="true"
					>
						{/* Phantom placeholder text positions the kbd hint right after where the real placeholder ends. */}
						<span style={{ color: 'transparent' }}>Search settings...</span>
						<kbd
							data-shortcut-hint=""
							className="text-2xs px-1.5 py-0.5 rounded font-mono opacity-55"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							{formatShortcutKeys(['Meta', 'f'])}
						</kbd>
					</span>
				)}
			</div>
			{isActive && (
				<>
					<span
						className="text-xs px-2 py-0.5 rounded font-medium"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
						}}
					>
						{resultCount}
					</span>
					<GhostIconButton onClick={onClear} padding="p-0.5" ariaLabel="Clear search">
						<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
					</GhostIconButton>
				</>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Search results - renders as a full-height panel replacing the sidebar+content */
export function SettingsSearchResults({
	theme,
	query,
	groups,
	isOpen,
	resultsRef,
	unfiltered,
	onToggleUnfiltered,
	onNavigate,
}: {
	theme: Theme;
	query: string;
	groups: SettingsSearchGroup[];
	isOpen: boolean;
	resultsRef: RefObject<HTMLDivElement>;
	unfiltered: ReadonlySet<string>;
	onToggleUnfiltered: (key: string) => void;
	onNavigate: (setting: SearchableSetting) => void;
}) {
	const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
	const short = query.trim().length < MIN_SUBSTRING_QUERY_LENGTH;

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			<div ref={resultsRef} className="flex-1 p-4 overflow-y-auto scrollbar-thin">
				{groups.length === 0 ? (
					<div className="text-center py-8">
						<p className="text-sm" style={{ color: theme.colors.textDim }}>
							{short
								? `Keep typing: search starts at ${MIN_SUBSTRING_QUERY_LENGTH} characters`
								: `No settings found for “${query}”`}
						</p>
					</div>
				) : (
					<div className="space-y-3">
						{groups.map((group, index) =>
							group.kind === 'panel' ? (
								<SearchResultPanel
									key={group.key}
									theme={theme}
									panel={group}
									isOpen={isOpen}
									eager={index < EAGER_PANEL_COUNT}
									scrollRoot={resultsRef}
									filtered={!unfiltered.has(group.key)}
									onToggleFiltered={() => onToggleUnfiltered(group.key)}
									onNavigate={onNavigate}
								/>
							) : (
								<SearchResultJumpRow
									key={group.key}
									theme={theme}
									setting={group.setting}
									terms={terms}
									onNavigate={onNavigate}
								/>
							)
						)}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * True once `ref` has come within `margin` of `root`'s visible area. Sticky:
 * a section that mounted stays mounted while the query keeps it in the list.
 */
function useHasBeenNear(
	ref: RefObject<HTMLElement>,
	root: RefObject<HTMLElement>,
	initial: boolean
): boolean {
	const [near, setNear] = useState(initial);
	useEffect(() => {
		if (near) return;
		const element = ref.current;
		if (!element || typeof IntersectionObserver === 'undefined') {
			setNear(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) setNear(true);
			},
			{ root: root.current, rootMargin: PANEL_MOUNT_MARGIN }
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [near, ref, root]);
	return near;
}

function SearchResultPanel({
	theme,
	panel,
	isOpen,
	eager,
	scrollRoot,
	filtered,
	onToggleFiltered,
	onNavigate,
}: {
	theme: Theme;
	panel: SettingsSearchPanel;
	isOpen: boolean;
	eager: boolean;
	scrollRoot: RefObject<HTMLElement>;
	filtered: boolean;
	onToggleFiltered: () => void;
	onNavigate: (setting: SearchableSetting) => void;
}) {
	const cardRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const mounted = useHasBeenNear(cardRef, scrollRoot, eager);
	const { section, matches } = panel;
	const total = section.settingIds.length;
	const partial = matches.length < total;
	const matchedKey = matches.map((m) => m.id).join('\n');
	const SectionComponent = section.Component;

	// Filter before paint, and again whenever the section re-renders its DOM
	// (a control that appears only in some states, a list that loads later).
	useLayoutEffect(() => {
		const body = bodyRef.current;
		if (!mounted || !body) return;
		const matched = filtered && partial ? new Set(matchedKey.split('\n')) : null;
		applySettingFilter(body, matched);
		if (typeof MutationObserver === 'undefined') return;
		const observer = new MutationObserver(() => applySettingFilter(body, matched));
		observer.observe(body, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [mounted, filtered, partial, matchedKey]);

	const target = matches[0];

	return (
		<div
			ref={cardRef}
			data-settings-search-panel={panel.key}
			className="rounded border"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			<div
				className="flex items-center gap-2 px-3 py-2 border-b select-none"
				style={{ borderColor: theme.colors.border }}
			>
				<div
					className="flex-1 min-w-0 text-xs font-bold uppercase truncate"
					style={{ color: theme.colors.textDim }}
				>
					{panel.tabLabel} <span className="opacity-55">›</span> {panel.title}
				</div>
				{partial && filtered && (
					<span className="text-xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
						{matches.length} of {total}
					</span>
				)}
				<GhostIconButton
					onClick={() => onNavigate(target)}
					padding="p-1"
					title={`Open in ${panel.tabLabel}`}
					ariaLabel={`Open ${panel.title} in ${panel.tabLabel}`}
				>
					<CornerDownLeft className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
				</GhostIconButton>
			</div>
			<div
				ref={bodyRef}
				data-settings-search-section=""
				className="px-3 pb-3 select-text"
				style={{ backgroundColor: theme.colors.bgSidebar }}
			>
				{mounted ? (
					<SectionComponent theme={theme} isOpen={isOpen} />
				) : (
					<div className="pt-3">
						<SkeletonBox theme={theme} className="h-10 w-full" />
					</div>
				)}
			</div>
			{partial && (
				<button
					type="button"
					onClick={onToggleFiltered}
					className="w-full text-left text-xs px-3 py-2 border-t select-none"
					style={{ borderColor: theme.colors.border, color: theme.colors.accent }}
				>
					{filtered ? `Show all ${total} in ${panel.title}` : 'Show only matches'}
				</button>
			)}
		</div>
	);
}

function SearchResultJumpRow({
	theme,
	setting,
	terms,
	onNavigate,
}: {
	theme: Theme;
	setting: SearchableSetting;
	terms: string[];
	onNavigate: (setting: SearchableSetting) => void;
}) {
	const [focused, setFocused] = useState(false);
	return (
		<div
			data-settings-search-row={setting.id}
			role="button"
			tabIndex={0}
			onClick={() => onNavigate(setting)}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onNavigate(setting);
				}
			}}
			onFocus={() => setFocused(true)}
			onBlur={() => setFocused(false)}
			title={`Open in ${setting.tabLabel}`}
			className="flex items-center gap-3 p-3 rounded border cursor-pointer outline-none select-none"
			style={{
				borderColor: focused ? theme.colors.accent : theme.colors.border,
				backgroundColor: focused ? theme.colors.bgActivity : theme.colors.bgMain,
			}}
		>
			<div className="flex-1 min-w-0">
				<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					<Highlighted text={setting.label} terms={terms} theme={theme} />
				</div>
				<div className="text-xs mt-0.5 opacity-70">
					{setting.tabLabel}
					{setting.description && (
						<>
							{' · '}
							<Highlighted text={setting.description} terms={terms} theme={theme} />
						</>
					)}
				</div>
			</div>
			<ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.textDim }} />
		</div>
	);
}

/** Paints the query terms in `text` with the accent color. */
function Highlighted({ text, terms, theme }: { text: string; terms: string[]; theme: Theme }) {
	return (
		<>
			{splitOnMatches(text, terms).map((segment) =>
				segment.isMatch ? (
					<span key={segment.start} style={{ color: theme.colors.accent, fontWeight: 600 }}>
						{segment.text}
					</span>
				) : (
					<React.Fragment key={segment.start}>{segment.text}</React.Fragment>
				)
			)}
		</>
	);
}
