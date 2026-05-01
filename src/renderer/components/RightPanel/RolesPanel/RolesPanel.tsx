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

/** Resolved GitHub project info, shown in the panel header (#447). */
interface GithubProjectInfo {
	owner: string;
	repo: string;
	projectNumber: number;
	projectTitle: string;
}

/** Minimal claim shape needed to show busy state on a SlotCard. */
interface ActiveClaimInfo {
	projectPath: string;
	role: string;
	agentId: string;
	sessionId: string;
	issueNumber?: number;
	issueTitle?: string;
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
	// GitHub project mapping (#447)
	const [githubProject, setGithubProject] = useState<GithubProjectInfo | null>(null);
	const [githubProjectLoading, setGithubProjectLoading] = useState(false);
	const [githubProjectError, setGithubProjectError] = useState<string | null>(null);

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

	// Resolve GitHub project mapping on mount / projectPath change (#447)
	useEffect(() => {
		if (!projectPath) {
			setGithubProject(null);
			setGithubProjectError(null);
			return;
		}
		setGithubProjectLoading(true);
		setGithubProjectError(null);
		window.maestro.pmResolveGithubProject
			.resolve({ projectPath })
			.then((res) => {
				if (res.success) {
					setGithubProject({
						owner: res.data.owner,
						repo: res.data.repo,
						projectNumber: res.data.projectNumber,
						projectTitle: res.data.projectTitle,
					});
				} else {
					setGithubProjectError(res.error);
				}
			})
			.catch((err: unknown) => {
				setGithubProjectError(String(err));
			})
			.finally(() => setGithubProjectLoading(false));
	}, [projectPath]);

	// Hydrate initial claim state from in-memory ClaimTracker (no GitHub query).
	// ClaimInfo from getBoard uses agentSessionId rather than agentId/sessionId,
	// so we normalise the shape here for the renderer-local map.
	useEffect(() => {
		window.maestro.agentDispatch
			.getBoard()
			.then((res) => {
				if (!res.success) return;
				type BoardItem = {
					role?: string;
					projectPath?: string;
					agentSessionId?: string;
					issueNumber?: number;
					issueTitle?: string;
					claimedAt?: string;
				};
				const items = (res.data as { items?: BoardItem[] }).items ?? [];
				const map = new Map<string, ActiveClaimInfo>();
				for (const item of items) {
					if (!item.role) continue;
					map.set(item.role, {
						projectPath: item.projectPath ?? '',
						role: item.role,
						agentId: item.agentSessionId ?? '',
						sessionId: item.agentSessionId ?? '',
						issueNumber: item.issueNumber,
						issueTitle: item.issueTitle,
						claimedAt: item.claimedAt ?? new Date().toISOString(),
					});
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

			{/* GitHub project header (#447) */}
			<div
				className="mb-3 px-2 py-1.5 rounded text-[10px] flex items-center gap-1 flex-wrap"
				style={{ backgroundColor: `${theme.colors.textDim}15`, color: theme.colors.textDim }}
			>
				{githubProjectLoading && <span>Resolving GitHub project…</span>}
				{!githubProjectLoading && githubProjectError && (
					<>
						<span style={{ color: theme.colors.error }}>GitHub: {githubProjectError}</span>
						<button
							className="underline ml-1 cursor-pointer"
							style={{ color: theme.colors.accent ?? theme.colors.textDim }}
							onClick={() => {
								if (!projectPath) return;
								setGithubProjectLoading(true);
								setGithubProjectError(null);
								window.maestro.pmResolveGithubProject
									.resolve({ projectPath, forceRefresh: true })
									.then((res) => {
										if (res.success) {
											setGithubProject({
												owner: res.data.owner,
												repo: res.data.repo,
												projectNumber: res.data.projectNumber,
												projectTitle: res.data.projectTitle,
											});
										} else {
											setGithubProjectError(res.error);
										}
									})
									.catch((err: unknown) => setGithubProjectError(String(err)))
									.finally(() => setGithubProjectLoading(false));
							}}
						>
							Retry
						</button>
					</>
				)}
				{!githubProjectLoading && !githubProjectError && githubProject && (
					<>
						<span>GitHub:</span>
						<a
							href={`https://github.com/${githubProject.owner}/${githubProject.repo}`}
							target="_blank"
							rel="noreferrer"
							className="font-medium hover:underline"
							style={{ color: theme.colors.textMain ?? theme.colors.textDim }}
						>
							{githubProject.owner}/{githubProject.repo}
						</a>
						<span>·</span>
						<a
							href={`https://github.com/orgs/${githubProject.owner}/projects/${githubProject.projectNumber}`}
							target="_blank"
							rel="noreferrer"
							className="hover:underline"
							style={{ color: theme.colors.textMain ?? theme.colors.textDim }}
						>
							Project #{githubProject.projectNumber} '{githubProject.projectTitle}'
						</a>
						<span>↗</span>
						<button
							className="ml-auto text-[9px] underline cursor-pointer"
							title="Reconfigure GitHub project"
							style={{ color: theme.colors.textDim }}
							onClick={() => {
								if (!projectPath) return;
								setGithubProjectLoading(true);
								setGithubProjectError(null);
								window.maestro.pmResolveGithubProject
									.resolve({ projectPath, forceRefresh: true })
									.then((res) => {
										if (res.success) {
											setGithubProject({
												owner: res.data.owner,
												repo: res.data.repo,
												projectNumber: res.data.projectNumber,
												projectTitle: res.data.projectTitle,
											});
										} else {
											setGithubProjectError(res.error);
										}
									})
									.catch((err: unknown) => setGithubProjectError(String(err)))
									.finally(() => setGithubProjectLoading(false));
							}}
						>
							Reconfigure
						</button>
					</>
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
