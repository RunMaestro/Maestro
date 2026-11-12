/**
 * SettingsSearch - Cross-tab search for the Settings modal
 *
 * Two components:
 *   SettingsSearchInput - the search bar (always visible in the header)
 *   SettingsSearchResults - the results list (shown when search is active, fills remaining space)
 *
 * A result can be changed without leaving the search:
 *   - a single on/off setting shows its switch on the row, and flips in place;
 *   - a result backed by a settings section expands to show that section;
 *   - anything else (the theme picker, the shortcut list, ...) jumps to its tab.
 *
 * Keyboard: Cmd+F focuses the input; Escape clears or blurs. While typing,
 * Enter jumps to the highlighted result and ArrowDown moves focus into the
 * list. In the list: ArrowUp/ArrowDown move (ArrowUp off the top returns to
 * the input), Space acts in place (flip, or expand/collapse), Enter jumps,
 * ArrowRight/ArrowLeft expand/collapse, Escape returns to the input, and
 * typing any character goes back to the input. Space only acts in place when
 * a row has focus, so it still types a space in a multi-word query.
 */

import React, { useState, useRef, useEffect, useCallback, type MutableRefObject } from 'react';
import { ChevronDown, ChevronRight, CornerDownLeft, Search, X } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { ToggleSwitchTrack } from '../ui/ToggleSwitch';
import type { Theme } from '../../types';
import {
	searchSettings,
	type SearchableSetting,
	type ToggleSettingKey,
} from './searchableSettings';
import { findSettingsSection, type SettingsSectionDef } from './settingsSections';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { splitOnMatches } from '../../utils/highlightMatches';
import { useScrollIntoView } from '../../hooks/ui/useScrollIntoView';
import { useSettingsStore, type SettingsStore } from '../../stores/settingsStore';

export interface SettingsSearchProps {
	theme: Theme;
	onNavigate: (tab: SearchableSetting['tab'], settingId: string) => void;
	isOpen: boolean;
	onSearchActiveChange: (active: boolean) => void;
}

// ---------------------------------------------------------------------------
// What a result does in place
// ---------------------------------------------------------------------------

/**
 * - `toggle`: the row carries the setting's switch; acting flips it.
 * - `expand`: the row opens the section that renders the setting.
 * - `jump`: nothing to change in place; acting opens the setting's tab.
 */
export type SearchResultMode = 'toggle' | 'expand' | 'jump';

/** The section to show inline for `setting`, when there is one and it is available now. */
export function inlineSectionFor(
	setting: SearchableSetting,
	settings: SettingsStore
): SettingsSectionDef | undefined {
	const section = findSettingsSection(setting.id);
	if (!section) return undefined;
	return section.isAvailable && !section.isAvailable(settings) ? undefined : section;
}

export function searchResultMode(
	setting: SearchableSetting,
	settings: SettingsStore
): SearchResultMode {
	if (setting.toggle) return 'toggle';
	return inlineSectionFor(setting, settings) ? 'expand' : 'jump';
}

function toggleSetterName(key: ToggleSettingKey): `set${Capitalize<ToggleSettingKey>}` {
	return `set${key.charAt(0).toUpperCase()}${key.slice(1)}` as `set${Capitalize<ToggleSettingKey>}`;
}

/** Flip a toggle through the same store setter the section's own switch calls. */
export function flipToggleSetting(key: ToggleSettingKey): void {
	const state = useSettingsStore.getState();
	const setter = state[toggleSetterName(key)] as (value: boolean) => void;
	setter(!state[key]);
}

// ---------------------------------------------------------------------------
// State + keyboard
// ---------------------------------------------------------------------------

