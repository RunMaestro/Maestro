/**
 * Tests for agent-definitions.ts
 *
 * Tests the agent definition data structures and helper functions.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
	AGENT_DEFINITIONS,
	getAgentDefinition,
	getAgentIds,
	getVisibleAgentDefinitions,
	type AgentDefinition,
	type AgentConfigOption,
} from '../../main/agents';

const expectedAgentIds = [
	'terminal',
	'claude-code',
	'codex',
	'opencode',
	'gemini-cli',
	'qwen3-coder',
	'factory-droid',
	'copilot-cli',
];

describe('agent-definitions', () => {
	afterEach(() => {
		vi.doUnmock('../../shared/platformDetection');
		vi.resetModules();
	});

	describe('AGENT_DEFINITIONS', () => {
		it('should contain all expected agents', () => {
			const agentIds = AGENT_DEFINITIONS.map((def) => def.id);

			expect(agentIds).toEqual(expect.arrayContaining(expectedAgentIds));
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

		it('should use PowerShell for the terminal agent on Windows', async () => {
			vi.resetModules();
			vi.doMock('../../shared/platformDetection', () => ({
				isWindows: () => true,
			}));

			const { AGENT_DEFINITIONS: windowsDefinitions } =
				await import('../../main/agents/definitions');
			const terminal = windowsDefinitions.find((def) => def.id === 'terminal');

			expect(terminal?.binaryName).toBe('powershell.exe');
			expect(terminal?.command).toBe('powershell.exe');
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
			for (const agentId of expectedAgentIds) {
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

		it('should have modelArgs function for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.modelArgs).toBeDefined();

			const args = codex?.modelArgs?.('gpt-5.3-codex');
			expect(args).toEqual(['-m', 'gpt-5.3-codex']);
		});

		it('should have imageArgs function for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.imageArgs).toBeDefined();

			const args = codex?.imageArgs?.('/path/to/image.png');
			expect(args).toEqual(['-i', '/path/to/image.png']);
		});

		it('should have Gemini batch argument builders', () => {
			const gemini = getAgentDefinition('gemini-cli');
			expect(gemini?.batchModePrefix).toEqual([]);
			expect(gemini?.batchModeArgs).toEqual(['-y']);
			expect(gemini?.jsonOutputArgs).toEqual(['--output-format', 'stream-json']);
			expect(gemini?.resumeArgs?.('gemini-session')).toEqual(['--resume', 'gemini-session']);
			expect(gemini?.workingDirArgs?.('/workspace/project')).toEqual([
				'--include-directories',
				'/workspace/project',
			]);
			expect(gemini?.imageArgs).toBeUndefined();
			expect(gemini?.modelArgs?.('gemini-3-pro-preview')).toEqual(['-m', 'gemini-3-pro-preview']);
			expect(gemini?.promptArgs?.('Summarize this diff')).toEqual(['-p', 'Summarize this diff']);
		});

		it('should have imageArgs function for opencode', () => {
			const opencode = getAgentDefinition('opencode');
			expect(opencode?.imageArgs).toBeDefined();

			const args = opencode?.imageArgs?.('/path/to/image.png');
			expect(args).toEqual(['-f', '/path/to/image.png']);
		});

		it('should have Factory Droid batch argument builders', () => {
			const droid = getAgentDefinition('factory-droid');
			expect(droid?.batchModePrefix).toEqual(['exec']);
			expect(droid?.batchModeArgs).toEqual(['--skip-permissions-unsafe']);
			expect(droid?.jsonOutputArgs).toEqual(['-o', 'stream-json']);
			expect(droid?.resumeArgs?.('droid-session')).toEqual(['-s', 'droid-session']);
			expect(droid?.readOnlyArgs).toEqual([]);
			expect(droid?.readOnlyCliEnforced).toBe(true);
			expect(droid?.yoloModeArgs).toEqual(['--skip-permissions-unsafe']);
			expect(droid?.workingDirArgs?.('/workspace/project')).toEqual([
				'--cwd',
				'/workspace/project',
			]);
			expect(droid?.imageArgs?.('/path/to/image.png')).toEqual(['-f', '/path/to/image.png']);
			expect(droid?.noPromptSeparator).toBe(true);
			expect(droid?.defaultEnvVars).toEqual({});
		});
	});

	describe('Agent config options', () => {
		it('should have configOptions for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.configOptions).toBeDefined();
			expect(Array.isArray(codex?.configOptions)).toBe(true);

			const modelOption = codex?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption?.type).toBe('text');
			expect(modelOption?.argBuilder?.('  gpt-5.3-codex  ')).toEqual(['-m', 'gpt-5.3-codex']);
			expect(modelOption?.argBuilder?.('')).toEqual([]);
			expect(modelOption?.argBuilder?.('  ')).toEqual([]);

			const reasoningOption = codex?.configOptions?.find((opt) => opt.key === 'reasoningEffort');
			expect(reasoningOption?.type).toBe('select');
			expect(reasoningOption?.default).toBe('');
			expect(reasoningOption?.argBuilder?.('  high  ')).toEqual(['-c', 'reasoning.effort="high"']);
			expect(reasoningOption?.argBuilder?.('')).toEqual([]);
			expect(reasoningOption?.argBuilder?.('  ')).toEqual([]);
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

		it('should have configOptions for Gemini CLI', () => {
			const gemini = getAgentDefinition('gemini-cli');
			expect(gemini?.configOptions).toBeDefined();

			const modelOption = gemini?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption?.type).toBe('select');
			expect(modelOption?.default).toBe('');
			expect(modelOption && 'options' in modelOption ? modelOption.options : []).toContain(
				'gemini-3-pro-preview'
			);
			expect(modelOption?.argBuilder?.('  gemini-2.5-flash  ')).toEqual(['-m', 'gemini-2.5-flash']);
			expect(modelOption?.argBuilder?.('')).toEqual([]);
			expect(modelOption?.argBuilder?.('  ')).toEqual([]);

			const contextWindowOption = gemini?.configOptions?.find((opt) => opt.key === 'contextWindow');
			expect(contextWindowOption?.type).toBe('number');
			expect(contextWindowOption?.default).toBe(1048576);
		});

		it('should have configOptions for Factory Droid', () => {
			const droid = getAgentDefinition('factory-droid');
			expect(droid?.configOptions).toBeDefined();

			const modelOption = droid?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption?.type).toBe('select');
			expect(modelOption?.default).toBe('');
			expect(modelOption && 'options' in modelOption ? modelOption.options : []).toContain(
				'claude-opus-4-5-20251101'
			);
			expect(modelOption?.argBuilder?.('  gpt-5.2  ')).toEqual(['-m', 'gpt-5.2']);
			expect(modelOption?.argBuilder?.('')).toEqual([]);
			expect(modelOption?.argBuilder?.('  ')).toEqual([]);

			const reasoningOption = droid?.configOptions?.find((opt) => opt.key === 'reasoningEffort');
			expect(reasoningOption?.type).toBe('select');
			expect(reasoningOption?.argBuilder?.('  high  ')).toEqual(['-r', 'high']);
			expect(reasoningOption?.argBuilder?.('')).toEqual([]);
			expect(reasoningOption?.argBuilder?.('  ')).toEqual([]);

			const contextWindowOption = droid?.configOptions?.find((opt) => opt.key === 'contextWindow');
			expect(contextWindowOption?.type).toBe('number');
			expect(contextWindowOption?.default).toBe(200000);
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
