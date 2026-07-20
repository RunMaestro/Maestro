/**
 * Details pane for a single extension (first-party Encore feature or plugin).
 *
 * For a plugin it shows the full description, version/author, trust/signature,
 * the requested permissions (risk-colored, via getGrants), a contributions
 * summary (filtered by pluginId), and the lifecycle actions: Enable/Disable,
 * Configure (consent + a live editor for the plugin's contributed settings,
 * written to `plugins.<id>.*`), Revoke, and Uninstall. For a built-in feature
 * it shows the description and an enable toggle.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft, Power, Settings as SettingsIcon, Trash2, KeyRound } from 'lucide-react';
import type { Theme } from '../../../types';
import { capabilityRisk, describeCapability } from '../../../../shared/plugins/permissions';
import { PermissionList, RISK_COLOR } from './PermissionList';
import { AgentDispatchAllowlist } from './AgentDispatchAllowlist';
import type { PluginGrantsSnapshot } from '../../../../main/ipc/handlers/plugins';
import type {
	AggregatedContributions,
	SettingContribution,
} from '../../../../shared/plugins/contributions';
import type { PluginRecord } from '../../../../shared/plugins/plugin-registry';
import {
	CATEGORY_LABELS,
	STATE_LABELS,
	type ExtensionState,
	type UnifiedExtension,
} from './extensionModel';
import { FIRST_PARTY_PLUGINS } from '../../../../shared/plugins/first-party';
import { getModalActions } from '../../../stores/modalStore';

interface ExtensionDetailsProps {
	theme: Theme;
	ext: UnifiedExtension;
	contributions: AggregatedContributions | null;
	busy: boolean;
	onBack: () => void;
	onTogglePlugin: (record: PluginRecord) => void;
	onToggleBuiltin: (flag: NonNullable<UnifiedExtension['flag']>) => void;
	onUninstall: (record: PluginRecord) => void;
	onRevoke: (id: string) => void;
	getGrants: (id: string) => Promise<PluginGrantsSnapshot>;
	/** First-party feature config body rendered in the Settings sub-tab (from
	 * the Plugins tab). Absent for plugins and for features with no inline
	 * config (e.g. Pianola, whose config is its own modal). */
	settingsBody?: ReactNode;
}

/** A buckets→count summary of a plugin's contributions (only non-empty buckets). */
const CONTRIB_BUCKETS: ReadonlyArray<{
	label: string;
	pick: (c: AggregatedContributions) => ReadonlyArray<{ pluginId: string }>;
}> = [
	{ label: 'Themes', pick: (c) => c.themes },
	{ label: 'Prompts', pick: (c) => c.prompts },
	{ label: 'Settings', pick: (c) => c.settings },
	{ label: 'Command macros', pick: (c) => c.commandMacros },
	{ label: 'Cue triggers', pick: (c) => c.cueTriggers },
	{ label: 'Commands', pick: (c) => c.commands },
	{ label: 'Panels', pick: (c) => c.panels },
	{ label: 'Agents', pick: (c) => c.agents },
	{ label: 'Tools', pick: (c) => c.tools },
	{ label: 'Keybindings', pick: (c) => c.keybindings },
	{ label: 'UI items', pick: (c) => c.uiItems },
];

