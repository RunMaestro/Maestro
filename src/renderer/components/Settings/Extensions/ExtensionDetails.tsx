/**
 * Details pane for a single extension (first-party Encore feature or plugin).
 *
 * For a plugin it shows the full description, version/author, trust/signature,
 * the requested permissions (risk-colored, via getGrants), a contributions
 * summary (filtered by pluginId), and the lifecycle actions: Enable/Disable,
 * Configure (consent + a live editor for the plugin's contributed settings,
 * written to `plugins.<id>.*`), Revoke, and Uninstall. For a built-in feature
 * it shows the description and an enable toggle.
 *
 * Every extension gets the same frame: title, meta, and the Enable switch
 * pinned in the header row, the one-line description,
 * then the Help | Settings | Permissions sub-tabs. The usage guide lives in the
 * Help tab, so a long guide never pushes the switch down the pane and every
 * tile puts it in the same place.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { HelpCircle, Settings as SettingsIcon, Trash2, KeyRound, RefreshCw } from 'lucide-react';
import type { EncoreFeatureFlags, Theme } from '../../../types';
import { capabilityRisk, describeCapability } from '../../../../shared/plugins/permissions';
import { formatCalendarDay } from '../../../../shared/formatters';
import { PermissionList, RISK_COLOR } from './PermissionList';
import { UsageGuide } from './UsageGuide';
import { ToggleSwitchTrack } from '../../ui/ToggleSwitch';
import { AgentDispatchAllowlist } from './AgentDispatchAllowlist';
import { WebLoginUsers } from './WebLoginUsers';
import type { PluginGrantsSnapshot } from '../../../../main/ipc/handlers/plugins';
import type {
	AggregatedContributions,
	SettingContribution,
} from '../../../../shared/plugins/contributions';
import { collectContributions } from '../../../../shared/plugins/contributions';
import type { PluginRecord } from '../../../../shared/plugins/plugin-registry';
import {
	CATEGORY_LABELS,
	extensionBadge,
	isDependencyMet,
	type UnifiedExtension,
} from './extensionModel';
import { FIRST_PARTY_PLUGINS } from '../../../../shared/plugins/first-party';
import { pluginSettingsId } from '../../../../shared/plugins/panel-host';
import { getModalActions, useModalStore } from '../../../stores/modalStore';
import { launchFromSettings } from '../../../utils/launchFromSettings';
import type { EncoreTileRequest } from '../tabs/EncoreTab/types';

interface ExtensionDetailsProps {
	theme: Theme;
	ext: UnifiedExtension;
	encoreFeatures?: EncoreFeatureFlags;
	contributions: AggregatedContributions | null;
	busy: boolean;
	onTogglePlugin: (record: PluginRecord) => void;
	onToggleBuiltin: (flag: NonNullable<UnifiedExtension['flag']>) => void;
	onUpdate?: (record: PluginRecord) => void;
	onUninstall: (record: PluginRecord) => void;
	onRevoke: (id: string) => void;
	getGrants: (id: string) => Promise<PluginGrantsSnapshot>;
	/** First-party feature config body rendered in the Settings sub-tab (from
	 * the Plugins tab). Absent for plugins and for features with no inline
	 * config (e.g. Pianola, whose config is its own modal). */
	settingsBody?: ReactNode;
	/** A deep link into this tile's settings. Each new request shows the
	 * Settings sub-tab, even when the pane was already open on Help. */
	settingsRequest?: EncoreTileRequest | null;
}

