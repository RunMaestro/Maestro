/**
 * Tests for useSymphonyContribution hook
 *
 * Tests:
 *   - Creates session with correct Symphony metadata
 *   - Validates session uniqueness — shows error toast on failure
 *   - Agent not found — shows error toast
 *   - Git repo detection — fetches branches and tags when isRepo is true
 *   - Non-git repo — skips branch/tag fetching
 *   - Registers active contribution via IPC
 *   - Tracks stats via IPC
 *   - Closes Symphony modal after session creation
 *   - Sets active session to new session
 *   - Focuses input after creation
 *   - Switches to Auto Run right tab
 *   - Auto-starts batch run when autoRunPath and documents exist
 *   - Skips batch run when no autoRunPath
 *   - Skips batch run when no documents
 *   - Custom agent config (customPath, customArgs, customEnvVars) passed through
 *   - Error in registerActive is caught and logged (doesn't throw)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ============================================================================
// Mocks — must come before imports
// ============================================================================

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn().mockResolvedValue(false),
		getBranches: vi.fn().mockResolvedValue(['main']),
		getTags: vi.fn().mockResolvedValue([]),
	},
}));

vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

let idCounter = 0;
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => `mock-id-${++idCounter}`),
}));

vi.mock('../../../renderer/utils/sessionValidation', () => ({
	validateNewSession: vi.fn(() => ({ valid: true, error: null })),
}));

vi.mock('../../../renderer/stores/modalStore', async () => {
	const actual = await vi.importActual('../../../renderer/stores/modalStore');
	const setSymphonyModalOpen = vi.fn();
	return {
		...actual,
		getModalActions: vi.fn(() => ({ setSymphonyModalOpen })),
	};
});

vi.mock('../../../renderer/components/BatchRunnerModal', () => ({
	DEFAULT_BATCH_PROMPT: 'mock-default-batch-prompt',
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import {
	useSymphonyContribution,
	type UseSymphonyContributionDeps,
} from '../../../renderer/hooks/symphony/useSymphonyContribution';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useModalStore, getModalActions } from '../../../renderer/stores/modalStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { gitService } from '../../../renderer/services/git';
import { validateNewSession } from '../../../renderer/utils/sessionValidation';
import type { SymphonyContributionData } from '../../../renderer/components/SymphonyModal';
import type { RegisteredRepository, SymphonyIssue } from '../../../shared/symphony-types';

// ============================================================================
// Window mock
// ============================================================================

const mockRegisterActive = vi.fn().mockResolvedValue(undefined);
const mockRecordSessionCreated = vi.fn();

const mockMaestro = {
	agents: {
		get: vi.fn().mockResolvedValue({ id: 'claude-code', name: 'Claude Code', command: 'claude' }),
	},
	symphony: {
		registerActive: mockRegisterActive,
	},
	stats: {
		recordSessionCreated: mockRecordSessionCreated,
	},
};

(window as any).maestro = mockMaestro;

// ============================================================================
// Test data factories
// ============================================================================

function createRepo(overrides: Partial<RegisteredRepository> = {}): RegisteredRepository {
	return {
		slug: 'owner/repo',
		name: 'My Repo',
		description: 'A test repo',
		url: 'https://github.com/owner/repo',
		category: 'tools',
		maintainer: { name: 'Owner' },
		isActive: true,
		addedAt: '2025-01-01T00:00:00Z',
		...overrides,
	};
}

function createIssue(overrides: Partial<SymphonyIssue> = {}): SymphonyIssue {
	return {
		number: 42,
		title: 'Fix the thing',
		body: 'Please do the following...',
		url: 'https://github.com/owner/repo/issues/42',
		htmlUrl: 'https://github.com/owner/repo/issues/42',
		author: 'maintainer',
		createdAt: '2025-01-01T00:00:00Z',
		updatedAt: '2025-01-02T00:00:00Z',
		documentPaths: [
			{ name: 'task1.md', path: 'docs/task1.md', isExternal: false },
			{ name: 'task2.md', path: 'docs/task2.md', isExternal: false },
		],
		labels: [],
		status: 'available',
		...overrides,
	};
}

function createContributionData(
	overrides: Partial<SymphonyContributionData> = {}
): SymphonyContributionData {
	return {
		contributionId: 'contrib-123',
		localPath: '/tmp/cloned-repo',
		autoRunPath: '/tmp/cloned-repo/docs',
		branchName: 'symphony/fix-the-thing',
		draftPrNumber: 7,
		draftPrUrl: 'https://github.com/owner/repo/pull/7',
		agentType: 'claude-code',
		sessionName: 'Fix the thing',
		repo: createRepo(),
		issue: createIssue(),
		...overrides,
	};
}

function createDeps(
	overrides: Partial<UseSymphonyContributionDeps> = {}
): UseSymphonyContributionDeps {
	return {
		startBatchRun: vi.fn(),
		inputRef: { current: { focus: vi.fn() } } as any,
		...overrides,
	};
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	idCounter = 0;
	vi.clearAllMocks();

	// Re-establish default mock return values cleared by clearAllMocks
	mockMaestro.agents.get.mockResolvedValue({
		id: 'claude-code',
		name: 'Claude Code',
		command: 'claude',
	});
	mockRegisterActive.mockResolvedValue(undefined);
	(gitService.isRepo as ReturnType<typeof vi.fn>).mockResolvedValue(false);
	(gitService.getBranches as ReturnType<typeof vi.fn>).mockResolvedValue(['main']);
	(gitService.getTags as ReturnType<typeof vi.fn>).mockResolvedValue([]);
	(validateNewSession as ReturnType<typeof vi.fn>).mockReturnValue({ valid: true, error: null });
	(getModalActions as ReturnType<typeof vi.fn>).mockReturnValue({
		setSymphonyModalOpen: vi.fn(),
	});

	// Reset stores
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
	});

	useSettingsStore.setState({
		defaultSaveToHistory: false,
	} as any);

	useUIStore.setState({
		activeFocus: 'main',
		activeRightTab: 'files',
	} as any);

	// Reset modal store
	useModalStore.getState().closeAll();
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('useSymphonyContribution', () => {
	// ========================================================================
	// Return type
	// ========================================================================
	describe('return type', () => {
		it('returns handleStartContribution function', () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			expect(typeof result.current.handleStartContribution).toBe('function');
		});
	});

	// ========================================================================
	// Agent lookup
	// ========================================================================
	describe('agent lookup', () => {
		it('fetches the agent definition by agentType', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({ agentType: 'claude-code' });

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			expect(mockMaestro.agents.get).toHaveBeenCalledWith('claude-code');
		});

		it('shows error toast and returns early when agent is not found', async () => {
			mockMaestro.agents.get.mockResolvedValueOnce(null);
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({ agentType: 'unknown-agent' });

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Symphony Error',
					message: expect.stringContaining('unknown-agent'),
				})
			);
			expect(useSessionStore.getState().sessions).toHaveLength(0);
			consoleError.mockRestore();
		});

		it('does not create session when agent is not found', async () => {
			mockMaestro.agents.get.mockResolvedValueOnce(null);
			vi.spyOn(console, 'error').mockImplementation(() => {});

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			expect(useSessionStore.getState().sessions).toHaveLength(0);
		});
	});

	// ========================================================================
	// Session validation
	// ========================================================================
	describe('session validation', () => {
		it('calls validateNewSession with correct arguments', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({
				sessionName: 'My Contribution',
				localPath: '/some/path',
				agentType: 'claude-code',
			});

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			expect(validateNewSession).toHaveBeenCalledWith(
				'My Contribution',
				'/some/path',
				'claude-code',
				[] // empty sessions array from store
			);
		});

		it('shows error toast and returns early when validation fails', async () => {
			(validateNewSession as ReturnType<typeof vi.fn>).mockReturnValueOnce({
				valid: false,
				error: 'Duplicate session for this path',
			});
			vi.spyOn(console, 'error').mockImplementation(() => {});

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Agent Creation Failed',
					message: 'Duplicate session for this path',
				})
			);
			expect(useSessionStore.getState().sessions).toHaveLength(0);
		});

		it('shows fallback message when validation error is empty', async () => {
			(validateNewSession as ReturnType<typeof vi.fn>).mockReturnValueOnce({
				valid: false,
				error: '',
			});
			vi.spyOn(console, 'error').mockImplementation(() => {});

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Agent Creation Failed',
					message: 'Cannot create duplicate agent',
				})
			);
		});

		it('validates against current sessions in the store', async () => {
			// Pre-populate the store with an existing session
			useSessionStore.setState({
				sessions: [
					{
						id: 'existing-sess',
						name: 'Existing',
						cwd: '/existing',
					} as any,
				],
			});

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			// validateNewSession should have received the current sessions
			expect(validateNewSession).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(String),
				expect.any(String),
				expect.arrayContaining([expect.objectContaining({ id: 'existing-sess' })])
			);
		});
	});

	// ========================================================================
	// Session creation
	// ========================================================================
	describe('session creation', () => {
		it('creates a session and adds it to the store', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			expect(useSessionStore.getState().sessions).toHaveLength(1);
		});

		it('creates session with correct name, path, and toolType', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({
				sessionName: 'Fix the thing',
				localPath: '/tmp/cloned-repo',
				agentType: 'claude-code',
			});

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			const session = useSessionStore.getState().sessions[0];
			expect(session.name).toBe('Fix the thing');
			expect(session.cwd).toBe('/tmp/cloned-repo');
			expect(session.fullPath).toBe('/tmp/cloned-repo');
			expect(session.projectRoot).toBe('/tmp/cloned-repo');
			expect(session.toolType).toBe('claude-code');
			expect(session.state).toBe('idle');
		});

		it('creates session with correct Symphony metadata', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const repo = createRepo({ slug: 'owner/repo', name: 'My Repo' });
			const issue = createIssue({
				number: 99,
				title: 'Important issue',
				documentPaths: [
					{ name: 'task1.md', path: 'docs/task1.md', isExternal: false },
					{ name: 'task2.md', path: 'docs/task2.md', isExternal: false },
				],
			});
			const data = createContributionData({
				contributionId: 'contrib-abc',
				repo,
				issue,
			});

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			const session = useSessionStore.getState().sessions[0];
			expect(session.symphonyMetadata).toEqual({
				isSymphonySession: true,
				contributionId: 'contrib-abc',
				repoSlug: 'owner/repo',
				issueNumber: 99,
				issueTitle: 'Important issue',
				documentPaths: ['docs/task1.md', 'docs/task2.md'],
				status: 'running',
			});
		});

		it('sets autoRunFolderPath from contribution data', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({ autoRunPath: '/tmp/cloned-repo/auto-run-docs' });

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			const session = useSessionStore.getState().sessions[0];
			expect(session.autoRunFolderPath).toBe('/tmp/cloned-repo/auto-run-docs');
		});

		it('creates initial AI tab with correct structure', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			const session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs).toHaveLength(1);
			const tab = session.aiTabs[0];
			expect(tab.agentSessionId).toBeNull();
			expect(tab.name).toBeNull();
			expect(tab.starred).toBe(false);
			expect(tab.logs).toEqual([]);
			expect(tab.inputValue).toBe('');
			expect(tab.stagedImages).toEqual([]);
			expect(tab.state).toBe('idle');
		});

		it('uses defaultSaveToHistory setting for initial tab', async () => {
			useSettingsStore.setState({ defaultSaveToHistory: true } as any);

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			const session = useSessionStore.getState().sessions[0];
			expect(session.aiTabs[0].saveToHistory).toBe(true);
		});

		it('creates unified tab order with only the initial AI tab (no default terminal tab)', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			const session = useSessionStore.getState().sessions[0];
			// New sessions start with only an AI tab — terminal tabs are created on demand
			expect(session.unifiedTabOrder).toHaveLength(1);
			const aiRef = session.unifiedTabOrder.find((r) => r.type === 'ai');
			const termRef = session.unifiedTabOrder.find((r) => r.type === 'terminal');
			expect(aiRef).toBeDefined();
			expect(aiRef!.id).toBe(session.activeTabId);
			expect(termRef).toBeUndefined();
		});

		it('initializes session with expected default fields', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			const session = useSessionStore.getState().sessions[0];
			expect(session.aiLogs).toEqual([]);
			expect(session.workLog).toEqual([]);
			expect(session.contextUsage).toBe(0);
			expect(session.inputMode).toBe('ai');
			expect(session.aiPid).toBe(0);
			expect(session.terminalPid).toBe(0);
			expect(session.isLive).toBe(false);
			expect(session.changedFiles).toEqual([]);
			expect(session.fileTree).toEqual([]);
			expect(session.fileExplorerExpanded).toEqual([]);
			expect(session.fileExplorerScrollPos).toBe(0);
			expect(session.fileTreeAutoRefreshInterval).toBe(180);
			expect(session.aiCommandHistory).toEqual([]);
			expect(session.shellCommandHistory).toEqual([]);
			expect(session.executionQueue).toEqual([]);
			expect(session.activeTimeMs).toBe(0);
			expect(session.closedTabHistory).toEqual([]);
			expect(session.filePreviewTabs).toEqual([]);
			expect(session.activeFileTabId).toBeNull();
			expect(session.unifiedClosedTabHistory).toEqual([]);
		});

		it('creates initial shell log with "Shell Session Ready." message', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			const session = useSessionStore.getState().sessions[0];
			expect(session.shellLogs).toHaveLength(1);
			expect(session.shellLogs[0].source).toBe('system');
			expect(session.shellLogs[0].text).toBe('Shell Session Ready.');
		});
	});

	// ========================================================================
	// Custom agent config
	// ========================================================================
	describe('custom agent config', () => {
		it('passes customPath through to the session', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({ customPath: '/usr/local/bin/claude' });

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			expect(useSessionStore.getState().sessions[0].customPath).toBe('/usr/local/bin/claude');
		});

		it('passes customArgs through to the session', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({ customArgs: '--verbose --no-color' });

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			expect(useSessionStore.getState().sessions[0].customArgs).toBe('--verbose --no-color');
		});

		it('passes customEnvVars through to the session', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({
				customEnvVars: { ANTHROPIC_API_KEY: 'sk-test', DEBUG: '1' },
			});

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			expect(useSessionStore.getState().sessions[0].customEnvVars).toEqual({
				ANTHROPIC_API_KEY: 'sk-test',
				DEBUG: '1',
			});
		});

		it('stores undefined customPath when not provided', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData();
			delete data.customPath;

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			expect(useSessionStore.getState().sessions[0].customPath).toBeUndefined();
		});
	});

	// ========================================================================
	// Git repo detection
	// ========================================================================
	describe('git repo detection', () => {
		it('calls gitService.isRepo with the localPath', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({ localPath: '/tmp/my-project' });

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			expect(gitService.isRepo).toHaveBeenCalledWith('/tmp/my-project');
		});

		it('sets isGitRepo to false when path is not a git repo', async () => {
			(gitService.isRepo as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			const session = useSessionStore.getState().sessions[0];
			expect(session.isGitRepo).toBe(false);
			expect(session.gitBranches).toBeUndefined();
			expect(session.gitTags).toBeUndefined();
			expect(session.gitRefsCacheTime).toBeUndefined();
		});

		it('does not fetch branches or tags when not a git repo', async () => {
			(gitService.isRepo as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			expect(gitService.getBranches).not.toHaveBeenCalled();
			expect(gitService.getTags).not.toHaveBeenCalled();
		});

		it('sets isGitRepo to true and fetches branches and tags when is a git repo', async () => {
			(gitService.isRepo as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(gitService.getBranches as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
				'main',
				'develop',
				'feature/x',
			]);
			(gitService.getTags as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['v1.0', 'v2.0']);

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			const session = useSessionStore.getState().sessions[0];
			expect(session.isGitRepo).toBe(true);
			expect(session.gitBranches).toEqual(['main', 'develop', 'feature/x']);
			expect(session.gitTags).toEqual(['v1.0', 'v2.0']);
		});

		it('sets gitRefsCacheTime when is a git repo', async () => {
			(gitService.isRepo as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(gitService.getBranches as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['main']);
			(gitService.getTags as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

			const before = Date.now();
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			const after = Date.now();
			const session = useSessionStore.getState().sessions[0];
			expect(session.gitRefsCacheTime).toBeDefined();
			expect(session.gitRefsCacheTime).toBeGreaterThanOrEqual(before);
			expect(session.gitRefsCacheTime).toBeLessThanOrEqual(after);
		});

		it('fetches branches and tags in parallel (both called with localPath)', async () => {
			(gitService.isRepo as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
			(gitService.getBranches as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['main']);
			(gitService.getTags as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['v1.0']);

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({ localPath: '/tmp/repo' });

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			expect(gitService.getBranches).toHaveBeenCalledWith('/tmp/repo');
			expect(gitService.getTags).toHaveBeenCalledWith('/tmp/repo');
		});
	});

	// ========================================================================
	// Active session management
	// ========================================================================
	describe('active session management', () => {
		it('sets activeSessionId to the new session ID', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			const { activeSessionId, sessions } = useSessionStore.getState();
			expect(activeSessionId).toBe(sessions[0].id);
		});
	});

	// ========================================================================
	// Symphony modal
	// ========================================================================
	describe('Symphony modal', () => {
		it('closes the Symphony modal after session creation', async () => {
			const setSymphonyModalOpen = vi.fn();
			(getModalActions as ReturnType<typeof vi.fn>).mockReturnValue({ setSymphonyModalOpen });

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			expect(setSymphonyModalOpen).toHaveBeenCalledWith(false);
		});
	});

	// ========================================================================
	// IPC: registerActive
	// ========================================================================
	describe('registerActive IPC call', () => {
		it('calls window.maestro.symphony.registerActive with correct payload', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const repo = createRepo({ slug: 'owner/repo', name: 'My Repo' });
			const issue = createIssue({
				number: 42,
				title: 'Fix the thing',
				documentPaths: [
					{ name: 'task1.md', path: 'docs/task1.md', isExternal: false },
					{ name: 'task2.md', path: 'docs/task2.md', isExternal: false },
				],
			});
			const data = createContributionData({
				contributionId: 'contrib-abc',
				localPath: '/tmp/repo',
				branchName: 'symphony/issue-42',
				draftPrNumber: 7,
				draftPrUrl: 'https://github.com/owner/repo/pull/7',
				agentType: 'claude-code',
				repo,
				issue,
			});

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			const newSessionId = useSessionStore.getState().sessions[0].id;
			expect(mockRegisterActive).toHaveBeenCalledWith(
				expect.objectContaining({
					contributionId: 'contrib-abc',
					sessionId: newSessionId,
					repoSlug: 'owner/repo',
					repoName: 'My Repo',
					issueNumber: 42,
					issueTitle: 'Fix the thing',
					localPath: '/tmp/repo',
					branchName: 'symphony/issue-42',
					totalDocuments: 2,
					agentType: 'claude-code',
					draftPrNumber: 7,
					draftPrUrl: 'https://github.com/owner/repo/pull/7',
				})
			);
		});

		it('uses empty string for branchName when not provided', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({ branchName: undefined });

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			expect(mockRegisterActive).toHaveBeenCalledWith(expect.objectContaining({ branchName: '' }));
		});

		it('does not throw when registerActive rejects', async () => {
			mockRegisterActive.mockRejectedValueOnce(new Error('Network error'));
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await expect(
				act(async () => {
					await result.current.handleStartContribution(createContributionData());
				})
			).resolves.not.toThrow();

			consoleError.mockRestore();
		});

		it('logs error when registerActive rejects', async () => {
			const networkError = new Error('Network error');
			mockRegisterActive.mockRejectedValueOnce(networkError);
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			// Wait for the rejected promise's catch to run
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});

			expect(consoleError).toHaveBeenCalledWith(
				expect.stringContaining('[Symphony] Failed to register active contribution:'),
				networkError
			);
			consoleError.mockRestore();
		});

		it('still creates the session even if registerActive fails', async () => {
			mockRegisterActive.mockRejectedValueOnce(new Error('Unreachable'));
			vi.spyOn(console, 'error').mockImplementation(() => {});

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			// Session creation happens before registerActive so it should still be there
			expect(useSessionStore.getState().sessions).toHaveLength(1);
		});
	});

	// ========================================================================
	// IPC: stats
	// ========================================================================
	describe('stats recording', () => {
		it('calls window.maestro.stats.recordSessionCreated with correct payload', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));
			const data = createContributionData({ agentType: 'codex', localPath: '/tmp/repo' });

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			const newSessionId = useSessionStore.getState().sessions[0].id;
			expect(mockRecordSessionCreated).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: newSessionId,
					agentType: 'codex',
					projectPath: '/tmp/repo',
					isRemote: false,
				})
			);
		});

		it('includes a createdAt timestamp in the stats payload', async () => {
			const before = Date.now();
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			const after = Date.now();
			const call = mockRecordSessionCreated.mock.calls[0][0];
			expect(call.createdAt).toBeGreaterThanOrEqual(before);
			expect(call.createdAt).toBeLessThanOrEqual(after);
		});
	});

	// ========================================================================
	// Focus and right tab
	// ========================================================================
	describe('focus and right tab', () => {
		it('sets activeFocus to "main" after session creation', async () => {
			useUIStore.setState({ activeFocus: 'left' } as any);

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			expect(useUIStore.getState().activeFocus).toBe('main');
		});

		it('switches activeRightTab to "autorun" after session creation', async () => {
			useUIStore.setState({ activeRightTab: 'files' } as any);

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			expect(useUIStore.getState().activeRightTab).toBe('autorun');
		});

		it('focuses input element after creation (via setTimeout)', async () => {
			vi.useFakeTimers();
			const focusMock = vi.fn();
			const deps = createDeps({
				inputRef: { current: { focus: focusMock } } as any,
			});
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			// Focus is called after a 50ms timeout
			act(() => {
				vi.advanceTimersByTime(50);
			});

			expect(focusMock).toHaveBeenCalled();
			vi.useRealTimers();
		});

		it('does not crash when inputRef.current is null', async () => {
			vi.useFakeTimers();
			const deps = createDeps({
				inputRef: { current: null } as any,
			});
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			await expect(
				act(() => {
					vi.advanceTimersByTime(50);
				})
			).resolves.not.toThrow();

			vi.useRealTimers();
		});
	});

	// ========================================================================
	// Batch run auto-start
	// ========================================================================
	describe('batch run auto-start', () => {
		it('calls startBatchRun when autoRunPath and documents are present', async () => {
			vi.useFakeTimers();
			const startBatchRun = vi.fn();
			const deps = createDeps({ startBatchRun });
			const issue = createIssue({
				documentPaths: [
					{ name: 'task1.md', path: 'docs/task1.md', isExternal: false },
					{ name: 'task2.md', path: 'docs/task2.md', isExternal: false },
				],
			});
			const data = createContributionData({
				autoRunPath: '/tmp/repo/docs',
				issue,
			});

			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			// startBatchRun fires after 500ms
			act(() => {
				vi.advanceTimersByTime(500);
			});

			expect(startBatchRun).toHaveBeenCalledTimes(1);
			vi.useRealTimers();
		});

		it('calls startBatchRun with the new session ID and autoRunPath', async () => {
			vi.useFakeTimers();
			const startBatchRun = vi.fn();
			const deps = createDeps({ startBatchRun });
			const data = createContributionData({ autoRunPath: '/tmp/repo/docs' });

			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			act(() => {
				vi.advanceTimersByTime(500);
			});

			const newSessionId = useSessionStore.getState().sessions[0].id;
			expect(startBatchRun).toHaveBeenCalledWith(
				newSessionId,
				expect.any(Object),
				'/tmp/repo/docs'
			);
			vi.useRealTimers();
		});

		it('calls startBatchRun with a BatchRunConfig containing documents from the issue', async () => {
			vi.useFakeTimers();
			const startBatchRun = vi.fn();
			const deps = createDeps({ startBatchRun });
			const issue = createIssue({
				documentPaths: [
					{ name: 'task1.md', path: 'docs/task1.md', isExternal: false },
					{ name: 'task2.md', path: 'docs/task2.md', isExternal: false },
				],
			});
			const data = createContributionData({ autoRunPath: '/tmp/repo/docs', issue });

			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			act(() => {
				vi.advanceTimersByTime(500);
			});

			const [, batchConfig] = startBatchRun.mock.calls[0];
			expect(batchConfig.documents).toHaveLength(2);
			// Document filenames strip .md extension
			expect(batchConfig.documents[0].filename).toBe('task1');
			expect(batchConfig.documents[1].filename).toBe('task2');
			expect(batchConfig.prompt).toBe('mock-default-batch-prompt');
			expect(batchConfig.loopEnabled).toBe(false);
			vi.useRealTimers();
		});

		it('sets resetOnCompletion and isDuplicate to false for each document', async () => {
			vi.useFakeTimers();
			const startBatchRun = vi.fn();
			const deps = createDeps({ startBatchRun });
			const issue = createIssue({
				documentPaths: [{ name: 'task1.md', path: 'docs/task1.md', isExternal: false }],
			});
			const data = createContributionData({ autoRunPath: '/tmp/repo/docs', issue });

			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			act(() => {
				vi.advanceTimersByTime(500);
			});

			const [, batchConfig] = startBatchRun.mock.calls[0];
			expect(batchConfig.documents[0].resetOnCompletion).toBe(false);
			expect(batchConfig.documents[0].isDuplicate).toBe(false);
			vi.useRealTimers();
		});

		it('does not call startBatchRun when autoRunPath is undefined', async () => {
			vi.useFakeTimers();
			const startBatchRun = vi.fn();
			const deps = createDeps({ startBatchRun });
			const data = createContributionData({ autoRunPath: undefined });

			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			act(() => {
				vi.advanceTimersByTime(1000);
			});

			expect(startBatchRun).not.toHaveBeenCalled();
			vi.useRealTimers();
		});

		it('does not call startBatchRun when documentPaths is empty', async () => {
			vi.useFakeTimers();
			const startBatchRun = vi.fn();
			const deps = createDeps({ startBatchRun });
			const issue = createIssue({ documentPaths: [] });
			const data = createContributionData({ autoRunPath: '/tmp/repo/docs', issue });

			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			act(() => {
				vi.advanceTimersByTime(1000);
			});

			expect(startBatchRun).not.toHaveBeenCalled();
			vi.useRealTimers();
		});

		it('does not call startBatchRun before 500ms delay', async () => {
			vi.useFakeTimers();
			const startBatchRun = vi.fn();
			const deps = createDeps({ startBatchRun });
			const data = createContributionData({ autoRunPath: '/tmp/repo/docs' });

			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(data);
			});

			act(() => {
				vi.advanceTimersByTime(499);
			});

			expect(startBatchRun).not.toHaveBeenCalled();
			vi.useRealTimers();
		});
	});

	// ========================================================================
	// ID generation
	// ========================================================================
	describe('ID generation', () => {
		it('generates a unique session ID for each call', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			await act(async () => {
				await result.current.handleStartContribution(
					createContributionData({ sessionName: 'Second Session', localPath: '/another/path' })
				);
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions).toHaveLength(2);
			expect(sessions[0].id).not.toBe(sessions[1].id);
		});
	});

	// ========================================================================
	// Idempotency / order of operations
	// ========================================================================
	describe('order of operations', () => {
		it('session is in the store before handleStartContribution resolves', async () => {
			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			// After await the session must already exist in the store
			expect(useSessionStore.getState().sessions).toHaveLength(1);
		});

		it('closes Symphony modal after adding session to store', async () => {
			const setSymphonyModalOpen = vi.fn();
			(getModalActions as ReturnType<typeof vi.fn>).mockReturnValue({ setSymphonyModalOpen });

			const deps = createDeps();
			const { result } = renderHook(() => useSymphonyContribution(deps));

			await act(async () => {
				await result.current.handleStartContribution(createContributionData());
			});

			// Session should exist and modal should be closed
			expect(useSessionStore.getState().sessions).toHaveLength(1);
			expect(setSymphonyModalOpen).toHaveBeenCalledWith(false);
		});
	});
});
