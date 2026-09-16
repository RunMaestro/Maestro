import { describe, it, expect, vi } from 'vitest';
import { resolveSynopsisProvider } from '../../../main/utils/director-notes-provider';
import {
	pickFirstAvailableProvider,
	synopsisProviderChoice,
} from '../../../shared/directorNotesProvider';
import type { AgentDetector } from '../../../main/agents';

function detectorWith(
	agents: Array<{ id: string; available: boolean }>
): AgentDetector & { detectAgents: ReturnType<typeof vi.fn>; getAgent: ReturnType<typeof vi.fn> } {
	return {
		detectAgents: vi.fn(async () => agents),
		getAgent: vi.fn(async (id: string) => agents.find((a) => a.id === id) ?? null),
	} as unknown as AgentDetector & {
		detectAgents: ReturnType<typeof vi.fn>;
		getAgent: ReturnType<typeof vi.fn>;
	};
}

describe('pickFirstAvailableProvider', () => {
	it('honors the preference order, not the input order', () => {
		expect(pickFirstAvailableProvider(['opencode', 'codex', 'claude-code'])).toBe('claude-code');
		expect(pickFirstAvailableProvider(['opencode', 'codex'])).toBe('codex');
	});

	it('ignores agents that are not synopsis providers', () => {
		expect(pickFirstAvailableProvider(['terminal', 'gemini-cli'])).toBeNull();
	});

	it('returns null when nothing is installed', () => {
		expect(pickFirstAvailableProvider([])).toBeNull();
	});
});

describe('synopsisProviderChoice', () => {
	it('sends the sentinel unless auto-selection is explicitly off', () => {
		expect(synopsisProviderChoice({ provider: 'codex' })).toBe('auto');
		expect(synopsisProviderChoice({ provider: 'codex', autoSelectProvider: true })).toBe('auto');
		expect(synopsisProviderChoice({ provider: 'codex', autoSelectProvider: false })).toBe('codex');
	});
});

describe('resolveSynopsisProvider', () => {
	it('picks the first available provider for the auto sentinel', async () => {
		const detector = detectorWith([
			{ id: 'claude-code', available: false },
			{ id: 'codex', available: true },
			{ id: 'opencode', available: true },
		]);

		const result = await resolveSynopsisProvider('auto', detector);

		expect(result).toEqual({ provider: 'codex', auto: true });
		expect(detector.getAgent).not.toHaveBeenCalled();
	});

	it('errors with an install hint when no supported provider is present', async () => {
		const detector = detectorWith([{ id: 'terminal', available: true }]);

		const result = await resolveSynopsisProvider('auto', detector);

		expect(result).toMatchObject({ error: expect.stringContaining('No supported AI provider') });
	});

	it('uses an explicit provider even when a preferred one is also installed', async () => {
		const detector = detectorWith([
			{ id: 'claude-code', available: true },
			{ id: 'opencode', available: true },
		]);

		const result = await resolveSynopsisProvider('opencode', detector);

		expect(result).toEqual({ provider: 'opencode', auto: false });
	});

	it('does not silently fall back when the explicit provider is unavailable', async () => {
		const detector = detectorWith([
			{ id: 'claude-code', available: true },
			{ id: 'codex', available: false },
		]);

		const result = await resolveSynopsisProvider('codex', detector);

		expect(result).toMatchObject({ error: expect.stringContaining('"codex" is not available') });
	});
});
