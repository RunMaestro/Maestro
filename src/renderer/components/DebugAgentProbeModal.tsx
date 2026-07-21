/**
 * DebugAgentProbeModal - re-probe agent binaries from a card grid.
 *
 * Mirrors the look of DebugApplicationStatsModal: one card per agent (3 per
 * row), each showing its readiness pill, detected path, last-probed time, and
 * a per-agent Re-probe button. Backed by the same capability-snapshot store as
 * the (now removed) Settings → Agents tab.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	RefreshCw,
	CheckCircle2,
	AlertCircle,
	XCircle,
	MinusCircle,
	Loader2,
	Boxes,
} from 'lucide-react';
import type { Theme } from '../types';
import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useAgentStore } from '../stores/agentStore';
import { AGENT_DISPLAY_NAMES, isBetaAgent } from '../../shared/agentMetadata';
import type { AgentId } from '../../shared/agentRegistry';
import { formatRelativeTime } from '../../shared/formatters';
import type { AgentCapabilitiesSnapshot, AgentStatus } from '../../shared/agentCapabilities';

interface DebugAgentProbeModalProps {
	theme: Theme;
	onClose: () => void;
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

export function DebugAgentProbeModal({ theme, onClose }: DebugAgentProbeModalProps) {
	const loadCapabilitySnapshots = useAgentStore((s) => s.loadCapabilitySnapshots);
	const reprobeAgent = useAgentStore((s) => s.reprobeAgent);
	const snapshots = useAgentStore((s) => s.capabilitySnapshots);
	const loaded = useAgentStore((s) => s.capabilitySnapshotsLoaded);
	const [busyAgents, setBusyAgents] = useState<Set<string>>(new Set());

	useEffect(() => {
		void loadCapabilitySnapshots();
	}, [loadCapabilitySnapshots]);

	const agents = useMemo(() => {
		// `terminal` is internal - the snapshot manager already skips it, but
		// guard here so a stray entry never surfaces a card in the UI.
		return (Object.keys(AGENT_DISPLAY_NAMES) as AgentId[])
			.filter((id) => id !== 'terminal')
			.map((id) => ({ id, name: AGENT_DISPLAY_NAMES[id], beta: isBetaAgent(id) }));
	}, []);

	const handleReprobe = useCallback(
		async (agentId: string) => {
			setBusyAgents((prev) => new Set(prev).add(agentId));
			try {
				await reprobeAgent(agentId);
			} finally {
				setBusyAgents((prev) => {
					const next = new Set(prev);
					next.delete(agentId);
					return next;
				});
			}
		},
		[reprobeAgent]
	);

	const handleReprobeAll = useCallback(() => {
		for (const meta of agents) void handleReprobe(meta.id);
	}, [agents, handleReprobe]);

	const anyBusy = busyAgents.size > 0;

	return (
		<Modal
			theme={theme}
			title="Agent Probes"
			headerIcon={<Boxes className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.DEBUG_AGENT_PROBE}
			onClose={onClose}
			width={820}
			maxHeight="85vh"
			closeOnBackdropClick
			footer={
				<div className="flex items-center justify-between w-full">
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						Maestro probes each agent's binary at startup. Re-probe to refresh after installing or
						authenticating an agent.
					</p>
					<button
						type="button"
						onClick={handleReprobeAll}
						disabled={anyBusy}
						className="px-3 py-1.5 rounded border text-sm flex items-center gap-2 transition-colors hover:bg-white/5 disabled:opacity-50"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<RefreshCw className={`w-3.5 h-3.5 ${anyBusy ? 'animate-spin' : ''}`} />
						Re-probe All
					</button>
				</div>
			}
		>
			{!loaded && (
				<div className="text-xs opacity-50 mb-3" style={{ color: theme.colors.textMain }}>
					Loading snapshots…
				</div>
			)}

			<div className="grid grid-cols-3 gap-3">
				{agents.map((meta) => {
					const snapshot: AgentCapabilitiesSnapshot | undefined = snapshots[meta.id];
					const isProbing = busyAgents.has(meta.id);
					const status = isProbing ? 'probing' : snapshot?.status;
					const visual = statusVisualFor(theme, status);
					const Icon = visual.icon;

					return (
						<div
							key={meta.id}
							className="p-3 rounded-md border flex flex-col gap-2"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
						>
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0">
									<div
										className="font-medium text-sm truncate flex items-center gap-1.5"
										style={{ color: theme.colors.textMain }}
									>
										<span className="truncate">{meta.name}</span>
										{meta.beta && (
											<span
												className="text-[9px] uppercase tracking-wide px-1 py-px rounded opacity-70 shrink-0"
												style={{
													backgroundColor: theme.colors.bgActivity,
													color: theme.colors.textDim,
												}}
											>
												Beta
											</span>
										)}
									</div>
								</div>
								<div
									className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap shrink-0"
									style={{ backgroundColor: theme.colors.bgActivity, color: visual.color }}
								>
									<Icon className={`w-2.5 h-2.5 ${isProbing ? 'animate-spin' : ''}`} />
									<span>{visual.label}</span>
								</div>
							</div>

							<div
								className="text-[11px] opacity-60 break-all select-text leading-snug"
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
									className="text-[11px] opacity-70 select-text break-all leading-snug"
									style={{ color: theme.colors.error }}
								>
									{snapshot.lastError}
								</div>
							) : null}

							<button
								onClick={() => void handleReprobe(meta.id)}
								disabled={isProbing}
								className="mt-auto flex items-center justify-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border transition-opacity disabled:opacity-50 cursor-pointer hover:bg-white/5"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								title="Clear this agent's snapshot and re-run detection"
							>
								<RefreshCw className={`w-3 h-3 ${isProbing ? 'animate-spin' : ''}`} />
								<span>Re-probe</span>
							</button>
						</div>
					);
				})}
			</div>
		</Modal>
	);
}

export default DebugAgentProbeModal;
