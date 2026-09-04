/**
 * Extensions (Encore) marketplace - the unified surface that lists first-party
 * Encore features AND community plugins as one tiled grid with category
 * filters, a search box, an "only installed" toggle, and a details pane.
 * Mounted in EncoreTab in place of the old plugins-only section.
 */

import { useCallback, useMemo, useState } from 'react';
import { Search, FolderPlus, Puzzle, ChevronLeft } from 'lucide-react';
import type { EncoreFeatureFlags, Theme } from '../../../types';
import type { ReactNode } from 'react';
import { useModalLayer } from '../../../hooks/ui/useModalLayer';
import { usePersistedChoice } from '../../../hooks/ui/usePersistedChoice';
import { useGridColumnCount } from '../../../hooks/ui/useGridColumnCount';
import { useListNavigation } from '../../../hooks/keyboard/useListNavigation';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { useExtensions } from './useExtensions';
import { ExtensionsGrid, ACTIVE_EXTENSION_TILE_SELECTOR } from './ExtensionsGrid';
import { ExtensionDetails } from './ExtensionDetails';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { FirstPartyEnableModal } from './FirstPartyEnableModal';
import {
	CATEGORY_FILTERS,
	CATEGORY_LABELS,
	EXTENSION_SORT_STORAGE_KEY,
	EXTENSION_SORT_VALUES,
	SORT_OPTIONS,
	filterExtensions,
	sortExtensions,
	type CategoryFilter,
	type ExtensionSort,
	type UnifiedExtension,
} from './extensionModel';

interface ExtensionsViewProps {
	theme: Theme;
	/** Config bodies for first-party tiles' Settings sub-tab, keyed by Encore
	 * flag. Supplied by the Plugins tab; absent when mounted standalone. */
	settingsBodies?: Partial<Record<keyof EncoreFeatureFlags, ReactNode>>;
}

