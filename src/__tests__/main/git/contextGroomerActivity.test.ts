import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import type { AgentConfig, AgentDetector } from '../../../main/agents';
import type {
	GroomContextOptions,
	GroomingProcessManager,
} from '../../../main/utils/context-groomer';

vi.mock('fs/promises', async (original) => {
	const actual = await original<typeof import('fs/promises')>();
	return { ...actual, default: { ...actual, realpath: vi.fn() } };
});
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	spawn: vi.fn(),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/agent-args', () => ({
	buildAgentArgs: vi.fn(() => ['--batch']),
	applyAgentConfigOverrides: vi.fn(() => ({ args: ['--batch'], effectiveCustomEnvVars: {} })),
}));
vi.mock('../../../main/utils/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: vi.fn(),
	sshUnresolvedRemoteMessage: vi.fn(() => 'Unresolved remote'),
}));
vi.mock('../../../main/agents/probeRemoteMaestroP', () => ({}));
vi.mock('../../../main/agents/resolveClaudeSpawnMode', () => ({}));
vi.mock('../../../shared/platformDetection', () => ({ isWindows: vi.fn(() => false) }));

import { logger } from '../../../main/utils/logger';
import { buildAgentArgs } from '../../../main/utils/agent-args';
import { wrapSpawnWithSsh } from '../../../main/utils/ssh-spawn-wrapper';

