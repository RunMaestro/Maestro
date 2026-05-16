/**
 * AgentsTab — Settings → Agents
 *
 * Per-agent readiness pill + version + last-probed + Re-probe button,
 * backed by the capability snapshot store in the main process. Avoids
 * duplicating the agent configuration UI: per-agent custom paths / args /
 * env vars stay in `AgentConfigPanel`, which lives in the wizard flow.
 *
 * The tab loads snapshots on mount and subscribes to live updates via
 * `agentStore.loadCapabilitySnapshots()`. A Re-probe button clears the
 * snapshot, re-runs detection, and surfaces the new pill through the
 * same subscription.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, CheckCircle2, AlertCircle, XCircle, MinusCircle, Loader2 } from 'lucide-react';
import { useAgentStore } from '../../../stores/agentStore';
import { AGENT_DISPLAY_NAMES, isBetaAgent } from '../../../../shared/agentMetadata';
import type { AgentId } from '../../../../shared/agentIds';
import { formatRelativeTime } from '../../../../shared/formatters';
import type { Theme } from '../../../types';
import type { AgentCapabilitiesSnapshot, AgentStatus } from '../../../../shared/agentCapabilities';

export interface AgentsTabProps {
	theme: Theme;
}

interface StatusVisual {
	label: string;
	color: string;
	icon: typeof CheckCircle2;
}

function statusVisualFor(theme: Theme, status: AgentStatus | undefined): StatusVisual {
	switch (status) {
		case 'ok':
			return { label: 'Ready', color: theme.colors.success, icon: CheckCircle2 };
		case 'auth_required':
			return { label: 'Auth required', color: theme.colors.warning, icon: AlertCircle };
		case 'not_installed':
			return { label: 'Not installed', color: theme.colors.error, icon: XCircle };
		case 'failed':
			return { label: 'Failed', color: theme.colors.error, icon: XCircle };
		case 'probing':
			return { label: 'Probing…', color: theme.colors.accent, icon: Loader2 };
		case 'not_configured':
			return { label: 'Not configured', color: theme.colors.textDim, icon: MinusCircle };
		default:
			return { label: 'Unknown', color: theme.colors.textDim, icon: MinusCircle };
	}
}

export function AgentsTab({ theme }: AgentsTabProps) {
	const loadCapabilitySnapshots = useAgentStore((s) => s.loadCapabilitySnapshots);
	const reprobeAgent = useAgentStore((s) => s.reprobeAgent);
	const snapshots = useAgentStore((s) => s.capabilitySnapshots);
	const loaded = useAgentStore((s) => s.capabilitySnapshotsLoaded);
	const [busyAgentId, setBusyAgentId] = useState<string | null>(null);

	useEffect(() => {
		void loadCapabilitySnapshots();
	}, [loadCapabilitySnapshots]);

	const agents = useMemo(() => {
		// `terminal` is internal — the snapshot manager already skips it, but
		// guard here so a stray entry never surfaces a row in the UI.
		return (Object.keys(AGENT_DISPLAY_NAMES) as AgentId[])
			.filter((id) => id !== 'terminal')
			.map((id) => ({ id, name: AGENT_DISPLAY_NAMES[id], beta: isBetaAgent(id) }));
	}, []);

	const handleReprobe = useCallback(
		async (agentId: string) => {
			setBusyAgentId(agentId);
			try {
				await reprobeAgent(agentId);
			} finally {
				setBusyAgentId(null);
			}
		},
		[reprobeAgent]
	);

	return (
		<div className="space-y-3 select-none">
			<div>
				<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
					Agents
				</h2>
				<p className="text-xs opacity-60 mt-1" style={{ color: theme.colors.textMain }}>
					Maestro probes each agent's binary at startup. Re-probe to refresh after installing or
					authenticating an agent.
				</p>
			</div>

			{!loaded && (
				<div className="text-xs opacity-50" style={{ color: theme.colors.textMain }}>
					Loading snapshots…
				</div>
			)}

			<ul className="divide-y" style={{ borderColor: theme.colors.border }}>
				{agents.map((meta) => {
					const snapshot: AgentCapabilitiesSnapshot | undefined = snapshots[meta.id];
					const status = busyAgentId === meta.id ? 'probing' : snapshot?.status;
					const visual = statusVisualFor(theme, status);
					const Icon = visual.icon;
					const isProbing = status === 'probing';

					return (
						<li
							key={meta.id}
							className="flex items-center justify-between py-3 gap-4 border-b last:border-b-0"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-3 min-w-0 flex-1">
								<div
									className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium whitespace-nowrap"
									style={{
										backgroundColor: theme.colors.bgActivity,
										color: visual.color,
									}}
								>
									<Icon className={`w-3 h-3 ${isProbing ? 'animate-spin' : ''}`} />
									<span>{visual.label}</span>
								</div>
								<div className="min-w-0 flex-1">
									<div
										className="font-medium text-sm truncate flex items-center gap-1.5"
										style={{ color: theme.colors.textMain }}
									>
										<span>{meta.name}</span>
										{meta.beta && (
											<span
												className="text-[9px] uppercase tracking-wide px-1 py-px rounded opacity-70"
												style={{
													backgroundColor: theme.colors.bgActivity,
													color: theme.colors.textDim,
												}}
											>
												Beta
											</span>
										)}
									</div>
									<div
										className="text-[11px] opacity-60 truncate select-text"
										style={{ color: theme.colors.textMain }}
									>
										{snapshot?.path
											? snapshot.path
											: status === 'not_installed'
												? `Binary "${meta.id}" not found in PATH`
												: 'No detection yet'}
										{snapshot?.lastProbedAt ? (
											<>
												{' · last probed '}
												{formatRelativeTime(snapshot.lastProbedAt)}
											</>
										) : null}
									</div>
									{snapshot?.lastError ? (
										<div
											className="text-[11px] mt-0.5 opacity-70 select-text"
											style={{ color: theme.colors.error }}
										>
											{snapshot.lastError}
										</div>
									) : null}
								</div>
							</div>

							<button
								onClick={() => void handleReprobe(meta.id)}
								disabled={isProbing}
								className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border transition-opacity disabled:opacity-50 cursor-pointer"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								title="Clear this agent's snapshot and re-run detection"
							>
								<RefreshCw className={`w-3 h-3 ${isProbing ? 'animate-spin' : ''}`} />
								<span>Re-probe</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
