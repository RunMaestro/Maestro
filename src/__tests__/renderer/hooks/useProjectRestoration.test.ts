/**
 * Tests for useProjectRestoration hook
 *
 * Tests project loading from disk, group-to-project migration,
 * active project selection, and debounced persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock generateId to produce deterministic IDs
let idCounter = 0;
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => `mock-id-${++idCounter}`),
}));

import { useProjectRestoration } from '../../../renderer/hooks/project/useProjectRestoration';
import { useProjectStore } from '../../../renderer/stores/projectStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Project } from '../../../shared/types';
import type { Session } from '../../../renderer/types';

// ============================================================================
// Mock Setup
// ============================================================================

const mockProjectsApi = {
	getAll: vi.fn().mockResolvedValue([]),
	setAll: vi.fn().mockResolvedValue(true),
};

const mockGroupsApi = {
	getAll: vi.fn().mockResolvedValue([]),
};

const mockSettingsApi = {
	get: vi.fn().mockResolvedValue(null),
	set: vi.fn().mockResolvedValue(true),
};

// ============================================================================
// Test Helpers
// ============================================================================

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		cwd: '/projects/myapp',
		fullPath: '/projects/myapp',
		projectRoot: '/projects/myapp',
		toolType: 'claude-code' as any,
		inputMode: 'ai' as any,
		state: 'idle' as any,
		aiTabs: [
			{
				id: 'tab-1',
				agentSessionId: null,
				name: null,
				state: 'idle' as const,
				logs: [],
				starred: false,
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
			},
		],
		activeTabId: 'tab-1',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: 'tab-1' }],
		unifiedClosedTabHistory: [],
		closedTabHistory: [],
		...overrides,
	} as Session;
}

function createMockProject(overrides: Partial<Project> = {}): Project {
	return {
		id: 'project-1',
		name: 'My App',
		repoPath: '/projects/myapp',
		createdAt: Date.now(),
		...overrides,
	};
}

// ============================================================================
// Test Suite
// ============================================================================

describe('useProjectRestoration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		idCounter = 0;

		// Reset stores to clean state
		useProjectStore.setState({ projects: [], activeProjectId: '' });
		useSessionStore.setState({
			sessions: [],
			initialLoadComplete: false,
			activeSessionId: '',
		});

		// Setup window.maestro mocks
		(window as any).maestro = {
			...(window as any).maestro,
			projects: mockProjectsApi,
			groups: mockGroupsApi,
			settings: mockSettingsApi,
		};

		// Reset all mocks
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ========================================================================
	// 1. Does not run before initialLoadComplete
	// ========================================================================
	describe('startup guard', () => {
		it('does not run before initialLoadComplete is true', async () => {
			// initialLoadComplete is false by default from beforeEach
			renderHook(() => useProjectRestoration());

			// Flush microtasks
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			// Should NOT have called any IPC methods yet
			expect(mockProjectsApi.getAll).not.toHaveBeenCalled();
			expect(mockGroupsApi.getAll).not.toHaveBeenCalled();
			expect(mockSettingsApi.get).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// 2. Loads existing projects from disk
	// ========================================================================
	describe('loading saved projects', () => {
		it('loads existing projects from disk and sets them in the store', async () => {
			const savedProjects = [
				createMockProject({ id: 'p1', name: 'Project One' }),
				createMockProject({ id: 'p2', name: 'Project Two' }),
			];
			mockProjectsApi.getAll.mockResolvedValue(savedProjects);

			useSessionStore.setState({
				initialLoadComplete: true,
				sessions: [createMockSession({ id: 's1', projectId: 'p1' })],
				activeSessionId: 's1',
			});

			renderHook(() => useProjectRestoration());

			// Flush the async loadProjects call
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			expect(mockProjectsApi.getAll).toHaveBeenCalledOnce();
			expect(useProjectStore.getState().projects).toEqual(savedProjects);
		});
	});

	// ========================================================================
	// 3. Sets active project from active session
	// ========================================================================
	describe('active project selection', () => {
		it('sets active project from active session projectId', async () => {
			const savedProjects = [
				createMockProject({ id: 'p1', name: 'Project One' }),
				createMockProject({ id: 'p2', name: 'Project Two' }),
			];
			mockProjectsApi.getAll.mockResolvedValue(savedProjects);

			useSessionStore.setState({
				initialLoadComplete: true,
				sessions: [
					createMockSession({ id: 's1', projectId: 'p2' }),
					createMockSession({ id: 's2', projectId: 'p1' }),
				],
				activeSessionId: 's1',
			});

			renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			// Active session s1 has projectId 'p2', so active project should be p2
			expect(useProjectStore.getState().activeProjectId).toBe('p2');
		});

		// ====================================================================
		// 4. Falls back to first project if active session has no projectId
		// ====================================================================
		it('falls back to first project if active session has no projectId', async () => {
			const savedProjects = [
				createMockProject({ id: 'p1', name: 'Project One' }),
				createMockProject({ id: 'p2', name: 'Project Two' }),
			];
			mockProjectsApi.getAll.mockResolvedValue(savedProjects);

			useSessionStore.setState({
				initialLoadComplete: true,
				sessions: [createMockSession({ id: 's1' })], // no projectId
				activeSessionId: 's1',
			});

			renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			// Should fall back to first project
			expect(useProjectStore.getState().activeProjectId).toBe('p1');
		});
	});

	// ========================================================================
	// 5. Runs migration when no projects saved
	// ========================================================================
	describe('group-to-project migration', () => {
		it('migrates groups to projects when no saved projects exist', async () => {
			mockProjectsApi.getAll.mockResolvedValue([]);
			mockSettingsApi.get.mockResolvedValue(null); // migration not done
			mockGroupsApi.getAll.mockResolvedValue([
				{ id: 'g1', name: 'Frontend', emoji: '', collapsed: false },
				{ id: 'g2', name: 'Backend', emoji: '', collapsed: false },
			]);

			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'g1',
					projectRoot: '/projects/frontend',
					cwd: '/projects/frontend',
				}),
				createMockSession({
					id: 's2',
					groupId: 'g2',
					projectRoot: '/projects/backend',
					cwd: '/projects/backend',
				}),
			];
			useSessionStore.setState({
				initialLoadComplete: true,
				sessions,
				activeSessionId: 's1',
			});

			renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			const storeProjects = useProjectStore.getState().projects;
			expect(storeProjects).toHaveLength(2);
			expect(storeProjects[0].name).toBe('Frontend');
			expect(storeProjects[0].repoPath).toBe('/projects/frontend');
			expect(storeProjects[1].name).toBe('Backend');
			expect(storeProjects[1].repoPath).toBe('/projects/backend');

			// Sessions should have been updated with projectIds
			const updatedSessions = useSessionStore.getState().sessions;
			expect(updatedSessions[0].projectId).toBe(storeProjects[0].id);
			expect(updatedSessions[1].projectId).toBe(storeProjects[1].id);

			// Projects should have been persisted
			expect(mockProjectsApi.setAll).toHaveBeenCalledWith(storeProjects);
		});

		// ====================================================================
		// 6. Groups ungrouped sessions by projectRoot
		// ====================================================================
		it('groups ungrouped sessions by projectRoot into auto-created projects', async () => {
			mockProjectsApi.getAll.mockResolvedValue([]);
			mockSettingsApi.get.mockResolvedValue(null);
			mockGroupsApi.getAll.mockResolvedValue([]); // no groups

			const sessions = [
				createMockSession({
					id: 's1',
					projectRoot: '/projects/alpha',
					cwd: '/projects/alpha',
				}),
				createMockSession({
					id: 's2',
					projectRoot: '/projects/alpha',
					cwd: '/projects/alpha',
				}),
				createMockSession({
					id: 's3',
					projectRoot: '/projects/beta',
					cwd: '/projects/beta',
				}),
			];
			useSessionStore.setState({
				initialLoadComplete: true,
				sessions,
				activeSessionId: 's1',
			});

			renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			const storeProjects = useProjectStore.getState().projects;
			expect(storeProjects).toHaveLength(2);

			// Folder name is last segment of the path
			const projectNames = storeProjects.map((p) => p.name).sort();
			expect(projectNames).toEqual(['alpha', 'beta']);

			// s1 and s2 share the same projectRoot, so they should have the same projectId
			const updatedSessions = useSessionStore.getState().sessions;
			expect(updatedSessions[0].projectId).toBe(updatedSessions[1].projectId);
			// s3 has a different root, different project
			expect(updatedSessions[2].projectId).not.toBe(updatedSessions[0].projectId);
		});

		// ====================================================================
		// 7. Marks migration complete
		// ====================================================================
		it('marks migration complete by writing settings flag', async () => {
			mockProjectsApi.getAll.mockResolvedValue([]);
			mockSettingsApi.get.mockResolvedValue(null);
			mockGroupsApi.getAll.mockResolvedValue([]);

			useSessionStore.setState({
				initialLoadComplete: true,
				sessions: [createMockSession({ id: 's1' })],
				activeSessionId: 's1',
			});

			renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			expect(mockSettingsApi.set).toHaveBeenCalledWith('projectMigrationComplete', true);
		});

		// ====================================================================
		// 8. Skips migration if already migrated
		// ====================================================================
		it('skips migration if already migrated', async () => {
			mockProjectsApi.getAll.mockResolvedValue([]);
			mockSettingsApi.get.mockResolvedValue(true); // migration already done

			useSessionStore.setState({
				initialLoadComplete: true,
				sessions: [createMockSession({ id: 's1' })],
				activeSessionId: 's1',
			});

			renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			// groups.getAll is called to check for groups, but migration
			// short-circuits because settings returns true
			expect(mockGroupsApi.getAll).not.toHaveBeenCalled();

			// No projects should have been set (migration returned null)
			expect(useProjectStore.getState().projects).toEqual([]);
		});
	});

	// ========================================================================
	// 9. Handles errors gracefully
	// ========================================================================
	describe('error handling', () => {
		it('handles errors gracefully without crashing', async () => {
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockProjectsApi.getAll.mockRejectedValue(new Error('Disk read failed'));

			useSessionStore.setState({
				initialLoadComplete: true,
				sessions: [],
				activeSessionId: '',
			});

			// Should not throw
			renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			expect(consoleSpy).toHaveBeenCalledWith(
				'[useProjectRestoration] Failed to load/migrate projects:',
				expect.any(Error)
			);

			consoleSpy.mockRestore();
		});
	});

	// ========================================================================
	// 10. Debounced persistence writes projects on change
	// ========================================================================
	describe('debounced persistence', () => {
		it('persists projects to disk after debounce delay when projects change', async () => {
			// Start with initialLoadComplete true and saved projects
			const savedProjects = [createMockProject({ id: 'p1', name: 'Existing' })];
			mockProjectsApi.getAll.mockResolvedValue(savedProjects);

			useSessionStore.setState({
				initialLoadComplete: true,
				sessions: [createMockSession({ id: 's1', projectId: 'p1' })],
				activeSessionId: 's1',
			});

			renderHook(() => useProjectRestoration());

			// Let the initial load complete
			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			// Clear the calls from initial load
			mockProjectsApi.setAll.mockClear();

			// Simulate a project change by updating the store directly
			const updatedProjects = [
				createMockProject({ id: 'p1', name: 'Updated Name' }),
			];
			act(() => {
				useProjectStore.getState().setProjects(updatedProjects);
			});

			// Before debounce fires, setAll should not have been called
			expect(mockProjectsApi.setAll).not.toHaveBeenCalled();

			// Advance past the 2000ms debounce
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});

			// Now it should have persisted
			expect(mockProjectsApi.setAll).toHaveBeenCalledWith(updatedProjects);
		});

		it('debounces rapid project changes into a single write', async () => {
			const savedProjects = [createMockProject({ id: 'p1', name: 'Existing' })];
			mockProjectsApi.getAll.mockResolvedValue(savedProjects);

			useSessionStore.setState({
				initialLoadComplete: true,
				sessions: [createMockSession({ id: 's1', projectId: 'p1' })],
				activeSessionId: 's1',
			});

			renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			mockProjectsApi.setAll.mockClear();

			// Rapid changes
			act(() => {
				useProjectStore.getState().setProjects([
					createMockProject({ id: 'p1', name: 'Change 1' }),
				]);
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});

			act(() => {
				useProjectStore.getState().setProjects([
					createMockProject({ id: 'p1', name: 'Change 2' }),
				]);
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});

			act(() => {
				useProjectStore.getState().setProjects([
					createMockProject({ id: 'p1', name: 'Final Change' }),
				]);
			});

			// Still within debounce window for the last change
			expect(mockProjectsApi.setAll).not.toHaveBeenCalled();

			// Advance past the debounce from the last change
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});

			// Should only write the final state
			expect(mockProjectsApi.setAll).toHaveBeenCalledTimes(1);
			expect(mockProjectsApi.setAll).toHaveBeenCalledWith([
				expect.objectContaining({ name: 'Final Change' }),
			]);
		});

		it('does not persist when initialLoadComplete is false', async () => {
			// Start with initialLoadComplete false
			useSessionStore.setState({
				initialLoadComplete: false,
				sessions: [],
				activeSessionId: '',
			});

			renderHook(() => useProjectRestoration());

			// Set some projects directly in the store (simulating external change)
			act(() => {
				useProjectStore.getState().setProjects([
					createMockProject({ id: 'p1', name: 'Test' }),
				]);
			});

			// Advance past debounce
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});

			// setAll should NOT have been called for persistence
			// (it may have been called 0 times since initialLoadComplete is false)
			expect(mockProjectsApi.setAll).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// Additional edge cases
	// ========================================================================
	describe('edge cases', () => {
		it('does not run restoration twice in React strict mode', async () => {
			const savedProjects = [createMockProject({ id: 'p1' })];
			mockProjectsApi.getAll.mockResolvedValue(savedProjects);

			useSessionStore.setState({
				initialLoadComplete: true,
				sessions: [],
				activeSessionId: '',
			});

			const { rerender } = renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			// Rerender to simulate strict mode double-render
			rerender();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			// getAll should have been called only once
			expect(mockProjectsApi.getAll).toHaveBeenCalledTimes(1);
		});

		it('skips empty groups during migration', async () => {
			mockProjectsApi.getAll.mockResolvedValue([]);
			mockSettingsApi.get.mockResolvedValue(null);
			mockGroupsApi.getAll.mockResolvedValue([
				{ id: 'g1', name: 'Empty Group', emoji: '', collapsed: false },
				{ id: 'g2', name: 'Has Sessions', emoji: '', collapsed: false },
			]);

			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'g2', // only in g2
					projectRoot: '/projects/app',
					cwd: '/projects/app',
				}),
			];
			useSessionStore.setState({
				initialLoadComplete: true,
				sessions,
				activeSessionId: 's1',
			});

			renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			const storeProjects = useProjectStore.getState().projects;
			// Only g2 should produce a project (g1 has no sessions)
			expect(storeProjects).toHaveLength(1);
			expect(storeProjects[0].name).toBe('Has Sessions');
		});

		it('sets active project after migration based on active session', async () => {
			mockProjectsApi.getAll.mockResolvedValue([]);
			mockSettingsApi.get.mockResolvedValue(null);
			mockGroupsApi.getAll.mockResolvedValue([
				{ id: 'g1', name: 'ProjectA', emoji: '', collapsed: false },
				{ id: 'g2', name: 'ProjectB', emoji: '', collapsed: false },
			]);

			const sessions = [
				createMockSession({
					id: 's1',
					groupId: 'g1',
					projectRoot: '/projects/a',
					cwd: '/projects/a',
				}),
				createMockSession({
					id: 's2',
					groupId: 'g2',
					projectRoot: '/projects/b',
					cwd: '/projects/b',
				}),
			];
			useSessionStore.setState({
				initialLoadComplete: true,
				sessions,
				activeSessionId: 's2', // active session is in g2
			});

			renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			const storeProjects = useProjectStore.getState().projects;
			const projectB = storeProjects.find((p) => p.name === 'ProjectB');
			expect(projectB).toBeDefined();

			// Active project should be the one containing s2
			expect(useProjectStore.getState().activeProjectId).toBe(projectB!.id);
		});

		it('uses cwd as fallback when projectRoot is not set', async () => {
			mockProjectsApi.getAll.mockResolvedValue([]);
			mockSettingsApi.get.mockResolvedValue(null);
			mockGroupsApi.getAll.mockResolvedValue([]);

			const sessions = [
				createMockSession({
					id: 's1',
					projectRoot: '', // empty projectRoot
					cwd: '/home/user/workspace',
				}),
			];
			useSessionStore.setState({
				initialLoadComplete: true,
				sessions,
				activeSessionId: 's1',
			});

			renderHook(() => useProjectRestoration());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			const storeProjects = useProjectStore.getState().projects;
			expect(storeProjects).toHaveLength(1);
			// Should use cwd since projectRoot is empty
			expect(storeProjects[0].repoPath).toBe('/home/user/workspace');
			expect(storeProjects[0].name).toBe('workspace');
		});
	});
});
