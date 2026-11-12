import { describe, expect, it } from 'vitest';
import { resolveAgentRunProvider } from '../../../shared/agent-run/provider';
import { KNOWN_AGENT_RUN_PROVIDERS } from '../../../shared/agent-run/types';

/**
 * resolveAgentRunProvider maps a raw session toolType to a canonical provider.
 * Contract under test: every canonical id is a fixed point, known aliases fold
 * to their canonical id, matching is case-insensitive and whitespace-tolerant,
 * and anything unrecognized (including empty/undefined) settles to 'unknown' so
 * a run is always tagged with a valid provider.
 */

describe('resolveAgentRunProvider - canonical ids are fixed points', () => {
	it.each([...KNOWN_AGENT_RUN_PROVIDERS])('%s resolves to itself', (provider) => {
		expect(resolveAgentRunProvider(provider)).toBe(provider);
	});
});

describe('resolveAgentRunProvider - alias folding', () => {
	const aliases: [string, string][] = [
		['claude', 'claude-code'],
		['claudecode', 'claude-code'],
		['copilot', 'copilot-cli'],
		['droid', 'factory-droid'],
		['factory', 'factory-droid'],
		['qwen', 'qwen-coder'],
		['qwen-code', 'qwen-coder'],
	];

	it.each(aliases)('%s -> %s', (alias, canonical) => {
		expect(resolveAgentRunProvider(alias)).toBe(canonical);
	});

	it('does not fold an alias onto itself (proves the mapping actually redirects)', () => {
		expect(resolveAgentRunProvider('claude')).not.toBe('claude');
		expect(resolveAgentRunProvider('droid')).not.toBe('droid');
		expect(resolveAgentRunProvider('qwen')).not.toBe('qwen');
	});
});

describe('resolveAgentRunProvider - case-insensitive matching', () => {
	it('uppercases and mixed case resolve to the lowercase canonical id', () => {
		expect(resolveAgentRunProvider('CLAUDE-CODE')).toBe('claude-code');
		expect(resolveAgentRunProvider('Codex')).toBe('codex');
		expect(resolveAgentRunProvider('OpenCode')).toBe('opencode');
	});

	it('aliases match case-insensitively', () => {
		expect(resolveAgentRunProvider('Claude')).toBe('claude-code');
		expect(resolveAgentRunProvider('DROID')).toBe('factory-droid');
		expect(resolveAgentRunProvider('Qwen-Code')).toBe('qwen-coder');
	});
});

describe('resolveAgentRunProvider - whitespace trimming', () => {
	it('trims surrounding whitespace before matching canonical ids', () => {
		expect(resolveAgentRunProvider('  codex  ')).toBe('codex');
		expect(resolveAgentRunProvider('\tcursor\n')).toBe('cursor');
	});

	it('trims surrounding whitespace before matching aliases', () => {
		expect(resolveAgentRunProvider('  copilot  ')).toBe('copilot-cli');
	});

	it('combines trim and case folding', () => {
		expect(resolveAgentRunProvider('  Claude  ')).toBe('claude-code');
	});
});

describe('resolveAgentRunProvider - unknown fallback', () => {
	it('empty string resolves to unknown', () => {
		expect(resolveAgentRunProvider('')).toBe('unknown');
	});

	it('undefined resolves to unknown', () => {
		expect(resolveAgentRunProvider(undefined)).toBe('unknown');
	});

	it('whitespace-only string resolves to unknown', () => {
		expect(resolveAgentRunProvider('   ')).toBe('unknown');
	});

	it.each(['bash', 'terminal', 'gpt-4', 'claude-3', 'copilotcli', 'factorydroid', 'random-tool'])(
		'unrecognized %s resolves to unknown',
		(toolType) => {
			expect(resolveAgentRunProvider(toolType)).toBe('unknown');
		}
	);
});
