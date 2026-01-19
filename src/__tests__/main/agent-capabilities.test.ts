import { describe, it, expect } from 'vitest';
import {
	AgentCapabilities,
	DEFAULT_CAPABILITIES,
	AGENT_CAPABILITIES,
	getAgentCapabilities,
	hasCapability,
} from '../../main/agent-capabilities';

describe('agent-capabilities', () => {
	describe('AgentCapabilities interface', () => {
		it('should have all required capability fields', () => {
			const capabilities: AgentCapabilities = {
				supportsResume: false,
				supportsReadOnlyMode: false,
				supportsJsonOutput: false,
				supportsSessionId: false,
				supportsImageInput: false,
				supportsImageInputOnResume: false,
				supportsSlashCommands: false,
				supportsSessionStorage: false,
				supportsCostTracking: false,
				supportsUsageStats: false,
				supportsBatchMode: false,
				supportsStreaming: false,
				supportsResultMessages: false,
			};

			expect(capabilities.supportsResume).toBe(false);
			expect(capabilities.supportsReadOnlyMode).toBe(false);
			expect(capabilities.supportsJsonOutput).toBe(false);
			expect(capabilities.supportsSessionId).toBe(false);
			expect(capabilities.supportsImageInput).toBe(false);
			expect(capabilities.supportsImageInputOnResume).toBe(false);
			expect(capabilities.supportsSlashCommands).toBe(false);
			expect(capabilities.supportsSessionStorage).toBe(false);
			expect(capabilities.supportsCostTracking).toBe(false);
			expect(capabilities.supportsUsageStats).toBe(false);
			expect(capabilities.supportsBatchMode).toBe(false);
			expect(capabilities.supportsStreaming).toBe(false);
			expect(capabilities.supportsResultMessages).toBe(false);
		});
	});

	describe('DEFAULT_CAPABILITIES', () => {
		it('should have all capabilities set to false', () => {
			expect(DEFAULT_CAPABILITIES.supportsResume).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsReadOnlyMode).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsJsonOutput).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsSessionId).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsImageInput).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsImageInputOnResume).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsSlashCommands).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsSessionStorage).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsCostTracking).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsUsageStats).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsBatchMode).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsStreaming).toBe(false);
			expect(DEFAULT_CAPABILITIES.supportsResultMessages).toBe(false);
		});

		it('should be a conservative default (all false)', () => {
			const allFalse = Object.values(DEFAULT_CAPABILITIES).every((v) => v === false);
			expect(allFalse).toBe(true);
		});
	});

	describe('AGENT_CAPABILITIES', () => {
		it('should have capabilities for claude-code', () => {
			const capabilities = AGENT_CAPABILITIES['claude-code'];
			expect(capabilities).toBeDefined();
			expect(capabilities.supportsResume).toBe(true);
			expect(capabilities.supportsReadOnlyMode).toBe(true);
			expect(capabilities.supportsJsonOutput).toBe(true);
			expect(capabilities.supportsSessionId).toBe(true);
			expect(capabilities.supportsImageInput).toBe(true);
			expect(capabilities.supportsSlashCommands).toBe(true);
			expect(capabilities.supportsSessionStorage).toBe(true);
			expect(capabilities.supportsCostTracking).toBe(true);
			expect(capabilities.supportsUsageStats).toBe(true);
			expect(capabilities.supportsBatchMode).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
			expect(capabilities.supportsResultMessages).toBe(true);
		});

		it('should have capabilities for terminal', () => {
			const capabilities = AGENT_CAPABILITIES['terminal'];
			expect(capabilities).toBeDefined();
			expect(capabilities.supportsResume).toBe(false);
			expect(capabilities.supportsStreaming).toBe(true);
			// Terminal is not an AI agent, should have minimal capabilities
			expect(capabilities.supportsJsonOutput).toBe(false);
			expect(capabilities.supportsCostTracking).toBe(false);
		});

		it('should have capabilities for codex', () => {
			const capabilities = AGENT_CAPABILITIES['codex'];
			expect(capabilities).toBeDefined();
			// Verified capabilities based on CLI testing (v0.73.0+)
			expect(capabilities.supportsResume).toBe(true);
			expect(capabilities.supportsReadOnlyMode).toBe(true);
			expect(capabilities.supportsJsonOutput).toBe(true);
			expect(capabilities.supportsSessionId).toBe(true);
			expect(capabilities.supportsUsageStats).toBe(true);
			expect(capabilities.supportsBatchMode).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
			expect(capabilities.supportsSlashCommands).toBe(false);
			expect(capabilities.supportsResultMessages).toBe(false);
		});

		it('should have capabilities for gemini-cli', () => {
			const capabilities = AGENT_CAPABILITIES['gemini-cli'];
			expect(capabilities).toBeDefined();
			// Gemini supports multimodal
			expect(capabilities.supportsImageInput).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
		});

		it('should have capabilities for qwen3-coder', () => {
			const capabilities = AGENT_CAPABILITIES['qwen3-coder'];
			expect(capabilities).toBeDefined();
			// Local model - no cost tracking
			expect(capabilities.supportsCostTracking).toBe(false);
			expect(capabilities.supportsStreaming).toBe(true);
		});

		it('should have capabilities for opencode', () => {
			const capabilities = AGENT_CAPABILITIES['opencode'];
			expect(capabilities).toBeDefined();
			expect(capabilities.supportsResume).toBe(true);
			expect(capabilities.supportsReadOnlyMode).toBe(true);
			expect(capabilities.supportsJsonOutput).toBe(true);
			expect(capabilities.supportsSessionId).toBe(true);
			expect(capabilities.supportsUsageStats).toBe(true);
			expect(capabilities.supportsBatchMode).toBe(true);
			expect(capabilities.supportsStreaming).toBe(true);
			expect(capabilities.supportsResultMessages).toBe(true);
		});

		it('should define capabilities for all known agents', () => {
			const knownAgents = [
				'claude-code',
				'terminal',
				'codex',
				'gemini-cli',
				'qwen3-coder',
				'opencode',
			];

			for (const agentId of knownAgents) {
				expect(AGENT_CAPABILITIES[agentId]).toBeDefined();
				// Each should have all capability fields
				expect(typeof AGENT_CAPABILITIES[agentId].supportsResume).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsReadOnlyMode).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsJsonOutput).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsSessionId).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsImageInput).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsImageInputOnResume).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsSlashCommands).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsSessionStorage).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsCostTracking).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsUsageStats).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsBatchMode).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsStreaming).toBe('boolean');
				expect(typeof AGENT_CAPABILITIES[agentId].supportsResultMessages).toBe('boolean');
			}
		});
	});

	describe('getAgentCapabilities', () => {
		it('should return capabilities for known agents', () => {
			const capabilities = getAgentCapabilities('claude-code');
			expect(capabilities).toEqual(AGENT_CAPABILITIES['claude-code']);
		});

		it('should return default capabilities for unknown agents', () => {
			const capabilities = getAgentCapabilities('unknown-agent');
			expect(capabilities).toEqual(DEFAULT_CAPABILITIES);
		});

		it('should return a copy of default capabilities for unknown agents', () => {
			const capabilities1 = getAgentCapabilities('unknown-agent-1');
			const capabilities2 = getAgentCapabilities('unknown-agent-2');

			// Should be equal but not the same reference
			expect(capabilities1).toEqual(capabilities2);
			expect(capabilities1).not.toBe(capabilities2);
		});

		it('should return correct capabilities for each agent type', () => {
			expect(getAgentCapabilities('claude-code').supportsResume).toBe(true);
			expect(getAgentCapabilities('terminal').supportsResume).toBe(false);
			expect(getAgentCapabilities('opencode').supportsResume).toBe(true);
		});
	});

	describe('hasCapability', () => {
		it('should return true for supported capabilities', () => {
			expect(hasCapability('claude-code', 'supportsResume')).toBe(true);
			expect(hasCapability('claude-code', 'supportsImageInput')).toBe(true);
			expect(hasCapability('claude-code', 'supportsJsonOutput')).toBe(true);
		});

		it('should return false for unsupported capabilities', () => {
			expect(hasCapability('terminal', 'supportsResume')).toBe(false);
			expect(hasCapability('terminal', 'supportsJsonOutput')).toBe(false);
			expect(hasCapability('openai-codex', 'supportsResume')).toBe(false);
		});

		it('should return false for unknown agents', () => {
			expect(hasCapability('unknown-agent', 'supportsResume')).toBe(false);
			expect(hasCapability('unknown-agent', 'supportsStreaming')).toBe(false);
		});

		it('should work for all capability types', () => {
			const capabilityKeys: (keyof AgentCapabilities)[] = [
				'supportsResume',
				'supportsReadOnlyMode',
				'supportsJsonOutput',
				'supportsSessionId',
				'supportsImageInput',
				'supportsImageInputOnResume',
				'supportsSlashCommands',
				'supportsSessionStorage',
				'supportsCostTracking',
				'supportsUsageStats',
				'supportsBatchMode',
				'supportsStreaming',
				'supportsResultMessages',
			];

			for (const key of capabilityKeys) {
				// Should not throw for any capability
				expect(() => hasCapability('claude-code', key)).not.toThrow();
				// Result should be a boolean
				expect(typeof hasCapability('claude-code', key)).toBe('boolean');
			}
		});
	});

	describe('capability consistency', () => {
		it('should have all fields in DEFAULT_CAPABILITIES match AgentCapabilities interface', () => {
			const expectedKeys: (keyof AgentCapabilities)[] = [
				'supportsResume',
				'supportsReadOnlyMode',
				'supportsJsonOutput',
				'supportsSessionId',
				'supportsImageInput',
				'supportsImageInputOnResume',
				'supportsSlashCommands',
				'supportsSessionStorage',
				'supportsCostTracking',
				'supportsUsageStats',
				'supportsBatchMode',
				'supportsStreaming',
				'supportsStreamJsonInput',
				'supportsResultMessages',
				'supportsModelSelection',
				'requiresPromptToStart',
				'supportsThinkingDisplay',
				'supportsContextMerge',
				'supportsContextExport',
			];

			const defaultKeys = Object.keys(DEFAULT_CAPABILITIES);
			expect(defaultKeys.sort()).toEqual(expectedKeys.sort());
		});

		it('should have all agent capabilities contain all required fields', () => {
			const expectedKeys = Object.keys(DEFAULT_CAPABILITIES);

			for (const [agentId, capabilities] of Object.entries(AGENT_CAPABILITIES)) {
				const agentKeys = Object.keys(capabilities);
				expect(agentKeys.sort()).toEqual(expectedKeys.sort());
			}
		});
	});
});
