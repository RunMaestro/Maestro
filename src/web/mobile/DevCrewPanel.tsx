/**
 * DevCrewPanel — web/mobile mirror of desktop RolesPanel (#448).
 *
 * Renders 4 slot cards (runner / fixer / reviewer / merger) with:
 *   - Role icon + brand colour
 *   - Role label (uppercase)
 *   - Status badge: On (Available) | On (Busy: #N) | Off (Draining: #N) | Off (Idle)
 *   - Agent assignment (read-only for v1 — edit from desktop)
 *
 * Live claim updates arrive via `agent_dispatch_claim_started` /
 * `agent_dispatch_claim_ended` WebSocket broadcasts pushed by the web server.
 * Initial state is loaded from GET /api/project-roles?projectPath=<path>.
 *
 * Encore-gated: only rendered when the `agentDispatch` feature flag is on
 * (the route returns HTTP 403 when the flag is off, which collapses the panel
 * to an empty-state message).
 */

import { useState, useEffect, useCallback } from 'react';
import { Hammer, Wrench, Eye, GitMerge, type LucideIcon } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import { buildApiUrl } from '../utils/config';
import type {
	AgentDispatchClaimStartedMessage,
	AgentDispatchClaimEndedMessage,
} from '../hooks/useWebSocket';
import type { ProjectRoleSlots, RoleSlotAssignment } from '../../shared/project-roles-types';
import { DISPATCH_ROLES, DISPATCH_ROLE_LABELS } from '../../shared/project-roles-types';
import type { DispatchRole } from '../../shared/project-roles-types';

// ---------------------------------------------------------------------------
// Role icon + colour registry — mirrors desktop SlotCard.tsx exactly.
// ---------------------------------------------------------------------------

const ROLE_ICON: Record<DispatchRole, LucideIcon> = {
	runner: Hammer,
	fixer: Wrench,
	reviewer: Eye,
	merger: GitMerge,
};

