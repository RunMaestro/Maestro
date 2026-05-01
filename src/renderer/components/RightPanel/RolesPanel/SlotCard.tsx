import React, { useCallback, useMemo } from 'react';
import { Hammer, Wrench, Eye, GitMerge } from 'lucide-react';
import type { Theme } from '../../../types';
import type { Session } from '../../../types';
import type { DispatchRole, RoleSlotAssignment } from '../../../../shared/project-roles-types';
import { DISPATCH_ROLE_LABELS } from '../../../../shared/project-roles-types';

// Role icons + brand colors — match the sidebar SessionItem icons exactly.
const ROLE_ICON_COMPONENT: Record<DispatchRole, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
	runner: Hammer,
	fixer: Wrench,
	reviewer: Eye,
	merger: GitMerge,
};
const ROLE_ICON_COLOR: Record<DispatchRole, string> = {
	runner: '#c084fc',
	fixer: '#fb923c',
	reviewer: '#22d3ee',
	merger: '#4ade80',
};

/** Active claim info pushed via IPC from SlotExecutor (#444). */
export interface ActiveClaimInfo {
	projectPath: string;
	role: string;
	agentId: string;
	sessionId: string;
	issueNumber?: number;
	issueTitle?: string;
	claimedAt: string;
}

export interface SlotCardProps {
	role: DispatchRole;
	/** The stored slot assignment (agentId + optional overrides). */
	assignment: RoleSlotAssignment | undefined;
	/**
	 * Live claim info from the renderer-local claim map (#444).
	 * Replaces busyWorkItem which was sourced from work-graph SQLite.
	 */
	activeClaim?: ActiveClaimInfo;
	theme: Theme;
	onAssignmentChange: (role: DispatchRole, assignment: RoleSlotAssignment | undefined) => void;
	/**
	 * All Left Bar sessions — filtered inside SlotCard to those matching the
	 * active project and host before populating the agent picker dropdown.
	 */
	sessions: Session[];
	/**
	 * The active session's project root (normalised).  Used to filter eligible
	 * agents for the picker.
	 */
	activeProjectRoot: string | null;
	/**
	 * The active session's SSH remote ID (null = local).  Used to filter
	 * eligible agents for the picker.
	 */
	activeRemoteId: string | null;
}

/** Normalise a path for comparison (trailing slash removed, lower-case on case-insensitive OSes). */
function normalisePath(p: string): string {
	return p.replace(/[/\\]+$/, '');
}

