/**
 * Tests for useProviderHealth hook.
 * Validates health computation, status determination, and failover event subscription.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useProviderHealth } from '../../../renderer/hooks/useProviderHealth';
import type { Session } from '../../../renderer/types';
import type { ProviderErrorStats } from '../../../shared/account-types';

// ── Mock data ────────────────────────────────────────────────────────────────

const mockAgents = [
	{ id: 'claude-code', name: 'Claude Code', available: true, hidden: false },
	{ id: 'opencode', name: 'OpenCode', available: true, hidden: false },
	{ id: 'codex', name: 'Codex', available: false, hidden: false },
	{ id: 'terminal', name: 'Terminal', available: true, hidden: false },
];

const emptyErrorStats: Record<string, ProviderErrorStats> = {};

function createSession(id: string, toolType: string, overrides?: Partial<Session>): Session {
	return {
		id,
		name: `Session ${id}`,
		toolType: toolType as any,
		state: 'idle',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		activeTimeMs: 0,
		executionQueue: [],
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		...overrides,
	};
}

// ── Mocks ──────────────────────────────────────────────────────────────────

let failoverCallback: (() => void) | null = null;

beforeEach(() => {
	vi.clearAllMocks();
	failoverCallback = null;

	vi.mocked(window.maestro.agents.detect).mockResolvedValue(mockAgents);
	vi.mocked(window.maestro.providers.getAllErrorStats).mockResolvedValue(emptyErrorStats);
	vi.mocked(window.maestro.settings.get).mockResolvedValue(null);
	vi.mocked(window.maestro.providers.onFailoverSuggest).mockImplementation((handler: any) => {
		failoverCallback = handler;
		return () => { failoverCallback = null; };
	});
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useProviderHealth', () => {
	it('loads providers on mount and sets loading state', async () => {
		const sessions = [createSession('s1', 'claude-code')];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		expect(result.current.isLoading).toBe(true);

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// Should filter out terminal
		expect(result.current.providers).toHaveLength(3);
		expect(result.current.providers.map((p) => p.toolType)).toEqual([
			'claude-code',
			'opencode',
			'codex',
		]);
	});

	it('computes healthy status for available providers with 0 errors', async () => {
		const sessions = [createSession('s1', 'claude-code')];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		const claude = result.current.providers.find((p) => p.toolType === 'claude-code')!;
		expect(claude.status).toBe('healthy');
		expect(claude.healthPercent).toBe(100);
		expect(claude.activeSessionCount).toBe(1);
	});

	it('computes not_installed status for unavailable providers', async () => {
		const sessions: Session[] = [];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		const codex = result.current.providers.find((p) => p.toolType === 'codex')!;
		expect(codex.status).toBe('not_installed');
		expect(codex.healthPercent).toBe(0);
	});

	it('computes idle status for available providers with 0 sessions', async () => {
		const sessions: Session[] = [];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		const opencode = result.current.providers.find((p) => p.toolType === 'opencode')!;
		expect(opencode.status).toBe('idle');
		expect(opencode.healthPercent).toBe(100);
	});

	it('computes degraded status when errors exist below threshold', async () => {
		const errorStats: Record<string, ProviderErrorStats> = {
			'claude-code': {
				toolType: 'claude-code',
				activeErrorCount: 1,
				totalErrorsInWindow: 1,
				lastErrorAt: Date.now() - 30_000,
				sessionsWithErrors: 1,
			},
		};
		vi.mocked(window.maestro.providers.getAllErrorStats).mockResolvedValue(errorStats);

		const sessions = [createSession('s1', 'claude-code')];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		const claude = result.current.providers.find((p) => p.toolType === 'claude-code')!;
		expect(claude.status).toBe('degraded');
		expect(claude.healthPercent).toBe(67); // 100 - (1/3)*100 = 67
		expect(result.current.hasDegradedProvider).toBe(true);
		expect(result.current.hasFailingProvider).toBe(false);
	});

	it('computes failing status when errors meet threshold', async () => {
		const errorStats: Record<string, ProviderErrorStats> = {
			'claude-code': {
				toolType: 'claude-code',
				activeErrorCount: 3,
				totalErrorsInWindow: 3,
				lastErrorAt: Date.now() - 10_000,
				sessionsWithErrors: 1,
			},
		};
		vi.mocked(window.maestro.providers.getAllErrorStats).mockResolvedValue(errorStats);

		const sessions = [createSession('s1', 'claude-code')];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		const claude = result.current.providers.find((p) => p.toolType === 'claude-code')!;
		expect(claude.status).toBe('failing');
		expect(claude.healthPercent).toBe(0);
		expect(result.current.hasFailingProvider).toBe(true);
	});

	it('counts active sessions excluding archived migrations', async () => {
		const sessions = [
			createSession('s1', 'claude-code'),
			createSession('s2', 'claude-code'),
			createSession('s3', 'claude-code', { archivedByMigration: true }),
		];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		const claude = result.current.providers.find((p) => p.toolType === 'claude-code')!;
		expect(claude.activeSessionCount).toBe(2);
	});

	it('reads failover threshold from saved config', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			errorThreshold: 5,
		});

		const sessions = [createSession('s1', 'claude-code')];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		expect(result.current.failoverThreshold).toBe(5);
	});

	it('subscribes to failover suggest events', async () => {
		const sessions = [createSession('s1', 'claude-code')];
		renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(window.maestro.providers.onFailoverSuggest).toHaveBeenCalled();
		});
	});

	it('refreshes on failover suggest event', async () => {
		const sessions = [createSession('s1', 'claude-code')];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		// Change error stats
		const errorStats: Record<string, ProviderErrorStats> = {
			'claude-code': {
				toolType: 'claude-code',
				activeErrorCount: 2,
				totalErrorsInWindow: 2,
				lastErrorAt: Date.now(),
				sessionsWithErrors: 1,
			},
		};
		vi.mocked(window.maestro.providers.getAllErrorStats).mockResolvedValue(errorStats);

		// Simulate failover event
		await act(async () => {
			failoverCallback?.();
		});

		await waitFor(() => {
			const claude = result.current.providers.find((p) => p.toolType === 'claude-code')!;
			expect(claude.status).toBe('degraded');
		});
	});

	it('sets lastUpdated timestamp after refresh', async () => {
		const sessions: Session[] = [];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		expect(result.current.lastUpdated).toBeTypeOf('number');
		expect(result.current.lastUpdated!).toBeGreaterThan(0);
	});

	it('provides a manual refresh function', async () => {
		const sessions: Session[] = [];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		const callCount = vi.mocked(window.maestro.agents.detect).mock.calls.length;

		await act(async () => {
			result.current.refresh();
		});

		expect(vi.mocked(window.maestro.agents.detect).mock.calls.length).toBeGreaterThan(callCount);
	});

	it('computes health percent correctly with custom threshold', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			errorThreshold: 10,
		});

		const errorStats: Record<string, ProviderErrorStats> = {
			'claude-code': {
				toolType: 'claude-code',
				activeErrorCount: 3,
				totalErrorsInWindow: 3,
				lastErrorAt: Date.now(),
				sessionsWithErrors: 1,
			},
		};
		vi.mocked(window.maestro.providers.getAllErrorStats).mockResolvedValue(errorStats);

		const sessions = [createSession('s1', 'claude-code')];
		const { result } = renderHook(() => useProviderHealth(sessions, 600_000));

		await waitFor(() => {
			expect(result.current.isLoading).toBe(false);
		});

		const claude = result.current.providers.find((p) => p.toolType === 'claude-code')!;
		// With threshold 10: 100 - (3/10)*100 = 70
		expect(claude.healthPercent).toBe(70);
		expect(claude.status).toBe('degraded');
	});
});
