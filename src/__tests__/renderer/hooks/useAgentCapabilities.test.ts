import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	useAgentCapabilities,
	clearCapabilitiesCache,
	DEFAULT_CAPABILITIES,
} from '../../../renderer/hooks';
import {
	hasCapabilityCached,
	setCapabilitiesCache,
	getCachedCapabilities,
	primeCapabilitiesCache,
} from '../../../renderer/hooks/agent/useAgentCapabilities';
import { useCapabilitiesPriming } from '../../../renderer/hooks/agent/useCapabilitiesPriming';

const baseCapabilities = {
	supportsResume: true,
	supportsReadOnlyMode: true,
	supportsJsonOutput: true,
	supportsSessionId: true,
	supportsImageInput: true,
	supportsImageInputOnResume: true,
	supportsSlashCommands: true,
	supportsSessionStorage: true,
	supportsCostTracking: true,
	supportsUsageStats: true,
	supportsBatchMode: true,
	requiresPromptToStart: false,
	supportsStreaming: true,
	supportsResultMessages: true,
	supportsModelSelection: false,
	supportsStreamJsonInput: true,
	supportsPromptViaStdin: true,
	supportsThinkingDisplay: false, // Added in Show Thinking feature
	supportsContextMerge: false,
	supportsContextExport: false,
	supportsWizard: false,
	supportsGroupChatModeration: false,
	usesJsonLineOutput: false,
	usesCombinedContextWindow: false,
	supportsAppendSystemPrompt: false,
	supportsProjectMemory: false,
	supportsAdditionalDirectories: false,
};

describe('useAgentCapabilities', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearCapabilitiesCache();
	});

	it('loads capabilities and caches results', async () => {
		vi.mocked(window.maestro.agents.getCapabilities).mockResolvedValueOnce(baseCapabilities);

		const { result } = renderHook(() => useAgentCapabilities('claude-code'));

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.capabilities).toEqual(baseCapabilities);
		expect(window.maestro.agents.getCapabilities).toHaveBeenCalledTimes(1);

		const { result: result2 } = renderHook(() => useAgentCapabilities('claude-code'));

		await waitFor(() => {
			expect(result2.current.loading).toBe(false);
		});

		expect(result2.current.capabilities).toEqual(baseCapabilities);
		expect(window.maestro.agents.getCapabilities).toHaveBeenCalledTimes(1);
	});

	it('refreshes capabilities by bypassing cache', async () => {
		const updatedCapabilities = {
			...baseCapabilities,
			supportsImageInput: false,
		};

		vi.mocked(window.maestro.agents.getCapabilities)
			.mockResolvedValueOnce(baseCapabilities)
			.mockResolvedValueOnce(updatedCapabilities);

		const { result } = renderHook(() => useAgentCapabilities('claude-code'));

		await waitFor(() => {
			expect(result.current.capabilities).toEqual(baseCapabilities);
		});

		await act(async () => {
			await result.current.refresh();
		});

		expect(result.current.capabilities).toEqual(updatedCapabilities);
		expect(window.maestro.agents.getCapabilities).toHaveBeenCalledTimes(2);
	});

	it('clears error state when agentId is unset', async () => {
		vi.mocked(window.maestro.agents.getCapabilities).mockRejectedValue(new Error('boom'));

		const { result, rerender } = renderHook(
			({ agentId }: { agentId?: string }) => useAgentCapabilities(agentId),
			{ initialProps: { agentId: 'claude-code' } }
		);

		await waitFor(() => {
			expect(result.current.error).toBe('boom');
		});

		rerender({ agentId: undefined });

		await waitFor(() => {
			expect(result.current.error).toBeNull();
			expect(result.current.capabilities).toEqual(DEFAULT_CAPABILITIES);
		});
	});
});

