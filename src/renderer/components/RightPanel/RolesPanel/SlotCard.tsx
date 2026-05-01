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

	const statusLabel = assignment ? (busyWorkItem ? 'busy' : 'idle') : null;

	const githubNumber = busyWorkItem?.github?.issueNumber;
	const githubUrl = busyWorkItem?.github?.url;
	const workItemDisplayId = githubNumber ? `#${githubNumber}` : busyWorkItem?.id;

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

	return (
		<div
			className="rounded border mb-3 p-3"
			style={{
				borderColor: statusLabel === 'busy' ? theme.colors.warning : theme.colors.border,
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

				{statusLabel && (
					<span
						className="text-[10px] px-1.5 py-0.5 rounded font-medium"
						style={{
							backgroundColor:
								statusLabel === 'busy' ? `${theme.colors.warning}25` : `${theme.colors.accent}20`,
							color: statusLabel === 'busy' ? theme.colors.warning : theme.colors.accent,
						}}
					>
						{statusLabel === 'busy' ? (
							<>
								{'Busy: '}
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
							</>
						) : (
							'Idle'
						)}
					</span>
				)}
			</div>

			<div className="mb-2">
				<label className="block text-[10px] mb-1" style={{ color: theme.colors.textDim }}>
					Agent
				</label>
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
