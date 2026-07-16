import { describe, expect, it } from 'vitest';
import {
	AGENT_ID_ALIASES,
	AGENT_IDS,
	AGENT_REGISTRY,
	getAgentCapabilities,
	resolveAgentId,
} from '../../shared/agentRegistry';

describe('agentRegistry', () => {
	it('derives the built-in ID list from the registry', () => {
		expect(AGENT_IDS).toEqual(Object.keys(AGENT_REGISTRY));
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
