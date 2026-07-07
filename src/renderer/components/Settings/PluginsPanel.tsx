/**
 * Plugins management panel (Settings -> Encore -> Plugins).
 *
 * Lists installed community plugins and lets the user enable/disable, install
 * (by picking a folder that contains a plugin.json), and uninstall them. Reads
 * window.maestro.plugins, which is gated in the main process on the `plugins`
 * Encore flag. Tier 0 (data) plugins apply on enable; tier 1 (code) plugins run
 * sandboxed and require permission consent before they are enabled.
 */

import { useState, useEffect, useCallback } from 'react';
import {
	Puzzle,
	Trash2,
	FolderPlus,
	RefreshCw,
	AlertTriangle,
	ShieldCheck,
	Play,
	PanelTop,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { PluginListSnapshot } from '../../../main/ipc/handlers/plugins';
import type { PluginRecord } from '../../../shared/plugins/plugin-registry';
import type {
	AggregatedContributions,
	PanelContribution,
} from '../../../shared/plugins/contributions';
import { notifyToast } from '../../stores/notificationStore';
import { PluginPanelHost } from './PluginPanelHost';
import { PluginPanelSlot } from '../plugins/PluginPanelSlot';
import { PluginActivityView } from './PluginActivityView';

interface PluginsPanelProps {
	theme: Theme;
}

function statusLabel(record: PluginRecord): { text: string; color: 'ok' | 'warn' | 'error' } {
	if (record.loadStatus === 'ok') {
		return record.enabled ? { text: 'Enabled', color: 'ok' } : { text: 'Disabled', color: 'warn' };
	}
	if (record.loadStatus === 'incompatible') return { text: 'Incompatible', color: 'error' };
	return { text: 'Invalid', color: 'error' };
}

export function PluginsPanel({ theme }: PluginsPanelProps) {
	const [snapshot, setSnapshot] = useState<PluginListSnapshot | null>(null);
	const [loading, setLoading] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [contributions, setContributions] = useState<AggregatedContributions | null>(null);
	const [openPanel, setOpenPanel] = useState<PanelContribution | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const snap = await window.maestro.plugins.list();
			setSnapshot(snap);
			// Contributions (commands/panels) are best-effort; ignore failures.
			try {
				setContributions(await window.maestro.plugins.contributions());
			} catch {
				setContributions(null);
			}
		} catch (err) {
			notifyToast({
				color: 'red',
				title: 'Plugins',
				message: `Failed to load plugins: ${String(err)}`,
			});
		} finally {
			setLoading(false);
		}
	}, []);

	const invokeCommand = useCallback(async (commandId: string, title: string) => {
		try {
			const result = await window.maestro.plugins.invokeCommand(commandId);
			notifyToast({
				color: result.dispatched ? 'green' : 'orange',
				title: 'Plugins',
				message: result.dispatched ? `Ran "${title}"` : `"${title}" is not running`,
			});
		} catch (err) {
			notifyToast({ color: 'red', title: 'Plugins', message: `Command failed: ${String(err)}` });
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// The host-owned consent window mints the grant and the main process then
	// enables the plugin, broadcasting 'plugins:changed'. Subscribe so the panel
	// reflects the new enabled/grant state without a manual reload (e.g. after the
	// user approves a code-tier plugin's permission prompt).
	useEffect(() => {
		const unsubscribe = window.maestro.plugins.onChanged(() => {
			void load();
		});
		return unsubscribe;
	}, [load]);

	const applyEnabled = useCallback(async (id: string, enabled: boolean) => {
		setBusyId(id);
		try {
			const snap = await window.maestro.plugins.setEnabled(id, enabled);
			setSnapshot(snap);
		} catch (err) {
			notifyToast({ color: 'red', title: 'Plugins', message: `Toggle failed: ${String(err)}` });
		} finally {
			setBusyId(null);
		}
	}, []);

	const handleToggle = useCallback(
		async (record: PluginRecord) => {
			if (record.loadStatus !== 'ok') return;
			// Disabling is always immediate. Enabling a tier-0 (data) plugin applies
			// directly. Enabling a code-tier plugin routes through the host-owned consent
			// window (plugins:request-consent): it collects per-capability approval and
			// mints the sealed grant, then the main process enables the plugin and pushes
			// a 'plugins:changed' update that reloads this panel. The renderer never
			// grants or enables code directly.
			const isCodeTier = (record.manifest?.tier ?? 0) >= 1;
			if (record.enabled || !isCodeTier) {
				await applyEnabled(record.id, !record.enabled);
				return;
			}
			try {
				await window.maestro.plugins.requestConsent(record.id);
			} catch (err) {
				notifyToast({
					color: 'red',
					title: 'Plugins',
					message: `Could not open the permission prompt: ${String(err)}`,
				});
			}
		},
		[applyEnabled]
	);

	const handleInstall = useCallback(async () => {
		const dir = await window.maestro.dialog.selectFolder();
		if (!dir) return;
		setLoading(true);
		try {
			const result = await window.maestro.plugins.install(dir);
			if (result.success) {
				notifyToast({
					color: 'green',
					title: 'Plugins',
					message: `Installed ${result.record?.manifest?.name ?? result.record?.id ?? 'plugin'}`,
				});
				await load();
			} else {
				notifyToast({
					color: 'orange',
					title: 'Plugins',
					message: `Install failed: ${result.error ?? 'unknown error'}`,
				});
			}
		} catch (err) {
			notifyToast({ color: 'red', title: 'Plugins', message: `Install failed: ${String(err)}` });
		} finally {
			setLoading(false);
		}
	}, [load]);

	const handleUninstall = useCallback(
		async (record: PluginRecord) => {
			setBusyId(record.id);
			try {
				const result = await window.maestro.plugins.uninstall(record.id);
				if (result.success) {
					notifyToast({ color: 'green', title: 'Plugins', message: `Uninstalled ${record.id}` });
					await load();
				} else {
					notifyToast({
						color: 'orange',
						title: 'Plugins',
						message: `Uninstall failed: ${result.error ?? 'unknown error'}`,
					});
				}
			} catch (err) {
				notifyToast({
					color: 'red',
					title: 'Plugins',
					message: `Uninstall failed: ${String(err)}`,
				});
			} finally {
				setBusyId(null);
			}
		},
		[load]
	);

	const records = snapshot?.plugins ?? [];
	const statusColor = (c: 'ok' | 'warn' | 'error'): string =>
		c === 'ok' ? theme.colors.success : c === 'warn' ? theme.colors.warning : theme.colors.error;

	return (
		<div
			className="px-4 pb-4 select-text"
			style={{ borderTop: `1px solid ${theme.colors.border}` }}
		>
			<div className="flex items-center justify-between pt-3 pb-2">
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Host API {snapshot?.hostApiVersion ?? '...'} - data plugins apply on enable; code plugins
					run sandboxed and ask for permission first.
				</div>
				<div className="flex items-center gap-2">
					<button
						className="flex items-center gap-1 px-2 py-1 rounded text-xs"
						style={{ color: theme.colors.textDim }}
						onClick={() => void load()}
						disabled={loading}
						title="Refresh"
					>
						<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
					</button>
					<button
						className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium"
						style={{ backgroundColor: theme.colors.accent, color: '#fff' }}
						onClick={() => void handleInstall()}
						disabled={loading}
					>
						<FolderPlus className="w-3.5 h-3.5" />
						Install from folder
					</button>
				</div>
			</div>

			{records.length === 0 ? (
				<div className="text-xs italic py-4 text-center" style={{ color: theme.colors.textDim }}>
					{loading
						? 'Loading...'
						: 'No plugins installed. Install one from a folder to get started.'}
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{records.map((record) => {
						const status = statusLabel(record);
						return (
							<div
								key={record.id}
								className="rounded-lg border p-3"
								style={{ borderColor: theme.colors.border }}
							>
								<div className="flex items-start justify-between gap-3">
									<div className="flex items-start gap-2.5 min-w-0">
										<Puzzle
											className="w-4 h-4 mt-0.5 shrink-0"
											style={{ color: theme.colors.textDim }}
										/>
										<div className="min-w-0">
											<div
												className="text-sm font-semibold flex items-center gap-2"
												style={{ color: theme.colors.textMain }}
											>
												<span className="truncate">{record.manifest?.name ?? record.id}</span>
												{record.manifest && (
													<span
														className="text-[10px] font-normal"
														style={{ color: theme.colors.textDim }}
													>
														v{record.manifest.version}
													</span>
												)}
												<span
													className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
													style={{
														backgroundColor: statusColor(status.color) + '25',
														color: statusColor(status.color),
													}}
												>
													{status.text}
												</span>
												{record.signature && record.signature.status !== 'unsigned' && (
													<span
														className="inline-flex items-center gap-0.5 text-[10px]"
														style={{
															color:
																record.signature.status === 'trusted'
																	? theme.colors.success
																	: record.signature.status === 'invalid'
																		? theme.colors.error
																		: theme.colors.warning,
														}}
														title={record.signature.detail ?? record.signature.status}
													>
														<ShieldCheck className="w-3 h-3" />
														{record.signature.status}
													</span>
												)}
											</div>
											<div
												className="text-[11px] mt-0.5 truncate"
												style={{ color: theme.colors.textDim }}
											>
												{record.id}
											</div>
											{record.manifest?.description && (
												<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
													{record.manifest.description}
												</div>
											)}
											{record.errors.length > 0 && (
												<div
													className="text-[11px] mt-1.5 flex items-start gap-1"
													style={{ color: theme.colors.error }}
												>
													<AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
													<span>{record.errors.join('; ')}</span>
												</div>
											)}
										</div>
									</div>

									<div className="flex items-center gap-2 shrink-0">
										{record.loadStatus === 'ok' && (
											<button
												className={`relative w-9 h-5 rounded-full transition-colors ${busyId === record.id ? 'opacity-50' : ''}`}
												style={{
													backgroundColor: record.enabled
														? theme.colors.accent
														: theme.colors.border,
												}}
												onClick={() => void handleToggle(record)}
												disabled={busyId === record.id}
												title={record.enabled ? 'Disable' : 'Enable'}
											>
												<div
													className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
													style={{
														transform: record.enabled ? 'translateX(18px)' : 'translateX(2px)',
													}}
												/>
											</button>
										)}
										<button
											className="p-1.5 rounded"
											style={{ color: theme.colors.error }}
											onClick={() => void handleUninstall(record)}
											disabled={busyId === record.id}
											title="Uninstall"
										>
											<Trash2 className="w-4 h-4" />
										</button>
									</div>
								</div>

								{record.enabled &&
									(() => {
										const cmds =
											contributions?.commands.filter((c) => c.pluginId === record.id) ?? [];
										const panels =
											contributions?.panels.filter((p) => p.pluginId === record.id) ?? [];
										if (cmds.length === 0 && panels.length === 0) return null;
										return (
											<div
												className="mt-2.5 pt-2.5 flex flex-wrap gap-1.5"
												style={{ borderTop: `1px solid ${theme.colors.border}` }}
											>
												{cmds.map((cmd) => (
													<button
														key={cmd.id}
														className="flex items-center gap-1 px-2 py-1 rounded text-[11px]"
														style={{
															backgroundColor: theme.colors.accent + '18',
															color: theme.colors.accent,
														}}
														onClick={() => void invokeCommand(cmd.id, cmd.title)}
														title={cmd.description ?? cmd.title}
													>
														<Play className="w-3 h-3" />
														{cmd.title}
													</button>
												))}
												{panels.map((panel) => (
													<button
														key={panel.id}
														className="flex items-center gap-1 px-2 py-1 rounded text-[11px]"
														style={{
															backgroundColor: theme.colors.accent + '18',
															color: theme.colors.accent,
														}}
														onClick={() => setOpenPanel(panel)}
														title={`Open ${panel.title}`}
													>
														<PanelTop className="w-3 h-3" />
														{panel.title}
													</button>
												))}
											</div>
										);
									})()}
							</div>
						);
					})}
				</div>
			)}

			{/* Read-only per-plugin observability for running tier-1 plugins. */}
			<PluginActivityView theme={theme} records={records} />

			{/* Plugin panels that dock into Settings (placement: 'settings'). Each
			    renders in the same locked-down sandboxed iframe with provenance. */}
			<PluginPanelSlot
				theme={theme}
				placement="settings"
				className="mt-4 flex flex-col overflow-hidden rounded-lg border h-[440px]"
			/>

			{openPanel && (
				<PluginPanelHost theme={theme} panel={openPanel} onClose={() => setOpenPanel(null)} />
			)}
		</div>
	);
}