describe('hasCapabilityCached', () => {
	beforeEach(() => {
		clearCapabilitiesCache();
	});

	it('returns DEFAULT_CAPABILITIES value when agent is not cached', () => {
		expect(hasCapabilityCached('uncached-agent', 'supportsResume')).toBe(false);
		expect(hasCapabilityCached('uncached-agent', 'supportsBatchMode')).toBe(false);
	});

	it('returns correct value from cached capabilities', () => {
		setCapabilitiesCache('test-agent', {
			...DEFAULT_CAPABILITIES,
			supportsResume: true,
			supportsBatchMode: true,
			supportsWizard: true,
		});

		expect(hasCapabilityCached('test-agent', 'supportsResume')).toBe(true);
		expect(hasCapabilityCached('test-agent', 'supportsBatchMode')).toBe(true);
		expect(hasCapabilityCached('test-agent', 'supportsWizard')).toBe(true);
		expect(hasCapabilityCached('test-agent', 'supportsSlashCommands')).toBe(false);
	});

	it('returns false for new capability flags when not set', () => {
		setCapabilitiesCache('test-agent', { ...DEFAULT_CAPABILITIES });

		expect(hasCapabilityCached('test-agent', 'supportsWizard')).toBe(false);
		expect(hasCapabilityCached('test-agent', 'supportsGroupChatModeration')).toBe(false);
		expect(hasCapabilityCached('test-agent', 'usesJsonLineOutput')).toBe(false);
		expect(hasCapabilityCached('test-agent', 'usesCombinedContextWindow')).toBe(false);
	});

	it('falls back to defaults after cache is cleared', () => {
		setCapabilitiesCache('test-agent', {
			...DEFAULT_CAPABILITIES,
			supportsResume: true,
		});
		expect(hasCapabilityCached('test-agent', 'supportsResume')).toBe(true);

		clearCapabilitiesCache();
		expect(hasCapabilityCached('test-agent', 'supportsResume')).toBe(false);
	});
});

describe('getCachedCapabilities', () => {
	beforeEach(() => {
		clearCapabilitiesCache();
	});

	it('returns undefined for an agent that was never looked up', () => {
		expect(getCachedCapabilities('uncached-agent')).toBeUndefined();
	});

	// The distinction hasCapabilityCached cannot make: a cached `false` is an
	// answer, a miss is not. Conflating them is what silently dropped CLI
	// dispatches to agent types the user had not opened.
	it('distinguishes a cached false from a miss', () => {
		setCapabilitiesCache('test-agent', { ...DEFAULT_CAPABILITIES, supportsBatchMode: false });

		expect(getCachedCapabilities('test-agent')?.supportsBatchMode).toBe(false);
		expect(getCachedCapabilities('other-agent')).toBeUndefined();
		// Both look identical through hasCapabilityCached.
		expect(hasCapabilityCached('test-agent', 'supportsBatchMode')).toBe(false);
		expect(hasCapabilityCached('other-agent', 'supportsBatchMode')).toBe(false);
	});
});

describe('primeCapabilitiesCache', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearCapabilitiesCache();
	});

	it('populates the cache for every returned agent id', async () => {
		vi.mocked(window.maestro.agents.getAllCapabilities).mockResolvedValueOnce({
			opencode: { ...DEFAULT_CAPABILITIES, supportsBatchMode: true },
			terminal: { ...DEFAULT_CAPABILITIES, supportsBatchMode: false },
		});

		const primed = await primeCapabilitiesCache();

		expect(primed).toBe(2);
		expect(getCachedCapabilities('opencode')?.supportsBatchMode).toBe(true);
		expect(getCachedCapabilities('terminal')?.supportsBatchMode).toBe(false);
		expect(hasCapabilityCached('opencode', 'supportsBatchMode')).toBe(true);
	});

	it('merges partial capability payloads over the defaults', async () => {
		vi.mocked(window.maestro.agents.getAllCapabilities).mockResolvedValueOnce({
			opencode: { supportsBatchMode: true } as any,
		});

		await primeCapabilitiesCache();

		expect(getCachedCapabilities('opencode')).toEqual({
			...DEFAULT_CAPABILITIES,
			supportsBatchMode: true,
		});
	});

	it('returns 0 and leaves the cache untouched when the fetch fails', async () => {
		setCapabilitiesCache('opencode', { ...DEFAULT_CAPABILITIES, supportsBatchMode: true });
		vi.mocked(window.maestro.agents.getAllCapabilities).mockRejectedValueOnce(
			new Error('IPC down')
		);

		await expect(primeCapabilitiesCache()).resolves.toBe(0);
		expect(getCachedCapabilities('opencode')?.supportsBatchMode).toBe(true);
	});
});

describe('useCapabilitiesPriming', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearCapabilitiesCache();
	});

	it('primes the cache once on mount', async () => {
		vi.mocked(window.maestro.agents.getAllCapabilities).mockResolvedValue({
			opencode: { ...DEFAULT_CAPABILITIES, supportsBatchMode: true },
		});

		const { rerender } = renderHook(() => useCapabilitiesPriming());
		rerender();

		await waitFor(() => {
			expect(getCachedCapabilities('opencode')?.supportsBatchMode).toBe(true);
		});
		expect(window.maestro.agents.getAllCapabilities).toHaveBeenCalledTimes(1);
	});

	it('does not throw when priming fails', async () => {
		vi.mocked(window.maestro.agents.getAllCapabilities).mockRejectedValue(new Error('IPC down'));

		expect(() => renderHook(() => useCapabilitiesPriming())).not.toThrow();

		await waitFor(() => {
			expect(window.maestro.agents.getAllCapabilities).toHaveBeenCalled();
		});
	});
});
