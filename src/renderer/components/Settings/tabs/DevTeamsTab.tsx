import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, GitMerge, Hammer, Power, Wrench } from 'lucide-react';
import type { Theme, Session } from '../../../types';
import { useSessionStore } from '../../../stores/sessionStore';
import { notifyToast } from '../../../stores/notificationStore';
import { truncatePath } from '../../../../shared/formatters';
import {
	DEFAULT_AGENT_DISPATCH_SETTINGS,
	type AgentDispatchSettings,
} from '../../../../shared/agent-dispatch-types';
import type {
	DispatchRole,
	ProjectRoleSlots,
	RoleSlotAssignment,
} from '../../../../shared/project-roles-types';
import { DISPATCH_ROLE_LABELS, DISPATCH_ROLES } from '../../../../shared/project-roles-types';
import { SettingsSectionHeading } from '../SettingsSectionHeading';

export interface DevTeamsTabProps {
	theme: Theme;
}

const ROLE_ICONS: Record<DispatchRole, typeof Hammer> = {
	runner: Hammer,
	fixer: Wrench,
	reviewer: Eye,
	merger: GitMerge,
};

type SlotsByProject = Record<string, ProjectRoleSlots>;

function mergeDispatchSettings(settings: Partial<AgentDispatchSettings>): AgentDispatchSettings {
	return {
		globalAutoPickupEnabled: settings.globalAutoPickupEnabled === true,
		projectAutoPickupEnabled: { ...(settings.projectAutoPickupEnabled ?? {}) },
		sshRemoteAutoPickupEnabled: { ...(settings.sshRemoteAutoPickupEnabled ?? {}) },
	};
}

function projectLabel(projectPath: string): string {
	const trimmed = projectPath.replace(/[/\\]+$/, '');
	const parts = trimmed.split(/[/\\]/);
	return parts[parts.length - 1] || projectPath;
}

