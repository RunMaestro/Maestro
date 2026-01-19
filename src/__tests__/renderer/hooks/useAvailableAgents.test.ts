import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAvailableAgents, useAvailableAgentsForCapability } from '../../../renderer/hooks';
import type { Session } from '../../../renderer/types';
import { DEFAULT_CAPABILITIES, type AgentCapabilities } from '../../../renderer/hooks';

// Define agent config type matching what detect() returns
interface AgentConfigDetected {
	id: string;
	name: string;
	available: boolean;
	hidden?: boolean;
	capabilities?: AgentCapabilities;
}

// Sample agent configs for tests
const mockAgentConfigs: AgentConfigDetected[] = [
	{
		id: 'claude-code',
		name: 'Claude Code',
		available: true,
		capabilities: {
			...DEFAULT_CAPABILITIES,
			supportsContextMerge: true,
			supportsContextExport: true,
		},
	},
	{
		id: 'opencode',
		name: 'OpenCode',
		available: true,
		capabilities: {
			...DEFAULT_CAPABILITIES,
			supportsContextMerge: true,
			supportsContextExport: true,
		},
	},
	{
		id: 'gemini-cli',
		name: 'Gemini CLI',
		available: false,
		capabilities: DEFAULT_CAPABILITIES,
	},
	{
		id: 'terminal',
		name: 'Terminal',
		available: true,
		hidden: true, // Should be filtered out
		capabilities: DEFAULT_CAPABILITIES,
	},
];

// Create a minimal session for testing
function createMockSession(
	id: string,
	toolType: string,
	state: 'idle' | 'busy' | 'error' | 'connecting' = 'idle'
): Session {
	return {
		id,
		name: `Session ${id}`,
		toolType: toolType as any,
		state,
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
	};
}

