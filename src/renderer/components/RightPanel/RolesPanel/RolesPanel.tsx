/**
 * RolesPanel — per-project fleet roster tab (#429).
 *
 * Shows exactly 4 slot cards (runner / fixer / reviewer / merger).
 * Persists via projectRoles:get / projectRoles:set IPC channels.
 * Polls agentDispatch:getBoard every 10 s to show busy state.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Theme } from '../../../types';
import type { Session } from '../../../types';
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
	sessions: Session[];
}

export function RolesPanel({ theme, projectPath, sessions }: RolesPanelProps) {
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
					setSlots(res.data);
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

	function busyItemForRole(role: DispatchRole): WorkItem | undefined {
		const assignment = slots[role];
		if (!assignment) return undefined;
		const { agentId } = assignment;
		return busyItems.find(
			(item) =>
				item.claim != null &&
				item.claim.status === 'active' &&
				(item.owner?.id === agentId || item.claim.owner?.id === agentId)
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
					Fleet Roster
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
					sessions={sessions}
					busyWorkItem={busyItemForRole(role)}
					theme={theme}
					onAssignmentChange={handleAssignmentChange}
				/>
			))}

			<p className="text-[10px] mt-2 px-1" style={{ color: theme.colors.textDim }}>
				Busy state refreshes every 10 s. Live events pending #427.
			</p>
		</div>
	);
}