export function useSettingsSearch({
	isOpen,
	onSearchActiveChange,
	onNavigate,
}: Pick<SettingsSearchProps, 'isOpen' | 'onSearchActiveChange'> & {
	onNavigate?: (tab: SearchableSetting['tab'], settingId: string) => void;
}) {
	const [query, setQuery] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	// The one result whose section is shown inline (null when none).
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const results = searchSettings(query);
	const isActive = query.length > 0;
	// Instant scroll: a held arrow key repeats faster than a smooth scroll animates.
	const rowRefs = useScrollIntoView<HTMLDivElement>(
		isActive,
		selectedIndex,
		results.length,
		'auto'
	);

	// Notify parent when search active state changes
	useEffect(() => {
		onSearchActiveChange(isActive);
	}, [isActive, onSearchActiveChange]);

	// Reset query when modal closes
	useEffect(() => {
		if (!isOpen) setQuery('');
	}, [isOpen]);

	// A new query is a new list: back to the top, nothing expanded
	useEffect(() => {
		setSelectedIndex(0);
		setExpandedId(null);
	}, [query]);

	// Keep selection in range if results shrink without a query change
	useEffect(() => {
		if (selectedIndex > 0 && selectedIndex >= results.length) {
			setSelectedIndex(Math.max(0, results.length - 1));
		}
	}, [results.length, selectedIndex]);

	// Keep latest onNavigate without re-binding the global listener
	const onNavigateRef = useRef(onNavigate);
	useEffect(() => {
		onNavigateRef.current = onNavigate;
	}, [onNavigate]);

	const navigate = useCallback((setting: SearchableSetting) => {
		onNavigateRef.current?.(setting.tab, setting.jumpToId ?? setting.id);
	}, []);

	const setExpanded = useCallback((setting: SearchableSetting, expanded: boolean) => {
		setExpandedId((current) => {
			if (expanded) return setting.id;
			return current === setting.id ? null : current;
		});
	}, []);

	/** Space / click: flip the switch, open or close the section, or jump. */
	const activate = useCallback(
		(setting: SearchableSetting) => {
			const mode = searchResultMode(setting, useSettingsStore.getState());
			if (mode === 'toggle' && setting.toggle) flipToggleSetting(setting.toggle);
			else if (mode === 'expand') setExpandedId((id) => (id === setting.id ? null : setting.id));
			else navigate(setting);
		},
		[navigate]
	);

	const focusRow = useCallback(
		(index: number) => {
			setSelectedIndex(index);
			rowRefs.current[index]?.focus();
		},
		[rowRefs]
	);

	// Cmd+F focuses the search input; Escape clears or blurs; the rest is the
	// result-list navigation described in the header comment.
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

			const active = document.activeElement as HTMLElement | null;
			const inputFocused = active === inputRef.current;
			const rowIndex = active ? rowRefs.current.indexOf(active as HTMLDivElement) : -1;
			const consume = () => {
				e.preventDefault();
				e.stopPropagation();
			};

			if (e.key === 'Escape') {
				if (inputFocused) {
					consume();
					if (query) setQuery('');
					else inputRef.current?.blur();
				} else if (rowIndex >= 0) {
					consume();
					inputRef.current?.focus();
				}
				// Inside an expanded section Escape is left to the section's own
				// controls (an open dropdown closes itself), exactly as on its tab.
				return;
			}

			if (!isActive || results.length === 0) return;

			if (inputFocused) {
				if (e.key === 'ArrowDown') {
					consume();
					focusRow(Math.min(selectedIndex, results.length - 1));
				} else if (e.key === 'Enter') {
					const target = results[selectedIndex] ?? results[0];
					if (target) {
						consume();
						navigate(target);
					}
				}
				return;
			}

			if (rowIndex < 0) return;
			const setting = results[rowIndex];
			if (!setting) return;

			if (e.key === 'ArrowDown') {
				consume();
				focusRow((rowIndex + 1) % results.length);
			} else if (e.key === 'ArrowUp') {
				consume();
				if (rowIndex === 0) inputRef.current?.focus();
				else focusRow(rowIndex - 1);
			} else if (e.key === ' ') {
				consume();
				activate(setting);
			} else if (e.key === 'Enter') {
				consume();
				navigate(setting);
			} else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
				if (searchResultMode(setting, useSettingsStore.getState()) !== 'expand') return;
				consume();
				setExpanded(setting, e.key === 'ArrowRight');
			} else if (
				(e.key.length === 1 || e.key === 'Backspace') &&
				!e.metaKey &&
				!e.ctrlKey &&
				!e.altKey
			) {
				// Back to the query. Not prevented, so the keystroke lands in the
				// input that now has focus.
				inputRef.current?.focus();
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [
		isOpen,
		query,
		isActive,
		results,
		selectedIndex,
		rowRefs,
		focusRow,
		activate,
		navigate,
		setExpanded,
	]);

	const clear = useCallback(() => {
		setQuery('');
		inputRef.current?.focus();
	}, []);

	return {
		query,
		setQuery,
		inputRef,
		results,
		isActive,
		clear,
		selectedIndex,
		setSelectedIndex,
		expandedId,
		rowRefs,
		activate,
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
	results,
	onClear,
}: {
	theme: Theme;
	query: string;
	setQuery: (q: string) => void;
	inputRef: React.RefObject<HTMLInputElement>;
	isActive: boolean;
	results: SearchableSetting[];
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
							className="text-2xs px-1.5 py-0.5 rounded font-mono opacity-40"
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
						{results.length}
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

/** Search results list - renders as a full-height panel replacing the sidebar+content */
export function SettingsSearchResults({
	theme,
	query,
	results,
	isOpen,
	selectedIndex,
	setSelectedIndex,
	expandedId,
	rowRefs,
	onActivate,
	onNavigate,
}: {
	theme: Theme;
	query: string;
	results: SearchableSetting[];
	isOpen: boolean;
	selectedIndex: number;
	setSelectedIndex: (i: number) => void;
	expandedId: string | null;
	rowRefs: MutableRefObject<(HTMLDivElement | null)[]>;
	onActivate: (setting: SearchableSetting) => void;
	onNavigate: (setting: SearchableSetting) => void;
}) {
	// Group results by tab for display while preserving the global flat index
	// for keyboard selection mapping.
	const grouped: {
		tabLabel: string;
		entries: { setting: SearchableSetting; flatIndex: number }[];
	}[] = [];
	const labelToGroup = new Map<string, (typeof grouped)[number]>();
	results.forEach((setting, flatIndex) => {
		let group = labelToGroup.get(setting.tabLabel);
		if (!group) {
			group = { tabLabel: setting.tabLabel, entries: [] };
			labelToGroup.set(setting.tabLabel, group);
			grouped.push(group);
		}
		group.entries.push({ setting, flatIndex });
	});

	const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			<div className="flex-1 p-4 overflow-y-auto scrollbar-thin">
				{results.length === 0 ? (
					<div className="text-center py-8">
						<p className="text-sm" style={{ color: theme.colors.textDim }}>
							No settings found for &ldquo;{query}&rdquo;
						</p>
					</div>
				) : (
					<div className="space-y-4">
						{grouped.map(({ tabLabel, entries }) => (
							<div key={tabLabel}>
								<h3
									className="text-xs font-bold uppercase mb-2 px-1"
									style={{ color: theme.colors.textDim }}
								>
									{tabLabel}
								</h3>
								<div className="space-y-1">
									{entries.map(({ setting, flatIndex }) => (
										<SearchResultRow
											key={setting.id}
											theme={theme}
											setting={setting}
											terms={terms}
											isOpen={isOpen}
											isSelected={flatIndex === selectedIndex}
											isExpanded={expandedId === setting.id}
											rowRef={(el) => {
												rowRefs.current[flatIndex] = el;
											}}
											onHover={() => setSelectedIndex(flatIndex)}
											onActivate={onActivate}
											onNavigate={onNavigate}
										/>
									))}
								</div>
							</div>
						))}
					</div>
				)}
			</div>
			{results.length > 0 && <SearchKeyLegend theme={theme} />}
		</div>
	);
}