export function SlotCard({
	role,
	assignment,
	activeClaim,
	theme,
	onAssignmentChange,
	sessions,
	activeProjectRoot,
	activeRemoteId,
}: SlotCardProps) {
	// -----------------------------------------------------------------------
	// Filter sessions to those on the same project + host as the active session
	// -----------------------------------------------------------------------
	const eligibleSessions = useMemo(() => {
		if (!activeProjectRoot) return [];
		const normProject = normalisePath(activeProjectRoot);

		return sessions.filter((s) => {
			// Same project root
			if (normalisePath(s.projectRoot) !== normProject) return false;

			// Same host: compare SSH remote IDs (null means local)
			const sessionRemoteId = s.sessionSshRemoteConfig?.enabled
				? (s.sessionSshRemoteConfig.remoteId ?? null)
				: null;

			return sessionRemoteId === activeRemoteId;
		});
	}, [sessions, activeProjectRoot, activeRemoteId]);

	// -----------------------------------------------------------------------
	// Derived state
	// -----------------------------------------------------------------------
	const selectedSession = useMemo(
		() => eligibleSessions.find((s) => s.id === assignment?.agentId) ?? null,
		[eligibleSessions, assignment]
	);

	// enabled defaults to true when absent
	const slotEnabled = assignment ? assignment.enabled !== false : true;

	// -----------------------------------------------------------------------
	// Handlers
	// -----------------------------------------------------------------------

	const handleAgentChange = useCallback(
		(agentId: string) => {
			if (!agentId) {
				onAssignmentChange(role, undefined);
				return;
			}
			onAssignmentChange(role, {
				agentId,
				// reset overrides when the agent changes
				modelOverride: undefined,
				effortOverride: undefined,
				enabled: assignment?.enabled,
			});
		},
		[role, assignment, onAssignmentChange]
	);

	const handleModelOverrideChange = useCallback(
		(value: string) => {
			if (!assignment) return;
			onAssignmentChange(role, { ...assignment, modelOverride: value || undefined });
		},
		[role, assignment, onAssignmentChange]
	);

	const handleEffortOverrideChange = useCallback(
		(value: string) => {
			if (!assignment) return;
			onAssignmentChange(role, { ...assignment, effortOverride: value || undefined });
		},
		[role, assignment, onAssignmentChange]
	);

	const handleToggleEnabled = useCallback(() => {
		if (!assignment) return;
		onAssignmentChange(role, {
			...assignment,
			enabled: assignment.enabled === false ? true : false,
		});
	}, [role, assignment, onAssignmentChange]);

	// -----------------------------------------------------------------------
	// Status badge helpers
	// -----------------------------------------------------------------------
	const githubNumber = activeClaim?.issueNumber;
	const workItemDisplayId = githubNumber ? `#${githubNumber}` : undefined;

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

	const openGithub = useCallback(() => {
		if (githubNumber) {
			void window.maestro.shell.openExternal(
				`https://github.com/HumpfTech/Maestro/issues/${githubNumber}`
			);
		}
	}, [githubNumber]);

	// -----------------------------------------------------------------------
	// Shared styles
	// -----------------------------------------------------------------------
	const selectStyle: React.CSSProperties = {
		backgroundColor: theme.colors.bgSidebar,
		color: theme.colors.textMain,
		border: `1px solid ${theme.colors.border}`,
		borderRadius: '4px',
		padding: '3px 6px',
		fontSize: '11px',
		outline: 'none',
		width: '100%',
		cursor: 'pointer',
	};

	const inputStyle: React.CSSProperties = {
		...selectStyle,
		cursor: 'text',
	};

	const statusBadgeColor = (v: StatusVariant) => {
		if (v === 'on-busy' || v === 'off-draining') return theme.colors.warning;
		if (v === 'on-available') return theme.colors.accent;
		return theme.colors.textDim;
	};

	const statusBadgeBg = (v: StatusVariant) => {
		if (v === 'on-busy' || v === 'off-draining') return `${theme.colors.warning}25`;
		if (v === 'on-available') return `${theme.colors.accent}20`;
		return `${theme.colors.textDim}20`;
	};

	return (
		<div
			className="rounded border mb-3 p-3"
			style={{
				borderColor:
					statusVariant === 'on-busy' || statusVariant === 'off-draining'
						? theme.colors.warning
						: theme.colors.border,
				backgroundColor: theme.colors.bgActivity,
			}}
		>
			{/* Header row */}
			<div className="flex items-center justify-between mb-2">
				<div className="flex items-center gap-1.5">
					{(() => {
						const Icon = ROLE_ICON_COMPONENT[role as DispatchRole];
						return Icon ? (
							<Icon
								className="w-4 h-4 shrink-0"
								style={{ color: ROLE_ICON_COLOR[role as DispatchRole] }}
							/>
						) : null;
					})()}
					<span
						className="text-xs font-bold uppercase tracking-wide"
						style={{ color: theme.colors.textMain }}
					>
						{DISPATCH_ROLE_LABELS[role]}
					</span>
				</div>

				<div className="flex items-center gap-1.5">
					{statusVariant && (
						<span
							className="text-[10px] px-1.5 py-0.5 rounded font-medium"
							style={{
								backgroundColor: statusBadgeBg(statusVariant),
								color: statusBadgeColor(statusVariant),
							}}
						>
							{statusVariant === 'on-available' && 'On (Available)'}
							{statusVariant === 'on-busy' && (
								<>
									{'On (Busy: '}
									{activeClaim ? (
										<button
											className="underline bg-transparent border-none p-0 cursor-pointer"
											style={{ color: theme.colors.warning, fontSize: 'inherit' }}
											onClick={openGithub}
											title={activeClaim?.issueTitle ?? ''}
										>
											{workItemDisplayId}
										</button>
									) : null}
									{')'}
								</>
							)}
							{statusVariant === 'off-draining' && (
								<>
									{'Off (Draining: '}
									{activeClaim ? (
										<button
											className="underline bg-transparent border-none p-0 cursor-pointer"
											style={{ color: theme.colors.warning, fontSize: 'inherit' }}
											onClick={openGithub}
											title={activeClaim?.issueTitle ?? ''}
										>
											{workItemDisplayId}
										</button>
									) : null}
									{')'}
								</>
							)}
							{statusVariant === 'off-idle' && 'Off (Idle)'}
						</span>
					)}

					{assignment && (
						<button
							onClick={handleToggleEnabled}
							className="text-[10px] px-1.5 py-0.5 rounded font-medium border"
							style={{
								backgroundColor: slotEnabled
									? `${theme.colors.accent}20`
									: `${theme.colors.textDim}15`,
								color: slotEnabled ? theme.colors.accent : theme.colors.textDim,
								borderColor: slotEnabled ? `${theme.colors.accent}50` : `${theme.colors.textDim}40`,
								cursor: 'pointer',
							}}
							title={
								slotEnabled
									? 'Slot is On — click to disable (drain mode)'
									: 'Slot is Off — click to enable'
							}
						>
							{slotEnabled ? 'On' : 'Off'}
						</button>
					)}
				</div>
			</div>

			{/* ----------------------------------------------------------------
			  Agent picker: Left Bar agents filtered to same project + host
			  ---------------------------------------------------------------- */}
			<div className="mb-2">
				<label className="block text-[10px] mb-1" style={{ color: theme.colors.textDim }}>
					Agent
				</label>
				{!activeProjectRoot ? (
					<p className="text-[10px]" style={{ color: theme.colors.textDim }}>
						Open a project to configure role slots.
					</p>
				) : eligibleSessions.length === 0 ? (
					<p className="text-[10px]" style={{ color: theme.colors.textDim }}>
						No agents configured for this project on this host. Create a dispatch agent in the Left
						Bar pointing at this project root, then come back.
					</p>
				) : (
					<select
						value={assignment?.agentId ?? ''}
						onChange={(e) => handleAgentChange(e.target.value)}
						style={selectStyle}
						title="Left Bar agent to use for dispatch"
					>
						<option value="">Select agent…</option>
						{eligibleSessions.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</select>
				)}
			</div>

			{/* Model override — shown when an agent is selected */}
			{assignment?.agentId && (
				<div className="mb-2">
					<label className="block text-[10px] mb-1" style={{ color: theme.colors.textDim }}>
						Model override{' '}
						<span style={{ color: theme.colors.textDim, fontWeight: 'normal' }}>
							(leave blank for agent default
							{selectedSession?.customModel ? `: ${selectedSession.customModel}` : ''})
						</span>
					</label>
					<input
						type="text"
						value={assignment.modelOverride ?? ''}
						onChange={(e) => handleModelOverrideChange(e.target.value)}
						placeholder={selectedSession?.customModel ?? 'Agent default'}
						style={inputStyle}
					/>
				</div>
			)}

			{/* Effort override — shown when an agent is selected */}
			{assignment?.agentId && (
				<div className="mb-2">
					<label className="block text-[10px] mb-1" style={{ color: theme.colors.textDim }}>
						Effort override{' '}
						<span style={{ color: theme.colors.textDim, fontWeight: 'normal' }}>
							(leave blank for agent default
							{selectedSession?.customEffort ? `: ${selectedSession.customEffort}` : ''})
						</span>
					</label>
					<input
						type="text"
						value={assignment.effortOverride ?? ''}
						onChange={(e) => handleEffortOverrideChange(e.target.value)}
						placeholder={selectedSession?.customEffort ?? 'Agent default'}
						style={inputStyle}
					/>
				</div>
			)}

			{/* Empty state hint */}
			{!assignment && activeProjectRoot && eligibleSessions.length > 0 && (
				<p className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
					Select an agent above to fill this slot.
				</p>
			)}
		</div>
	);
}