export function ExtensionDetails({
	theme,
	ext,
	contributions,
	busy,
	onBack,
	onTogglePlugin,
	onToggleBuiltin,
	onUninstall,
	onRevoke,
	getGrants,
	settingsBody,
}: ExtensionDetailsProps) {
	const [grants, setGrants] = useState<PluginGrantsSnapshot | null>(null);
	const [configureOpen, setConfigureOpen] = useState(false);
	const [settingValues, setSettingValues] = useState<Record<string, boolean | string | number>>({});
	const [activeSubTab, setActiveSubTab] = useState<'settings' | 'permissions'>('settings');

	const isPlugin = ext.kind === 'plugin';
	const record = ext.record;
	const isCodeTier = (ext.tier ?? 0) >= 1;

	// Load the plugin's requested/granted permissions whenever the selection
	// changes. First-party features disclose statically from their definition
	// (grants are minted host-side on enable), so no ledger round-trip.
	useEffect(() => {
		if (!isPlugin) {
			setGrants(null);
			return;
		}
		let cancelled = false;
		// Clear the previous plugin's snapshot synchronously so the async load
		// below can never pair plugin A's grant with plugin B's id (a stale-grant
		// window in the dispatch allow-list editor).
		setGrants(null);
		void getGrants(ext.id)
			.then((snap) => {
				if (!cancelled) setGrants(snap);
			})
			.catch(() => {
				if (!cancelled) setGrants(null);
			});
		return () => {
			cancelled = true;
		};
	}, [isPlugin, ext.id, getGrants]);

	const isPianola = !isPlugin && ext.flag === 'pianola';

	const pluginSettings: SettingContribution[] = contributions
		? contributions.settings.filter((s) => s.pluginId === ext.id)
		: [];
	const canConfigurePlugin = isPlugin && ext.state === 'enabled' && pluginSettings.length > 0;

	// The Settings sub-tab exists when there's something to configure: a
	// first-party config body, a configurable plugin, or Pianola's modal entry.
	const hasSettingsTab = Boolean(settingsBody) || canConfigurePlugin || isPianola;

	// Reset transient editor + sub-tab when switching extensions. Default to
	// Settings when it exists, else Permissions.
	useEffect(() => {
		setConfigureOpen(false);
		setSettingValues({});
		setActiveSubTab(hasSettingsTab ? 'settings' : 'permissions');
	}, [ext.key, hasSettingsTab]);

	const openConfigure = useCallback(async () => {
		if (!canConfigurePlugin) {
			setConfigureOpen(false);
			return;
		}
		// Requesting consent ensures the plugin holds the grants its settings back.
		try {
			await window.maestro.plugins.requestConsent(ext.id);
		} catch {
			setConfigureOpen(false);
			return;
		}
		setConfigureOpen(true);
		const next: Record<string, boolean | string | number> = {};
		for (const s of pluginSettings) {
			const raw = await window.maestro.settings.get(`plugins.${ext.id}.${s.key}`);
			let value: boolean | string | number = s.default;
			if (s.type === 'boolean' && typeof raw === 'boolean') value = raw;
			else if (s.type === 'string' && typeof raw === 'string') value = raw;
			else if (s.type === 'number' && typeof raw === 'number') value = raw;
			next[s.key] = value;
		}
		setSettingValues(next);
	}, [canConfigurePlugin, ext.id, pluginSettings]);

	const writeSetting = useCallback(
		(key: string, value: boolean | string | number) => {
			if (!canConfigurePlugin) return;
			setSettingValues((prev) => ({ ...prev, [key]: value }));
			void window.maestro.settings.set(`plugins.${ext.id}.${key}`, value);
		},
		[canConfigurePlugin, ext.id]
	);

	const stateColor = (state: ExtensionState): string =>
		state === 'enabled'
			? theme.colors.success
			: state === 'installed'
				? theme.colors.accent
				: theme.colors.textDim;

	const grantedCaps = new Set((grants?.granted ?? []).map((g) => g.capability));
	const toggleLabel = ext.state === 'enabled' ? 'Disable' : 'Enable';

	// First-party tiles surface their supervised background services; status
	// derives from the definition + the bridge-written flag state (enable
	// reconciles, disable stops) - no live process polling.
	const firstPartyServices =
		!isPlugin && ext.firstParty && ext.flag && ext.flag in FIRST_PARTY_PLUGINS
			? FIRST_PARTY_PLUGINS[ext.flag as keyof typeof FIRST_PARTY_PLUGINS].backgroundServices
			: [];

	return (
		<div data-testid="extension-details" className="select-text">
			<button
				type="button"
				data-testid="extension-details-back"
				onClick={onBack}
				className="flex items-center gap-1 text-sm mb-4 opacity-70 hover:opacity-100"
				style={{ color: theme.colors.textMain }}
			>
				<ChevronLeft className="w-4 h-4" /> All extensions
			</button>

			{/* Title + meta */}
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div
						className="text-base font-bold flex items-center gap-2"
						style={{ color: theme.colors.textMain }}
					>
						{ext.name}
						{ext.beta && (
							<span
								className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
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
						className="text-xs mt-1 flex items-center gap-2"
						style={{ color: theme.colors.textDim }}
					>
						{ext.version && <span>v{ext.version}</span>}
						{ext.author && <span>· {ext.author}</span>}
						<span>· {CATEGORY_LABELS[ext.category]}</span>
					</div>
				</div>
				<span
					data-testid="extension-details-state"
					className="px-2 py-0.5 rounded text-[11px] font-bold flex-shrink-0"
					style={{ backgroundColor: stateColor(ext.state) + '22', color: stateColor(ext.state) }}
				>
					{STATE_LABELS[ext.state]}
				</span>
			</div>

			<p className="text-sm mt-3" style={{ color: theme.colors.textMain }}>
				{ext.description || 'No description provided.'}
			</p>

			{isPlugin && ext.loadStatus && ext.loadStatus !== 'ok' && (
				<p className="text-xs mt-2" style={{ color: theme.colors.error }}>
					This plugin is {ext.loadStatus} and cannot be enabled.
					{record && record.errors.length > 0 ? ` ${record.errors.join('; ')}` : ''}
				</p>
			)}

			{/* FC1 Option-B gate: code execution requires a trusted signature.
			    unsigned/untrusted: code never runs, declarative contributions still
			    apply. invalid (tampered): the plugin is fully inert - getActiveRecords
			    excludes it, so even declarative contributions are dropped. */}
			{isPlugin && isCodeTier && ext.trust === 'invalid' && (
				<p
					data-testid="extension-code-disabled"
					className="text-xs mt-2"
					style={{ color: theme.colors.error }}
				>
					This plugin&apos;s files no longer match their signature (tampered). It is fully disabled:
					no code runs and no contributions apply. Reinstall it from a trusted source.
				</p>
			)}
			{isPlugin && isCodeTier && ext.trust !== 'trusted' && ext.trust !== 'invalid' && (
				<p
					data-testid="extension-code-disabled"
					className="text-xs mt-2"
					style={{ color: theme.colors.warning }}
				>
					Code execution requires a trusted signature - this plugin is{' '}
					{(ext.trust ?? 'unsigned') === 'unsigned' ? 'unsigned' : 'signed by an untrusted key'}.
					Its code will not run; declarative contributions (themes, prompts) still apply.
				</p>
			)}

			{/* Actions */}
			<div className="flex flex-wrap items-center gap-2 mt-4">
				<button
					type="button"
					data-testid="extension-enable-toggle"
					disabled={busy || (isPlugin && ext.loadStatus !== 'ok')}
					onClick={() => {
						if (isPlugin && record) onTogglePlugin(record);
						else if (ext.flag) onToggleBuiltin(ext.flag);
					}}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
				>
					<Power className="w-4 h-4" /> {toggleLabel}
				</button>

				{isPlugin && isCodeTier && (
					<button
						type="button"
						data-testid="extension-revoke"
						disabled={busy}
						onClick={() => onRevoke(ext.id)}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors hover:bg-white/5 disabled:opacity-50"
						style={{ borderColor: theme.colors.border, color: theme.colors.warning }}
					>
						<KeyRound className="w-4 h-4" /> Revoke
					</button>
				)}

				{isPlugin && record && (
					<button
						type="button"
						data-testid="extension-uninstall"
						disabled={busy}
						onClick={() => onUninstall(record)}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors hover:bg-white/5 disabled:opacity-50"
						style={{ borderColor: theme.colors.border, color: theme.colors.error }}
					>
						<Trash2 className="w-4 h-4" /> Uninstall
					</button>
				)}
			</div>

			{/* Sub-tabs: Settings (config) and Permissions (capabilities, services,
			    contributions). Settings only shows when there's something to
			    configure; otherwise the pane opens straight on Permissions. */}
			<div
				className="flex items-center gap-1 mt-5 border-b"
				style={{ borderColor: theme.colors.border }}
				role="tablist"
			>
				{hasSettingsTab && (
					<button
						type="button"
						role="tab"
						data-testid="extension-subtab-settings"
						aria-selected={activeSubTab === 'settings'}
						onClick={() => setActiveSubTab('settings')}
						className="px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors"
						style={{
							borderColor: activeSubTab === 'settings' ? theme.colors.accent : 'transparent',
							color: activeSubTab === 'settings' ? theme.colors.textMain : theme.colors.textDim,
						}}
					>
						Settings
					</button>
				)}
				<button
					type="button"
					role="tab"
					data-testid="extension-subtab-permissions"
					aria-selected={activeSubTab === 'permissions'}
					onClick={() => setActiveSubTab('permissions')}
					className="px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors"
					style={{
						borderColor: activeSubTab === 'permissions' ? theme.colors.accent : 'transparent',
						color: activeSubTab === 'permissions' ? theme.colors.textMain : theme.colors.textDim,
					}}
				>
					Permissions
				</button>
			</div>

			{activeSubTab === 'permissions' && (
				<>
					{/* First-party background services (supervised via the lifecycle bridge) */}
					{firstPartyServices.length > 0 && (
						<div className="mt-5">
							<div
								className="text-xs font-bold uppercase opacity-70 mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Background services
							</div>
							<div className="space-y-1.5">
								{firstPartyServices.map((service) => (
									<div
										key={service.id}
										data-testid="extension-background-service"
										data-service={service.id}
										className="flex items-start gap-2 rounded-lg border p-2"
										style={{ borderColor: theme.colors.border }}
									>
										<div className="min-w-0 flex-1">
											<div className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
												{service.id}
											</div>
											<div className="text-[10px] mt-0.5" style={{ color: theme.colors.textDim }}>
												{service.description}
											</div>
										</div>
										<span
											data-testid="extension-background-service-status"
											className="text-[10px] font-medium flex-shrink-0 mt-0.5"
											style={{
												color:
													ext.state === 'enabled' ? theme.colors.success : theme.colors.textDim,
											}}
										>
											{ext.state === 'enabled' ? 'Running (supervised)' : 'Stopped'}
										</span>
									</div>
								))}
							</div>
						</div>
					)}

					{/* Requested permissions */}
					{isPlugin && grants && grants.requested.length > 0 && (
						<div className="mt-5">
							<div
								className="text-xs font-bold uppercase opacity-70 mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Requested permissions
							</div>
							<div className="space-y-1.5">
								{grants.requested.map((req) => {
									const risk = capabilityRisk(req.capability);
									const color = theme.colors[RISK_COLOR[risk]];
									const granted = grantedCaps.has(req.capability);
									return (
										<div
											key={req.capability}
											data-testid="extension-permission"
											data-cap={req.capability}
											className="flex items-start gap-2 rounded-lg border p-2"
											style={{ borderColor: theme.colors.border }}
										>
											<span
												className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase flex-shrink-0 mt-0.5"
												style={{ backgroundColor: color + '22', color }}
											>
												{risk}
											</span>
											<div className="min-w-0 flex-1">
												<div className="text-xs" style={{ color: theme.colors.textMain }}>
													{describeCapability(req.capability)}
												</div>
												{req.scope && (
													<div
														className="text-[10px] font-mono mt-0.5"
														style={{ color: theme.colors.textDim }}
													>
														{req.scope}
													</div>
												)}
											</div>
											<span
												className="text-[10px] font-medium flex-shrink-0 mt-0.5"
												style={{ color: granted ? theme.colors.success : theme.colors.textDim }}
											>
												{granted ? 'Granted' : 'Not granted'}
											</span>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{/* Host-managed dispatch allow list (issue #1250): editable only once
					    the plugin holds a consented agents:dispatch grant. Widening it
					    re-mints the grant scope host-side - no plugin re-pack/re-sign. */}
					{isPlugin &&
						(() => {
							const dispatchGrant = grants?.granted.find((g) => g.capability === 'agents:dispatch');
							return dispatchGrant ? (
								<AgentDispatchAllowlist
									key={ext.id}
									theme={theme}
									pluginId={ext.id}
									grant={dispatchGrant}
									onSaved={setGrants}
								/>
							) : null;
						})()}

					{/* First-party permission disclosure: the capabilities the feature's
			    definition declares. Grants are minted host-side by the lifecycle
			    bridge when the tile is enabled (trusted by construction), so this
			    is static disclosure - no ledger round-trip. */}
					{!isPlugin && (ext.permissions?.length ?? 0) > 0 && (
						<div className="mt-5">
							<div
								className="text-xs font-bold uppercase opacity-70 mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Permissions
							</div>
							<PermissionList theme={theme} permissions={ext.permissions ?? []} />
						</div>
					)}

					{/* Contributions summary */}
					{isPlugin && contributions && (
						<div className="mt-5">
							<div
								className="text-xs font-bold uppercase opacity-70 mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Contributions
							</div>
							<div className="flex flex-wrap gap-1.5">
								{CONTRIB_BUCKETS.map((bucket) => {
									const count = bucket
										.pick(contributions)
										.filter((i) => i.pluginId === ext.id).length;
									if (count === 0) return null;
									return (
										<span
											key={bucket.label}
											className="px-1.5 py-0.5 rounded text-[10px]"
											style={{
												backgroundColor: theme.colors.bgActivity,
												color: theme.colors.textDim,
											}}
										>
											{bucket.label}: {count}
										</span>
									);
								})}
								{CONTRIB_BUCKETS.every(
									(b) => b.pick(contributions).filter((i) => i.pluginId === ext.id).length === 0
								) && (
									<span className="text-xs" style={{ color: theme.colors.textDim }}>
										No contributions.
									</span>
								)}
							</div>
						</div>
					)}
				</>
			)}

			{/* Settings sub-tab: first-party config body, plugin config editor, or
			    Pianola's modal entry - whichever applies to this extension. */}
			{activeSubTab === 'settings' && (
				<div className="mt-5" data-testid="extension-settings-panel">
					{/* First-party feature with an inline config body */}
					{!isPlugin && settingsBody ? (
						ext.state === 'enabled' ? (
							settingsBody
						) : (
							<div
								data-testid="extension-settings-disabled-hint"
								className="text-xs rounded-lg border p-3"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								Enable this plugin to configure it.
							</div>
						)
					) : null}

					{/* Pianola: config lives in its dedicated modal */}
					{isPianola &&
						(ext.state === 'enabled' ? (
							<button
								type="button"
								data-testid="extension-open-pianola"
								onClick={() => getModalActions().setPianolaModalOpen(true)}
								className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors hover:bg-white/5"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							>
								<SettingsIcon className="w-4 h-4" /> Open Pianola
							</button>
						) : (
							<div
								data-testid="extension-settings-disabled-hint"
								className="text-xs rounded-lg border p-3"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								Enable Pianola to open its manager and rules.
							</div>
						))}

					{/* Plugin: consent-gated live editor for contributed settings */}
					{isPlugin && canConfigurePlugin && (
						<div>
							{!configureOpen ? (
								<button
									type="button"
									data-testid="extension-configure"
									onClick={() => void openConfigure()}
									className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors hover:bg-white/5"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									<SettingsIcon className="w-4 h-4" /> Configure (grant + edit)
								</button>
							) : (
								<div className="space-y-3">
									{pluginSettings.map((setting) => {
										const current = settingValues[setting.key] ?? setting.default;
										return (
											<div key={setting.key} className="flex items-center justify-between gap-3">
												<div className="min-w-0">
													<div className="text-sm" style={{ color: theme.colors.textMain }}>
														{setting.key}
													</div>
													{setting.description && (
														<div className="text-[11px]" style={{ color: theme.colors.textDim }}>
															{setting.description}
														</div>
													)}
												</div>
												{setting.type === 'boolean' && (
													<input
														type="checkbox"
														data-testid="extension-setting-input"
														data-key={setting.key}
														checked={current === true}
														onChange={(e) => writeSetting(setting.key, e.target.checked)}
													/>
												)}
												{setting.type === 'string' && (
													<input
														type="text"
														data-testid="extension-setting-input"
														data-key={setting.key}
														value={typeof current === 'string' ? current : ''}
														onChange={(e) => writeSetting(setting.key, e.target.value)}
														className="px-2 py-1 rounded border text-sm w-48"
														style={{
															backgroundColor: theme.colors.bgMain,
															borderColor: theme.colors.border,
															color: theme.colors.textMain,
														}}
													/>
												)}
												{setting.type === 'number' && (
													<input
														type="number"
														data-testid="extension-setting-input"
														data-key={setting.key}
														value={typeof current === 'number' ? current : 0}
														onChange={(e) => writeSetting(setting.key, Number(e.target.value))}
														className="px-2 py-1 rounded border text-sm w-28"
														style={{
															backgroundColor: theme.colors.bgMain,
															borderColor: theme.colors.border,
															color: theme.colors.textMain,
														}}
													/>
												)}
											</div>
										);
									})}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
