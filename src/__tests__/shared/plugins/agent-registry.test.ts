import { describe, it, expect } from 'vitest';
import { createAgentRegistry } from '../../../shared/plugins/agent-registry';
import { AGENT_IDS } from '../../../shared/agentIds';
import type { AgentContribution } from '../../../shared/plugins/contributions';

function agent(id: string, overrides: Partial<AgentContribution> = {}): AgentContribution {
	return {
		id,
		localId: id.split('/').pop() ?? id,
		pluginId: id.split('/')[0] ?? 'com.x',
		displayName: id,
		binaryName: 'bin',
		baseArgs: [],
		capabilities: {},
		...overrides,
	};
}

describe('createAgentRegistry', () => {
	it('knows the built-in agents with no plugins', () => {
		const reg = createAgentRegistry([]);
		expect(reg.isBuiltIn('claude-code')).toBe(true);
		expect(reg.isKnown('claude-code')).toBe(true);
		expect(reg.isRuntime('claude-code')).toBe(false);
		expect(reg.builtInIds).toEqual([...AGENT_IDS]);
		expect(reg.runtimeIds).toEqual([]);
		expect(reg.getRuntime('claude-code')).toBeUndefined();
	});

	it('registers runtime agents alongside built-ins', () => {
		const reg = createAgentRegistry([agent('com.acme/bot'), agent('com.acme/helper')]);
		expect(reg.isRuntime('com.acme/bot')).toBe(true);
		expect(reg.isKnown('com.acme/bot')).toBe(true);
		expect(reg.isBuiltIn('com.acme/bot')).toBe(false);
		expect(reg.runtimeIds).toEqual(['com.acme/bot', 'com.acme/helper']);
		expect(reg.getRuntime('com.acme/bot')?.localId).toBe('bot');
		expect(reg.listAll()).toEqual([...AGENT_IDS, 'com.acme/bot', 'com.acme/helper']);
	});

	it('never lets a runtime agent shadow a built-in id', () => {
		const reg = createAgentRegistry([agent('claude-code', { displayName: 'Imposter' })]);
		expect(reg.isBuiltIn('claude-code')).toBe(true);
		expect(reg.isRuntime('claude-code')).toBe(false);
		// The imposter is dropped, not registered.
		expect(reg.getRuntime('claude-code')).toBeUndefined();
		expect(reg.runtimeIds).toEqual([]);
	});

	it('keeps the first of two runtime agents with the same id', () => {
		const reg = createAgentRegistry([
			agent('com.a/x', { displayName: 'First' }),
			agent('com.a/x', { displayName: 'Second' }),
		]);
		expect(reg.runtimeIds).toEqual(['com.a/x']);
		expect(reg.getRuntime('com.a/x')?.displayName).toBe('First');
	});

	it('reports unknown ids as unknown', () => {
		const reg = createAgentRegistry([agent('com.a/x')]);
		expect(reg.isKnown('nope')).toBe(false);
		expect(reg.isBuiltIn('nope')).toBe(false);
		expect(reg.isRuntime('nope')).toBe(false);
	});

	it('honors a custom built-in id set', () => {
		const reg = createAgentRegistry([agent('plug/y')], ['only-one']);
		expect(reg.isBuiltIn('only-one')).toBe(true);
		expect(reg.isBuiltIn('claude-code')).toBe(false);
		expect(reg.listAll()).toEqual(['only-one', 'plug/y']);
	});
});
