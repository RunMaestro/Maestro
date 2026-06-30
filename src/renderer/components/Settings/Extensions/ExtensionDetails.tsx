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

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Power, Settings as SettingsIcon, Trash2, KeyRound } from 'lucide-react';
import type { Theme } from '../../../types';
import {
	capabilityRisk,
	describeCapability,
	type CapabilityRisk,
} from '../../../../shared/plugins/permissions';
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
}

const RISK_COLOR: Record<CapabilityRisk, 'success' | 'warning' | 'error'> = {
	low: 'success',
	medium: 'warning',
	high: 'error',
};

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
}: ExtensionDetailsProps) {
	const [grants, setGrants] = useState<PluginGrantsSnapshot | null>(null);
	const [configureOpen, setConfigureOpen] = useState(false);
	const [settingValues, setSettingValues] = useState<Record<string, boolean | string | number>>({});

	const isPlugin = ext.kind === 'plugin';
	const record = ext.record;
	const isCodeTier = (ext.tier ?? 0) >= 1;

	// Load the plugin's requested/granted permissions whenever the selection
	// changes. Built-in features have no permission surface.
	useEffect(() => {
		if (!isPlugin) {
			setGrants(null);
			return;
		}
		let cancelled = false;
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

	// Reset the configure editor when switching extensions.
	useEffect(() => {
		setConfigureOpen(false);
		setSettingValues({});
	}, [ext.key]);

	const pluginSettings: SettingContribution[] = contributions
		? contributions.settings.filter((s) => s.pluginId === ext.id)
		: [];
	const canConfigurePlugin = isPlugin && ext.state === 'enabled' && pluginSettings.length > 0;

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

				{canConfigurePlugin && (
					<button
						type="button"
						data-testid="extension-configure"
						onClick={() => void openConfigure()}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors hover:bg-white/5"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<SettingsIcon className="w-4 h-4" /> Configure
					</button>
				)}

				{!isPlugin && ext.flag === 'pianola' && ext.state === 'enabled' && (
					<button
						type="button"
						data-testid="extension-open-pianola"
						onClick={() => getModalActions().setPianolaModalOpen(true)}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors hover:bg-white/5"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<SettingsIcon className="w-4 h-4" /> Open Pianola
					</button>
				)}

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
							const count = bucket.pick(contributions).filter((i) => i.pluginId === ext.id).length;
							if (count === 0) return null;
							return (
								<span
									key={bucket.label}
									className="px-1.5 py-0.5 rounded text-[10px]"
									style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
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

			{/* Configure: live editor for the plugin's contributed settings */}
			{isPlugin && canConfigurePlugin && configureOpen && (
				<div className="mt-5">
					<div
						className="text-xs font-bold uppercase opacity-70 mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Configure
					</div>
					{pluginSettings.length === 0 ? (
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							This plugin contributes no configurable settings.
						</div>
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

			{!isPlugin && (
				<p className="text-xs mt-4" style={{ color: theme.colors.textDim }}>
					This is a built-in Maestro feature. Detailed configuration lives in its section on the
					Encore Features tab.
				</p>
			)}
		</div>
	);
}
