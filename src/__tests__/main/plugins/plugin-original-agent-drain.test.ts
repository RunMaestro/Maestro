import {
	HEADLESS_RUN_TIMEOUT_MS,
	HEADLESS_IDLE_PROFILE,
} from '../../../shared/plugins/headless-agent-timeouts';
// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as settleHostIo } from 'node:timers/promises';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnAgent } from '../../../cli/services/agent-spawner';
import { createPluginHeadlessAgentRunner } from '../../../main/plugins/plugin-headless-agent-runner';
import { PluginMediaTools, MediaError } from '../../../main/plugins/plugin-media-tools';
import { hasHeadlessAgentActivity } from '../../../main/utils/headless-agent-activity';
import type { SessionInfo } from '../../../shared/types';

const native = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
	...(await original<typeof import('node:child_process')>()),
	spawn: native.spawn,
	execFile: native.execFile,
}));
vi.mock('../../../cli/services/storage', () => ({
	getAgentCustomPath: () => undefined,
	readAgentConfig: () => ({}),
	readSshRemotes: () => [],
}));
vi.mock('../../../cli/services/wakatime', () => ({ buildCliWakaTimeHeartbeat: () => undefined }));

vi.mock('../../../shared/maestro-lib/launch/path-prober', async (original) => ({
	...(await original<typeof import('../../../shared/maestro-lib/launch/path-prober')>()),
	checkBinaryExists: async () => ({ exists: true, path: '/fixture/provider' }),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

describe('original audio through the production spawner and supervisor', () => {
	let root: string;
	let child: ChildProcess;
	let tools: PluginMediaTools;
	let allowed: boolean;
	const original = Buffer.from([79, 103, 103, 83, 255]);

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-original-drain-'));
		allowed = true;
		vi.useFakeTimers();
		child = Object.assign(new EventEmitter(), {
			pid: undefined, // Do not let the stop ladder inspect any real process tree.
			exitCode: null,
			signalCode: null,
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(() => true), // A successful request deliberately does not prove exit.
		}) as unknown as ChildProcess;
		native.spawn.mockReturnValue(child);
		native.execFile.mockImplementation((_binary, _args, _options, callback) => {
			queueMicrotask(() =>
				callback(
					null,
					JSON.stringify({
						format: { format_name: 'ogg', duration: '1' },
						streams: [
							{ codec_type: 'audio', codec_name: 'opus', sample_rate: '48000', channels: 1 },
						],
					})
				)
			);
			return { kill: vi.fn() };
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(original))
		);
		tools = new PluginMediaTools({
			tempDir: root,
			egressGuard: { assertUrlAllowed: async () => {}, lookup: vi.fn() as never, dispatcher: {} },
			authorize: () => {
				if (!allowed) throw new MediaError('MediaDenied');
			},
			resolveRuntime: async () => ({ binaries: { ffprobe: '/fixture/ffprobe' }, models: {} }),
		});
	});

	afterEach(async () => {
		child.emit('exit', null, 'SIGKILL');
		child.emit('close', null, 'SIGKILL');
		await tools.cleanupPlugin('p');
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	it.each(
		(['codex', 'claude-code'] as const).flatMap((type) =>
			(['accepted', 'close', 'revoke', 'silence', 'timeout'] as const).map((cause) => ({
				type,
				cause,
			}))
		)
	)(
		'keeps $type files and resource slots until observed termination on $cause',
		async ({ type, cause }) => {
			allowed = true;
			const { jobId } = (await tools.call('p', 'media.open', {})) as { jobId: string };
			const { audioId } = (await tools.call('p', 'media.download', {
				jobId,
				url: 'https://cdn.discordapp.com/attachments/1/2/fixture.ogg',
			})) as { audioId: string };
			const runner = createPluginHeadlessAgentRunner({
				getAgent: () => ({ id: 'fixture-agent', toolType: type, cwd: root }) as SessionInfo,
				getAgentConfig: () => ({}),
				detectAgent: async () => ({ available: true, path: '/fixture/provider' }),
				hasPluginTools: () => false,
				spawn: spawnAgent,
				prepareSystemPrompt: async () => undefined,
				issueRunToken: vi.fn(),
				revokeRunToken: vi.fn(),
				cliScriptPath: () => '/fixture/cli',
				audit: vi.fn(),
			});
			let settled = false;
			const send = tools
				.forwardOriginal(
					'p',
					{ jobId, audioId },
					() => {
						if (!allowed) throw new MediaError('MediaDenied');
					},
					(lease) =>
						runner(
							'fixture-agent',
							'Read original',
							undefined,
							lease.signal,
							'relay',
							undefined,
							undefined,
							false,
							false,
							{ originalAttachment: lease }
						)
				)
				.then(
					(value) => {
						settled = true;
						return value;
					},
					(error) => {
						settled = true;
						return error;
					}
				);
			let close: Promise<unknown> | undefined;
			try {
				await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledOnce());
				const prompt = (native.spawn.mock.calls[0][1] as string[]).join('\n');
				const receipt = JSON.parse(
					prompt
						.split('[Host original audio attachment - staging receipt only]\n')[1]
						.split('\n')[0]
				);
				expect(await fs.readFile(receipt.path)).toEqual(original);
				expect(receipt.bytes).toBe(original.length);
				if (cause === 'accepted') {
					child.stdout?.emit(
						'data',
						JSON.stringify(
							type === 'codex'
								? {
										type: 'item.completed',
										item: { type: 'agent_message', phase: 'final', text: 'read fixture' },
									}
								: { type: 'result', result: 'read fixture' }
						) + '\n'
					);
					child.emit('close', 0, null);
					expect(await send).toMatchObject({
						success: true,
						response: 'read fixture',
						originalAttachments: [{ bytes: original.length }],
					});
					await expect(fs.stat(receipt.path)).rejects.toMatchObject({ code: 'ENOENT' });
					return;
				}
				if (cause === 'close') close = tools.call('p', 'media.close', { jobId });
				if (cause === 'revoke') {
					allowed = false;
					await vi.advanceTimersByTimeAsync(250);
				}
				if (cause === 'silence' || cause === 'timeout') {
					// Fresh normalized model work clears startup supervision; replayed
					// transport output would not keep an actual provider turn alive.
					const steps = cause === 'timeout' ? HEADLESS_RUN_TIMEOUT_MS / (5 * 60_000) : 1;
					for (let step = 0; step < steps; step++) {
						child.stdout?.emit(
							'data',
							JSON.stringify(
								type === 'codex'
									? {
											type: 'item.completed',
											item: { type: 'agent_message', phase: 'commentary', text: `work ${step}` },
										}
									: { type: 'result', result: `work ${step}` }
							) + '\n'
						);
						await vi.advanceTimersByTimeAsync(
							cause === 'timeout' ? 5 * 60_000 : HEADLESS_IDLE_PROFILE.idleMs
						);
						if (cause === 'timeout' && step < steps - 1) {
							expect(child.kill).not.toHaveBeenCalled();
							expect(settled).toBe(false);
						}
					}
				}
				await vi.advanceTimersByTimeAsync(10_000);
				// File deletion is real asynchronous I/O, not a fake-timer microtask.
				// Let an incorrect early cleanup finish before checking retention.
				await settleHostIo(50);
				expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
				expect(child.exitCode).toBeNull();
				expect(child.signalCode).toBeNull();
				expect(settled).toBe(false);
				expect(await fs.readFile(receipt.path)).toEqual(original);
				expect((await fs.readdir(root)).filter((n) => n.startsWith('maestro-media-'))).toHaveLength(
					1
				);
				// Live authorization can recover, but the unresolved job still owns its slot.
				allowed = true;
				const spare = (await tools.call('p', 'media.open', {})) as { jobId: string };
				await expect(tools.call('p', 'media.open', {})).rejects.toMatchObject({
					code: 'MediaBusy',
				});
				await tools.call('p', 'media.close', spare);
				child.emit('exit', null, 'SIGKILL');
				const answer = await send;
				if (cause === 'timeout' || cause === 'silence')
					expect(answer).toMatchObject({
						success: false,
						error: expect.stringContaining(
							cause === 'timeout' ? 'absolute runtime ceiling' : 'semantic inactivity'
						),
					});
				else
					expect(answer).toMatchObject({
						code: cause === 'revoke' ? 'MediaDenied' : 'MediaCancelled',
					});
				await close;
				await expect(fs.stat(receipt.path)).rejects.toMatchObject({ code: 'ENOENT' });
				expect(hasHeadlessAgentActivity('fixture-agent')).toBe(false);
				const recovered = (await tools.call('p', 'media.open', {})) as { jobId: string };
				await tools.call('p', 'media.close', recovered);
			} finally {
				child.emit('exit', null, 'SIGKILL');
				child.emit('close', null, 'SIGKILL');
				await send;
				await close;
				native.spawn.mockClear();
				child.removeAllListeners();
			}
		}
	);

	it('denies export before any production spawn and releases the downloaded job on close', async () => {
		const { jobId } = (await tools.call('p', 'media.open', {})) as { jobId: string };
		const { audioId } = (await tools.call('p', 'media.download', {
			jobId,
			url: 'https://cdn.discordapp.com/attachments/1/2/fixture.ogg',
		})) as { audioId: string };
		await expect(
			tools.forwardOriginal(
				'p',
				{ jobId, audioId },
				() => {
					throw new MediaError('MediaDenied');
				},
				vi.fn()
			)
		).rejects.toMatchObject({ code: 'MediaDenied' });
		expect(native.spawn).not.toHaveBeenCalled();
		expect((await fs.readdir(root)).some((n) => n.startsWith('.maestro-audio-'))).toBe(false);
		await tools.call('p', 'media.close', { jobId });
		expect(await fs.readdir(root)).toEqual([]);
	});
});
