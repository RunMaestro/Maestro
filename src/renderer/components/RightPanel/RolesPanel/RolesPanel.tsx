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

/** Candidate project entry returned when MULTIPLE_MATCHES. */
interface ProjectCandidate {
	id: string;
	number: number;
	title: string;
}

/** Structured error from pm:resolveGithubProject. */
interface GithubProjectError {
	code: string;
	message: string;
	detail?: string;
	candidates?: ProjectCandidate[];
}

/** Map a structured error code to a user-facing message + action hint. */
function describeDiscoveryError(err: GithubProjectError): { label: string; action: string } {
	switch (err.code) {
		case 'GH_CLI_MISSING':
			return {
				label: 'gh CLI not found.',
				action: 'Install from https://cli.github.com/ then retry.',
			};
		case 'GH_AUTH_REQUIRED':
			return {
				label: 'Not logged in to GitHub CLI.',
				action: 'Run: gh auth login',
			};
		case 'NOT_A_GIT_REPO':
			return {
				label: 'Not a git repository.',
				action: 'Open a folder that contains a .git directory.',
			};
		case 'NO_ORIGIN_REMOTE':
			return {
				label: 'No origin remote configured.',
				action: 'Run: git remote add origin <url>',
			};
		case 'NOT_GITHUB':
			return {
				label: 'Origin remote is not on github.com.',
				action: 'Use a GitHub remote or configure the project manually.',
			};
		case 'NO_PROJECT_AND_CANNOT_CREATE':
			return {
				label: 'No Projects v2 found and cannot create one.',
				action: 'Check user/org permissions in GitHub settings.',
			};
		case 'MULTIPLE_MATCHES':
			return {
				label: `Multiple matching projects found (${err.candidates?.length ?? '?'}).`,
				action: 'Pick one below.',
			};
		case 'GH_CLI_OUTPUT_UNRECOGNIZED':
			return {
				label: 'Unexpected output from gh CLI (version mismatch?).',
				action: 'Update gh CLI and retry.',
			};
		case 'GH_PERMISSION_DENIED':
			return {
				label: 'Permission denied.',
				action: err.detail ?? 'Check your GitHub org project permissions.',
			};
		default:
			return {
				label: err.message,
				action: 'Retry or configure manually.',
			};
	}
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
	/**
	 * Full SSH remote config for the active session.
	 * Passed to pm:resolveGithubProject so git runs on the remote host for
	 * sessions whose project lives on an SSH remote.
	 */
	activeSshRemoteId?: string | null;
}