describe('useAvailableAgents', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(mockAgentConfigs);
	});

	it('loads agents on mount and sets loading state', async () => {
		const { result } = renderHook(() => useAvailableAgents('claude-code', []));

		// Initially loading
		expect(result.current.loading).toBe(true);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		// Should filter out hidden agents
		expect(result.current.agents).toHaveLength(3);
		expect(result.current.agents.map((a) => a.id)).toEqual([
			'claude-code',
			'opencode',
			'gemini-cli',
		]);
	});

	it('marks current agent with "current" status', async () => {
		const { result } = renderHook(() => useAvailableAgents('claude-code', []));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const claudeAgent = result.current.agents.find((a) => a.id === 'claude-code');
		expect(claudeAgent?.status).toBe('current');
	});

	it('marks unavailable agents with "unavailable" status', async () => {
		const { result } = renderHook(() => useAvailableAgents('claude-code', []));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const geminiAgent = result.current.agents.find((a) => a.id === 'gemini-cli');
		expect(geminiAgent?.status).toBe('unavailable');
		expect(geminiAgent?.available).toBe(false);
	});

	it('marks agents with busy sessions as "busy"', async () => {
		const sessions: Session[] = [createMockSession('1', 'opencode', 'busy')];

		const { result } = renderHook(() => useAvailableAgents('claude-code', sessions));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const openCodeAgent = result.current.agents.find((a) => a.id === 'opencode');
		expect(openCodeAgent?.status).toBe('busy');
		expect(openCodeAgent?.activeSessions).toBe(1);
	});

	it('counts active sessions per agent', async () => {
		const sessions: Session[] = [
			createMockSession('1', 'claude-code', 'idle'),
			createMockSession('2', 'claude-code', 'idle'),
			createMockSession('3', 'opencode', 'idle'),
		];

		const { result } = renderHook(() => useAvailableAgents(null, sessions));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const claudeAgent = result.current.agents.find((a) => a.id === 'claude-code');
		expect(claudeAgent?.activeSessions).toBe(2);

		const openCodeAgent = result.current.agents.find((a) => a.id === 'opencode');
		expect(openCodeAgent?.activeSessions).toBe(1);
	});

	it('provides icon for each agent', async () => {
		const { result } = renderHook(() => useAvailableAgents(null, []));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.agents[0].icon).toBe('🤖'); // claude-code
		expect(result.current.agents[1].icon).toBe('📟'); // opencode
		expect(result.current.agents[2].icon).toBe('🔷'); // gemini-cli
	});

	it('refreshes agents when refresh is called', async () => {
		const { result } = renderHook(() => useAvailableAgents(null, []));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		// Should have been called once on mount
		expect(window.maestro.agents.detect).toHaveBeenCalledTimes(1);

		// Call refresh
		await act(async () => {
			await result.current.refresh();
		});

		expect(window.maestro.agents.detect).toHaveBeenCalledTimes(2);
	});

	it('returns agent by ID with getAgent helper', async () => {
		const { result } = renderHook(() => useAvailableAgents(null, []));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const agent = result.current.getAgent('opencode');
		expect(agent).toBeDefined();
		expect(agent?.name).toBe('OpenCode');

		const unknownAgent = result.current.getAgent('unknown' as any);
		expect(unknownAgent).toBeUndefined();
	});

	it('handles error when agent detection fails', async () => {
		vi.mocked(window.maestro.agents.detect).mockRejectedValueOnce(new Error('Detection failed'));

		const { result } = renderHook(() => useAvailableAgents(null, []));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.error).toBe('Detection failed');
		expect(result.current.agents).toEqual([]);
	});

	it('updates when currentAgentId changes', async () => {
		const { result, rerender } = renderHook(
			({ currentAgentId }) => useAvailableAgents(currentAgentId, []),
			{ initialProps: { currentAgentId: 'claude-code' as any } }
		);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		let claudeAgent = result.current.agents.find((a) => a.id === 'claude-code');
		expect(claudeAgent?.status).toBe('current');

		// Rerender with different currentAgentId
		rerender({ currentAgentId: 'opencode' as any });

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		claudeAgent = result.current.agents.find((a) => a.id === 'claude-code');
		expect(claudeAgent?.status).toBe('ready');

		const openCodeAgent = result.current.agents.find((a) => a.id === 'opencode');
		expect(openCodeAgent?.status).toBe('current');
	});

	it('includes capabilities for each agent', async () => {
		const { result } = renderHook(() => useAvailableAgents(null, []));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const claudeAgent = result.current.agents.find((a) => a.id === 'claude-code');
		expect(claudeAgent?.capabilities.supportsContextMerge).toBe(true);
		expect(claudeAgent?.capabilities.supportsContextExport).toBe(true);
	});
});

describe('useAvailableAgentsForCapability', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(mockAgentConfigs);
	});

	it('filters agents by required capability', async () => {
		const { result } = renderHook(() =>
			useAvailableAgentsForCapability(null, [], 'supportsContextMerge')
		);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		// Only claude-code and opencode have supportsContextMerge: true
		expect(result.current.agents).toHaveLength(2);
		expect(result.current.agents.map((a) => a.id)).toEqual(['claude-code', 'opencode']);
	});

	it('getAgent only finds filtered agents', async () => {
		const { result } = renderHook(() =>
			useAvailableAgentsForCapability(null, [], 'supportsContextMerge')
		);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		// gemini-cli should not be findable since it doesn't have the capability
		const geminiAgent = result.current.getAgent('gemini-cli');
		expect(geminiAgent).toBeUndefined();

		// opencode should be findable
		const openCodeAgent = result.current.getAgent('opencode');
		expect(openCodeAgent).toBeDefined();
	});

	it('respects current agent status in filtered results', async () => {
		const { result } = renderHook(() =>
			useAvailableAgentsForCapability('claude-code', [], 'supportsContextMerge')
		);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const claudeAgent = result.current.agents.find((a) => a.id === 'claude-code');
		expect(claudeAgent?.status).toBe('current');
	});
});