type ExtensionSubTab = 'help' | 'settings' | 'permissions';

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
	encoreFeatures,
	contributions,
	busy,
	onTogglePlugin,
	onToggleBuiltin,
	onUpdate,
	onUninstall,
	onRevoke,
	getGrants,
	settingsBody,
	settingsRequest,
}: ExtensionDetailsProps) {
	// Grants are tagged with the plugin they belong to, so switching plugins never
	// reads the previous plugin's snapshot before the new plugin's async load
	// resolves. `grants` is derived and stays null until THIS plugin's snapshot has
	// loaded - a synchronous render guard that closes the stale-grant window (a
	// plugin id could otherwise pair with the wrong grant for one render).
	const [grantsState, setGrantsState] = useState<{
		pluginId: string;
		snapshot: PluginGrantsSnapshot;
	} | null>(null);
	const grants = grantsState?.pluginId === ext.id ? grantsState.snapshot : null;
	const [configureOpen, setConfigureOpen] = useState(false);
	const [settingValues, setSettingValues] = useState<Record<string, boolean | string | number>>({});
	const [activeSubTab, setActiveSubTab] = useState<ExtensionSubTab>('help');
	// Read when the user switches extensions, NOT a dependency of that reset:
	// flipping the switch must never yank the user off the tab they are on.
	const extStateRef = useRef(ext.state);
	extStateRef.current = ext.state;

	const isPlugin = ext.kind === 'plugin';
	const record = ext.record;
	const grantsLoadGeneration = useRef(0);
	const isCodeTier = (ext.tier ?? 0) >= 1;

	// Refresh grants without mounting any executable panel inside management.
	useEffect(() => {
		let cancelled = false;
		setGrantsState(null);
		if (!isPlugin) return;
		const load = () => {
			const generation = ++grantsLoadGeneration.current;
			void getGrants(ext.id)
				.then((snapshot) => {
					if (!cancelled && generation === grantsLoadGeneration.current)
						setGrantsState({ pluginId: ext.id, snapshot });
				})
				.catch(() => {
					if (!cancelled && generation === grantsLoadGeneration.current) setGrantsState(null);
				});
		};
		load();
		const unsubscribe = window.maestro.plugins.onChanged(() => load());
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [
		isPlugin,
		ext.id,
		getGrants,
		record?.enabled,
		record?.manifest?.version,
		record?.loadStatus,
		record?.signature?.status,
	]);

	const isBoard = !isPlugin && ext.flag === 'board';
	const isPianola = !isPlugin && ext.flag === 'pianola';
	// Web Login manages its accounts in its own tile: the channels behind that
	// pane are desktop-only, so there is nowhere else they could be offered.
	const isWebLogin = !isPlugin && ext.flag === 'webLogin';

	const pluginSettings: SettingContribution[] = contributions
		? contributions.settings.filter((s) => s.pluginId === ext.id)
		: [];
	const declared =
		isPlugin &&
		record?.manifest &&
		record.loadStatus === 'ok' &&
		record.signature?.status !== 'invalid'
			? collectContributions(record.manifest)
			: null;
	const settingsPanels = declared?.panels.filter((panel) => panel.placement === 'settings') ?? [];

	const canConfigurePlugin = isPlugin && ext.state === 'enabled' && pluginSettings.length > 0;

	// The Settings sub-tab exists when there's something to configure: a
	// first-party config body, a configurable plugin, or Pianola's modal entry.
	const hasSettingsTab =
		Boolean(settingsBody) ||
		canConfigurePlugin ||
		Boolean(declared?.settings.length) ||
		isPianola ||
		isWebLogin ||
		settingsPanels.length > 0;

	// Reset transient editor + sub-tab when switching extensions. Something not
	// yet enabled opens on Help (the user is deciding whether to turn it on);
	// something enabled opens on Settings when it has any, else on Help.
	useEffect(() => {
		setConfigureOpen(false);
		setSettingValues({});
		setActiveSubTab(extStateRef.current === 'enabled' && hasSettingsTab ? 'settings' : 'help');
	}, [ext.key, hasSettingsTab]);

	useEffect(() => {
		if (settingsRequest && hasSettingsTab) setActiveSubTab('settings');
	}, [settingsRequest, hasSettingsTab]);

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

	const grantedCaps = new Set((grants?.granted ?? []).map((g) => g.capability));
	// Dependency gate (e.g. Board requires Maestro Cue): block ENABLING until the
	// required flag is on. Disabling stays allowed so a feature can always be
	// turned off. Mirrors the main-process dispatcher's dual-gate.
	const dependencyMet = encoreFeatures ? isDependencyMet(ext, encoreFeatures) : true;
	const dependencyName =
		ext.dependsOn && ext.dependsOn in FIRST_PARTY_PLUGINS
			? FIRST_PARTY_PLUGINS[ext.dependsOn as keyof typeof FIRST_PARTY_PLUGINS].name
			: ext.dependsOn;
	const enableBlockedByDependency = !isPlugin && !dependencyMet && ext.state !== 'enabled';

	const isEnabled = ext.state === 'enabled';
	const toggleBlocked = busy || (isPlugin && ext.loadStatus !== 'ok');

	// First-party tiles surface their supervised background services; status
	// derives from the definition + the bridge-written flag state (enable
	// reconciles, disable stops) - no live process polling.
	const firstPartyServices =
		!isPlugin && ext.firstParty && ext.flag && ext.flag in FIRST_PARTY_PLUGINS
			? FIRST_PARTY_PLUGINS[ext.flag as keyof typeof FIRST_PARTY_PLUGINS].backgroundServices
			: [];

	const badge = extensionBadge(ext);

	return (
		<div data-testid="extension-details" className="select-text">
			{/* The way back lives in the view's header row, where the grid's
			    "Install plugin…" button sits - see ExtensionsView. */}
			{/* Title + meta */}
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div
						className="text-base font-bold flex items-center gap-2"
						style={{ color: theme.colors.textMain }}
					>
						{ext.name}
						{badge && (
							<span
								data-testid="extension-details-badge"
								data-badge={badge.label}
								className="px-1.5 py-0.5 rounded text-3xs font-bold uppercase"
								style={{
									backgroundColor: theme.colors[badge.tone] + '30',
									color: theme.colors[badge.tone],
								}}
							>
								{badge.label}
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
						{ext.releaseDate && (
							<span data-testid="extension-details-release-date">
								· Released {formatCalendarDay(ext.releaseDate)}
							</span>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2 flex-shrink-0">
					{/* One switch for every tile, always in this spot. The label and
					    the pill share one role="switch" button (a nested button
					    would be invalid), the same shape as the Cue header. */}
					<button
						type="button"
						role="switch"
						aria-checked={isEnabled}
						aria-label={isEnabled ? `Disable ${ext.name}` : `Enable ${ext.name}`}
						data-testid="extension-enable-toggle"
						disabled={toggleBlocked || enableBlockedByDependency}
						title={enableBlockedByDependency ? `Requires ${dependencyName}` : undefined}
						onClick={() => {
							if (isPlugin && record) onTogglePlugin(record);
							else if (ext.flag) onToggleBuiltin(ext.flag);
						}}
						className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs-plus font-bold transition-colors disabled:opacity-50"
						style={{
							backgroundColor: isEnabled ? theme.colors.success + '22' : theme.colors.bgActivity,
							color: isEnabled ? theme.colors.success : theme.colors.textDim,
						}}
					>
						<span data-testid="extension-details-state">{isEnabled ? 'Enabled' : 'Disabled'}</span>
						<ToggleSwitchTrack
							checked={isEnabled}
							theme={theme}
							busy={busy}
							activeColor={theme.colors.success}
						/>
					</button>
				</div>
			</div>

			{enableBlockedByDependency && (
				<span
					data-testid="extension-dependency-hint"
					className="text-xs"
					style={{ color: theme.colors.textDim }}
				>
					Requires {dependencyName}. Enable it first.
				</span>
			)}

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

			{/* Plugin lifecycle actions. Enable/Disable is the header switch. */}
			{isPlugin && (
				<div className="flex flex-wrap items-center gap-2 mt-4">
					{isCodeTier && (
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

					{record && (
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
					{record && onUpdate && (
						<button
							type="button"
							data-testid="extension-update"
							disabled={busy}
							onClick={() => onUpdate(record)}
							className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors disabled:opacity-50"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							title="Choose a folder with a newer version of this plugin"
						>
							<RefreshCw className="w-4 h-4" /> Update from folder…
						</button>
					)}
				</div>
			)}

			{/* Sub-tabs: Help (the usage guide), Settings (config), and Permissions
			    (capabilities, services, contributions). Help is always there;
			    Settings only when there's something to configure. */}
			<div
				className="flex items-center gap-1 mt-5 border-b"
				style={{ borderColor: theme.colors.border }}
				role="tablist"
			>
				<button
					type="button"
					role="tab"
					data-testid="extension-subtab-help"
					aria-selected={activeSubTab === 'help'}
					onClick={() => setActiveSubTab('help')}
					className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors"
					style={{
						borderColor: activeSubTab === 'help' ? theme.colors.accent : 'transparent',
						color: activeSubTab === 'help' ? theme.colors.textMain : theme.colors.textDim,
					}}
				>
					<HelpCircle className="w-3.5 h-3.5" />
					Help
				</button>
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

			{activeSubTab === 'help' && (
				<div className="mt-1" data-testid="extension-help-panel">
					{ext.usage ? (
						<UsageGuide theme={theme} usage={ext.usage} />
					) : (
						<p
							data-testid="extension-help-missing"
							className="mt-4 text-xs rounded-lg border p-3"
							style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
						>
							{ext.name} does not ship a usage guide. The description above is everything its author
							provided.
						</p>
					)}
				</div>
			)}

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
											<div className="text-2xs mt-0.5" style={{ color: theme.colors.textDim }}>
												{service.description}
											</div>
										</div>
										<span
											data-testid="extension-background-service-status"
											className="text-2xs font-medium flex-shrink-0 mt-0.5"
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
												className="px-1.5 py-0.5 rounded text-3xs font-bold uppercase flex-shrink-0 mt-0.5"
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
														className="text-2xs font-mono mt-0.5"
														style={{ color: theme.colors.textDim }}
													>
														{req.scope}
													</div>
												)}
											</div>
											<span
												className="text-2xs font-medium flex-shrink-0 mt-0.5"
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
									onSaved={(snap) => setGrantsState({ pluginId: ext.id, snapshot: snap })}
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
											className="px-1.5 py-0.5 rounded text-2xs"
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

					{/* Web Login: the accounts are the configuration. With the flag off
					    the gate is not consulted at all, so managing accounts there
					    would be editing something nothing reads. */}
					{isWebLogin &&
						(ext.state === 'enabled' ? (
							<WebLoginUsers theme={theme} />
						) : (
							<div
								data-testid="extension-settings-disabled-hint"
								className="text-xs rounded-lg border p-3"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								Enable Web Login to manage accounts.
							</div>
						))}

					{/* Pianola: config lives in its dedicated modal, which renders below
					    Settings - so the launch closes Settings first. */}
					{isPianola &&
						(ext.state === 'enabled' ? (
							<button
								type="button"
								data-testid="extension-open-pianola"
								onClick={() =>
									launchFromSettings(() => getModalActions().setPianolaModalOpen(true))
								}
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

					{isPlugin &&
						ext.state !== 'enabled' &&
						declared &&
						(settingsPanels.length > 0 || declared.settings.length > 0) && (
							<div
								data-testid="extension-plugin-settings-status"
								className="text-xs rounded-lg border p-3"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								Select Enable to review permissions for this version. Plugin content stays disabled.
							</div>
						)}
					{settingsPanels.map((panel) => (
						<button
							key={panel.id}
							disabled={
								ext.state !== 'enabled' ||
								record?.signature?.status !== 'trusted' ||
								!grantedCaps.has('ui:panel') ||
								!contributions?.panels.some(
									(active) => active.id === panel.id && active.pluginId === ext.id
								)
							}
							type="button"
							className="w-full px-3 py-2 rounded border text-sm disabled:opacity-50"
							style={{ borderColor: theme.colors.border }}
							onClick={() =>
								useModalStore
									.getState()
									.openModal('settings', { tab: 'encore', settingId: pluginSettingsId(panel.id) })
							}
						>
							Open {panel.title}
						</button>
					))}

					{/* Board: the kanban surface lives in its own modal. The open action
					    also requires the Cue dependency: with Cue off the modal will not
					    mount (AppStandaloneModals), so an active button would be a no-op. */}
					{isBoard &&
						(ext.state === 'enabled' && dependencyMet ? (
							<button
								type="button"
								data-testid="extension-open-board"
								onClick={() => getModalActions().setBoardModalOpen(true)}
								className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors hover:bg-white/5"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							>
								<SettingsIcon className="w-4 h-4" /> Open Board
							</button>
						) : (
							<div
								data-testid="extension-settings-disabled-hint"
								className="text-xs rounded-lg border p-3"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								{ext.state === 'enabled'
									? `Enable ${dependencyName ?? 'Maestro Cue'} to open the Board.`
									: 'Enable Board to open its kanban surface.'}
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
														<div className="text-xs-plus" style={{ color: theme.colors.textDim }}>
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
