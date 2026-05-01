import React, { useState, useEffect, useCallback } from 'react';
import type { Theme } from '../../../types';
import type { DispatchRole, RoleSlotAssignment } from '../../../../shared/project-roles-types';
import { DISPATCH_ROLE_LABELS } from '../../../../shared/project-roles-types';
import type { Session } from '../../../types';
import type { WorkItem } from '../../../../shared/work-graph-types';

// Role icon characters
const ROLE_ICONS: Record<DispatchRole, string> = {
	runner: '▶',
	fixer: '🔧',
	reviewer: '👁',
	merger: '⎇',
};

export interface SlotCardProps {
	role: DispatchRole;
	assignment: RoleSlotAssignment | undefined;
	sessions: Session[];
	busyWorkItem?: WorkItem;
	theme: Theme;
	onAssignmentChange: (role: DispatchRole, assignment: RoleSlotAssignment | undefined) => void;
}

export function SlotCard({
	role,
	assignment,
	sessions,
	busyWorkItem,
	theme,
	onAssignmentChange,
}: SlotCardProps) {
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [availableEfforts, setAvailableEfforts] = useState<string[]>([]);

	const assignedSession = assignment
		? sessions.find((s) => s.id === assignment.agentId)
		: undefined;

	useEffect(() => {
		if (!assignedSession?.toolType) {
			setAvailableModels([]);
			setAvailableEfforts([]);
			return;
		}
		let stale = false;
		const agentId = assignedSession.toolType;

		window.maestro.agents
			.getModels(agentId)
			.then((models) => {
				if (!stale) setAvailableModels(models ?? []);
			})
			.catch(() => {
				if (!stale) setAvailableModels([]);
			});

		Promise.all([
			window.maestro.agents.getConfigOptions(agentId, 'effort').catch(() => [] as string[]),
			window.maestro.agents
				.getConfigOptions(agentId, 'reasoningEffort')
				.catch(() => [] as string[]),
		])
			.then(([effortOpts, reasoningOpts]) => {
				if (!stale) {
					setAvailableEfforts(effortOpts.length > 0 ? effortOpts : reasoningOpts);
				}
			})
			.catch(() => {
				if (!stale) setAvailableEfforts([]);
			});

		return () => {
			stale = true;
		};
	}, [assignedSession?.toolType]);

	const handleAgentChange = useCallback(
		(agentId: string) => {
			if (!agentId) {
				onAssignmentChange(role, undefined);
				return;
			}
			onAssignmentChange(role, {
				agentId,
				modelOverride: assignment?.modelOverride,
				effortOverride: assignment?.effortOverride,
			});
		},
		[role, assignment, onAssignmentChange]
	);

	const handleModelChange = useCallback(
		(model: string) => {
			if (!assignment) return;
			onAssignmentChange(role, { ...assignment, modelOverride: model || undefined });
		},
		[role, assignment, onAssignmentChange]
	);

	const handleEffortChange = useCallback(
		(effort: string) => {
			if (!assignment) return;
			onAssignmentChange(role, { ...assignment, effortOverride: effort || undefined });
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

	// enabled defaults to true when absent
	const slotEnabled = assignment ? assignment.enabled !== false : true;

	const githubNumber = busyWorkItem?.github?.issueNumber;
	const githubUrl = busyWorkItem?.github?.url;
	const workItemDisplayId = githubNumber ? `#${githubNumber}` : busyWorkItem?.id;

	/**
	 * Status badge text (#437 drain-mode spec):
	 *   On  + no busy item  → "On (Available)"
	 *   On  + busy item     → "On (Busy: #1234)"
	 *   Off + busy item     → "Off (Draining: #1234)"
	 *   Off + no busy item  → "Off (Idle)"
	 */
	type StatusVariant = 'on-available' | 'on-busy' | 'off-draining' | 'off-idle';
	const statusVariant: StatusVariant | null = assignment
		? slotEnabled
			? busyWorkItem
				? 'on-busy'
				: 'on-available'
			: busyWorkItem
				? 'off-draining'
				: 'off-idle'
		: null;

	const openGithub = useCallback(() => {
		if (githubUrl) {
			void window.maestro.shell.openExternal(githubUrl);
		}
	}, [githubUrl]);

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

	const statusBadgeColor = (v: StatusVariant) => {
		if (v === 'on-busy' || v === 'off-draining') return theme.colors.warning;
		if (v === 'on-available') return theme.colors.accent;
		return theme.colors.textDim; // off-idle
	};

	const statusBadgeBg = (v: StatusVariant) => {
		if (v === 'on-busy' || v === 'off-draining') return `${theme.colors.warning}25`;
		if (v === 'on-available') return `${theme.colors.accent}20`;
		return `${theme.colors.textDim}20`; // off-idle
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
			<div className="flex items-center justify-between mb-2">
				<div className="flex items-center gap-1.5">
					<span style={{ fontSize: '13px' }}>{ROLE_ICONS[role]}</span>
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
									{busyWorkItem ? (
										<button
											className="underline bg-transparent border-none p-0 cursor-pointer"
											style={{ color: theme.colors.warning, fontSize: 'inherit' }}
											onClick={openGithub}
											title={busyWorkItem.title}
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
									{busyWorkItem ? (
										<button
											className="underline bg-transparent border-none p-0 cursor-pointer"
											style={{ color: theme.colors.warning, fontSize: 'inherit' }}
											onClick={openGithub}
											title={busyWorkItem.title}
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

			<div className="mb-2">
				<label className="block text-[10px] mb-1" style={{ color: theme.colors.textDim }}>
					Agent
				</label>
				{role === 'runner' ? (
					<>
						<select
							value={assignment?.agentId ?? ''}
							onChange={(e) => handleAgentChange(e.target.value)}
							style={selectStyle}
							title="Agent assigned to this role slot"
						>
							<option value="">Select agent for {DISPATCH_ROLE_LABELS[role]}</option>
							{sessions.filter((s) => !s.sessionSshRemoteConfig?.enabled).length === 0 ? (
								<option value="" disabled>
									No local agents available — runner role requires local execution.
								</option>
							) : (
								sessions.map((s) => {
									const isRemote = s.sessionSshRemoteConfig?.enabled === true;
									if (isRemote) return null;
									return (
										<option key={s.id} value={s.id}>
											{s.name || s.id}
										</option>
									);
								})
							)}
						</select>
						{sessions.some((s) => s.sessionSshRemoteConfig?.enabled) && (
							<p className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
								SSH-remote agents are hidden — runners must be local.
							</p>
						)}
					</>
				) : (
					<select
						value={assignment?.agentId ?? ''}
						onChange={(e) => handleAgentChange(e.target.value)}
						style={selectStyle}
						title="Agent assigned to this role slot"
					>
						<option value="">Select agent for {DISPATCH_ROLE_LABELS[role]}</option>
						{sessions.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name || s.id}
							</option>
						))}
					</select>
				)}
			</div>

			{assignment && availableModels.length > 0 && (
				<div className="mb-2">
					<label className="block text-[10px] mb-1" style={{ color: theme.colors.textDim }}>
						Model
					</label>
					<select
						value={assignment.modelOverride ?? ''}
						onChange={(e) => handleModelChange(e.target.value)}
						style={selectStyle}
						title="Used when this agent claims a task in this role"
					>
						<option value="">Agent default</option>
						{availableModels.map((m) => (
							<option key={m} value={m}>
								{m}
							</option>
						))}
					</select>
				</div>
			)}

			{assignment && availableEfforts.length > 0 && (
				<div>
					<label className="block text-[10px] mb-1" style={{ color: theme.colors.textDim }}>
						Effort
					</label>
					<select
						value={assignment.effortOverride ?? ''}
						onChange={(e) => handleEffortChange(e.target.value)}
						style={selectStyle}
						title="Used when this agent claims a task in this role"
					>
						<option value="">Agent default</option>
						{availableEfforts.map((e) => (
							<option key={e} value={e}>
								{e}
							</option>
						))}
					</select>
				</div>
			)}

			{!assignment && (
				<p className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
					No agent assigned — pick one above to fill this slot.
				</p>
			)}
		</div>
	);
}
