/**
 * Extensions (Encore) marketplace - the unified surface that lists first-party
 * Encore features AND community plugins as one tiled grid with category
 * filters, a search box, an "only installed" toggle, and a details pane.
 * Mounted in EncoreTab in place of the old plugins-only section.
 */

import { useMemo, useState } from 'react';
import { Search, FolderPlus, Puzzle } from 'lucide-react';
import type { EncoreFeatureFlags, Theme } from '../../../types';
import type { ReactNode } from 'react';
import { useExtensions } from './useExtensions';
import { ExtensionsGrid } from './ExtensionsGrid';
import { ExtensionDetails } from './ExtensionDetails';
import { FirstPartyEnableModal } from './FirstPartyEnableModal';
import {
	CATEGORY_FILTERS,
	CATEGORY_LABELS,
	filterExtensions,
	type CategoryFilter,
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
		encoreFeatures,
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

	const visible = useMemo(
		() => filterExtensions(extensions, { category, onlyInstalled, query }),
		[extensions, category, onlyInstalled, query]
	);

	// The selected tile, resolved against the live list so it stays fresh after
	// enable/disable/uninstall (and disappears if the plugin is removed).
	const selected = selectedKey ? extensions.find((e) => e.key === selectedKey) : undefined;

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
				<button
					type="button"
					data-testid="extensions-install"
					onClick={() => void installPlugin()}
					className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors hover:bg-white/5"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					<FolderPlus className="w-3.5 h-3.5" /> Install plugin…
				</button>
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
					encoreFeatures={encoreFeatures}
					contributions={contributions}
					busy={busyId === selected.id}
					onBack={() => setSelectedKey(null)}
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

					{/* Search + only-installed */}
					<div className="flex items-center gap-2 mb-4">
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
								placeholder="Search extensions…"
								className="bg-transparent flex-1 text-sm outline-none"
								style={{ color: theme.colors.textMain }}
								aria-label="Search extensions"
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
								className="relative w-8 h-4 rounded-full transition-colors"
								style={{
									backgroundColor: onlyInstalled ? theme.colors.accent : theme.colors.border,
								}}
							>
								<span
									className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
									style={{ transform: onlyInstalled ? 'translateX(18px)' : 'translateX(2px)' }}
								/>
							</span>
							Only installed
						</button>
					</div>

					<ExtensionsGrid
						theme={theme}
						extensions={visible}
						onSelect={(ext) => setSelectedKey(ext.key)}
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