describe('context grooming request activity', () => {
	const target = path.resolve('grooming-target');
	const options = { projectRoot: target, agentType: 'codex', prompt: 'summarize' };
	const agent = {
		id: 'codex',
		available: true,
		command: 'codex',
		binaryName: 'codex',
		args: [],
	} as unknown as AgentConfig;
	let gate: typeof import('../../../main/git/worktreeActivity');
	let grooming: typeof import('../../../main/utils/context-groomer');
	let turns: typeof import('../../../main/git/worktreeTurnActivity');
	let bus: EventEmitter;
	let children: EventEmitter[];
	let releases: Array<() => void>;
	let detector: { getAgent: ReturnType<typeof vi.fn> };
	let manager: GroomingProcessManager & {
		spawn: ReturnType<typeof vi.fn<GroomingProcessManager['spawn']>>;
		kill: ReturnType<typeof vi.fn<GroomingProcessManager['kill']>>;
	};
	const drain = () => new Promise(setImmediate);
	const request = (overrides: Partial<GroomContextOptions> = {}) =>
		grooming.groomContext(
			{ ...options, ...overrides },
			manager,
			detector as unknown as AgentDetector
		);
	const id = (index = 0) => manager.spawn.mock.calls[index][0].sessionId;
	function finish(index = 0) {
		bus.emit('data', id(index), 'collected response');
		bus.emit('exit', id(index), 0);
	}
	async function reserve(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}
	async function blocked() {
		const hold = await gate.reserveWorktreeCleanup(target);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold).toMatchObject({ status: 'blocked', blockers: [{ code: 'mutation-busy' }] });
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.resetAllMocks();
		children = [];
		releases = [];
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
		});
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		vi.mocked(buildAgentArgs).mockReturnValue(['--batch']);
		const { applyAgentConfigOverrides } = await import('../../../main/utils/agent-args');
		vi.mocked(applyAgentConfigOverrides).mockReturnValue({
			args: ['--batch'],
			effectiveCustomEnvVars: { PRESERVED: 'value' },
			customArgsSource: 'none',
			customEnvSource: 'session',
			modelSource: 'default',
		});
		gate = await import('../../../main/git/worktreeActivity');
		turns = await import('../../../main/git/worktreeTurnActivity');
		grooming = await import('../../../main/utils/context-groomer');
		bus = new EventEmitter();
		detector = { getAgent: vi.fn(async () => agent) };
		vi.mocked(spawn).mockImplementation(() => {
			const child = new EventEmitter();
			child.on('error', () => {});
			children.push(child);
			return child as ReturnType<typeof spawn>;
		});
		manager = {
			on: (event, listener) => void bus.on(event, listener),
			off: (event, listener) => void bus.off(event, listener),
			kill: vi.fn(),
			spawn: vi.fn(() =>
				turns.withWorktreeTurnActivity(
					(_start, _observe, nativeSpawn) => {
						nativeSpawn('provider', [], {});
						return { pid: 123, success: true };
					},
					() => {}
				)
			),
		};
	});
	afterEach(async () => {
		for (const release of releases) release();
		grooming.cancelAllGroomingSessions();
		for (const child of children) child.emit('close');
		await drain();
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
		'refuses before options, diagnostics, detection or recovery under %s',
		async (root) => {
			await reserve(root);
			const read = vi.fn(() => {
				throw new Error('Unexpected options read');
			});
			await expect(
				grooming.groomContext(
					new Proxy(options, { get: read }),
					manager,
					detector as unknown as AgentDetector
				)
			).rejects.toThrow(/reserved/);
			for (const work of [
				read,
				logger.info,
				logger.warn,
				detector.getAgent,
				buildAgentArgs,
				wrapSpawnWithSsh,
				manager.spawn,
				manager.kill,
			])
				expect(work).not.toHaveBeenCalled();
		}
	);
	it('admits synchronously while reservation canonicalization is pending', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const hold = gate.reserveWorktreeCleanup(target);
		const pending = request();
		canonical.resolve(target);
		await expect(hold).resolves.toMatchObject({ status: 'blocked' });
		await drain();
		finish();
		await pending;
		await blocked();
		children[0].emit('close');
		await reserve();
	});
	it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
		'refuses standalone cancellation before logging or session access under %s',
		async (root) => {
			await reserve(root);
			expect(() => grooming.cancelAllGroomingSessions()).toThrow(/reserved/);
			expect(logger.info).not.toHaveBeenCalled();
			expect(manager.kill).not.toHaveBeenCalled();
		}
	);
	it.each([false, true])(
		'holds standalone cancellation diagnostics until return or throw (fail=%s)',
		async (fail) => {
			let active = 0;
			const admit = gate.beginGlobalWorktreeActivity;
			vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
				const release = admit();
				active++;
				return () => {
					active--;
					release();
				};
			});
			let during: number | undefined;
			vi.mocked(logger.info).mockImplementationOnce(() => {
				during = active;
				if (fail) throw new Error('cancel diagnostics');
			});
			if (fail) expect(() => grooming.cancelAllGroomingSessions()).toThrow('cancel diagnostics');
			else expect(grooming.cancelAllGroomingSessions()).toBeUndefined();
			expect(during).toBe(1);
			expect(active).toBe(0);
			await reserve();
		}
	);
	it('holds detection and collection even when native close precedes the result', async () => {
		const detection = Promise.withResolvers<AgentConfig>();
		detector.getAgent.mockReturnValueOnce(detection.promise);
		const pending = request();
		await blocked();
		expect(manager.spawn).not.toHaveBeenCalled();
		detection.resolve(agent);
		await drain();
		children[0].emit('close');
		await blocked();
		finish();
		await expect(pending).resolves.toMatchObject({
			response: 'collected response',
			completionReason: 'process exited with code 0',
		});
		await reserve();
	});
	it.each(['error', 'exit', 'result'] as const)(
		'keeps native ownership after early %s',
		async (event) => {
			const pending = request();
			await drain();
			if (event === 'error') children[0].emit('error', new Error('native failure'));
			if (event === 'exit') children[0].emit('exit', 0);
			finish();
			await pending;
			await blocked();
			children[0].emit('close');
			await reserve();
		}
	);
	it('keeps concurrent preparations independently admitted', async () => {
		const detection = Promise.withResolvers<AgentConfig>();
		detector.getAgent.mockReturnValueOnce(detection.promise);
		const first = request();
		const second = request();
		await drain();
		finish();
		children[0].emit('close');
		await second;
		await blocked();
		detection.resolve(agent);
		await drain();
		finish(1);
		children[1].emit('close');
		await first;
		await reserve();
	});
	it.each(['detection', 'args', 'logging'] as const)(
		'releases on pre-native %s failure',
		async (stage) => {
			const error = new Error(stage);
			if (stage === 'detection') detector.getAgent.mockRejectedValueOnce(error);
			if (stage === 'args')
				vi.mocked(buildAgentArgs).mockImplementationOnce(() => {
					throw error;
				});
			if (stage === 'logging')
				vi.mocked(logger.info).mockImplementationOnce(() => {
					throw error;
				});
			await expect(request()).rejects.toBe(error);
			expect(manager.spawn).not.toHaveBeenCalled();
			await reserve();
		}
	);
	it('holds one admission across effort failure, retry diagnostics and pending second setup', async () => {
		const retry = Promise.withResolvers<AgentConfig>();
		detector.getAgent.mockResolvedValueOnce(agent).mockReturnValueOnce(retry.promise);
		let reporting: ReturnType<typeof gate.reserveWorktreeCleanup> | undefined;
		vi.mocked(logger.warn).mockImplementationOnce(() => {
			reporting = gate.reserveWorktreeCleanup(target);
		});
		const pending = request({ sessionCustomEffort: 'low' });
		await drain();
		children[0].emit('close');
		bus.emit('agent-error', id(), {
			message: 'Model "auto" does not support reasoning effort configuration (requested: "low").',
		});
		await drain();
		await expect(reporting).resolves.toMatchObject({ status: 'blocked' });
		await blocked();
		retry.resolve(agent);
		await drain();
		expect(detector.getAgent).toHaveBeenCalledTimes(2);
		finish(1);
		children[1].emit('close');
		await pending;
		await reserve();
	});
	it.each(['cancel', 'timeout', 'agent-error'] as const)(
		'settles %s without releasing the native child',
		async (reason) => {
			const pending = request({ timeoutMs: 100 });
			const rejected = expect(pending).rejects.toThrow(/cancelled|timed out|Grooming error/);
			await drain();
			if (reason === 'cancel') grooming.cancelAllGroomingSessions();
			if (reason === 'timeout') await vi.advanceTimersByTimeAsync(100);
			if (reason === 'agent-error')
				bus.emit('agent-error', id(), { message: 'failure', type: 'auth' });
			await rejected;
			await blocked();
			if (reason !== 'agent-error') expect(manager.kill).toHaveBeenCalledWith(id());
			expect(grooming.getActiveGroomingSessionCount()).toBe(0);
			children[0].emit('close');
			await reserve();
		}
	);
	it.each(['retry', 'report'] as const)(
		'releases after effort fallback %s failure',
		async (stage) => {
			const error = new Error(stage);
			if (stage === 'retry')
				detector.getAgent.mockResolvedValueOnce(agent).mockRejectedValueOnce(error);
			else
				vi.mocked(logger.warn).mockImplementationOnce(() => {
					throw error;
				});
			const pending = request({ sessionCustomEffort: 'low' });
			const rejected = expect(pending).rejects.toBe(error);
			await drain();
			children[0].emit('close');
			bus.emit('agent-error', id(), {
				message: 'Model "auto" does not support reasoning effort configuration (requested: "low").',
			});
			await rejected;
			expect(detector.getAgent).toHaveBeenCalledTimes(stage === 'retry' ? 2 : 1);
			await reserve();
		}
	);
	it('preserves a failed spawn result and releases only the outer request', async () => {
		manager.spawn.mockReturnValueOnce(null);
		await expect(request()).rejects.toThrow('Failed to spawn grooming process for codex');
		expect(spawn).not.toHaveBeenCalled();
		expect(grooming.getActiveGroomingSessionCount()).toBe(0);
		await reserve();
	});
	it.each(['idle', 'overall'] as const)(
		'keeps native ownership after %s timeout with content',
		async (reason) => {
			const pending = request({ timeoutMs: reason === 'idle' ? 30_000 : 100 });
			await drain();
			bus.emit('data', id(), 'x'.repeat(120));
			await vi.advanceTimersByTimeAsync(reason === 'idle' ? 6000 : 100);
			await expect(pending).resolves.toMatchObject({
				completionReason:
					reason === 'idle' ? 'idle timeout with content' : 'overall timeout with content',
			});
			await blocked();
			children[0].emit('close');
			await reserve();
		}
	);
	it('retains the request after progress reporting throws', async () => {
		const error = new Error('progress reporting');
		const pending = request({
			onProgress: () => {
				throw error;
			},
		});
		await drain();
		expect(() => bus.emit('data', id(), 'partial')).toThrow(error);
		children[0].emit('close');
		await blocked();
		bus.emit('exit', id(), 0);
		await expect(pending).resolves.toMatchObject({ response: 'partial' });
		await reserve();
	});
	it.each([false, true])(
		'holds pending SSH preparation and preserves remote routing (reject=%s)',
		async (fail) => {
			const wrapping = Promise.withResolvers<Awaited<ReturnType<typeof wrapSpawnWithSsh>>>();
			vi.mocked(wrapSpawnWithSsh).mockReturnValueOnce(wrapping.promise);
			const pending = request({
				projectRoot: '~/remote-only',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote' },
				sshStore: { getSshRemotes: () => [] },
			});
			const outcome = fail ? expect(pending).rejects.toThrow('SSH setup') : undefined;
			await drain();
			await blocked();
			expect(manager.spawn).not.toHaveBeenCalled();
			expect(vi.mocked(fs.realpath).mock.calls).toEqual([[target]]);
			if (fail) {
				wrapping.reject(new Error('SSH setup'));
				await outcome;
			} else {
				wrapping.resolve({
					command: 'ssh',
					args: ['remote'],
					cwd: '/local',
					prompt: undefined,
					customEnvVars: { KEPT: 'yes' },
					sshStdinScript: 'remote-script',
					sshRemoteCommand: 'codex',
					sshRemoteUsed: {
						id: 'remote',
						host: 'example.invalid',
						name: 'Remote',
						port: 22,
						username: 'worker',
						privateKeyPath: '',
						enabled: true,
					},
				});
				await drain();
				expect(manager.spawn).toHaveBeenCalledWith(
					expect.objectContaining({
						command: 'ssh',
						cwd: '/local',
						sshStdinScript: 'remote-script',
						customEnvVars: { KEPT: 'yes' },
					})
				);
				finish();
				children[0].emit('close');
				await pending;
			}
			await reserve();
		}
	);
});