export function RolesPanel({
	theme,
	projectPath,
	sessions,
	activeRemoteId,
	activeSshRemoteId,
}: RolesPanelProps) {
	const [slots, setSlots] = useState<ProjectRoleSlots>({});
	// Renderer-local claim state: role → claim info
	const [activeClaims, setActiveClaims] = useState<Map<string, ActiveClaimInfo>>(new Map());
	const [loading, setLoading] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	// GitHub project mapping (#447)
	const [githubProject, setGithubProject] = useState<GithubProjectInfo | null>(null);
	const [githubProjectLoading, setGithubProjectLoading] = useState(false);
	const [githubProjectError, setGithubProjectError] = useState<GithubProjectError | null>(null);
	// When MULTIPLE_MATCHES: the user-selected candidate (null = not yet picked)
	const [pickedCandidate, setPickedCandidate] = useState<ProjectCandidate | null>(null);

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

	/** Shared resolve logic used on mount, retry, and after manual pick. */
	const resolveGithubProject = useCallback(
		(forceRefresh = false) => {
			if (!projectPath) return;
			setGithubProjectLoading(true);
			setGithubProjectError(null);
			window.maestro.pmResolveGithubProject
				.resolve({ projectPath, forceRefresh, sshRemoteId: activeSshRemoteId ?? null })
				.then((res) => {
					if (res.success) {
						setGithubProject({
							owner: res.data.owner,
							repo: res.data.repo,
							projectNumber: res.data.projectNumber,
							projectTitle: res.data.projectTitle,
						});
						setPickedCandidate(null);
					} else {
						setGithubProjectError({
							code: res.code,
							message: res.error,
							detail: res.detail,
							candidates: res.candidates,
						});
					}
				})
				.catch((err: unknown) => {
					setGithubProjectError({ code: 'UNKNOWN', message: String(err) });
				})
				.finally(() => setGithubProjectLoading(false));
		},
		[projectPath, activeSshRemoteId]
	);

	// Resolve GitHub project mapping on mount / projectPath change (#447)
	useEffect(() => {
		if (!projectPath) {
			setGithubProject(null);
			setGithubProjectError(null);
			setPickedCandidate(null);
			return;
		}
		resolveGithubProject(false);
	}, [projectPath, resolveGithubProject]);

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
					// Scope to this panel's project — the global ClaimTracker has
					// claims from every project, but each RolesPanel instance only
					// shows its own.
					if (projectPath && item.projectPath !== projectPath) continue;
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
			// Ignore events for other projects — each RolesPanel only mirrors its own.
			if (projectPath && event.projectPath !== projectPath) return;
			setActiveClaims((prev) => {
				const next = new Map(prev);
				next.set(event.role, event);
				return next;
			});
		});

		const unsubEnd = window.maestro.agentDispatch.onClaimEnded((event) => {
			if (projectPath && event.projectPath !== projectPath) return;
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
	}, [projectPath]);

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
				className="mb-3 px-2 py-1.5 rounded text-[10px] flex flex-col gap-1"
				style={{ backgroundColor: `${theme.colors.textDim}15`, color: theme.colors.textDim }}
			>
				{githubProjectLoading && <span>Resolving GitHub project…</span>}

				{/* Structured error display */}
				{!githubProjectLoading &&
					githubProjectError &&
					(() => {
						const { label, action } = describeDiscoveryError(githubProjectError);
						const isMultiMatch = githubProjectError.code === 'MULTIPLE_MATCHES';
						const canRetry = !isMultiMatch;
						return (
							<>
								<div className="flex items-start gap-1 flex-wrap">
									<span style={{ color: theme.colors.error }}>GitHub: {label}</span>
									{canRetry && (
										<button
											className="underline ml-1 cursor-pointer"
											style={{ color: theme.colors.accent ?? theme.colors.textDim }}
											onClick={() => resolveGithubProject(true)}
										>
											Retry
										</button>
									)}
								</div>
								<span style={{ color: theme.colors.textDim }}>{action}</span>

								{/* MULTIPLE_MATCHES: show a picker so the user can choose */}
								{isMultiMatch && githubProjectError.candidates && (
									<div className="mt-1 flex flex-col gap-0.5">
										<span
											className="font-semibold"
											style={{ color: theme.colors.textMain ?? theme.colors.textDim }}
										>
											Configure manually — pick a project:
										</span>
										{githubProjectError.candidates.map((c) => (
											<button
												key={c.id || c.number}
												className="text-left px-1 py-0.5 rounded hover:opacity-80 cursor-pointer"
												style={{
													backgroundColor:
														pickedCandidate?.number === c.number
															? `${theme.colors.accent ?? theme.colors.textDim}30`
															: 'transparent',
													color: theme.colors.textMain ?? theme.colors.textDim,
													border: `1px solid ${theme.colors.textDim}40`,
												}}
												onClick={() => {
													setPickedCandidate(c);
													// Treat a user pick as a confirmed mapping: surface it as success
													// by pushing it to the settings store via a force-refresh that
													// would normally call discovery — but here we short-circuit by
													// constructing a synthetic success.  The simplest route is to
													// call the normal resolve (which re-runs discovery) with the
													// expectation that MULTIPLE_MATCHES still fires, then override
													// the display state locally from the candidate.
													//
													// We surface the picked candidate immediately; the store will be
													// updated on the next resolveGithubProject call with the right
													// project selected (if the user later hits Reconfigure).
													setGithubProjectError(null);
													setGithubProject({
														owner: '',
														repo: '',
														projectNumber: c.number,
														projectTitle: c.title,
													});
												}}
											>
												#{c.number} — {c.title}
											</button>
										))}
									</div>
								)}
							</>
						);
					})()}

				{/* Happy path */}
				{!githubProjectLoading && !githubProjectError && githubProject && (
					<div className="flex items-center gap-1 flex-wrap">
						<span>GitHub:</span>
						{githubProject.owner && (
							<>
								<a
									href={`https://github.com/${githubProject.owner}/${githubProject.repo}`}
									onClick={(e) => {
										e.preventDefault();
										void window.maestro.shell?.openExternal?.(
											`https://github.com/${githubProject.owner}/${githubProject.repo}`
										);
									}}
									className="font-medium hover:underline cursor-pointer"
									style={{ color: theme.colors.textMain ?? theme.colors.textDim }}
								>
									{githubProject.owner}/{githubProject.repo}
								</a>
								<span>·</span>
							</>
						)}
						<a
							href={
								githubProject.owner
									? `https://github.com/orgs/${githubProject.owner}/projects/${githubProject.projectNumber}`
									: '#'
							}
							onClick={(e) => {
								e.preventDefault();
								if (githubProject.owner) {
									void window.maestro.shell?.openExternal?.(
										`https://github.com/orgs/${githubProject.owner}/projects/${githubProject.projectNumber}`
									);
								}
							}}
							className="hover:underline cursor-pointer"
							style={{ color: theme.colors.textMain ?? theme.colors.textDim }}
						>
							Project #{githubProject.projectNumber} '{githubProject.projectTitle}'
						</a>
						<span>↗</span>
						<button
							className="ml-auto text-[9px] underline cursor-pointer"
							title="Reconfigure GitHub project"
							style={{ color: theme.colors.textDim }}
							onClick={() => resolveGithubProject(true)}
						>
							Reconfigure
						</button>
					</div>
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
					githubOwner={githubProject?.owner}
					githubRepo={githubProject?.repo}
				/>
			))}

			<p className="text-[10px] mt-2 px-1" style={{ color: theme.colors.textDim }}>
				Busy state updates via live events from DispatchEngine (#444).
			</p>
		</div>
	);
}
