/**
 * Coworking Setup panel - shown inside the Coworking section of the Encore tab.
 *
 * Lists every supported agent with its current install status and per-agent
 * Install / Uninstall buttons, plus an "Install for all" convenience button.
 *
 * Install writes the `maestro-coworking` MCP entry into the agent's user-level
 * config file (e.g. `~/.claude.json`, `~/.codex/config.toml`). After install,
 * the user must restart any open agent tabs of that type for the change to be
 * picked up - we surface that explicitly via toast.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Download, Loader2, RefreshCw, X } from 'lucide-react';
import type { Theme } from '../../types';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import type { AgentId } from '../../../shared/agentIds';
import { notifyToast } from '../../stores/notificationStore';
import { useSettingsStore } from '../../stores/settingsStore';

interface CoworkingInstallStatus {
	agentId: string;
	configPath: string;
	installed: boolean;
}

export interface CoworkingSetupProps {
	theme: Theme;
}

export function CoworkingSetup({ theme }: CoworkingSetupProps) {
	const [statuses, setStatuses] = useState<CoworkingInstallStatus[]>([]);
	const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
	const [busyAll, setBusyAll] = useState(false);
	const [loading, setLoading] = useState(true);
	const browserInteractionAgents = useSettingsStore((s) => s.coworkingBrowserInteraction);
	const setBrowserInteractionAgents = useSettingsStore((s) => s.setCoworkingBrowserInteraction);
	const toggleInteraction = useCallback(
		(agentId: string) => {
			const isEnabled = browserInteractionAgents.includes(agentId);
			setBrowserInteractionAgents(
				isEnabled
					? browserInteractionAgents.filter((a) => a !== agentId)
					: [...browserInteractionAgents, agentId]
			);
		},
		[browserInteractionAgents, setBrowserInteractionAgents]
	);
	const browserConfirm = useSettingsStore((s) => s.coworkingBrowserInteractionConfirm);
	const setBrowserConfirm = useSettingsStore((s) => s.setCoworkingBrowserInteractionConfirm);
	const cycleConfirmPolicy = useCallback(
		(agentId: string) => {
			const current = browserConfirm[agentId] ?? 'dangerous';
			const next = current === 'dangerous' ? 'all' : current === 'all' ? 'off' : 'dangerous';
			setBrowserConfirm({ ...browserConfirm, [agentId]: next });
		},
		[browserConfirm, setBrowserConfirm]
	);
	const backgroundBrowsers = useSettingsStore((s) => s.coworkingBackgroundBrowsers);
	const setBackgroundBrowsers = useSettingsStore((s) => s.setCoworkingBackgroundBrowsers);
	const backgroundLimit = useSettingsStore((s) => s.coworkingBackgroundBrowsersLimit);
	const setBackgroundLimit = useSettingsStore((s) => s.setCoworkingBackgroundBrowsersLimit);

	const refresh = useCallback(async () => {
		// Defensive: in test harnesses (or older preload bundles) the namespace
		// may not exist. Treat as "no agents detected" rather than crashing.
		const bridge = window.maestro?.coworking;
		if (!bridge) {
			setStatuses([]);
			setLoading(false);
			return;
		}
		try {
			const next = await bridge.getInstallStatus();
			setStatuses(next);
		} catch (err) {
			notifyToast({
				color: 'red',
				title: 'Coworking',
				message: `Could not read install status: ${err instanceof Error ? err.message : String(err)}`,
			});
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const handleInstall = useCallback(
		async (agentId: string) => {
			// Don't let two mutations race on the same user-level config file.
			if (busyAll || busyAgentId) return;
			setBusyAgentId(agentId);
			try {
				await window.maestro.coworking.install(agentId);
				notifyToast({
					color: 'green',
					title: 'Coworking installed',
					message: `${getAgentDisplayName(agentId as AgentId)} will see terminals on its next launch. Restart any open ${getAgentDisplayName(agentId as AgentId)} tabs to pick up the change.`,
				});
				await refresh();
			} catch (err) {
				notifyToast({
					color: 'red',
					title: 'Coworking install failed',
					message: err instanceof Error ? err.message : String(err),
				});
			} finally {
				setBusyAgentId(null);
			}
		},
		[busyAll, busyAgentId, refresh]
	);

	const handleUninstall = useCallback(
		async (agentId: string) => {
			if (busyAll || busyAgentId) return;
			setBusyAgentId(agentId);
			try {
				await window.maestro.coworking.uninstall(agentId);
				notifyToast({
					color: 'theme',
					title: 'Coworking uninstalled',
					message: `${getAgentDisplayName(agentId as AgentId)} will stop seeing terminals after its next launch.`,
				});
				await refresh();
			} catch (err) {
				notifyToast({
					color: 'red',
					title: 'Coworking uninstall failed',
					message: err instanceof Error ? err.message : String(err),
				});
			} finally {
				setBusyAgentId(null);
			}
		},
		[busyAll, busyAgentId, refresh]
	);

	const handleInstallAll = useCallback(async () => {
		// Don't let bulk install race with a per-agent mutation already in flight.
		if (busyAll || busyAgentId) return;
		setBusyAll(true);
		try {
			const results = await window.maestro.coworking.installAll();
			const failures = results.filter((r) => !r.ok);
			if (failures.length === 0) {
				notifyToast({
					color: 'green',
					title: 'Coworking installed',
					message: `Installed for ${results.length} agents. Restart any open agent tabs to pick up the change.`,
				});
			} else {
				notifyToast({
					color: 'orange',
					title: 'Coworking partially installed',
					message: `Failed for: ${failures.map((f) => f.agentId).join(', ')}. See system log for details.`,
				});
			}
			await refresh();
		} catch (err) {
			notifyToast({
				color: 'red',
				title: 'Coworking install failed',
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusyAll(false);
		}
	}, [busyAll, busyAgentId, refresh]);

	const allInstalled = useMemo(
		() => statuses.length > 0 && statuses.every((s) => s.installed),
		[statuses]
	);

	const anyBusy = busyAll || busyAgentId !== null;

	return (
		<div className="px-4 pb-4 pt-3 space-y-3 border-t" style={{ borderColor: theme.colors.border }}>
			<div className="flex items-center justify-between">
				<div>
					<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						Coworking Setup
					</div>
					<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
						Install the Maestro coworking MCP server into each agent's user-level config so the
						agent can read terminal scrollback and browser tabs on demand. Enable "Interaction" per
						agent to also let it drive browser tabs (navigate, click, type, eval, screenshot).
					</div>
				</div>
				<button
					onClick={refresh}
					disabled={loading}
					title="Refresh install status"
					className="p-1.5 rounded transition-colors hover:bg-white/10 disabled:opacity-40"
					style={{ color: theme.colors.textDim }}
				>
					<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
				</button>
			</div>

			<div
				data-setting-id="coworking-background-browsers"
				className="flex items-center justify-between px-3 py-2 rounded"
				style={{
					backgroundColor: theme.colors.bgActivity,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<div className="min-w-0 flex-1 pr-2">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Background browsing
					</div>
					<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
						Let agents read and drive their own browser tabs while you are focused on a different
						agent. Keeps hidden webviews alive (one renderer process each, LRU-capped).
					</div>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					{backgroundBrowsers && (
						<label
							className="text-xs flex items-center gap-1"
							style={{ color: theme.colors.textDim }}
							title="Maximum background webviews kept alive (LRU-evicted, 1-10)"
						>
							Limit
							<input
								type="number"
								min={1}
								max={10}
								value={backgroundLimit}
								onChange={(e) => setBackgroundLimit(Number(e.target.value))}
								className="w-12 px-1 py-0.5 rounded text-xs"
								style={{
									backgroundColor: theme.colors.bgMain,
									border: `1px solid ${theme.colors.border}`,
									color: theme.colors.textMain,
								}}
							/>
						</label>
					)}
					<button
						onClick={() => setBackgroundBrowsers(!backgroundBrowsers)}
						className="text-xs px-2.5 py-1 rounded transition-colors"
						style={{
							backgroundColor: backgroundBrowsers ? theme.colors.accent : 'transparent',
							border: `1px solid ${backgroundBrowsers ? theme.colors.accent : theme.colors.border}`,
							color: backgroundBrowsers ? theme.colors.bgMain : theme.colors.textDim,
						}}
					>
						{backgroundBrowsers ? 'On' : 'Off'}
					</button>
				</div>
			</div>

			<div className="space-y-1.5">
				{statuses.map((s) => {
					const isBusy = busyAgentId === s.agentId || busyAll;
					return (
						<div
							key={s.agentId}
							className="flex items-center justify-between px-3 py-2 rounded"
							style={{
								backgroundColor: theme.colors.bgActivity,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<div className="flex items-center gap-2 min-w-0 flex-1">
								{s.installed ? (
									<Check className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.success }} />
								) : (
									<X
										className="w-3.5 h-3.5 shrink-0 opacity-50"
										style={{ color: theme.colors.textDim }}
									/>
								)}
								<div className="min-w-0">
									<div
										className="text-sm font-medium truncate"
										style={{ color: theme.colors.textMain }}
									>
										{getAgentDisplayName(s.agentId as AgentId)}
									</div>
									<div
										className="text-[10px] font-mono truncate opacity-60"
										title={s.configPath}
										style={{ color: theme.colors.textDim }}
									>
										{s.configPath}
									</div>
								</div>
							</div>
							<div className="flex items-center gap-2 shrink-0">
								{s.installed && (
									<button
										onClick={() => toggleInteraction(s.agentId)}
										title="Allow this agent to drive browser tabs: navigate, click, type, eval, screenshot. Off by default; read tools work without this."
										className="text-[10px] px-2 py-1 rounded transition-colors"
										style={{
											backgroundColor: browserInteractionAgents.includes(s.agentId)
												? `${theme.colors.accent}22`
												: 'transparent',
											color: browserInteractionAgents.includes(s.agentId)
												? theme.colors.accent
												: theme.colors.textDim,
											border: `1px solid ${
												browserInteractionAgents.includes(s.agentId)
													? theme.colors.accent
													: theme.colors.border
											}`,
										}}
										aria-pressed={browserInteractionAgents.includes(s.agentId)}
									>
										{browserInteractionAgents.includes(s.agentId)
											? 'Interaction: on'
											: 'Interaction: off'}
									</button>
								)}
								{s.installed && browserInteractionAgents.includes(s.agentId) && (
									<button
										onClick={() => cycleConfirmPolicy(s.agentId)}
										title="Per-call approval for browser actions. dangerous = confirm navigate + eval (default); all = confirm every action; off = no per-call confirm."
										className="text-[10px] px-2 py-1 rounded transition-colors"
										style={{
											backgroundColor: 'transparent',
											color: theme.colors.textDim,
											border: `1px solid ${theme.colors.border}`,
										}}
									>
										{`Confirm: ${browserConfirm[s.agentId] ?? 'dangerous'}`}
									</button>
								)}
								{s.installed ? (
									<button
										onClick={() => handleUninstall(s.agentId)}
										disabled={isBusy}
										className="text-xs px-2.5 py-1 rounded transition-colors disabled:opacity-40 hover:bg-white/10"
										style={{ color: theme.colors.error, borderColor: theme.colors.error }}
									>
										{isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Uninstall'}
									</button>
								) : (
									<button
										onClick={() => handleInstall(s.agentId)}
										disabled={isBusy}
										className="text-xs px-2.5 py-1 rounded transition-colors disabled:opacity-40"
										style={{
											backgroundColor: theme.colors.accent,
											color: theme.colors.bgMain,
										}}
									>
										{isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Install'}
									</button>
								)}
							</div>
						</div>
					);
				})}
			</div>

			<div className="flex justify-end pt-1">
				<button
					onClick={handleInstallAll}
					disabled={anyBusy || allInstalled || statuses.length === 0}
					className="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded transition-colors disabled:opacity-40"
					style={{
						borderColor: theme.colors.border,
						border: '1px solid',
						color: theme.colors.textMain,
					}}
				>
					{busyAll ? (
						<Loader2 className="w-3.5 h-3.5 animate-spin" />
					) : (
						<Download className="w-3.5 h-3.5" />
					)}
					{allInstalled ? 'All agents installed' : 'Install for all agents'}
				</button>
			</div>
		</div>
	);
}
