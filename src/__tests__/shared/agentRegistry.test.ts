import { describe, expect, it } from 'vitest';
import {
	AGENT_ID_ALIASES,
	AGENT_IDS,
	AGENT_REGISTRY,
	getAgentCapabilities,
	isValidAgentId,
	resolveAgentId,
} from '../../shared/agentRegistry';

describe('agentRegistry', () => {
	it('derives the built-in ID list from the registry', () => {
		expect(AGENT_IDS).toEqual(Object.keys(AGENT_REGISTRY));
	});

	it('contains the supported built-in agent IDs', () => {
		expect(AGENT_IDS).toEqual(
			expect.arrayContaining([
				'claude-code',
				'codex',
				'opencode',
				'factory-droid',
				'hermes',
				'pi',
				'terminal',
				'gemini-cli',
				'qwen3-coder',
				'copilot-cli',
				'omp',
			])
		);
	});

	it('validates every registry ID and rejects invalid IDs', () => {
		for (const id of AGENT_IDS) {
			expect(isValidAgentId(id)).toBe(true);
		}

		expect(isValidAgentId('unknown-agent')).toBe(false);
		expect(isValidAgentId('')).toBe(false);
		expect(isValidAgentId('Claude Code')).toBe(false);
	});

	it.each(AGENT_IDS)('resolves built-in %s to its registry capabilities', (id) => {
		expect(resolveAgentId(id)).toBe(id);
		expect(getAgentCapabilities(id)).toBe(AGENT_REGISTRY[id]);
	});

	it.each(Object.entries(AGENT_ID_ALIASES))('resolves alias %s to %s', (alias, id) => {
		expect(resolveAgentId(alias)).toBe(id);
	});

	it('keeps unknown and custom agent IDs unresolved with conservative capabilities', () => {
		expect(resolveAgentId('com.acme/custom-agent')).toBeUndefined();
		expect(getAgentCapabilities('com.acme/custom-agent').supportsResume).toBe(false);
	});
});