export function DevTeamsTab({ theme }: DevTeamsTabProps) {
	const sessions = useSessionStore((s) => s.sessions);
	const [slotsByProject, setSlotsByProject] = useState<SlotsByProject>({});
	const [dispatchSettings, setDispatchSettings] = useState<AgentDispatchSettings>(
		DEFAULT_AGENT_DISPATCH_SETTINGS
	);
	const [loading, setLoading] = useState(true);
	const [savingProjectPath, setSavingProjectPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const projectPaths = useMemo(() => {
		const paths = new Set<string>();
		for (const session of sessions) {
			if (session.projectRoot) paths.add(session.projectRoot);
		}
		for (const projectPath of Object.keys(slotsByProject)) paths.add(projectPath);
		return Array.from(paths).sort((a, b) => projectLabel(a).localeCompare(projectLabel(b)));
	}, [sessions, slotsByProject]);

	const sessionsByProject = useMemo(() => {
		const map = new Map<string, Session[]>();
		for (const session of sessions) {
			if (!session.projectRoot) continue;
			const existing = map.get(session.projectRoot) ?? [];
			existing.push(session);
			map.set(session.projectRoot, existing);
		}
		for (const [, projectSessions] of map) {
			projectSessions.sort((a, b) => a.name.localeCompare(b.name));
		}
		return map;
	}, [sessions]);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [rolesResult, settingsResult] = await Promise.all([
				window.maestro.projectRoles.list(),
				window.maestro.agents.getDispatchSettings(),
			]);
			if (rolesResult.success) setSlotsByProject(rolesResult.data);
			setDispatchSettings(mergeDispatchSettings(settingsResult));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const saveSlots = useCallback(
		async (projectPath: string, nextSlots: ProjectRoleSlots) => {
			setSavingProjectPath(projectPath);
			setError(null);
			setSlotsByProject((prev) => ({ ...prev, [projectPath]: nextSlots }));
			try {
				const result = await window.maestro.projectRoles.set(projectPath, nextSlots);
				if (!result.success) throw new Error(result.error);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				setError(message);
				notifyToast({ color: 'red', title: 'Dev Teams save failed', message });
				void load();
			} finally {
				setSavingProjectPath(null);
			}
		},
		[load]
	);

	const saveDispatchSettings = useCallback(async (next: AgentDispatchSettings) => {
		setDispatchSettings(next);
		try {
			const ok = await window.maestro.agents.setDispatchSettings(next);
			if (!ok) throw new Error('Unable to save dispatch settings');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			setError(message);
			notifyToast({ color: 'red', title: 'Dispatch settings save failed', message });
		}
	}, []);

	const setProjectEnabled = useCallback(
		(projectPath: string, enabled: boolean) => {
			const next = mergeDispatchSettings({
				...dispatchSettings,
				projectAutoPickupEnabled: {
					...dispatchSettings.projectAutoPickupEnabled,
					[projectPath]: enabled,
				},
			});
			void saveDispatchSettings(next);
		},
		[dispatchSettings, saveDispatchSettings]
	);

	const setGlobalEnabled = useCallback(
		(enabled: boolean) => {
			void saveDispatchSettings({ ...dispatchSettings, globalAutoPickupEnabled: enabled });
		},
		[dispatchSettings, saveDispatchSettings]
	);

	const updateAssignment = useCallback(
		(projectPath: string, role: DispatchRole, agentId: string) => {
			const current = slotsByProject[projectPath] ?? {};
			const next: ProjectRoleSlots = { ...current };
			if (agentId) {
				const previous = current[role] as RoleSlotAssignment | undefined;
				next[role] = { ...previous, agentId, enabled: previous?.enabled ?? true };
			} else {
				delete next[role];
			}
			void saveSlots(projectPath, next);
		},
		[slotsByProject, saveSlots]
	);

	const updateSlotEnabled = useCallback(
		(projectPath: string, role: DispatchRole, enabled: boolean) => {
			const current = slotsByProject[projectPath] ?? {};
			const assignment = current[role];
			if (!assignment) return;
			void saveSlots(projectPath, {
				...current,
				[role]: { ...assignment, enabled },
			});
		},
		[slotsByProject, saveSlots]
	);

	return (
		<div data-setting-id="devteams-roster" className="space-y-5">
			<div className="flex items-center justify-between gap-4">
				<SettingsSectionHeading icon={Hammer}>Dev Teams</SettingsSectionHeading>
				<button
					type="button"
					onClick={() => setGlobalEnabled(!dispatchSettings.globalAutoPickupEnabled)}
					className="flex items-center gap-2 px-3 py-1.5 rounded border text-xs font-semibold"
					style={{
						borderColor: dispatchSettings.globalAutoPickupEnabled
							? theme.colors.accent
							: theme.colors.border,
						color: dispatchSettings.globalAutoPickupEnabled
							? theme.colors.accent
							: theme.colors.textDim,
						backgroundColor: dispatchSettings.globalAutoPickupEnabled
							? `${theme.colors.accent}12`
							: 'transparent',
					}}
				>
					<Power className="w-3.5 h-3.5" />
					{dispatchSettings.globalAutoPickupEnabled ? 'Auto-pickup on' : 'Auto-pickup off'}
				</button>
			</div>

			{error && (
				<div
					className="rounded border px-3 py-2 text-xs"
					style={{ borderColor: theme.colors.error, color: theme.colors.error }}
				>
					{error}
				</div>
			)}

			<div className="overflow-x-auto border rounded" style={{ borderColor: theme.colors.border }}>
				<table className="w-full text-xs">
					<thead style={{ backgroundColor: `${theme.colors.bgActivity}80` }}>
						<tr style={{ color: theme.colors.textDim }}>
							<th className="text-left px-3 py-2 font-semibold">Project</th>
							<th className="text-left px-3 py-2 font-semibold">Enabled</th>
							{DISPATCH_ROLES.map((role) => (
								<th key={role} className="text-left px-3 py-2 font-semibold">
									{DISPATCH_ROLE_LABELS[role]}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{loading && (
							<tr>
								<td className="px-3 py-6" colSpan={6} style={{ color: theme.colors.textDim }}>
									Loading dev teams...
								</td>
							</tr>
						)}
						{!loading && projectPaths.length === 0 && (
							<tr>
								<td className="px-3 py-6" colSpan={6} style={{ color: theme.colors.textDim }}>
									No projects with agents are open.
								</td>
							</tr>
						)}
						{!loading &&
							projectPaths.map((projectPath) => {
								const slots = slotsByProject[projectPath] ?? {};
								const projectSessions = sessionsByProject.get(projectPath) ?? [];
								const enabled = dispatchSettings.projectAutoPickupEnabled[projectPath] !== false;
								return (
									<tr
										key={projectPath}
										className="border-t"
										style={{ borderColor: theme.colors.border }}
									>
										<td className="px-3 py-3 align-top min-w-[180px]">
											<div className="font-semibold" style={{ color: theme.colors.textMain }}>
												{projectLabel(projectPath)}
											</div>
											<div className="mt-0.5" style={{ color: theme.colors.textDim }}>
												{truncatePath(projectPath, 46)}
											</div>
										</td>
										<td className="px-3 py-3 align-top">
											<label className="inline-flex items-center gap-2 cursor-pointer">
												<input
													type="checkbox"
													checked={enabled}
													onChange={(e) => setProjectEnabled(projectPath, e.target.checked)}
												/>
												<span
													style={{ color: enabled ? theme.colors.accent : theme.colors.textDim }}
												>
													{enabled ? 'On' : 'Off'}
												</span>
											</label>
										</td>
										{DISPATCH_ROLES.map((role) => {
											const Icon = ROLE_ICONS[role];
											const assignment = slots[role];
											return (
												<td key={role} className="px-3 py-3 align-top min-w-[150px]">
													<div className="flex items-center gap-1.5 mb-1">
														<Icon className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
														<select
															value={assignment?.agentId ?? ''}
															onChange={(e) => updateAssignment(projectPath, role, e.target.value)}
															className="w-full min-w-0 rounded border px-2 py-1 bg-transparent outline-none"
															style={{
																borderColor: theme.colors.border,
																color: theme.colors.textMain,
															}}
															disabled={savingProjectPath === projectPath}
														>
															<option value="">Unassigned</option>
															{projectSessions.map((session) => (
																<option key={session.id} value={session.id}>
																	{session.name}
																</option>
															))}
														</select>
													</div>
													{assignment && (
														<label
															className="inline-flex items-center gap-1.5"
															style={{ color: theme.colors.textDim }}
														>
															<input
																type="checkbox"
																checked={assignment.enabled !== false}
																onChange={(e) =>
																	updateSlotEnabled(projectPath, role, e.target.checked)
																}
																disabled={savingProjectPath === projectPath}
															/>
															<span>Pickup</span>
														</label>
													)}
												</td>
											);
										})}
									</tr>
								);
							})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