function SearchResultRow({
	theme,
	setting,
	terms,
	isOpen,
	isSelected,
	isExpanded,
	rowRef,
	onHover,
	onActivate,
	onNavigate,
}: {
	theme: Theme;
	setting: SearchableSetting;
	terms: string[];
	isOpen: boolean;
	isSelected: boolean;
	isExpanded: boolean;
	rowRef: (el: HTMLDivElement | null) => void;
	onHover: () => void;
	onActivate: (setting: SearchableSetting) => void;
	onNavigate: (setting: SearchableSetting) => void;
}) {
	const mode = useSettingsStore((s) => searchResultMode(setting, s));
	const toggleOn = useSettingsStore((s) => (setting.toggle ? Boolean(s[setting.toggle]) : false));
	const [focused, setFocused] = useState(false);
	const section = mode === 'expand' ? findSettingsSection(setting.id) : undefined;
	const SectionComponent = isExpanded ? section?.Component : undefined;

	return (
		<div
			className="rounded border transition-colors"
			style={{
				borderColor: isSelected ? theme.colors.accent : theme.colors.border,
				backgroundColor: isSelected ? theme.colors.bgActivity : theme.colors.bgMain,
				boxShadow: focused ? `inset 0 0 0 1px ${theme.colors.accent}` : undefined,
			}}
		>
			<div
				ref={rowRef}
				data-settings-search-row={setting.id}
				role={mode === 'toggle' ? 'switch' : 'button'}
				aria-checked={mode === 'toggle' ? toggleOn : undefined}
				aria-expanded={mode === 'expand' ? isExpanded : undefined}
				tabIndex={isSelected ? 0 : -1}
				onClick={() => onActivate(setting)}
				onMouseEnter={onHover}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				className="flex items-center gap-3 p-3 cursor-pointer outline-none select-none"
			>
				<div className="flex-1 min-w-0">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						<Highlighted text={setting.label} terms={terms} theme={theme} />
					</div>
					{setting.description && (
						<div className="text-xs mt-0.5 opacity-70">
							<Highlighted text={setting.description} terms={terms} theme={theme} />
						</div>
					)}
				</div>
				<div className="flex items-center gap-1 flex-shrink-0">
					{mode === 'toggle' && <ToggleSwitchTrack checked={toggleOn} theme={theme} />}
					{mode === 'expand' && (
						<ChevronDown
							className="w-4 h-4 transition-transform"
							style={{
								color: theme.colors.textDim,
								transform: isExpanded ? 'rotate(180deg)' : undefined,
							}}
						/>
					)}
					{mode === 'jump' ? (
						<ChevronRight className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					) : (
						<GhostIconButton
							onClick={(e) => {
								e.stopPropagation();
								onNavigate(setting);
							}}
							padding="p-1"
							title={`Open in ${setting.tabLabel} (Enter)`}
							ariaLabel={`Open ${setting.label} in ${setting.tabLabel}`}
						>
							<CornerDownLeft className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
						</GhostIconButton>
					)}
				</div>
			</div>
			{SectionComponent && (
				<div
					data-settings-search-section=""
					className="px-3 pb-3 pt-3 border-t select-text"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
				>
					<SectionComponent theme={theme} isOpen={isOpen} />
				</div>
			)}
		</div>
	);
}

function SearchKeyLegend({ theme }: { theme: Theme }) {
	const items: [string, string][] = [
		['↓', 'results'],
		['Space', 'toggle or expand'],
		['↵', 'open in tab'],
	];
	return (
		<div
			data-shortcut-hint=""
			className="flex items-center justify-center gap-4 px-4 py-2 border-t text-xs select-none"
			style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
		>
			{items.map(([key, label]) => (
				<span key={key} className="flex items-center gap-1.5">
					<kbd
						className="text-2xs px-1.5 py-0.5 rounded font-mono"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						{key}
					</kbd>
					{label}
				</span>
			))}
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
