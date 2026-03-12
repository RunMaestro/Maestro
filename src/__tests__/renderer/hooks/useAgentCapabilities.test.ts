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
} from '../../../renderer/hooks/agent/useAgentCapabilities';

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
	supportsThinkingDisplay: false, // Added in Show Thinking feature
	supportsContextMerge: false,
	supportsContextExport: false,
	supportsWizard: false,
	supportsGroupChatModeration: false,
	usesJsonLineOutput: false,
	usesCombinedContextWindow: false,
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
