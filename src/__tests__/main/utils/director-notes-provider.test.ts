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

// Grok as a Director's Notes synopsis provider. Auto-selection
// reaches it only when nothing ahead of it in the preference is installed, an
// explicit Grok pick runs on Grok alone, and an unavailable Grok pick is
// refused without detection or a provider from the preference list.
describe('Grok synopsis provider', () => {
	it('is a synopsis provider, ranked behind every other installed one', () => {
		expect(pickFirstAvailableProvider(['grok'])).toBe('grok');
		expect(pickFirstAvailableProvider(['grok', 'opencode'])).toBe('opencode');
		expect(pickFirstAvailableProvider(['grok', 'claude-code'])).toBe('claude-code');
	});

	it('sends an explicit Grok pick only when auto-selection is off', () => {
		expect(synopsisProviderChoice({ provider: 'grok' })).toBe('auto');
		expect(synopsisProviderChoice({ provider: 'grok', autoSelectProvider: false })).toBe('grok');
	});

	it('auto-selects Grok when it is the only installed synopsis provider', async () => {
		const detector = detectorWith([
			{ id: 'claude-code', available: false },
			{ id: 'codex', available: false },
			{ id: 'terminal', available: true },
			{ id: 'grok', available: true },
		]);

		expect(await resolveSynopsisProvider('auto', detector)).toEqual({
			provider: 'grok',
			auto: true,
		});
		expect(detector.getAgent).not.toHaveBeenCalled();
	});

	it('names Grok in the install hint when no synopsis provider is installed', async () => {
		const result = await resolveSynopsisProvider(
			'auto',
			detectorWith([{ id: 'grok', available: false }])
		);

		expect(result).toMatchObject({ error: expect.stringContaining('grok') });
		expect(result).not.toHaveProperty('provider');
	});

	it('runs an explicit Grok pick on Grok while a preferred provider is installed', async () => {
		const detector = detectorWith([
			{ id: 'claude-code', available: true },
			{ id: 'codex', available: true },
			{ id: 'grok', available: true },
		]);

		expect(await resolveSynopsisProvider('grok', detector)).toEqual({
			provider: 'grok',
			auto: false,
		});
		expect(detector.getAgent).toHaveBeenCalledExactlyOnceWith('grok');
		expect(detector.detectAgents).not.toHaveBeenCalled();
	});

	it.each([
		['installed but unavailable', [{ id: 'grok', available: false }]],
		['not detected at all', []],
	])(
		'refuses an explicit Grok pick that is %s without switching provider',
		async (_label, grokRows) => {
			const detector = detectorWith([
				{ id: 'claude-code', available: true },
				{ id: 'codex', available: true },
				...grokRows,
			]);

			const result = await resolveSynopsisProvider('grok', detector);

			expect(result).not.toHaveProperty('provider');
			const { error } = result as { error: string };
			expect(error).toContain('Agent "grok" is not available.');
			expect(error).toContain('did not run on Grok CLI and used no other provider');
			expect(error).toContain('Install Grok CLI or set its binary path');
			expect(error).not.toMatch(/claude|codex/i);
			expect(detector.getAgent).toHaveBeenCalledExactlyOnceWith('grok');
			expect(detector.detectAgents).not.toHaveBeenCalled();
		}
	);
});
