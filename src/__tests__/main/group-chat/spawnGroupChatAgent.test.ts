/**
 * @file spawnGroupChatAgent.test.ts
 * @description Verifies the Group Chat spawn helper forwards `maxWaitSeconds`
 * into maestro-p's `--max-wait`. Without this the interactive (TUI) path falls
 * back to maestro-p's 300s idle default and silently kills a still-working
 * moderator/participant whose JSONL output stalls past 300s, even though the
 * router would wait the full supervising timeout. Regression guard for that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep applyClaudeSpawnDecision + buildRemoteInteractiveSpawn REAL (they own the
// actual `--max-wait` arg injection, which is what we want to assert lands in
// the spawn). Only stub resolveClaudeSpawnMode so it deterministically resolves
// to the local interactive (maestro-p) path without needing a real binary or a
// usage snapshot.
const mockResolve = vi.fn();
vi.mock('../../../main/agents/resolveClaudeSpawnMode', async () => {
	const actual = await vi.importActual<
		typeof import('../../../main/agents/resolveClaudeSpawnMode')
	>('../../../main/agents/resolveClaudeSpawnMode');
	return {
		...actual,
		resolveClaudeSpawnMode: (...args: unknown[]) => mockResolve(...args),
	};
});

import { spawnGroupChatAgent } from '../../../main/group-chat/spawnGroupChatAgent';
import type { AgentConfig } from '../../../main/agents/definitions';
import type { IProcessManager } from '../../../main/group-chat/group-chat-moderator';

function makeAgent(): AgentConfig {
	return {
		id: 'claude-code',
		command: 'claude',
		interactiveCommand: 'claude',
		interactiveModeArgs: ['--dangerously-skip-permissions'],
	} as unknown as AgentConfig;
}

describe('spawnGroupChatAgent', () => {
	let processManager: IProcessManager;
	let spawnSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		spawnSpy = vi.fn().mockReturnValue({ pid: 4242, success: true });
		processManager = {
			spawn: spawnSpy,
			write: vi.fn().mockReturnValue(true),
			kill: vi.fn().mockReturnValue(true),
		} as unknown as IProcessManager;
	});

	it('forwards maxWaitSeconds as --max-wait on the interactive maestro-p spawn', async () => {
		// Decision: local interactive, with a resolved maestro-p script path.
		mockResolve.mockReturnValue({
			mode: 'interactive',
			reason: 'auto',
			maestroPBinPath: '/bundled/maestro-p.js',
			claudeRealBinPath: '/usr/local/bin/claude',
		});

		await spawnGroupChatAgent({
			sessionId: 'sess-1',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'interactive',
			maxWaitSeconds: 600,
			processManager,
			debugLabel: 'participant: Test',
		});

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const spawned = spawnSpy.mock.calls[0][0] as { command: string; args: string[] };
		// process.execPath drives the maestro-p script under ELECTRON_RUN_AS_NODE.
		expect(spawned.command).toBe(process.execPath);
		// --max-wait must land after the script but before the batch args/prompt.
		const i = spawned.args.indexOf('--max-wait');
		expect(i).toBeGreaterThan(-1);
		expect(spawned.args[i + 1]).toBe('600');
		expect(spawned.args.indexOf('--max-wait')).toBeLessThan(spawned.args.indexOf('--'));
	});

	it('omits --max-wait when maxWaitSeconds is not provided', async () => {
		mockResolve.mockReturnValue({
			mode: 'interactive',
			reason: 'auto',
			maestroPBinPath: '/bundled/maestro-p.js',
			claudeRealBinPath: '/usr/local/bin/claude',
		});

		await spawnGroupChatAgent({
			sessionId: 'sess-2',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'interactive',
			processManager,
		});

		const spawned = spawnSpy.mock.calls[0][0] as { args: string[] };
		expect(spawned.args).not.toContain('--max-wait');
	});

	it('does not inject --max-wait on the API path (no maestro-p)', async () => {
		mockResolve.mockReturnValue({ mode: 'api', reason: 'auto', maestroPBinPath: null });

		await spawnGroupChatAgent({
			sessionId: 'sess-3',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'api',
			maxWaitSeconds: 600,
			processManager,
		});

		const spawned = spawnSpy.mock.calls[0][0] as { command: string; args: string[] };
		expect(spawned.command).toBe('/usr/local/bin/claude');
		expect(spawned.args).not.toContain('--max-wait');
	});
});
