import { describe, expect, it } from 'vitest';
import { resolveAgentRunProvider } from '../../../shared/agent-run/provider';
import {
	HISTORICAL_AGENT_RUN_PROVIDERS,
	KNOWN_AGENT_RUN_PROVIDERS,
} from '../../../shared/agent-run/types';
import { AGENT_IDS } from '../../../shared/agentIds';

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

/**
 * Completeness is generated from the agent-ID registry
 * (`AGENT_IDS`), never from the resolver's own allowlist, so a registered agent
 * the run ledger left out fails here instead of passing by construction.
 */
describe('resolveAgentRunProvider - Grok and the agent-ID registry', () => {
	const providerIds = AGENT_IDS.filter((id) => id !== 'terminal');

	it('grok is a registered agent ID', () => {
		expect(AGENT_IDS).toContain('grok');
		expect(providerIds).toContain('grok');
	});

	it.each(providerIds)('registered agent %s is attributed as itself, never unknown', (id) => {
		expect(resolveAgentRunProvider(id)).toBe(id);
		expect(resolveAgentRunProvider(id.toUpperCase())).toBe(id);
		expect(resolveAgentRunProvider(` ${id}\n`)).toBe(id);
	});

	it('terminal is registered but is not a provider', () => {
		expect(AGENT_IDS).toContain('terminal');
		expect(resolveAgentRunProvider('terminal')).toBe('unknown');
	});

	it('the known set is every registered provider, the historical values and unknown, each once', () => {
		expect([...KNOWN_AGENT_RUN_PROVIDERS].sort()).toEqual(
			[...providerIds, ...HISTORICAL_AGENT_RUN_PROVIDERS, 'unknown'].sort()
		);
		expect(new Set(KNOWN_AGENT_RUN_PROVIDERS).size).toBe(KNOWN_AGENT_RUN_PROVIDERS.length);
	});

	it('historical values stored before the registry stay fixed points and are not agent IDs', () => {
		const registered: readonly string[] = AGENT_IDS;
		for (const value of HISTORICAL_AGENT_RUN_PROVIDERS) {
			expect(registered).not.toContain(value);
			expect(resolveAgentRunProvider(value)).toBe(value);
		}
	});

	it('invents no Grok alias: near spellings settle to unknown rather than grok', () => {
		for (const spelling of ['grok-cli', 'grokcli', 'xai', 'x-ai', 'grok-build', 'grok 4']) {
			expect(resolveAgentRunProvider(spelling)).toBe('unknown');
		}
	});

	it('an unregistered future agent settles to unknown at capture time', () => {
		expect(resolveAgentRunProvider('future-agent')).toBe('unknown');
	});
});
