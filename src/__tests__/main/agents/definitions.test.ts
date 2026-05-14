/**
 * Tests for agent-definitions.ts
 *
 * Tests the agent definition data structures and helper functions.
 */

import { describe, it, expect } from 'vitest';
import {
	AGENT_DEFINITIONS,
	getAgentDefinition,
	getAgentIds,
	getVisibleAgentDefinitions,
	type AgentDefinition,
	type AgentConfigOption,
} from '../../../main/agents';

describe('agent-definitions', () => {
	describe('AGENT_DEFINITIONS', () => {
		it('should contain all expected agents', () => {
			const agentIds = AGENT_DEFINITIONS.map((def) => def.id);

			expect(agentIds).toContain('terminal');
			expect(agentIds).toContain('claude-code');
			expect(agentIds).toContain('codex');
			expect(agentIds).toContain('opencode');
			expect(agentIds).toContain('gemini-cli');
			expect(agentIds).toContain('qwen3-coder');
			expect(agentIds).toContain('aider');
		});

		it('should have required properties on all definitions', () => {
			for (const def of AGENT_DEFINITIONS) {
				expect(def.id).toBeDefined();
				expect(def.name).toBeDefined();
				expect(def.binaryName).toBeDefined();
				expect(def.command).toBeDefined();
				expect(def.args).toBeDefined();
				expect(Array.isArray(def.args)).toBe(true);
			}
		});

		it('should have terminal as a hidden agent', () => {
			const terminal = AGENT_DEFINITIONS.find((def) => def.id === 'terminal');
			expect(terminal?.hidden).toBe(true);
		});

		it('should have claude-code with correct base args', () => {
			const claudeCode = AGENT_DEFINITIONS.find((def) => def.id === 'claude-code');
			expect(claudeCode).toBeDefined();
			expect(claudeCode?.args).toContain('--print');
			expect(claudeCode?.args).toContain('--verbose');
			expect(claudeCode?.args).toContain('--output-format');
			expect(claudeCode?.args).toContain('stream-json');
			expect(claudeCode?.args).toContain('--dangerously-skip-permissions');
		});

		it('should have codex with batch mode configuration', () => {
			const codex = AGENT_DEFINITIONS.find((def) => def.id === 'codex');
			expect(codex).toBeDefined();
			expect(codex?.batchModePrefix).toEqual(['exec']);
			expect(codex?.batchModeArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
			expect(codex?.jsonOutputArgs).toEqual(['--json']);
		});

		it('should have opencode with batch mode configuration', () => {
			const opencode = AGENT_DEFINITIONS.find((def) => def.id === 'opencode');
			expect(opencode).toBeDefined();
			expect(opencode?.batchModePrefix).toEqual(['run']);
			expect(opencode?.jsonOutputArgs).toEqual(['--format', 'json']);
			// noPromptSeparator removed: '--' separator prevents yargs from misinterpreting prompt content (#527)
			expect(opencode?.noPromptSeparator).toBeUndefined();
		});

		it('should have opencode with default env vars for YOLO mode and disabled question tool', () => {
			const opencode = AGENT_DEFINITIONS.find((def) => def.id === 'opencode');
			expect(opencode?.defaultEnvVars).toBeDefined();
			const configContent = opencode?.defaultEnvVars?.OPENCODE_CONFIG_CONTENT;
			expect(configContent).toBeDefined();

			// Verify it's valid JSON
			const config = JSON.parse(configContent!);

			// Should have permission settings for YOLO mode
			expect(config.permission).toBeDefined();
			expect(config.permission['*']).toBe('allow');
			expect(config.permission.external_directory).toBe('allow');

			// Should disable the question tool to prevent batch mode hangs
			// The question tool waits for stdin input which causes hangs in batch mode
			expect(config.tools).toBeDefined();
			expect(config.tools.question).toBe(false);
		});
	});

	describe('getAgentDefinition', () => {
		it('should return definition for valid agent ID', () => {
			const claudeCode = getAgentDefinition('claude-code');
			expect(claudeCode).toBeDefined();
			expect(claudeCode?.id).toBe('claude-code');
			expect(claudeCode?.name).toBe('Claude Code');
		});

		it('should return undefined for invalid agent ID', () => {
			const invalid = getAgentDefinition('non-existent-agent');
			expect(invalid).toBeUndefined();
		});

		it('should return definition for all known agents', () => {
			const knownAgents = ['terminal', 'claude-code', 'codex', 'opencode', 'gemini-cli', 'aider'];
			for (const agentId of knownAgents) {
				const def = getAgentDefinition(agentId);
				expect(def).toBeDefined();
				expect(def?.id).toBe(agentId);
			}
		});
	});

	describe('getAgentIds', () => {
		it('should return array of all agent IDs', () => {
			const ids = getAgentIds();
			expect(Array.isArray(ids)).toBe(true);
			expect(ids.length).toBeGreaterThan(0);
			expect(ids).toContain('claude-code');
			expect(ids).toContain('terminal');
		});

		it('should match AGENT_DEFINITIONS length', () => {
			const ids = getAgentIds();
			expect(ids.length).toBe(AGENT_DEFINITIONS.length);
		});
	});

	describe('getVisibleAgentDefinitions', () => {
		it('should not include hidden agents', () => {
			const visible = getVisibleAgentDefinitions();
			const visibleIds = visible.map((def) => def.id);

			// Terminal should be hidden
			expect(visibleIds).not.toContain('terminal');
		});

		it('should include visible agents', () => {
			const visible = getVisibleAgentDefinitions();
			const visibleIds = visible.map((def) => def.id);

			expect(visibleIds).toContain('claude-code');
			expect(visibleIds).toContain('codex');
			expect(visibleIds).toContain('opencode');
		});

		it('should return fewer items than AGENT_DEFINITIONS', () => {
			const visible = getVisibleAgentDefinitions();
			expect(visible.length).toBeLessThan(AGENT_DEFINITIONS.length);
		});
	});

	describe('Agent argument builders', () => {
		it('should have resumeArgs function for claude-code', () => {
			const claudeCode = getAgentDefinition('claude-code');
			expect(claudeCode?.resumeArgs).toBeDefined();
			expect(typeof claudeCode?.resumeArgs).toBe('function');

			const args = claudeCode?.resumeArgs?.('test-session-123');
			expect(args).toEqual(['--resume', 'test-session-123']);
		});

		it('should have resumeArgs function for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.resumeArgs).toBeDefined();

			const args = codex?.resumeArgs?.('thread-456');
			expect(args).toEqual(['resume', 'thread-456']);
		});

		it('should have resumeArgs function for opencode', () => {
			const opencode = getAgentDefinition('opencode');
			expect(opencode?.resumeArgs).toBeDefined();

			const args = opencode?.resumeArgs?.('session-789');
			expect(args).toEqual(['--session', 'session-789']);
		});

		it('should have modelArgs function for opencode', () => {
			const opencode = getAgentDefinition('opencode');
			expect(opencode?.modelArgs).toBeDefined();

			const args = opencode?.modelArgs?.('ollama/qwen3:8b');
			expect(args).toEqual(['--model', 'ollama/qwen3:8b']);
		});

		it('should have workingDirArgs function for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.workingDirArgs).toBeDefined();

			const args = codex?.workingDirArgs?.('/path/to/project');
			expect(args).toEqual(['-C', '/path/to/project']);
		});

		it('should have imageArgs function for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.imageArgs).toBeDefined();

			const args = codex?.imageArgs?.('/path/to/image.png');
			expect(args).toEqual(['-i', '/path/to/image.png']);
		});

		it('should have imageArgs function for opencode', () => {
			const opencode = getAgentDefinition('opencode');
			expect(opencode?.imageArgs).toBeDefined();

			const args = opencode?.imageArgs?.('/path/to/image.png');
			expect(args).toEqual(['-f', '/path/to/image.png']);
		});
	});

	describe('Agent config options', () => {
		it('should have configOptions for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.configOptions).toBeDefined();
			expect(Array.isArray(codex?.configOptions)).toBe(true);

			const contextWindowOption = codex?.configOptions?.find((opt) => opt.key === 'contextWindow');
			expect(contextWindowOption).toBeDefined();
			expect(contextWindowOption?.type).toBe('number');
			expect(contextWindowOption?.default).toBe(400000);
		});

		it('should have configOptions for opencode', () => {
			const opencode = getAgentDefinition('opencode');
			expect(opencode?.configOptions).toBeDefined();

			const modelOption = opencode?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption).toBeDefined();
			expect(modelOption?.type).toBe('text');
			expect(modelOption?.default).toBe('');

			// Test argBuilder
			expect(modelOption?.argBuilder).toBeDefined();
			expect(modelOption?.argBuilder?.('ollama/qwen3:8b')).toEqual(['--model', 'ollama/qwen3:8b']);
			expect(modelOption?.argBuilder?.('')).toEqual([]);
			expect(modelOption?.argBuilder?.('  ')).toEqual([]);
		});
	});

	describe('Type definitions', () => {
		it('should export AgentDefinition type', () => {
			const def: AgentDefinition = {
				id: 'test',
				name: 'Test Agent',
				binaryName: 'test',
				command: 'test',
				args: [],
			};
			expect(def.id).toBe('test');
		});

		it('should export AgentConfigOption type', () => {
			const option: AgentConfigOption = {
				key: 'testKey',
				type: 'text',
				label: 'Test Label',
				description: 'Test description',
				default: 'default value',
			};
			expect(option.key).toBe('testKey');
		});
	});
});
