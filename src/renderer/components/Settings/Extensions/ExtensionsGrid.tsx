/**
 * Tiled grid of extension cards (first-party Encore features + plugins).
 * Each tile shows an icon, name, one-line description, a category badge, a
 * state pill, and (for plugins) a tier + trust badge. Clicking a tile opens
 * the details pane.
 *
 * The grid is arrow-navigable. It uses a roving tabindex - exactly one tile is
 * tabbable at a time - so Tab moves past the whole grid in one press while the
 * arrows walk it, which is the standard composite-widget contract. Tiles stay
 * native `<button>`s, so Enter and Space activate them without extra wiring.
 * The active index is owned by the parent, because it has to survive the grid
 * unmounting while the details pane is open.
 */

import { useCallback, useEffect, useRef } from 'react';
import {
	Puzzle,
	Database,
	Music,
	Zap,
	Clapperboard,
	Bot,
	ShieldCheck,
	ShieldAlert,
	ShieldX,
	Shield,
	type LucideIcon,
} from 'lucide-react';
import type { Theme } from '../../../types';
import { formatCalendarDay } from '../../../../shared/formatters';
import { CATEGORY_LABELS, STATE_LABELS, type UnifiedExtension } from './extensionModel';

interface ExtensionsGridProps {
	theme: Theme;
	extensions: UnifiedExtension[];
	onSelect: (ext: UnifiedExtension) => void;
	/** Index of the keyboard-active tile, owned by the parent. */
	activeIndex: number;
	/** Sync the parent when the pointer moves the active tile. */
	onActiveIndexChange: (index: number) => void;
	/** Arrow/Home/End handling, from the parent's `useListNavigation`. */
	onKeyDown: (e: React.KeyboardEvent) => void;
	/** Hands the grid element up to the parent, which measures its column count
	 * and needs it to move focus. A callback rather than a ref object so the
	 * parent re-runs when the grid unmounts and mounts again. */
	onGridElement: (el: HTMLDivElement | null) => void;
}

/** Finds the one tabbable tile. Shared so callers outside this file (the search
 * box handing focus down to the grid) do not restate the attribute. */
export const ACTIVE_EXTENSION_TILE_SELECTOR = '[data-testid="extension-card"][data-active="true"]';

const BUILTIN_ICONS: Record<string, LucideIcon> = {
	usageStats: Database,
	symphony: Music,
	maestroCue: Zap,
	directorNotes: Clapperboard,
	pianola: Bot,
};

const TRUST_META: Record<
	NonNullable<UnifiedExtension['trust']>,
	{ label: string; icon: LucideIcon; color: 'success' | 'warning' | 'error' | 'textDim' }
> = {
	trusted: { label: 'Trusted', icon: ShieldCheck, color: 'success' },
	untrusted: { label: 'Untrusted', icon: ShieldAlert, color: 'warning' },
	invalid: { label: 'Bad signature', icon: ShieldX, color: 'error' },
	unsigned: { label: 'Unsigned', icon: Shield, color: 'textDim' },
};

