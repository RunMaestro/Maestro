/**
 * useProjectRestoration - Loads projects from disk on startup and runs migration.
 *
 * Migration: Converts existing groups -> projects on first run.
 * After migration, groups store is left inert (not read again for project purposes).
 *
 * Effects:
 *   - Project loading/migration after sessions are loaded (with React Strict Mode guard)
 *   - Debounced persistence of project store changes to disk
 */

import { useEffect, useRef, useMemo } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useSessionStore } from '../../stores/sessionStore';
import { generateId } from '../../utils/ids';
import type { Project } from '../../../shared/types';
import type { Session } from '../../types';

const MIGRATION_KEY = 'projectMigrationComplete';
const PERSISTENCE_DEBOUNCE_MS = 2000;

// ============================================================================
// Migration Logic
// ============================================================================

/**
 * Migrate groups -> projects. Runs once on first launch after upgrade.
 *
 * 1. Each group with sessions becomes a project (name from group, repoPath from first session).
 * 2. Ungrouped sessions are grouped by projectRoot/cwd into auto-created projects.
 * 3. All affected sessions get a projectId assignment.
 * 4. Migration flag is written so it never runs again.
 *
 * Returns null if migration was already completed.
 */
async function migrateGroupsToProjects(): Promise<{
	projects: Project[];
	updatedSessions: Session[];
} | null> {
	const migrated = await window.maestro.settings.get(MIGRATION_KEY);
	if (migrated) return null;

	const groups = await window.maestro.groups.getAll();
	const sessions = useSessionStore.getState().sessions;

	const projects: Project[] = [];
	const sessionUpdates = new Map<string, string>(); // sessionId -> projectId

	// 1. Convert groups -> projects
	if (groups && groups.length > 0) {
		for (const group of groups) {
			const groupSessions = sessions.filter((s) => s.groupId === group.id);
			if (groupSessions.length === 0) continue;

			const project: Project = {
				id: generateId(),
				name: group.name || 'Unnamed Project',
				repoPath: groupSessions[0].projectRoot || groupSessions[0].cwd,
				createdAt: Date.now(),
			};
			projects.push(project);

			for (const session of groupSessions) {
				sessionUpdates.set(session.id, project.id);
			}
		}
	}

	// 2. Handle ungrouped sessions -- group by projectRoot/cwd
	const ungrouped = sessions.filter((s) => !s.groupId && !sessionUpdates.has(s.id));
	const byRoot = new Map<string, Session[]>();
	for (const session of ungrouped) {
		const root = session.projectRoot || session.cwd;
		if (!byRoot.has(root)) byRoot.set(root, []);
		byRoot.get(root)!.push(session);
	}

	for (const [root, rootSessions] of byRoot) {
		const folderName = root.split(/[\\/]/).filter(Boolean).pop() || 'Default';
		const project: Project = {
			id: generateId(),
			name: folderName,
			repoPath: root,
			createdAt: Date.now(),
		};
		projects.push(project);
		for (const session of rootSessions) {
			sessionUpdates.set(session.id, project.id);
		}
	}

	// 3. Apply projectId to sessions
	const updatedSessions = sessions.map((s) => ({
		...s,
		projectId: sessionUpdates.get(s.id) || s.projectId,
	}));

	// 4. Mark migration complete
	await window.maestro.settings.set(MIGRATION_KEY, true);

	return { projects, updatedSessions };
}

// ============================================================================
// Hook
// ============================================================================

export function useProjectRestoration() {
	const hasRun = useRef(false);
	const initialLoadComplete = useSessionStore((s) => s.initialLoadComplete);

	// Extract stable action references (Zustand actions are singletons)
	const { setProjects, setActiveProjectId } = useMemo(() => useProjectStore.getState(), []);
	const { setSessions } = useMemo(() => useSessionStore.getState(), []);

	// --- Restoration effect ---
	useEffect(() => {
		if (!initialLoadComplete || hasRun.current) return;
		hasRun.current = true;

		const loadProjects = async () => {
			// 1. Try loading existing projects from disk
			const savedProjects = await window.maestro.projects.getAll();

			if (savedProjects && savedProjects.length > 0) {
				setProjects(savedProjects);

				// Set active project to the one containing the active session
				const activeSessionId = useSessionStore.getState().activeSessionId;
				const activeSession = useSessionStore
					.getState()
					.sessions.find((s) => s.id === activeSessionId);
				if (activeSession?.projectId) {
					setActiveProjectId(activeSession.projectId);
				} else if (savedProjects.length > 0) {
					setActiveProjectId(savedProjects[0].id);
				}
				return;
			}

			// 2. No projects saved -- run migration
			const migrationResult = await migrateGroupsToProjects();
			if (migrationResult) {
				setProjects(migrationResult.projects);
				setSessions(migrationResult.updatedSessions);
				await window.maestro.projects.setAll(migrationResult.projects);

				// Set active project from active session or fall back to first
				const activeSessionId = useSessionStore.getState().activeSessionId;
				const activeSession = migrationResult.updatedSessions.find(
					(s) => s.id === activeSessionId
				);
				if (activeSession?.projectId) {
					setActiveProjectId(activeSession.projectId);
				} else if (migrationResult.projects.length > 0) {
					setActiveProjectId(migrationResult.projects[0].id);
				}
			}
		};

		loadProjects().catch((err) => {
			console.error('[useProjectRestoration] Failed to load/migrate projects:', err);
		});
	}, [initialLoadComplete, setProjects, setActiveProjectId, setSessions]);

	// --- Debounced persistence effect ---
	const projects = useProjectStore((s) => s.projects);

	useEffect(() => {
		if (!initialLoadComplete) return;

		const timer = setTimeout(() => {
			window.maestro.projects.setAll(projects);
		}, PERSISTENCE_DEBOUNCE_MS);

		return () => clearTimeout(timer);
	}, [projects, initialLoadComplete]);
}
