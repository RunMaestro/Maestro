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
			expect(agentIds).toContain('copilot-cli');
			expect(agentIds).toContain('hermes');
			expect(agentIds).toContain('pi');
			expect(agentIds).toContain('omp');
		});

		it('should have omp with batch mode and json output configuration', () => {
			const omp = AGENT_DEFINITIONS.find((def) => def.id === 'omp');
			expect(omp).toBeDefined();
			expect(omp?.name).toBe('Oh My Pi');
			expect(omp?.command).toBe('omp');
			expect(omp?.binaryName).toBe('omp');
			expect(omp?.batchModePrefix).toEqual(['-p']);
			expect(omp?.jsonOutputArgs).toEqual(['--mode', 'json']);
			expect(omp?.resumeArgs?.('abc')).toEqual(['--resume', 'abc']);
			expect(omp?.modelArgs?.('opus')).toEqual(['--model', 'opus']);
			expect(omp?.hidden).toBeFalsy();
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
			// Base args are the standard-permission default; --dangerously-skip-permissions
			// only applies in full permission mode via fullAccessArgs.
			expect(claudeCode?.args).not.toContain('--dangerously-skip-permissions');
			expect(claudeCode?.fullAccessArgs).toContain('--dangerously-skip-permissions');
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

		it('should have copilot configured to use a PTY for interactive sessions', () => {
			const copilot = AGENT_DEFINITIONS.find((def) => def.id === 'copilot-cli');
			expect(copilot).toBeDefined();
			expect(copilot?.requiresPty).toBe(true);
			expect(copilot?.jsonOutputArgs).toEqual(['--output-format', 'json']);
			expect(copilot?.readOnlyArgs).toEqual([
				'--allow-tool=read,url',
				'--deny-tool=write,shell,memory,github',
				'--no-ask-user',
			]);
			expect(copilot?.readOnlyCliEnforced).toBe(true);
		});

		it('should configure Pi for documented JSONL batch output', () => {
			const pi = AGENT_DEFINITIONS.find((def) => def.id === 'pi');
			expect(pi?.batchModePrefix).toEqual(['-p']);
			expect(pi?.jsonOutputArgs).toEqual(['--mode', 'json']);
			expect(pi?.noPromptSeparator).toBe(true);
			expect(pi?.resumeArgs?.('pi-session-1')).toEqual(['--session', 'pi-session-1']);
			expect(pi?.readOnlyArgs).toEqual(['--tools', 'read,grep,find,ls']);
			expect(pi?.readOnlyCliEnforced).toBe(true);
			expect(pi?.noToolsArgs).toEqual(['--no-tools']);
			expect(pi?.modelArgs?.('anthropic/claude-sonnet-4')).toEqual([
				'--model',
				'anthropic/claude-sonnet-4',
			]);
			expect(pi?.imageArgs?.('/tmp/image.png')).toEqual(['@/tmp/image.png']);
		});

		it('should keep Hermes on the documented plain-text batch path', () => {
			const hermes = AGENT_DEFINITIONS.find((def) => def.id === 'hermes');
			expect(hermes?.batchModePrefix).toEqual(['chat']);
			expect(hermes?.batchModeArgs).toEqual(['-Q', '--yolo']);
			expect(hermes?.jsonOutputArgs).toBeUndefined();
			expect(hermes?.resumeArgs).toBeUndefined();
			expect(hermes?.promptArgs?.('hello')).toEqual(['-q', 'hello']);
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

		it('should have claude-code with defaultEnvVars disabling background tasks', () => {
			// Background tasks are disabled across every spawn path (desktop UI, CLI batch, --live, SSH).
			// Two motivations: short-lived batch sessions exit before background tasks finish (#861), and
			// the run_in_background + Monitor poll wrapper deadlocks on a self-matching `pgrep -f` when
			// the watched regex appears in the wrapper's own argv - observed in long-running desktop tabs.
			const claudeCode = AGENT_DEFINITIONS.find((def) => def.id === 'claude-code');
			expect(claudeCode?.defaultEnvVars).toBeDefined();
			expect(claudeCode?.defaultEnvVars?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
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
			const knownAgents = [
				'terminal',
				'claude-code',
				'codex',
				'opencode',
				'gemini-cli',
				'copilot-cli',
				'omp',
				'qwen3-coder',
			];
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

		it('should use = syntax for Copilot resume args', () => {
			const copilot = getAgentDefinition('copilot-cli');
			expect(copilot?.resumeArgs).toBeDefined();

			const args = copilot?.resumeArgs?.('session-789');
			expect(args).toEqual(['--resume=session-789']);
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

		it('should embed Copilot images into prompts using @mentions', () => {
			const copilot = getAgentDefinition('copilot-cli');
			expect(copilot?.imagePromptBuilder).toBeDefined();

			const promptPrefix = copilot?.imagePromptBuilder?.([
				'/tmp/screenshot-1.png',
				'/tmp/screenshot-2.jpg',
			]);
			expect(promptPrefix).toContain('@/tmp/screenshot-1.png');
			expect(promptPrefix).toContain('@/tmp/screenshot-2.jpg');
		});
	});

	describe('Agent config options', () => {
		it('should have configOptions for codex', () => {
			const codex = getAgentDefinition('codex');
			expect(codex?.configOptions).toBeDefined();
			expect(Array.isArray(codex?.configOptions)).toBe(true);

			const modelOption = codex?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption).toBeDefined();
			expect(modelOption?.type).toBe('text');

			const reasoningOption = codex?.configOptions?.find((opt) => opt.key === 'reasoningEffort');
			expect(reasoningOption).toBeDefined();
			expect(reasoningOption?.type).toBe('select');
			expect((reasoningOption as any)?.dynamic).toBe(true);
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

		it('should expose only the batch-meaningful Copilot config knobs', () => {
			const copilot = getAgentDefinition('copilot-cli');
			expect(copilot?.configOptions).toBeDefined();

			// The only user-facing knobs we expose are model, contextWindow, and
			// reasoningEffort. The autopilot / allow-all-paths / allow-all-urls /
			// experimental / screen-reader flags are intentionally omitted: batch
			// mode already runs with --allow-all, and the rest are either
			// interactive-only or general user preferences (see definitions.ts).
			const keys = (copilot?.configOptions || []).map((opt) => opt.key).sort();
			expect(keys).toEqual(['contextWindow', 'model', 'reasoningEffort']);

			const reasoningEffort = copilot?.configOptions?.find((opt) => opt.key === 'reasoningEffort');
			expect(reasoningEffort?.type).toBe('select');
			expect(reasoningEffort?.argBuilder?.('high')).toEqual(['--reasoning-effort', 'high']);
			expect(reasoningEffort?.argBuilder?.('')).toEqual([]);
		});

		it('should run Grok batch with --always-approve matching yoloModeArgs', () => {
			const grok = getAgentDefinition('grok');
			// batchModeArgs must equal yoloModeArgs (same pattern as Copilot's
			// --allow-all) so the CLI spawner's read-only filter strips the approve
			// flag: grok's clap hard-errors on a repeated --permission-mode
			// ("cannot be used multiple times"), so batchModeArgs must never carry
			// ['--permission-mode', 'bypassPermissions'] alongside readOnlyArgs'
			// ['--permission-mode', 'plan'].
			expect(grok?.batchModeArgs).toEqual(['--always-approve']);
			expect(grok?.yoloModeArgs).toEqual(['--always-approve']);
			expect(grok?.readOnlyArgs).toEqual(['--permission-mode', 'plan']);
		});

		it('should run Cursor CLI batch with --trust/--force and plan mode', () => {
			const cursor = getAgentDefinition('cursor-cli');
			expect(cursor?.binaryName).toBe('agent');
			expect(cursor?.batchModePrefix).toEqual(['-p', '--trust']);
			expect(cursor?.yoloModeArgs).toEqual(['--force']);
			expect(cursor?.readOnlyArgs).toEqual(['--mode', 'plan']);
			expect(cursor?.jsonOutputArgs).toEqual([
				'--output-format',
				'stream-json',
				'--stream-partial-output',
			]);
			expect(cursor?.workingDirArgs?.('/tmp/proj')).toEqual(['--workspace', '/tmp/proj']);
			expect(cursor?.promptArgs?.('hi')).toEqual(['hi']);
			expect(cursor?.resumeArgs?.('sess-1')).toEqual(['--resume', 'sess-1']);
			// Only --force is removable in read-only mode; -p and --trust remain
			// required for non-interactive trusted-workspace execution.
			expect(cursor?.batchModeArgs).toEqual(['--force']);
			expect(cursor?.yoloModeArgs).toContain('--force');
			expect(
				cursor?.imagePromptBuilder?.([
					'/tmp/cursor-screenshot-1.png',
					'/tmp/cursor-screenshot-2.jpg',
				])
			).toBe(
				'Use these attached images as context:\n/tmp/cursor-screenshot-1.png\n/tmp/cursor-screenshot-2.jpg\n\n'
			);
		});

		it('should define the Cursor CLI model option as a dynamic select', () => {
			const cursor = getAgentDefinition('cursor-cli');
			const modelOption = cursor?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption?.type).toBe('select');
			expect((modelOption as { dynamic?: boolean })?.dynamic).toBe(true);
			expect(modelOption?.argBuilder?.('auto')).toEqual(['--model', 'auto']);
			expect(modelOption?.argBuilder?.('')).toEqual([]);
		});

		it('should define the Grok model option as a dynamic select with static fallback', () => {
			const grok = getAgentDefinition('grok');
			expect(grok?.configOptions).toBeDefined();

			const modelOption = grok?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption?.type).toBe('select');
			expect((modelOption as any)?.dynamic).toBe(true);
			// Static fallback for fresh installs where ~/.grok/models_cache.json
			// hasn't been written yet (per `grok models` v0.2.93).
			expect((modelOption as any)?.options).toEqual(['', 'grok-4.5', 'grok-composer-2.5-fast']);
			expect(modelOption?.default).toBe('');
			expect(modelOption?.argBuilder?.('grok-4.5')).toEqual(['-m', 'grok-4.5']);
			expect(modelOption?.argBuilder?.('')).toEqual([]);
			expect(modelOption?.argBuilder?.('  ')).toEqual([]);
		});

		it('should expose the full Grok reasoning-effort ladder the CLI accepts', () => {
			const grok = getAgentDefinition('grok');
			const reasoningEffort = grok?.configOptions?.find((opt) => opt.key === 'reasoningEffort');
			expect(reasoningEffort?.type).toBe('select');
			// Empirically discovered from grok v0.2.93: passing a bogus value errors
			// with "Use none, minimal, low, medium, high, xhigh, max, or a model menu
			// option id".
			expect((reasoningEffort as any)?.options).toEqual([
				'',
				'none',
				'minimal',
				'low',
				'medium',
				'high',
				'xhigh',
				'max',
			]);
			expect(reasoningEffort?.default).toBe('');
			expect(reasoningEffort?.argBuilder?.('xhigh')).toEqual(['--reasoning-effort', 'xhigh']);
			expect(reasoningEffort?.argBuilder?.('')).toEqual([]);
			expect(reasoningEffort?.argBuilder?.('  ')).toEqual([]);
		});

		it('should run Copilot batch with --allow-all (no --silent, no per-flag toggles)', () => {
			const copilot = getAgentDefinition('copilot-cli');
			expect(copilot?.batchModeArgs).toEqual(['--allow-all']);
			expect(copilot?.batchModeArgs).not.toContain('--silent');
			expect(copilot?.yoloModeArgs).toEqual(['--allow-all']);
		});
	});

	describe('Qwen3 Coder agent', () => {
		it('should be a visible, real agent (not hidden)', () => {
			const qwen = getAgentDefinition('qwen3-coder');
			expect(qwen).toBeDefined();
			expect(qwen?.hidden).toBeFalsy();
			expect(qwen?.binaryName).toBe('qwen');
			expect(qwen?.command).toBe('qwen');
		});

		it('should build modelArgs and stream-json output args', () => {
			const qwen = getAgentDefinition('qwen3-coder');
			expect(qwen?.modelArgs?.('qwen3-coder-plus')).toEqual(['-m', 'qwen3-coder-plus']);
			expect(qwen?.jsonOutputArgs).toEqual(['--output-format', 'stream-json']);
			expect(qwen?.promptArgs?.('hello')).toEqual(['-p', 'hello']);
		});

		it('should expose a free-text model config option with trimming argBuilder', () => {
			const qwen = getAgentDefinition('qwen3-coder');
			const modelOption = qwen?.configOptions?.find((opt) => opt.key === 'model');
			expect(modelOption).toBeDefined();
			expect(modelOption?.type).toBe('text');
			expect(modelOption?.default).toBe('');
			expect(modelOption?.argBuilder?.('qwen3-coder-plus')).toEqual(['-m', 'qwen3-coder-plus']);
			expect(modelOption?.argBuilder?.('')).toEqual([]);
			expect(modelOption?.argBuilder?.('  ')).toEqual([]);
		});

		it('should use --approval-mode plan for CLI-enforced read-only (never -y)', () => {
			const qwen = getAgentDefinition('qwen3-coder');
			expect(qwen?.readOnlyArgs).toEqual(['--approval-mode', 'plan']);
			expect(qwen?.readOnlyCliEnforced).toBe(true);
			expect(qwen?.readOnlyArgs).not.toContain('-y');
		});
	});

	describe('Oh My Pi agent', () => {
		it('should restrict to read-only tools for CLI-enforced read-only', () => {
			const omp = getAgentDefinition('omp');
			expect(omp?.readOnlyArgs).toEqual(['--tools', 'read,grep,glob']);
			expect(omp?.readOnlyCliEnforced).toBe(true);
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

// ---------------------------------------------------------------------------
// Additional Directories: per-provider grant mapping
// ---------------------------------------------------------------------------
describe('additionalDirArgs', () => {
	const GRANTS = [
		{ path: '/ref/docs', read: true, write: false }, // read-only
		{ path: '/out/drop', read: false, write: true }, // write-only
		{ path: '/shared/src', read: true, write: true }, // read + write
		{ path: '/ignored', read: false, write: false }, // inert
	];

	const argsFor = (id: string) => {
		const def = AGENT_DEFINITIONS.find((d) => d.id === id);
		return def?.additionalDirArgs?.(GRANTS);
	};

	it('claude-code: --add-dir allows tool access, so every granted dir maps', () => {
		// `--add-dir` is access (read AND write). It cannot express write-only, so
		// the write-only dir is still passed and the prompt enforces "never read it".
		expect(argsFor('claude-code')).toEqual([
			'--add-dir',
			'/ref/docs',
			'--add-dir',
			'/out/drop',
			'--add-dir',
			'/shared/src',
		]);
	});

	it('copilot-cli: same access semantics as Claude Code', () => {
		expect(argsFor('copilot-cli')).toEqual([
			'--add-dir',
			'/ref/docs',
			'--add-dir',
			'/out/drop',
			'--add-dir',
			'/shared/src',
		]);
	});

	it('codex: --add-dir adds a WRITABLE sandbox root, so read-only grants do not map', () => {
		// Codex's flag is narrower than Claude's. Passing a read-only dir here would
		// hand the sandbox write access the user never granted.
		expect(argsFor('codex')).toEqual(['--add-dir', '/out/drop', '--add-dir', '/shared/src']);
	});

	it('drops inert grants for every provider that has a builder', () => {
		for (const def of AGENT_DEFINITIONS) {
			const args = def.additionalDirArgs?.(GRANTS);
			if (!args) continue;
			expect(args, `${def.id} leaked a grant with neither read nor write`).not.toContain(
				'/ignored'
			);
		}
	});

	it('opencode has no native mechanism and falls back to the prompt', () => {
		expect(argsFor('opencode')).toBeUndefined();
	});
});