export function ExtensionsGrid({
	theme,
	extensions,
	onSelect,
	activeIndex,
	onActiveIndexChange,
	onKeyDown,
	onGridElement,
}: ExtensionsGridProps) {
	const gridRef = useRef<HTMLDivElement | null>(null);

	// Publishes the node to the parent AND keeps a local handle for the focus
	// work below. Stable, so React does not detach and reattach on every render.
	const attachGrid = useCallback(
		(el: HTMLDivElement | null) => {
			gridRef.current = el;
			onGridElement(el);
		},
		[onGridElement]
	);

	// The grid claims focus on mount, so the arrows work the moment the pane is
	// on screen - no click or Tab needed to "get into" it first. The grid mounts
	// exactly twice per visit: when the pane opens, and when the details pane
	// closes. Both want focus here, and the second is what makes Escape land the
	// user back on the tile they opened.
	//
	// Consumed on the first effect run: without the ref every later arrow press
	// would re-focus, yanking focus back from wherever the user actually put it.
	const pendingAutoFocus = useRef(true);

	// Afterwards, move real DOM focus with the active tile only while focus is
	// already inside the grid. Otherwise merely filtering the list would steal
	// the caret out of the search box.
	useEffect(() => {
		const grid = gridRef.current;
		if (!grid) return;
		const restoring = pendingAutoFocus.current;
		pendingAutoFocus.current = false;
		if (!restoring && !grid.contains(document.activeElement)) return;
		grid.querySelector<HTMLButtonElement>(ACTIVE_EXTENSION_TILE_SELECTOR)?.focus();
	}, [activeIndex]);

	const stateTone = (ext: UnifiedExtension): string => {
		if (ext.state === 'enabled') return theme.colors.success;
		if (ext.state === 'installed') return theme.colors.accent;
		return theme.colors.textDim;
	};

	if (extensions.length === 0) {
		return (
			<div
				data-testid="extensions-empty"
				className="text-sm py-10 text-center"
				style={{ color: theme.colors.textDim }}
			>
				No extensions match your filters.
			</div>
		);
	}

	return (
		<div
			ref={attachGrid}
			data-testid="extensions-grid"
			className="grid gap-3"
			onKeyDown={onKeyDown}
			style={{
				// Never more than 3 across: the per-column floor is a full third of the
				// row (minus the two gaps), so a 4th column can never fit. Narrower
				// panels fall back to the 240px floor and drop to 2 or 1 column.
				gridTemplateColumns: 'repeat(auto-fill, minmax(max(240px, (100% - 1.5rem) / 3), 1fr))',
			}}
		>
			{extensions.map((ext, index) => {
				const Icon = ext.kind === 'plugin' ? Puzzle : (BUILTIN_ICONS[ext.id] ?? Puzzle);
				const trust = ext.trust ? TRUST_META[ext.trust] : null;
				const TrustIcon = trust?.icon;
				const isEnabled = ext.state === 'enabled';
				const isActive = index === activeIndex;
				return (
					<button
						key={ext.key}
						type="button"
						data-testid="extension-card"
						data-extension-key={ext.key}
						data-extension-id={ext.id}
						data-extension-kind={ext.kind}
						data-extension-state={ext.state}
						data-extension-category={ext.category}
						data-active={isActive ? 'true' : 'false'}
						tabIndex={isActive ? 0 : -1}
						onClick={() => {
							onActiveIndexChange(index);
							onSelect(ext);
						}}
						onFocus={() => onActiveIndexChange(index)}
						className="flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-white/5 outline-none"
						style={{
							borderColor: isEnabled ? theme.colors.accent : theme.colors.border,
							backgroundColor: isEnabled ? `${theme.colors.accent}08` : 'transparent',
							// The ring rides the active tile, not :focus - the grid keeps
							// showing where the cursor is after focus leaves for the search box.
							boxShadow: isActive ? `0 0 0 2px ${theme.colors.accent}` : undefined,
						}}
					>
						<div className="flex items-start gap-2.5">
							<Icon
								className="w-5 h-5 mt-0.5 flex-shrink-0"
								style={{ color: isEnabled ? theme.colors.accent : theme.colors.textDim }}
							/>
							<div className="min-w-0 flex-1">
								<div
									className="text-sm font-bold flex items-center gap-1.5"
									style={{ color: theme.colors.textMain }}
								>
									<span className="truncate">{ext.name}</span>
									{ext.beta && (
										<span
											className="px-1 py-0.5 rounded text-[8px] font-bold uppercase flex-shrink-0"
											style={{
												backgroundColor: theme.colors.warning + '30',
												color: theme.colors.warning,
											}}
										>
											Beta
										</span>
									)}
								</div>
								<div
									className="text-xs mt-0.5 line-clamp-3"
									style={{ color: theme.colors.textDim }}
								>
									{ext.description || 'No description provided.'}
								</div>
							</div>
						</div>

						<div className="flex items-center gap-1.5 flex-wrap mt-auto pt-1">
							<span
								data-testid="extension-category"
								className="px-1.5 py-0.5 rounded text-[10px] font-medium"
								style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
							>
								{CATEGORY_LABELS[ext.category]}
							</span>
							<span
								data-testid="extension-state"
								className="px-1.5 py-0.5 rounded text-[10px] font-bold"
								style={{ backgroundColor: stateTone(ext) + '22', color: stateTone(ext) }}
							>
								{STATE_LABELS[ext.state]}
							</span>
							{ext.kind === 'plugin' && ext.tier !== undefined && (
								<span
									className="px-1.5 py-0.5 rounded text-[10px] font-medium"
									style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
								>
									Tier {ext.tier}
								</span>
							)}
							{trust && TrustIcon && (
								<span
									data-testid="extension-trust"
									className="px-1.5 py-0.5 rounded text-[10px] font-medium inline-flex items-center gap-1"
									style={{
										backgroundColor: theme.colors.bgActivity,
										color: theme.colors[trust.color],
									}}
								>
									<TrustIcon className="w-3 h-3" />
									{trust.label}
								</span>
							)}
							{ext.releaseDate && (
								<span
									data-testid="extension-release-date"
									data-release-date={ext.releaseDate}
									className="px-1.5 py-0.5 rounded text-[10px] font-medium ml-auto"
									style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
									title={`Released ${formatCalendarDay(ext.releaseDate)}`}
								>
									{formatCalendarDay(ext.releaseDate)}
								</span>
							)}
						</div>
					</button>
				);
			})}
		</div>
	);
}