const ROLE_COLOR: Record<DispatchRole, string> = {
	runner: '#c084fc',
	fixer: '#fb923c',
	reviewer: '#22d3ee',
	merger: '#4ade80',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveClaimInfo {
	projectPath: string;
	role: string;
	issueNumber?: number;
	issueTitle?: string;
	claimedAt: string;
}

interface DevCrewPanelProps {
	projectPath: string | null | undefined;
	/** Raw WebSocket messages forwarded from the parent. */
	lastMessage?: AgentDispatchClaimStartedMessage | AgentDispatchClaimEndedMessage | null;
}

// ---------------------------------------------------------------------------
// Single slot card (read-only for v1)
// ---------------------------------------------------------------------------

function SlotCard({
	role,
	assignment,
	activeClaim,
}: {
	role: DispatchRole;
	assignment: RoleSlotAssignment | undefined;
	activeClaim: ActiveClaimInfo | undefined;
}) {
	const colors = useThemeColors();

	const slotEnabled = assignment ? assignment.enabled !== false : true;

	type StatusVariant = 'on-available' | 'on-busy' | 'off-draining' | 'off-idle';
	const statusVariant: StatusVariant | null = assignment
		? slotEnabled
			? activeClaim
				? 'on-busy'
				: 'on-available'
			: activeClaim
				? 'off-draining'
				: 'off-idle'
		: null;

	const githubNumber = activeClaim?.issueNumber;
	const workItemLabel = githubNumber ? `#${githubNumber}` : undefined;

	const openGithub = useCallback(() => {
		if (githubNumber) {
			window.open(`https://github.com/HumpfTech/Maestro/issues/${githubNumber}`, '_blank');
		}
	}, [githubNumber]);

	const statusBgColor = (v: StatusVariant) => {
		if (v === 'on-busy' || v === 'off-draining') return `${colors.warning}25`;
		if (v === 'on-available') return `${colors.accent}20`;
		return `${colors.textDim}20`;
	};

	const statusTextColor = (v: StatusVariant) => {
		if (v === 'on-busy' || v === 'off-draining') return colors.warning;
		if (v === 'on-available') return colors.accent;
		return colors.textDim;
	};

	const Icon = ROLE_ICON[role];

	return (
		<div
			style={{
				borderRadius: '8px',
				border: `1px solid ${statusVariant === 'on-busy' || statusVariant === 'off-draining' ? colors.warning : colors.border}`,
				backgroundColor: colors.bgSidebar,
				padding: '12px',
				marginBottom: '10px',
			}}
		>
			{/* Header row */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					marginBottom: '8px',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
					<Icon size={15} style={{ color: ROLE_COLOR[role], flexShrink: 0 }} />
					<span
						style={{
							fontSize: '12px',
							fontWeight: 700,
							textTransform: 'uppercase',
							letterSpacing: '0.06em',
							color: colors.textMain,
						}}
					>
						{DISPATCH_ROLE_LABELS[role]}
					</span>
				</div>

				{statusVariant && (
					<span
						style={{
							fontSize: '10px',
							padding: '2px 7px',
							borderRadius: '10px',
							fontWeight: 600,
							backgroundColor: statusBgColor(statusVariant),
							color: statusTextColor(statusVariant),
						}}
					>
						{statusVariant === 'on-available' && 'On (Available)'}
						{statusVariant === 'on-busy' && (
							<>
								On (Busy:{' '}
								{workItemLabel ? (
									<button
										onClick={openGithub}
										style={{
											background: 'none',
											border: 'none',
											padding: 0,
											cursor: 'pointer',
											color: colors.warning,
											fontSize: 'inherit',
											fontWeight: 'inherit',
											textDecoration: 'underline',
										}}
										title={activeClaim?.issueTitle ?? ''}
									>
										{workItemLabel}
									</button>
								) : (
									'…'
								)}
								)
							</>
						)}
						{statusVariant === 'off-draining' && (
							<>
								Off (Draining:{' '}
								{workItemLabel ? (
									<button
										onClick={openGithub}
										style={{
											background: 'none',
											border: 'none',
											padding: 0,
											cursor: 'pointer',
											color: colors.warning,
											fontSize: 'inherit',
											fontWeight: 'inherit',
											textDecoration: 'underline',
										}}
										title={activeClaim?.issueTitle ?? ''}
									>
										{workItemLabel}
									</button>
								) : (
									'…'
								)}
								)
							</>
						)}
						{statusVariant === 'off-idle' && 'Off (Idle)'}
					</span>
				)}
			</div>

			{/* Agent assignment (read-only) */}
			<div>
				<span style={{ fontSize: '10px', color: colors.textDim }}>Agent: </span>
				{assignment?.agentId ? (
					<span style={{ fontSize: '11px', color: colors.textMain, fontFamily: 'monospace' }}>
						{assignment.agentId}
					</span>
				) : (
					<span style={{ fontSize: '11px', color: colors.textDim, fontStyle: 'italic' }}>
						Unassigned
					</span>
				)}
			</div>

			{!assignment && (
				<p
					style={{
						fontSize: '11px',
						color: colors.textDim,
						margin: '4px 0 0',
						fontStyle: 'italic',
					}}
				>
					No agent assigned. Edit from desktop.
				</p>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function DevCrewPanel({ projectPath, lastMessage }: DevCrewPanelProps) {
	const colors = useThemeColors();

	const [slots, setSlots] = useState<ProjectRoleSlots>({});
	const [activeClaims, setActiveClaims] = useState<Map<string, ActiveClaimInfo>>(new Map());
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [featureDisabled, setFeatureDisabled] = useState(false);

	// Load slots + initial claim state from HTTP endpoint
	const loadData = useCallback(async () => {
		if (!projectPath) return;
		setLoading(true);
		setError(null);
		setFeatureDisabled(false);
		try {
			const url = buildApiUrl(`/project-roles?projectPath=${encodeURIComponent(projectPath)}`);
			const res = await fetch(url);
			if (res.status === 403) {
				setFeatureDisabled(true);
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			if (!json.success) throw new Error(json.error ?? 'Unknown error');

			const { slots: fetchedSlots, claims } = json.data as {
				slots: ProjectRoleSlots;
				claims: ActiveClaimInfo[];
			};
			setSlots(fetchedSlots);

			const map = new Map<string, ActiveClaimInfo>();
			for (const claim of claims) {
				map.set(claim.role, claim);
			}
			setActiveClaims(map);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [projectPath]);

	useEffect(() => {
		void loadData();
	}, [loadData]);

	// Live claim updates via WebSocket broadcast
	useEffect(() => {
		if (!lastMessage || !projectPath) return;

		if (lastMessage.type === 'agent_dispatch_claim_started') {
			const msg = lastMessage as AgentDispatchClaimStartedMessage;
			if (msg.projectPath !== projectPath) return;
			setActiveClaims((prev) => {
				const next = new Map(prev);
				next.set(msg.role, {
					projectPath: msg.projectPath,
					role: msg.role,
					issueNumber: msg.issueNumber,
					issueTitle: msg.issueTitle,
					claimedAt: msg.claimedAt,
				});
				return next;
			});
		} else if (lastMessage.type === 'agent_dispatch_claim_ended') {
			const msg = lastMessage as AgentDispatchClaimEndedMessage;
			if (msg.projectPath !== projectPath) return;
			setActiveClaims((prev) => {
				const next = new Map(prev);
				next.delete(msg.role);
				return next;
			});
		}
	}, [lastMessage, projectPath]);

	if (!projectPath) {
		return (
			<div
				style={{ padding: '24px', textAlign: 'center', color: colors.textDim, fontSize: '13px' }}
			>
				Open a project to view the Dev Crew.
			</div>
		);
	}

	if (featureDisabled) {
		return (
			<div
				style={{ padding: '24px', textAlign: 'center', color: colors.textDim, fontSize: '13px' }}
			>
				Dev Crew requires the Agent Dispatch Encore Feature to be enabled.
			</div>
		);
	}

	if (loading) {
		return (
			<div
				style={{ padding: '24px', textAlign: 'center', color: colors.textDim, fontSize: '13px' }}
			>
				Loading…
			</div>
		);
	}

	if (error) {
		return (
			<div style={{ padding: '16px' }}>
				<p style={{ color: colors.error, fontSize: '13px', margin: 0 }}>{error}</p>
				<button
					onClick={() => void loadData()}
					style={{
						marginTop: '8px',
						padding: '6px 12px',
						border: `1px solid ${colors.border}`,
						borderRadius: '6px',
						backgroundColor: 'transparent',
						color: colors.textMain,
						cursor: 'pointer',
						fontSize: '12px',
					}}
				>
					Retry
				</button>
			</div>
		);
	}

	return (
		<div style={{ padding: '12px' }}>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					marginBottom: '12px',
				}}
			>
				<span
					style={{
						fontSize: '11px',
						fontWeight: 700,
						textTransform: 'uppercase',
						letterSpacing: '0.08em',
						color: colors.textDim,
					}}
				>
					Dev Crew
				</span>
				<button
					onClick={() => void loadData()}
					style={{
						background: 'none',
						border: 'none',
						cursor: 'pointer',
						color: colors.textDim,
						fontSize: '16px',
						padding: '2px 4px',
						lineHeight: 1,
					}}
					title="Refresh"
					aria-label="Refresh Dev Crew"
				>
					↻
				</button>
			</div>

			{/* Slot cards */}
			{(DISPATCH_ROLES as DispatchRole[]).map((role) => (
				<SlotCard
					key={role}
					role={role}
					assignment={slots[role]}
					activeClaim={activeClaims.get(role)}
				/>
			))}

			<p
				style={{ fontSize: '10px', color: colors.textDim, margin: '4px 0 0', textAlign: 'center' }}
			>
				Read-only — edit slots from the desktop app.
			</p>
		</div>
	);
}

export default DevCrewPanel;
