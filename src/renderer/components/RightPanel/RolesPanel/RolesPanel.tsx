/**
 * RolesPanel — per-project fleet roster tab (#429).
 *
 * Shows exactly 4 slot cards (runner / fixer / reviewer / merger).
 * Persists via projectRoles:get / projectRoles:set IPC channels.
 * Polls agentDispatch:getBoard every 10 s to show busy state.
 *
 * Slots reference existing Left Bar agents (agentId-based).  SlotCard filters
 * the sessions list to agents on the same project + host as the active session.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Theme, Session } from '../../../types';
import type {
	DispatchRole,
	ProjectRoleSlots,
	RoleSlotAssignment,
} from '../../../../shared/project-roles-types';
import { DISPATCH_ROLES } from '../../../../shared/project-roles-types';
import type { WorkItem } from '../../../../shared/work-graph-types';
import { SlotCard } from './SlotCard';

interface RolesPanelProps {
	theme: Theme;
	projectPath: string | null;
	/** All Left Bar sessions — passed from RightPanel for the agent picker. */
	sessions: Session[];
	/** SSH remote ID of the active session (null = local). */
	activeRemoteId: string | null;
}

export function RolesPanel({ theme, projectPath, sessions, activeRemoteId }: RolesPanelProps) {
	const [slots, setSlots] = useState<ProjectRoleSlots>({});
	const [busyItems, setBusyItems] = useState<WorkItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	useEffect(() => {
		if (!projectPath) {
			setSlots({});
			return;
		}
		setLoading(true);
		window.maestro.projectRoles
			.get(projectPath)
			.then((res) => {
				if (res.success) {
					setSlots(res.data as ProjectRoleSlots);
				}
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [projectPath]);

	useEffect(() => {
		let cancelled = false;

		function poll() {
			if (cancelled) return;
			window.maestro.agentDispatch
				.getBoard()
				.then((res) => {
					if (!cancelled && res.success) {
						setBusyItems(res.data.items ?? []);
					}
				})
				.catch(() => {});
		}

		poll();
		const id = setInterval(poll, 10_000);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, []);

	const handleAssignmentChange = useCallback(
		(role: DispatchRole, assignment: RoleSlotAssignment | undefined) => {
			if (!projectPath) return;
			const next: ProjectRoleSlots = { ...slots };
			if (assignment) {
				next[role] = assignment;
			} else {
				delete next[role];
			}
			setSlots(next);
			setSaveError(null);
			window.maestro.projectRoles
				.set(projectPath, next)
				.then((res) => {
					if (!res.success) {
						setSaveError(res.error ?? 'Save failed');
					}
				})
				.catch((err: unknown) => {
					setSaveError(String(err));
				});
		},
		[projectPath, slots]
	);

	/**
	 * Find the busy work item for a role slot.
	 * Matched by pipeline.currentRole on the work item.
	 */
	function busyItemForRole(role: DispatchRole): WorkItem | undefined {
		const slot = slots[role];
		if (!slot) return undefined;

		return busyItems.find(
			(item) =>
				item.claim != null && item.claim.status === 'active' && item.pipeline?.currentRole === role
		);
	}

	if (!projectPath) {
		return (
			<div className="p-4">
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Open a project to configure role slots.
				</p>
			</div>
		);
	}

	return (
		<div className="py-2">
			<div className="flex items-center justify-between mb-3 px-1">
				<span
					className="text-xs font-bold uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Dev Crew
				</span>
				{loading && (
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						Loading…
					</span>
				)}
			</div>

			{saveError && (
				<div
					className="mb-3 px-3 py-2 rounded text-[10px]"
					style={{ backgroundColor: `${theme.colors.error}20`, color: theme.colors.error }}
				>
					{saveError}
				</div>
			)}

			{(DISPATCH_ROLES as DispatchRole[]).map((role) => (
				<SlotCard
					key={role}
					role={role}
					assignment={slots[role]}
					busyWorkItem={busyItemForRole(role)}
					theme={theme}
					onAssignmentChange={handleAssignmentChange}
					sessions={sessions}
					activeProjectRoot={projectPath}
					activeRemoteId={activeRemoteId}
				/>
			))}

			<p className="text-[10px] mt-2 px-1" style={{ color: theme.colors.textDim }}>
				Busy state refreshes every 10 s. Live events pending #427.
			</p>
		</div>
	);
}
