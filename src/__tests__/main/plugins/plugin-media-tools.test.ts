import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PluginMediaTools, resolveMediaRuntime } from '../../../main/plugins/plugin-media-tools';
import { MEDIA_LIMITS } from '../../../shared/plugins/media-tools';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import { parsePermissions } from '../../../shared/plugins/permissions';
import type { PermissionGrant } from '../../../shared/plugins/permissions';

const native = vi.hoisted(() => ({ execFile: vi.fn(), paths: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: native.execFile }));
vi.mock('../../../main/agents/path-prober', () => ({ findAllBinaryPaths: native.paths }));

const url = 'https://cdn.discordapp.com/attachments/123/456/voice.ogg?ex=SIGNED';
let root: string;
let tools: PluginMediaTools;
let grant: boolean;
let children: { kill: ReturnType<typeof vi.fn> }[];
let hold: boolean;
let probeDuration: number;
let probeCodec: string;
let whisperJson: string;
let diagnostics: Error | null;
let grants: PermissionGrant[];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-media-test-'));
	grant = true;
	hold = false;
	probeDuration = 1;
	probeCodec = 'opus';
	whisperJson = JSON.stringify({
		model: { multilingual: true },
		params: { language: 'de', translate: false },
		result: { language: 'de' },
		transcription: [{ text: 'Guten Tag.' }],
	});
	diagnostics = null;
	children = [];
	grants = [{ capability: 'media:tools', scope: 'discord-voice', grantedAt: 1 }];
	const broker = new PermissionBroker({ getGrants: () => grants });
	tools = new PluginMediaTools({
		tempDir: root,
		egressGuard: {
			assertUrlAllowed: vi.fn(async () => {}),
			lookup: vi.fn() as never,
			dispatcher: {},
		},
		authorize: (id) => {
			if (!grant || !broker.authorize(id, 'media.open', {}).allowed)
				throw new Error('denied secret');
		},
		resolveRuntime: async () => ({
			binaries: {
				ffprobe: '/approved/ffprobe',
				ffmpeg: '/approved/ffmpeg',
				'whisper-cli': '/approved/whisper-cli',
			},
			models: { base: '/approved/models/ggml-base.bin' },
		}),
	});
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(new Uint8Array([79, 103, 103, 83, 255]), { status: 200 }))
	);
	native.execFile.mockImplementation(
		(
			binary: string,
			args: string[],
			_opts: unknown,
			callback: (error: Error | null, stdout: string) => void
		) => {
			const child = {
				stdin: { end: vi.fn() },
				kill: vi.fn(() => {
					queueMicrotask(() => callback(new Error('raw secret killed'), ''));
					return true;
				}),
			};
			children.push(child);
			if (hold) return child;
			void (async () => {
				await Promise.resolve();
				if (binary.endsWith('ffmpeg')) await fs.writeFile(args.at(-1)!, Buffer.alloc(100));
				if (binary.endsWith('whisper-cli'))
					await fs.writeFile(args[args.indexOf('-of') + 1] + '.json', whisperJson);
				const wav = args.includes('wav');
				const stdout = binary.endsWith('ffprobe')
					? JSON.stringify({
							format: { format_name: wav ? 'wav' : 'ogg', duration: String(probeDuration) },
							streams: [
								{
									codec_type: 'audio',
									codec_name: wav ? 'pcm_s16le' : probeCodec,
									sample_rate: wav ? '16000' : '48000',
									channels: wav ? 1 : 2,
								},
							],
						})
					: '';
				callback(diagnostics, stdout);
			})();
			return child;
		}
	);
});
afterEach(async () => {
	tools.cleanupPlugin('p');
	tools.cleanupPlugin('other');
	await fs.rm(root, { recursive: true, force: true });
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

async function open(): Promise<string> {
	return ((await tools.call('p', 'media.open', {})) as { jobId: string }).jobId;
}
async function download(jobId: string): Promise<string> {
	return ((await tools.call('p', 'media.download', { jobId, url })) as { audioId: string }).audioId;
}

describe('media tools boundary', () => {
	it('requires an exact grant, rejects broad/network/spawn substitutes, and supports release after revoke', async () => {
		for (const caps of [
			[],
			[{ capability: 'media:tools', grantedAt: 1 }],
			[{ capability: 'media:tools', scope: '*', grantedAt: 1 }],
			[{ capability: 'net:fetch', grantedAt: 1 }],
			[{ capability: 'process:spawn', scope: 'ffmpeg', grantedAt: 1 }],
		] as PermissionGrant[][]) {
			grants = caps;
			await expect(tools.call('p', 'media.open', {})).rejects.toMatchObject({
				code: 'MediaDenied',
			});
		}
		expect(parsePermissions([{ capability: 'media:tools' }]).errors).toHaveLength(1);
		const broker = new PermissionBroker({ getGrants: () => [] });
		expect(broker.authorize('p', 'media.close', { jobId: 'opaque' }).allowed).toBe(true);
		grants = [{ capability: 'media:tools', scope: 'discord-voice', grantedAt: 1 }];
		const jobId = await open();
		await download(jobId);
		grant = false;
		await tools.call('p', 'media.close', { jobId });
		expect(await fs.readdir(root)).toEqual([]);
	});

	it('reserves without I/O, caps jobs, and binds job ownership', async () => {
		const jobId = await open();
		expect(await fs.readdir(root)).toEqual([]);
		await open();
		await expect(open()).rejects.toMatchObject({ code: 'MediaBusy' });
		await expect(tools.call('other', 'media.download', { jobId, url })).rejects.toMatchObject({
			code: 'MediaInvalid',
		});
		await tools.call('other', 'media.close', { jobId });
		await download(jobId);
	});

	it('keeps binary bytes on the host and pins a credential-free GET', async () => {
		const jobId = await open();
		const audioId = await download(jobId);
		const dirs = await fs.readdir(root);
		expect(await fs.readFile(path.join(root, dirs[0], 'source.ogg'))).toEqual(
			Buffer.from([79, 103, 103, 83, 255])
		);
		expect(audioId).not.toContain('/');
		expect(fetch).toHaveBeenCalledWith(
			url,
			expect.objectContaining({
				method: 'GET',
				credentials: 'omit',
				redirect: 'error',
				dispatcher: {},
				signal: expect.any(AbortSignal),
			})
		);
		expect((vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers).toBeUndefined();
		await tools.call('p', 'media.close', { jobId });
		await tools.call('p', 'media.close', { jobId });
		expect(await fs.readdir(root)).toEqual([]);
	});

	it.each([
		'http://cdn.discordapp.com/attachments/1/2/a.ogg',
		'https://cdn.discordapp.com.evil.test/attachments/1/2/a.ogg',
		'https://cdn.discordapp.com:443/attachments/1/2/a.ogg',
		'https://token@cdn.discordapp.com/attachments/1/2/a.ogg',
		'https://cdn.discordapp.com/attachments/1/2/%2e%2e',
		'https://cdn.discordapp.com/attachments/1/2/%2fsecret',
		'https://media.discordapp.net/other/1/2/a.ogg',
		'https://127.0.0.1/attachments/1/2/a.ogg',
	])('rejects non-attachment URL without leaking it: %s', async (badUrl) => {
		const jobId = await open();
		await expect(tools.call('p', 'media.download', { jobId, url: badUrl })).rejects.toMatchObject({
			code: 'MediaInvalid',
			message: 'MediaInvalid',
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(await fs.readdir(root)).toEqual([]);
	});

	it('rejects redirects and oversized declared/actual streams with cleanup', async () => {
		for (const response of [
			new Response(null, { status: 302 }),
			new Response('x', {
				headers: { 'content-length': String(MEDIA_LIMITS.maxDownloadBytes + 1) },
			}),
			new Response(new Uint8Array(MEDIA_LIMITS.maxDownloadBytes + 1)),
		]) {
			vi.mocked(fetch).mockResolvedValueOnce(response);
			const jobId = await open();
			await expect(download(jobId)).rejects.toThrow(/^Media/);
			expect(await fs.readdir(root)).toEqual([]);
		}
	});

	it('fails closed when egress pinning or host authorization is absent', async () => {
		const denied = new PluginMediaTools({
			tempDir: root,
			authorize: () => {},
			egressGuard: { assertUrlAllowed: async () => {}, lookup: vi.fn() as never },
		});
		const { jobId } = (await denied.call('p', 'media.open', {})) as { jobId: string };
		await expect(denied.call('p', 'media.download', { jobId, url })).rejects.toMatchObject({
			code: 'MediaDenied',
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('runs only fixed profiles with host paths, no shell or inherited credentials', async () => {
		const jobId = await open();
		const audioId = await download(jobId);
		expect(await tools.call('p', 'media.probe', { jobId, audioId })).toMatchObject({
			container: 'ogg',
			durationSeconds: 1,
			streams: [{ codec: 'opus', type: 'audio' }],
		});
		const pcm = (await tools.call('p', 'media.decode', { jobId, audioId })) as {
			audioId: string;
			durationSeconds: number;
		};
		expect(pcm.durationSeconds).toBe(1);
		expect(await tools.call('p', 'media.probe', { jobId, audioId: pcm.audioId })).toMatchObject({
			container: 'wav',
			streams: [{ sampleRate: 16000, channels: 1, codec: 'pcm_s16le' }],
		});
		expect(
			await tools.call('p', 'media.run', {
				jobId,
				audioId: pcm.audioId,
				options: { profile: 'whisper-cli', model: 'base' },
			})
		).toEqual({ json: whisperJson });
		const call = native.execFile.mock.calls.at(-1)!;
		expect(call[0]).toBe('/approved/whisper-cli');
		expect(call[1]).toContain('de');
		expect(call[1]).not.toContain('-tr');
		expect(call[2]).toMatchObject({
			env: {},
			shell: false,
			killSignal: 'SIGKILL',
			maxBuffer: 16 * 1024,
		});
		await tools.call('p', 'media.close', { jobId });
		expect(await fs.readdir(root)).toEqual([]);
	});

	it.each([121, 120.0001, Infinity])(
		'refuses actual duration %s before decode',
		async (duration) => {
			const jobId = await open();
			const audioId = await download(jobId);
			probeDuration = duration;
			await expect(tools.call('p', 'media.decode', { jobId, audioId })).rejects.toThrow(
				duration === Infinity ? 'MediaInvalid' : 'MediaTooLong'
			);
			expect(native.execFile.mock.calls.every((c) => c[0].endsWith('ffprobe'))).toBe(true);
		}
	);

	it('requires Opus and rejects foreign handles/free arguments/English-only models', async () => {
		const jobId = await open();
		const audioId = await download(jobId);
		await expect(
			tools.call('p', 'media.probe', { jobId, audioId, argv: ['secret'] })
		).rejects.toMatchObject({ code: 'MediaInvalid' });
		probeCodec = 'vorbis';
		await expect(tools.call('p', 'media.decode', { jobId, audioId })).rejects.toMatchObject({
			code: 'MediaInvalid',
		});
		const next = await open();
		await expect(tools.call('p', 'media.probe', { jobId: next, audioId })).rejects.toMatchObject({
			code: 'MediaInvalid',
		});
		for (const options of [
			{ profile: 'bash', model: 'base' },
			{ profile: 'whisper-cli', model: 'base.en' },
			{ profile: 'whisper-cli', model: '../../secret' },
			{ profile: 'whisper-cli', model: 'base', args: [] },
			{ profile: 'whisper-cli', model: 'base', language: '--help' },
		]) {
			const j = await open();
			const a = await download(j);
			probeCodec = 'opus';
			const pcm = (await tools.call('p', 'media.decode', { jobId: j, audioId: a })) as {
				audioId: string;
			};
			await expect(
				tools.call('p', 'media.run', { jobId: j, audioId: pcm.audioId, options })
			).rejects.toMatchObject({ code: 'MediaInvalid' });
		}
	});

	it('bounds raw JSON and sanitizes process/network errors', async () => {
		const jobId = await open();
		const audioId = await download(jobId);
		const pcm = (await tools.call('p', 'media.decode', { jobId, audioId })) as { audioId: string };
		whisperJson = 'x'.repeat(MEDIA_LIMITS.maxResultBytes + 1);
		await expect(
			tools.call('p', 'media.run', {
				jobId,
				audioId: pcm.audioId,
				options: { profile: 'whisper-cli', model: 'base' },
			})
		).rejects.toMatchObject({ code: 'MediaOutputTooLarge' });
		const j = await open();
		const a = await download(j);
		diagnostics = new Error('signed URL TOKEN /private/model audio-data');
		await expect(tools.call('p', 'media.probe', { jobId: j, audioId: a })).rejects.toMatchObject({
			message: 'MediaProcessFailed',
			code: 'MediaProcessFailed',
		});
		vi.mocked(fetch).mockRejectedValueOnce(diagnostics);
		await expect(download(await open())).rejects.toMatchObject({ message: 'MediaProcessFailed' });
	});

	it('kills pending native work, settles it, then confirms cleanup on close', async () => {
		const jobId = await open();
		const audioId = await download(jobId);
		hold = true;
		const pending = tools.call('p', 'media.probe', { jobId, audioId });
		const result = expect(pending).rejects.toMatchObject({ code: 'MediaCancelled' });
		await vi.waitFor(() => expect(children).toHaveLength(1));
		await expect(tools.call('p', 'media.probe', { jobId, audioId })).rejects.toMatchObject({
			code: 'MediaBusy',
		});
		await tools.call('p', 'media.close', { jobId });
		await result;
		expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
		expect(await fs.readdir(root)).toEqual([]);
	});

	it('enforces the whole-job deadline on a stalled body and reclaims its slot', async () => {
		vi.useFakeTimers();
		vi.mocked(fetch).mockImplementationOnce(
			(_url, init) =>
				new Promise((_resolve, reject) =>
					init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))
				)
		);
		const jobId = await open();
		const pending = download(jobId);
		const outcome = expect(pending).rejects.toMatchObject({ code: 'MediaTimeout' });
		// Let asynchronous directory creation reach the fetch before moving the job clock.
		await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
		await vi.advanceTimersByTimeAsync(MEDIA_LIMITS.jobTimeoutMs);
		await outcome;
		expect(await fs.readdir(root)).toEqual([]);
		await open();
	});

	it('revocation and teardown abort work without allowing a late success', async () => {
		const jobId = await open();
		const audioId = await download(jobId);
		hold = true;
		const pending = tools.call('p', 'media.probe', { jobId, audioId });
		const outcome = expect(pending).rejects.toMatchObject({ code: 'MediaDenied' });
		await vi.waitFor(() => expect(children).toHaveLength(1));
		grant = false;
		await outcome;
		expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
		expect(await fs.readdir(root)).toEqual([]);
	});

	it('settles cancellation during non-abortable discovery without a late process spawn', async () => {
		const gate = Promise.withResolvers<void>();
		const delayed = new PluginMediaTools({
			tempDir: root,
			authorize: () => {},
			egressGuard: {
				assertUrlAllowed: () => gate.promise,
				dispatcher: {},
				lookup: vi.fn() as never,
			},
		});
		const { jobId } = (await delayed.call('p', 'media.open', {})) as { jobId: string };
		const pending = delayed.call('p', 'media.download', { jobId, url });
		const outcome = expect(pending).rejects.toMatchObject({ code: 'MediaCancelled' });
		await vi.waitFor(async () => expect(await fs.readdir(root)).toHaveLength(1));
		await delayed.call('p', 'media.close', { jobId });
		await outcome;
		gate.resolve();
		expect(fetch).not.toHaveBeenCalled();
		expect(await fs.readdir(root)).toEqual([]);
	});

	it('aborts a stalled response body under the same total deadline', async () => {
		vi.useFakeTimers();
		vi.mocked(fetch).mockImplementationOnce(
			async (_url, init) =>
				new Response(
					new ReadableStream({
						start(controller) {
							init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason));
						},
					})
				)
		);
		const jobId = await open();
		const pending = download(jobId);
		const outcome = expect(pending).rejects.toMatchObject({ code: 'MediaTimeout' });
		await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
		await vi.advanceTimersByTimeAsync(MEDIA_LIMITS.jobTimeoutMs);
		await outcome;
		expect(await fs.readdir(root)).toEqual([]);
	});

	it('caps all plugins together and tears down outstanding processes', async () => {
		const first = await open();
		await open();
		await tools.call('other', 'media.open', {});
		await tools.call('other', 'media.open', {});
		await expect(tools.call('third', 'media.open', {})).rejects.toMatchObject({
			code: 'MediaBusy',
		});
		const audioId = await download(first);
		hold = true;
		const pending = tools.call('p', 'media.probe', { jobId: first, audioId });
		const outcome = expect(pending).rejects.toMatchObject({ code: 'MediaCancelled' });
		await vi.waitFor(() => expect(children).toHaveLength(1));
		tools.cleanupPlugin('p');
		await outcome;
		expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
		expect(await fs.readdir(root)).toEqual([]);
	});

	it('reports only available model IDs and keeps path overrides host-only', async () => {
		const modelRoot = path.join(root, 'models');
		await fs.mkdir(modelRoot);
		await fs.writeFile(path.join(modelRoot, 'ggml-base.bin'), 'model');
		await fs.writeFile(path.join(root, 'private'), 'secret');
		await fs.symlink(path.join(root, 'private'), path.join(modelRoot, 'ggml-small.bin'));
		vi.stubEnv('MAESTRO_MEDIA_MODEL_DIR', modelRoot);
		vi.stubEnv('MAESTRO_MEDIA_FFMPEG', path.join(root, 'not-a-binary.cmd'));
		native.paths.mockResolvedValue([]);
		const runtime = await resolveMediaRuntime();
		expect(Object.keys(runtime.models)).toEqual(['base']);
		expect(runtime.binaries).toEqual({});
		expect(await tools.call('p', 'media.status', {})).toEqual({
			profiles: ['whisper-cli'],
			models: ['base'],
			missing: [],
		});
	});
});
