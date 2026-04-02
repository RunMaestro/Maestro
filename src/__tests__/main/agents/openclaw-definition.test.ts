import { describe, it, expect } from 'vitest';
import { getAgentDefinition } from '../../../main/agents/definitions';
import { AGENT_CAPABILITIES } from '../../../main/agents/capabilities';
import { AGENT_DISPLAY_NAMES, BETA_AGENTS } from '../../../shared/agentMetadata';
import { DEFAULT_CONTEXT_WINDOWS } from '../../../shared/agentConstants';
import { AGENT_IDS } from '../../../shared/agentIds';

describe('OpenClaw Agent Definition', () => {
	it('should have correct basic definition', () => {
		const def = getAgentDefinition('openclaw');
		expect(def).toBeDefined();
		expect(def?.binaryName).toBe('openclaw');
		expect(def?.batchModePrefix).toEqual(['agent']);
		expect(def?.jsonOutputArgs).toEqual(['--json']);
		expect(def?.noPromptSeparator).toBe(true);
	});

	it('should have correct resumeArgs', () => {
		const def = getAgentDefinition('openclaw');
		expect(def?.resumeArgs?.('sess-1')).toEqual(['--session-id', 'sess-1']);
		expect(def?.resumeArgs?.('main:sess-2')).toEqual(['--session-id', 'main:sess-2']);
		expect(def?.resumeArgs?.('main:sub:sess-3')).toEqual(['--session-id', 'main:sub:sess-3']);
	});

	it('should have correct promptArgs', () => {
		const def = getAgentDefinition('openclaw');
		expect(def?.promptArgs?.('hello')).toEqual(['--message', 'hello']);
	});

	it('should have correct configOptions and argBuilders', () => {
		const def = getAgentDefinition('openclaw');
		expect(def?.configOptions).toHaveLength(4);

		const agentIdOpt = def?.configOptions.find((o) => o.key === 'agentId');
		expect(agentIdOpt?.argBuilder?.('main')).toEqual(['--agent', 'main']);

		const thinkingOpt = def?.configOptions.find((o) => o.key === 'thinking');
		expect(thinkingOpt?.argBuilder?.('high')).toEqual(['--thinking', 'high']);

		const localModeOpt = def?.configOptions.find((o) => o.key === 'localMode');
		expect(localModeOpt?.argBuilder?.(true)).toEqual(['--local']);
		expect(localModeOpt?.argBuilder?.(false)).toEqual([]);
	});

	it('should have correct capabilities', () => {
		const caps = AGENT_CAPABILITIES.openclaw;
		expect(caps).toBeDefined();
		expect(caps.supportsResume).toBe(true);
		expect(caps.supportsJsonOutput).toBe(true);
		expect(caps.supportsBatchMode).toBe(true);
		expect(caps.supportsStreaming).toBe(false);
		expect(caps.usesJsonLineOutput).toBe(false);
	});

	it('should have correct metadata', () => {
		expect(AGENT_DISPLAY_NAMES.openclaw).toBe('OpenClaw');
		expect(BETA_AGENTS.has('openclaw')).toBe(true);
	});

	it('should have correct default context window', () => {
		expect(DEFAULT_CONTEXT_WINDOWS.openclaw).toBe(200000);
	});

	it('should be included in AGENT_IDS', () => {
		expect(AGENT_IDS).toContain('openclaw');
	});
});