export function ExtensionsView({ theme, settingsBodies }: ExtensionsViewProps) {
	const {
		extensions,
		contributions,
		pluginsSubsystemEnabled,
		busyId,
		toggleBuiltin,
		pendingEnable,
		confirmPendingEnable,
		cancelPendingEnable,
		enablePluginsSubsystem,
		togglePlugin,
		installPlugin,
		uninstallPlugin,
		revokePlugin,
		getGrants,
	} = useExtensions();

	const [query, setQuery] = useState('');
	const [category, setCategory] = useState<CategoryFilter>('all');
	const [onlyInstalled, setOnlyInstalled] = useState(false);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	// Remembered rather than reset per visit: which order the grid reads in is a
	// standing preference, and Settings unmounts this view on every tab switch.
	const { value: sort, setValue: setSort } = usePersistedChoice<ExtensionSort>(
		EXTENSION_SORT_STORAGE_KEY,
		EXTENSION_SORT_VALUES,
		'name'
	);

	const visible = useMemo(
		() => sortExtensions(filterExtensions(extensions, { category, onlyInstalled, query }), sort),
		[extensions, category, onlyInstalled, query, sort]
	);

	// The selected tile, resolved against the live list so it stays fresh after
	// enable/disable/uninstall (and disappears if the plugin is removed).
	const selected = selectedKey ? extensions.find((e) => e.key === selectedKey) : undefined;

	// Keyboard navigation over the tile grid. The active index lives HERE rather
	// than in the grid because the grid unmounts while the details pane is open -
	// keeping it here is what lets Escape drop the user back on the tile they
	// opened instead of resetting them to the first one.
	// The grid element lives in STATE, not a ref: it unmounts while the details
	// pane is open, and a ref's `.current` changing is invisible to React - the
	// column measurement would stay bound to the old, detached grid and read as
	// a single column for the rest of the visit, quietly turning the row jump
	// back into a one-tile step.
	const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
	const columns = useGridColumnCount(gridEl, visible.length);
	const openDetails = useCallback((ext: UnifiedExtension) => setSelectedKey(ext.key), []);

	const {
		selectedIndex: activeIndex,
		setSelectedIndex: setActiveIndex,
		handleKeyDown: handleGridKeyDown,
	} = useListNavigation({
		listLength: visible.length,
		columns,
		enablePageNavigation: true,
		// Enter arrives here rather than through the tile's own click: the hook
		// calls preventDefault, which suppresses the button's default activation,
		// so the details pane opens exactly once.
		onSelect: (index) => {
			const ext = visible[index];
			if (ext) openDetails(ext);
		},
		enabled: !selected,
	});

	// Re-sorting renumbers the grid, so carry the keyboard cursor by TILE rather
	// than by index - otherwise switching to Newest silently moves the ring onto
	// whatever extension happens to land in that slot.
	const handleSortChange = useCallback(
		(next: ExtensionSort) => {
			const activeKey = visible[activeIndex]?.key;
			setSort(next);
			if (!activeKey) return;
			const nextIndex = sortExtensions(visible, next).findIndex((e) => e.key === activeKey);
			if (nextIndex >= 0) setActiveIndex(nextIndex);
		},
		[visible, activeIndex, setSort, setActiveIndex]
	);

	// While the details pane is open it owns Escape: back to the grid, not out of
	// the whole Settings modal. Non-blocking / no focus trap so the rest of
	// Settings (search, tab switching) keeps working underneath.
	// Remounting the grid is what restores focus to the tile that was opened -
	// see ExtensionsGrid's mount-focus effect.
	const closeDetails = useCallback(() => setSelectedKey(null), []);
	useModalLayer(MODAL_PRIORITIES.EXTENSION_DETAILS, 'Extension Details', closeDetails, {
		enabled: Boolean(selected),
		blocksLowerLayers: false,
		capturesFocus: false,
		focusTrap: 'none',
	});

	return (
		<div data-testid="extensions-view" data-setting-id="encore-plugins">
			{/* Settings-search anchor: Pianola is managed as a marketplace tile in
			    this view; the registry/DOM parity contract needs the literal
			    attribute present where the search should scroll to. */}
			<span data-setting-id="encore-pianola" aria-hidden="true" />
			<span data-setting-id="encore-concerto" aria-hidden="true" />
			<span data-setting-id="encore-groups-plus" aria-hidden="true" />
			<div className="flex items-center justify-between gap-3 mb-1">
				<h3 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
					Plugins
				</h3>
				{/* One header slot, two jobs. Installing belongs to the marketplace
				    grid, not to one plugin's details pane - shown there it reads as
				    "install this plugin" - so the details pane spends the slot on the
				    way back to the grid instead. */}
				{selected ? (
					<button
						type="button"
						data-testid="extensions-back"
						onClick={closeDetails}
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors hover:bg-white/5"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<ChevronLeft className="w-3.5 h-3.5" /> All plugins
					</button>
				) : (
					<button
						type="button"
						data-testid="extensions-install"
						onClick={() => void installPlugin()}
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors hover:bg-white/5"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<FolderPlus className="w-3.5 h-3.5" /> Install plugin…
					</button>
				)}
			</div>
			<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
				Built-in Encore features and community plugins. Enable what you want; everything else stays
				hidden from shortcuts, menus, and the command palette.
			</p>

			{!pluginsSubsystemEnabled && (
				<div
					className="flex items-center justify-between gap-3 rounded-lg border p-3 mb-4"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
				>
					<div className="flex items-center gap-2 text-xs" style={{ color: theme.colors.textDim }}>
						<Puzzle className="w-4 h-4" />
						The community plugin subsystem is off, so only built-in features are listed.
					</div>
					<button
						type="button"
						data-testid="extensions-enable-subsystem"
						onClick={enablePluginsSubsystem}
						className="px-2.5 py-1.5 rounded-lg text-xs font-medium flex-shrink-0"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
					>
						Enable plugins
					</button>
				</div>
			)}

			{selected ? (
				<ExtensionDetails
					theme={theme}
					ext={selected}
					contributions={contributions}
					busy={busyId === selected.id}
					onTogglePlugin={togglePlugin}
					onToggleBuiltin={toggleBuiltin}
					onUninstall={uninstallPlugin}
					onRevoke={revokePlugin}
					getGrants={getGrants}
					settingsBody={selected.flag ? settingsBodies?.[selected.flag] : undefined}
				/>
			) : (
				<>
					{/* Filter bar */}
					<div className="flex items-center gap-1.5 flex-wrap mb-3">
						{CATEGORY_FILTERS.map((cat) => {
							const active = category === cat;
							return (
								<button
									key={cat}
									type="button"
									data-testid="extensions-filter"
									data-category={cat}
									aria-pressed={active}
									onClick={() => setCategory(cat)}
									className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
									style={{
										backgroundColor: active ? theme.colors.accent : theme.colors.bgActivity,
										color: active ? theme.colors.bgMain : theme.colors.textDim,
									}}
								>
									{cat === 'all' ? 'All' : CATEGORY_LABELS[cat]}
								</button>
							);
						})}
					</div>

					{/* Search + sort + only-installed */}
					<div className="flex items-center gap-2 mb-4 flex-wrap">
						<div
							className="flex items-center gap-2 flex-1 px-2.5 py-1.5 rounded-lg border"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
						>
							<Search className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.textDim }} />
							<input
								type="text"
								data-testid="extensions-search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								onKeyDown={(e) => {
									// Down out of the search box is the way into the grid without
									// reaching for Tab, which has to cross the only-installed toggle.
									if (e.key !== 'ArrowDown') return;
									e.preventDefault();
									gridEl?.querySelector<HTMLButtonElement>(ACTIVE_EXTENSION_TILE_SELECTOR)?.focus();
								}}
								placeholder="Search extensions…"
								className="bg-transparent flex-1 text-sm outline-none"
								style={{ color: theme.colors.textMain }}
								aria-label="Search extensions"
							/>
						</div>
						<div className="flex items-center gap-1.5 flex-shrink-0">
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Sort
							</span>
							<SegmentedControl
								value={sort}
								onChange={handleSortChange}
								options={SORT_OPTIONS}
								theme={theme}
								ariaLabel="Sort extensions"
								testId="extensions-sort"
							/>
						</div>
						<button
							type="button"
							data-testid="extensions-only-installed"
							role="switch"
							aria-checked={onlyInstalled}
							onClick={() => setOnlyInstalled((v) => !v)}
							className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs transition-colors"
							style={{
								borderColor: onlyInstalled ? theme.colors.accent : theme.colors.border,
								color: onlyInstalled ? theme.colors.accent : theme.colors.textDim,
								backgroundColor: onlyInstalled ? `${theme.colors.accent}10` : 'transparent',
							}}
						>
							<span
								className="relative w-8 h-4 rounded-full transition-colors flex-shrink-0"
								style={{
									backgroundColor: onlyInstalled ? theme.colors.accent : theme.colors.border,
								}}
							>
								<span
									className="absolute left-0 top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
									style={{ transform: onlyInstalled ? 'translateX(18px)' : 'translateX(2px)' }}
								/>
							</span>
							Only installed
						</button>
					</div>

					<ExtensionsGrid
						theme={theme}
						extensions={visible}
						onSelect={openDetails}
						activeIndex={activeIndex}
						onActiveIndexChange={setActiveIndex}
						onKeyDown={handleGridKeyDown}
						onGridElement={setGridEl}
					/>
				</>
			)}
			{pendingEnable && (
				<FirstPartyEnableModal
					theme={theme}
					name={pendingEnable.name}
					permissions={pendingEnable.permissions}
					onConfirm={confirmPendingEnable}
					onCancel={cancelPendingEnable}
				/>
			)}
		</div>
	);
}
