/**
 * @file claude-slash-command-probe.test.ts
 * @description Tests for src/main/agents/claude-slash-command-probe.ts - the
 * zero-token `/help` probe that fills the slash-command list for agents whose
 * turns run through maestro-p (whose TUI announces no commands).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import type { ExecResult } from '../../../main/utils/execFile';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { execFileNoThrow } from '../../../main/utils/execFile';
import {
	clearClaudeSlashCommandCache,
	parseInitSlashCommands,
	probeClaudeSlashCommands,
	probeClaudeSlashCommandsCached,
} from '../../../main/agents/claude-slash-command-probe';

const initLine = (commands: string[]) =>
	JSON.stringify({ type: 'system', subtype: 'init', slash_commands: commands }) + '\n';

beforeEach(() => {
	vi.mocked(execFileNoThrow).mockReset();
	clearClaudeSlashCommandCache();
});

describe('parseInitSlashCommands', () => {
	it('reads the commands from the init event among other lines', () => {
		const stdout = 'warning: something\n' + initLine(['/help', '/compact']) + '{"type":"result"}\n';
		expect(parseInitSlashCommands(stdout)).toEqual(['/help', '/compact']);
	});

	it('returns null when no init event names commands', () => {
		expect(parseInitSlashCommands('{"type":"result"}\n')).toBeNull();
		expect(parseInitSlashCommands('')).toBeNull();
	});
});

describe('probeClaudeSlashCommands', () => {
	// A probe that persisted its session would leave a stray `/help` transcript
	// in the folder's session list every time it ran.
	it('runs /help without persisting a session', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({
			stdout: initLine(['/help']),
			stderr: '',
			exitCode: 0,
		});

		await expect(probeClaudeSlashCommands('/bin/claude', '/proj')).resolves.toEqual(['/help']);
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'/bin/claude',
			[
				'--print',
				'--verbose',
				'--output-format',
				'stream-json',
				'--dangerously-skip-permissions',
				'--no-session-persistence',
				'--',
				'/help',
			],
			'/proj',
			undefined,
			expect.any(Function)
		);
	});

	it('passes the environment it is given', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({
			stdout: initLine(['/help']),
			stderr: '',
			exitCode: 0,
		});
		const env = { CLAUDE_CONFIG_DIR: '/cfg' };

		await probeClaudeSlashCommands('/bin/claude', '/proj', env);

		expect(execFileNoThrow).toHaveBeenCalledWith(
			'/bin/claude',
			expect.any(Array),
			'/proj',
			{ env },
			expect.any(Function)
		);
	});

	it('asks again without the flag when claude is too old to know it', async () => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({
				stdout: '',
				stderr: "error: unknown option '--no-session-persistence'",
				exitCode: 1,
			})
			.mockResolvedValueOnce({ stdout: initLine(['/help']), stderr: '', exitCode: 0 });

		await expect(probeClaudeSlashCommands('/bin/claude', '/proj')).resolves.toEqual(['/help']);
		expect(vi.mocked(execFileNoThrow).mock.calls[1][1]).not.toContain('--no-session-persistence');
	});

	it('returns null when claude fails with no output', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 1 });

		await expect(probeClaudeSlashCommands('/bin/claude', '/proj')).resolves.toBeNull();
	});
});

describe('probeClaudeSlashCommandsCached', () => {
	it('probes once per binary, folder, and config dir', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({
			stdout: initLine(['/help']),
			stderr: '',
			exitCode: 0,
		});

		const env = { CLAUDE_CONFIG_DIR: '/cfg-a' };
		await Promise.all([
			probeClaudeSlashCommandsCached('/bin/claude', '/proj', env),
			probeClaudeSlashCommandsCached('/bin/claude', '/proj', env),
		]);
		await probeClaudeSlashCommandsCached('/bin/claude', '/proj', env);
		expect(execFileNoThrow).toHaveBeenCalledTimes(1);

		await probeClaudeSlashCommandsCached('/bin/claude', '/proj', { CLAUDE_CONFIG_DIR: '/cfg-b' });
		await probeClaudeSlashCommandsCached('/bin/claude', '/other', env);
		expect(execFileNoThrow).toHaveBeenCalledTimes(3);
	});

	it('does not cache a failed probe', async () => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({ stdout: '', stderr: 'boom', exitCode: 1 })
			.mockResolvedValueOnce({ stdout: initLine(['/help']), stderr: '', exitCode: 0 });

		const env = {};
		await expect(probeClaudeSlashCommandsCached('/bin/claude', '/proj', env)).resolves.toBeNull();
		await expect(probeClaudeSlashCommandsCached('/bin/claude', '/proj', env)).resolves.toEqual([
			'/help',
		]);
	});
});

describe('standalone Claude probe activity', () => {
	const target = path.resolve('claude-probe-target');
	const success = { stdout: initLine(['/help']), stderr: '', exitCode: 0 };
	let gate: typeof import('../../../main/git/worktreeActivity');
	let probes: typeof import('../../../main/agents/claude-slash-command-probe');
	let natives: Array<{
		child: EventEmitter;
		result: ReturnType<typeof Promise.withResolvers<ExecResult>>;
	}>;
	let releases: Array<() => void>;

	async function reserve(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}
	async function blocked() {
		expect(await gate.reserveWorktreeCleanup(target)).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		natives = [];
		releases = [];
		vi.mocked(execFileNoThrow).mockImplementation((_command, _args, _cwd, _opts, onSpawn) => {
			const child = new EventEmitter();
			const result = Promise.withResolvers<ExecResult>();
			natives.push({ child, result });
			onSpawn?.(child as Parameters<NonNullable<typeof onSpawn>>[0]);
			return result.promise;
		});
		gate = await import('../../../main/git/worktreeActivity');
		probes = await import('../../../main/agents/claude-slash-command-probe');
	});
	afterEach(() => {
		for (const release of releases) release();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('other-repo')])(
		'refuses direct and cached discovery before setup/recovery under %s',
		async (root) => {
			await reserve(root);
			const getter = vi.fn(() => '/config');
			const env = Object.defineProperty({}, 'CLAUDE_CONFIG_DIR', { get: getter });
			const { logger } = await import('../../../main/utils/logger');
			vi.mocked(logger.warn).mockClear();
			await expect(probes.probeClaudeSlashCommands('claude', target, env)).rejects.toThrow(
				/reserved/
			);
			await expect(probes.probeClaudeSlashCommandsCached('claude', target, env)).rejects.toThrow(
				/reserved/
			);
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(getter).not.toHaveBeenCalled();
			expect(logger.warn).not.toHaveBeenCalled();
		}
	);

	it('blocks a pending canonicalization and holds after result/exit/error until close', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = gate.reserveWorktreeCleanup(target);
		const result = probes.probeClaudeSlashCommands('claude', target);
		canonical.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		natives[0].result.resolve(success);
		await expect(result).resolves.toEqual(['/help']);
		natives[0].child.on('error', () => {});
		natives[0].child.emit('exit', 0);
		natives[0].child.emit('error', new Error('native failed'));
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('retains parsing/reporting after close before result settlement', async () => {
		const result = probes.probeClaudeSlashCommands('claude', target);
		natives[0].child.emit('close');
		await blocked();
		natives[0].result.resolve(success);
		await expect(result).resolves.toEqual(['/help']);
		await reserve();
	});

	it('owns concurrent children independently', async () => {
		const first = probes.probeClaudeSlashCommands('claude', target);
		const second = probes.probeClaudeSlashCommands('claude', target);
		for (const native of natives) native.result.resolve(success);
		await Promise.all([first, second]);
		natives[0].child.emit('close');
		await blocked();
		natives[1].child.emit('close');
		await reserve();
	});

	it('keeps both retry children even if the first result precedes its close', async () => {
		const result = probes.probeClaudeSlashCommands('claude', target);
		natives[0].result.resolve({ stdout: '', stderr: 'unknown option', exitCode: 1 });
		await new Promise(setImmediate);
		expect(natives).toHaveLength(2);
		expect(vi.mocked(execFileNoThrow).mock.calls[1][1]).not.toContain('--no-session-persistence');
		natives[1].result.resolve(success);
		natives[1].child.emit('close');
		await expect(result).resolves.toEqual(['/help']);
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('deduplicates concurrent cached requests while retaining every child', async () => {
		const first = probes.probeClaudeSlashCommandsCached('claude', target, {});
		const second = probes.probeClaudeSlashCommandsCached('claude', target, {});
		expect(natives).toHaveLength(1);
		natives[0].result.resolve(success);
		await expect(Promise.all([first, second])).resolves.toEqual([['/help'], ['/help']]);
		await blocked();
		natives[0].child.emit('close');
		const hold = await reserve();
		await expect(probes.probeClaudeSlashCommandsCached('claude', target, {})).rejects.toThrow(
			/reserved/
		);
		hold.release();
		await expect(probes.probeClaudeSlashCommandsCached('claude', target, {})).resolves.toEqual([
			'/help',
		]);
		expect(natives).toHaveLength(1);
	});

	it('evicts failed cache results without releasing the older child', async () => {
		const first = probes.probeClaudeSlashCommandsCached('claude', target, {});
		natives[0].result.resolve({ stdout: '', stderr: 'timeout', exitCode: 'ETIMEDOUT' });
		await expect(first).resolves.toBeNull();
		const second = probes.probeClaudeSlashCommandsCached('claude', target, {});
		expect(natives).toHaveLength(2);
		natives[1].result.resolve(success);
		natives[1].child.emit('close');
		await second;
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('releases cached setup failure and retains rejected native work until close', async () => {
		const failure = new Error('configuration failed');
		const env = Object.defineProperty({}, 'CLAUDE_CONFIG_DIR', {
			get: () => {
				throw failure;
			},
		});
		await expect(probes.probeClaudeSlashCommandsCached('claude', target, env)).rejects.toBe(
			failure
		);
		(await reserve()).release();
		const result = probes.probeClaudeSlashCommands('claude', target);
		const assertion = expect(result).rejects.toBe(failure);
		natives[0].result.reject(failure);
		await assertion;
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it('releases failed reporting only after the independent child closes', async () => {
		const { logger } = await import('../../../main/utils/logger');
		const failure = new Error('reporting failed');
		vi.mocked(logger.warn).mockImplementationOnce(() => {
			throw failure;
		});
		const result = probes.probeClaudeSlashCommands('claude', target);
		natives[0].result.resolve({ stdout: '', stderr: 'failed', exitCode: 1 });
		await expect(result).rejects.toBe(failure);
		await blocked();
		natives[0].child.emit('close');
		await reserve();
	});

	it.each(['missing child', 'observer failure', 'unknown launch'])(
		'fails closed for %s',
		async (kind) => {
			vi.mocked(execFileNoThrow).mockImplementationOnce((_c, _a, _d, _o, observer) => {
				if (kind === 'missing child') return Promise.resolve(success);
				if (kind === 'observer failure')
					observer?.({
						once() {
							throw new Error(kind);
						},
					} as never);
				throw new Error(kind);
			});
			const result = probes.probeClaudeSlashCommands('claude', target);
			if (kind === 'missing child') await expect(result).resolves.toEqual(['/help']);
			else await expect(result).rejects.toThrow(kind);
			await blocked();
		}
	);
});
