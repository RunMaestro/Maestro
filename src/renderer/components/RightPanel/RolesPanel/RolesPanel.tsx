/**
 * RolesPanel — per-project fleet roster tab (#429).
 *
 * Shows exactly 4 slot cards (runner / fixer / reviewer / merger).
 * Persists via projectRoles:get / projectRoles:set IPC channels.
 *
 * #444: removed polling getBoard against work-graph SQLite.
 * Now subscribes to agentDispatch:claimStarted/claimEnded IPC events from
 * DispatchEngine to maintain a renderer-local claim state map.
 * Initial hydration via agentDispatch:getBoard (in-memory ClaimTracker).
 *
 * No GitHub query is made on initial mount — all data comes from the
 * in-memory ClaimTracker pushed via IPC events.
 *
 * Slots reference existing Left Bar agents (agentId-based). SlotCard filters
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
import { SlotCard } from './SlotCard';

/** Minimal claim shape needed to show busy state on a SlotCard. */
interface ActiveClaimInfo {
	projectPath: string;
	role: string;
	issueNumber: number;
	issueTitle: string;
	claimedAt: string;
}

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
	// Renderer-local claim state: role → claim info
	const [activeClaims, setActiveClaims] = useState<Map<string, ActiveClaimInfo>>(new Map());
	const [loading, setLoading] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	// Load project role slots when projectPath changes
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

	// Hydrate initial claim state from in-memory ClaimTracker (no GitHub query)
	useEffect(() => {
		window.maestro.agentDispatch
			.getBoard()
			.then((res) => {
				if (!res.success) return;
				const items = (res.data as { items?: ActiveClaimInfo[] }).items ?? [];
				const map = new Map<string, ActiveClaimInfo>();
				for (const item of items) {
					if (item.role) map.set(item.role, item);
				}
				setActiveClaims(map);
			})
			.catch(() => {});
	}, []);

	// Subscribe to live claim events from DispatchEngine (#444)
	useEffect(() => {
		const unsubStart = window.maestro.agentDispatch.onClaimStarted((event) => {
			setActiveClaims((prev) => {
				const next = new Map(prev);
				next.set(event.role, event);
				return next;
			});
		});

		const unsubEnd = window.maestro.agentDispatch.onClaimEnded((event) => {
			setActiveClaims((prev) => {
				const next = new Map(prev);
				next.delete(event.role);
				return next;
			});
		});

		return () => {
			unsubStart();
			unsubEnd();
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
	 * Find the busy claim info for a role slot.
	 * Matched by role name against the renderer-local claim map.
	 */
	function busyClaimForRole(role: DispatchRole): ActiveClaimInfo | undefined {
		return activeClaims.get(role);
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
					activeClaim={busyClaimForRole(role)}
					theme={theme}
					onAssignmentChange={handleAssignmentChange}
					sessions={sessions}
					activeProjectRoot={projectPath}
					activeRemoteId={activeRemoteId}
				/>
			))}

			<p className="text-[10px] mt-2 px-1" style={{ color: theme.colors.textDim }}>
				Busy state updates via live events from DispatchEngine (#444).
			</p>
		</div>
	);
}
