/**
 * Tests for context window resolution utilities used by the Auto Run
 * fresh-context mode picker and the live context gauge.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	resolveConfiguredContextWindow,
	resolveEffectiveContextWindow,
} from '../../../renderer/utils/contextWindowResolver';

const mockGetConfig = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		agents: {
			getConfig: mockGetConfig,
		},
	};
});

describe('resolveConfiguredContextWindow', () => {
	it('prefers the per-agent customContextWindow override', async () => {
		const value = await resolveConfiguredContextWindow({
			toolType: 'claude-code',
			customContextWindow: 1_000_000,
		});
		expect(value).toBe(1_000_000);
		expect(mockGetConfig).not.toHaveBeenCalled();
	});

	it('ignores a zero/negative override and falls back to agent config', async () => {
		mockGetConfig.mockResolvedValue({ contextWindow: 200000 });
		const value = await resolveConfiguredContextWindow({
			toolType: 'claude-code',
			customContextWindow: 0,
		});
		expect(value).toBe(200000);
	});

	it('reads the agent-type config when no override is set', async () => {
		mockGetConfig.mockResolvedValue({ contextWindow: 128000 });
		const value = await resolveConfiguredContextWindow({ toolType: 'opencode' });
		expect(value).toBe(128000);
		expect(mockGetConfig).toHaveBeenCalledWith('opencode');
	});

	it('returns 0 (unknown) when config has no contextWindow', async () => {
		mockGetConfig.mockResolvedValue({});
		const value = await resolveConfiguredContextWindow({ toolType: 'claude-code' });
		expect(value).toBe(0);
	});

	it('returns 0 when there is no toolType', async () => {
		const value = await resolveConfiguredContextWindow({});
		expect(value).toBe(0);
		expect(mockGetConfig).not.toHaveBeenCalled();
	});

	it('returns 0 when the config fetch throws', async () => {
		mockGetConfig.mockRejectedValue(new Error('boom'));
		const value = await resolveConfiguredContextWindow({ toolType: 'claude-code' });
		expect(value).toBe(0);
	});

	it('detects the 1M window from a session [1m] model without fetching config', async () => {
		const value = await resolveConfiguredContextWindow({
			toolType: 'claude-code',
			customModel: 'opus[1m]',
		});
		expect(value).toBe(1_000_000);
		expect(mockGetConfig).not.toHaveBeenCalled();
	});

	it('detects the 1M window from the agent-level [1m] model', async () => {
		mockGetConfig.mockResolvedValue({ model: 'claude-opus-4-7[1m]', contextWindow: 200000 });
		const value = await resolveConfiguredContextWindow({ toolType: 'claude-code' });
		expect(value).toBe(1_000_000);
	});

	it('lets an explicit customContextWindow override win over a [1m] model', async () => {
		const value = await resolveConfiguredContextWindow({
			toolType: 'claude-code',
			customContextWindow: 500_000,
			customModel: 'opus[1m]',
		});
		expect(value).toBe(500_000);
		expect(mockGetConfig).not.toHaveBeenCalled();
	});
});

describe('resolveEffectiveContextWindow', () => {
	it('returns the configured window when known', async () => {
		const value = await resolveEffectiveContextWindow({
			toolType: 'claude-code',
			customContextWindow: 1_000_000,
		});
		expect(value).toBe(1_000_000);
	});

	it('falls back to the agent default when the window is unknown', async () => {
		mockGetConfig.mockResolvedValue({});
		const value = await resolveEffectiveContextWindow({ toolType: 'claude-code' });
		expect(value).toBe(200000); // DEFAULT_CONTEXT_WINDOWS['claude-code']
	});

	it('uses the global fallback for an unknown agent with no config', async () => {
		mockGetConfig.mockResolvedValue({});
		const value = await resolveEffectiveContextWindow({ toolType: 'some-future-agent' });
		expect(value).toBe(200000); // FALLBACK_CONTEXT_WINDOW
	});

	it('resolves terminal agents to 0', async () => {
		mockGetConfig.mockResolvedValue({});
		const value = await resolveEffectiveContextWindow({ toolType: 'terminal' });
		expect(value).toBe(0);
	});
});
