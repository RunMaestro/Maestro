/** Host media boundary: no STT routing, arbitrary argv, file reads, or raw binary RPC. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findAllBinaryPaths } from '../agents/path-prober';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { createIdleWatchdog, type IdleWatchdog } from '../utils/idle-watchdog';
import {
	MEDIA_LIMITS,
	MEDIA_MODEL_IDS,
	type MediaErrorCode,
	type MediaModelId,
	type MediaProbe,
	type MediaToolStatus,
} from '../../shared/plugins/media-tools';
import type { EgressGuard } from './net-egress-guard';

type Tool = 'ffprobe' | 'ffmpeg' | 'whisper-cli';
type Runtime = {
	binaries: Partial<Record<Tool, string>>;
	models: Partial<Record<MediaModelId, string>>;
};
interface Audio {
	file: string;
	kind: 'ogg' | 'wav';
	probe?: MediaProbe;
}
/** Host-only lease: bound to one invocation; never transfers owner handles. */
export interface MediaServiceLease {
	audioId: string;
	expiresAt: number;
	signal: AbortSignal;
	call(method: 'probe' | 'decode' | 'run', audioId: string): Promise<unknown>;
	close(): Promise<void>;
}
interface Job {
	id: string;
	pluginId: string;
	controller: AbortController;
	watchdog: IdleWatchdog;
	recheck: ReturnType<typeof setInterval>;
	dir?: string;
	audio: Map<string, Audio>;
	operation?: Promise<unknown>;
	closing?: Promise<void>;
	downloaded: boolean;
	decoded: boolean;
	ran: boolean;
	expiresAt: number;
	serviceLease?: { authorize: () => void };
}

/** Codes are the ONLY diagnostic surface: never pass through errors containing inputs. */
class MediaError extends Error {
	constructor(readonly code: MediaErrorCode) {
		super(code);
	}
}

export interface PluginMediaToolsDeps {
	egressGuard: EgressGuard;
	/** Re-checks live broker grant and signature. May throw; errors are sanitized here. */
	authorize: (pluginId: string) => void;
	/** Host-only seams for tests/integrators; never reachable through the SDK. */
	resolveRuntime?: () => Promise<Runtime>;
	tempDir?: string;
}

/** Canonical host setting validation shared by desktop IPC and CLI writes. */
export async function resolveMediaModelDirectory(value: unknown): Promise<string> {
	if (typeof value !== 'string') throw new Error('Invalid media model directory');
	if (value === '') return '';
	if (!path.isAbsolute(value)) throw new Error('Media model directory must be absolute');
	const canonical = await fs.realpath(value);
	if (!(await fs.stat(canonical)).isDirectory())
		throw new Error('Media model directory must be a directory');
	return canonical;
}

/** Resolve existing installations at call time. No binaries/models are downloaded or bundled. */
export async function resolveMediaRuntime(configuredDirectory?: unknown): Promise<Runtime> {
	const binaries: Runtime['binaries'] = {};
	for (const [tool, key] of [
		['ffprobe', 'MAESTRO_MEDIA_FFPROBE'],
		['ffmpeg', 'MAESTRO_MEDIA_FFMPEG'],
		['whisper-cli', 'MAESTRO_MEDIA_WHISPER_CLI'],
	] as const) {
		const override = process.env[key];
		const candidates = override ? [override] : await findAllBinaryPaths(tool);
		for (const candidate of candidates) {
			try {
				if (!path.isAbsolute(candidate) || /\.(?:bat|cmd|ps1|sh|js)$/i.test(candidate)) continue;
				const real = await fs.realpath(candidate);
				if (process.platform === 'win32' && !/\.exe$/i.test(real)) continue;
				if (!(await fs.stat(real)).isFile()) continue;
				await fs.access(real, constants.X_OK);
				binaries[tool] = real;
				break;
			} catch {
				/* unavailable */
			}
		}
	}
	const models: Runtime['models'] = {};
	// A non-empty host setting takes precedence. Invalid stored values fail closed.
	const directory =
		configuredDirectory === undefined || configuredDirectory === ''
			? process.env.MAESTRO_MEDIA_MODEL_DIR
			: configuredDirectory;
	if (typeof directory === 'string' && directory && path.isAbsolute(directory)) {
		try {
			const root = await fs.realpath(directory);
			for (const id of MEDIA_MODEL_IDS) {
				try {
					const real = await fs.realpath(path.join(root, `ggml-${id}.bin`));
					// A symlink cannot expose a file outside the host-approved model directory.
					if (path.dirname(real) !== root || !(await fs.stat(real)).isFile()) continue;
					await fs.access(real, constants.R_OK);
					models[id] = real;
				} catch {
					/* absent models are not installed */
				}
			}
		} catch {
			/* unavailable */
		}
	}
	return { binaries, models };
}

/** Shared by the broker and the host settings diagnostic. Never exposes filesystem paths. */
export function getMediaToolStatus(runtime: Runtime): MediaToolStatus {
	const models = MEDIA_MODEL_IDS.filter((id) => runtime.models[id]);
	const missing: MediaToolStatus['missing'] = (
		['ffprobe', 'ffmpeg', 'whisper-cli'] as const
	).filter((t) => !runtime.binaries[t]);
	if (models.length === 0) missing.push('model-directory');
	return { profiles: missing.length ? [] : ['whisper-cli'], models, missing };
}

export class PluginMediaTools {
	private readonly jobs = new Map<string, Job>();
	constructor(private readonly deps: PluginMediaToolsDeps) {}

	private authorize(pluginId: string): void {
		try {
			this.deps.authorize(pluginId);
		} catch {
			throw new MediaError('MediaDenied');
		}
	}

	/** Strict param validation lives at this boundary as well as the public broker gate. */
	async call(pluginId: string, method: string, raw: unknown): Promise<unknown> {
		try {
			if (method !== 'media.close') this.authorize(pluginId);
			if (!raw || typeof raw !== 'object' || Array.isArray(raw))
				throw new MediaError('MediaInvalid');
			const p = raw as Record<string, unknown>;
			const schemas: Record<string, readonly string[]> = {
				'media.status': [],
				'media.open': [],
				'media.close': ['jobId'],
				'media.download': ['jobId', 'url'],
				'media.probe': ['jobId', 'audioId'],
				'media.decode': ['jobId', 'audioId'],
				'media.run': ['jobId', 'audioId', 'options'],
			};
			const keys = schemas[method];
			if (!keys || Object.keys(p).some((k) => !keys.includes(k)))
				throw new MediaError('MediaInvalid');
			if (method === 'media.status') {
				const status = await this.status();
				this.authorize(pluginId);
				return status;
			}
			if (method === 'media.open') return this.open(pluginId);
			if (typeof p.jobId !== 'string' || p.jobId.length > 64) throw new MediaError('MediaInvalid');
			const job = this.jobs.get(p.jobId);
			// Close reveals no ownership/existence and never touches a different plugin's job.
			if (method === 'media.close') {
				if (job?.pluginId === pluginId) await this.close(job, 'MediaCancelled');
				return;
			}
			if (!job || job.pluginId !== pluginId || job.controller.signal.aborted)
				throw new MediaError('MediaInvalid');
			if (job.operation || job.serviceLease) throw new MediaError('MediaBusy');
			const operation = this.execute(job, method, p);
			job.operation = operation;
			try {
				const result = await operation;
				this.check(job);
				return result;
			} catch (error) {
				// Kill/abort before returning a failure. Finish cleanup after the operation settles.
				job.operation = undefined;
				const code = job.controller.signal.aborted ? job.controller.signal.reason : error;
				await this.close(job, code instanceof MediaError ? code.code : 'MediaProcessFailed');
				throw code;
			} finally {
				job.operation = undefined;
			}
		} catch (error) {
			throw error instanceof MediaError ? error : new MediaError('MediaProcessFailed');
		}
	}

	private async status(): Promise<MediaToolStatus> {
		const runtime = await (this.deps.resolveRuntime ?? resolveMediaRuntime)();
		return getMediaToolStatus(runtime);
	}

	private open(pluginId: string): { jobId: string } {
		if (
			this.jobs.size >= MEDIA_LIMITS.maxJobs ||
			[...this.jobs.values()].filter((j) => j.pluginId === pluginId).length >=
				MEDIA_LIMITS.maxJobsPerPlugin
		)
			throw new MediaError('MediaBusy');
		const id = randomUUID();
		const controller = new AbortController();
		const job: Job = {
			id,
			pluginId,
			controller,
			audio: new Map(),
			downloaded: false,
			decoded: false,
			ran: false,
			expiresAt: Date.now() + MEDIA_LIMITS.jobTimeoutMs,
			watchdog: createIdleWatchdog({
				idleMs: MEDIA_LIMITS.jobTimeoutMs,
				maxMs: MEDIA_LIMITS.jobTimeoutMs,
				onIdle: () => {
					void this.close(job, 'MediaTimeout').catch(() => {});
				},
			}),
			recheck: setInterval(() => {
				try {
					this.authorize(pluginId);
				} catch {
					void this.close(job, 'MediaDenied').catch(() => {});
				}
			}, 250),
		};
		job.recheck.unref();
		this.jobs.set(id, job);
		return { jobId: id };
	}

	private check(job: Job): void {
		if (job.controller.signal.aborted) throw job.controller.signal.reason;
		this.authorize(job.pluginId);
		job.serviceLease?.authorize();
	}

	/** Only the host service broker can mint this lease, after BOTH parties' consent. */
	delegate(
		owner: string,
		jobId: string,
		audioId: string,
		options: { model: MediaModelId; language: string },
		authorize: () => void
	): MediaServiceLease {
		this.authorize(owner);
		authorize();
		const job = this.jobs.get(jobId);
		if (!job || job.pluginId !== owner || !job.audio.has(audioId) || job.controller.signal.aborted)
			throw new MediaError('MediaInvalid');
		if (job.operation || job.serviceLease || job.ran) throw new MediaError('MediaBusy');
		// Capture only the approved run fields; owner handles never become run options.
		const { model, language } = options;
		const aliases = new Map<string, string>([[randomUUID(), audioId]]);
		job.serviceLease = { authorize };
		this.check(job);
		return {
			audioId: aliases.keys().next().value!,
			expiresAt: job.expiresAt,
			signal: job.controller.signal,
			call: async (method, alias) => {
				this.check(job);
				const original = aliases.get(alias);
				if (!original || !['probe', 'decode', 'run'].includes(method))
					throw new MediaError('MediaInvalid');
				if (job.operation) throw new MediaError('MediaBusy');
				const operation = this.execute(job, `media.${method}`, {
					audioId: original,
					options: { profile: 'whisper-cli', model, language },
				});
				job.operation = operation;
				try {
					const value = await operation;
					this.check(job);
					if (method === 'decode') {
						const decoded = value as { audioId: string; durationSeconds: number };
						const next = randomUUID();
						aliases.set(next, decoded.audioId);
						return { audioId: next, durationSeconds: decoded.durationSeconds };
					}
					if (method === 'run') {
						// Native Whisper metadata can include host model/input paths. Expose only
						// the fields the closed provider contract needs, never arbitrary metadata.
						const parsed = JSON.parse((value as { json: string }).json);
						if (
							typeof parsed?.model?.multilingual !== 'boolean' ||
							typeof parsed?.params?.translate !== 'boolean' ||
							typeof parsed?.params?.language !== 'string' ||
							!/^[a-z]{2,3}$/.test(parsed.params.language) ||
							typeof parsed?.result?.language !== 'string' ||
							!/^[a-z]{2,3}$/.test(parsed.result.language) ||
							!Array.isArray(parsed.transcription) ||
							parsed.transcription.length > 1000 ||
							parsed.transcription.some(
								(segment: unknown) =>
									!segment ||
									typeof segment !== 'object' ||
									typeof (segment as { text?: unknown }).text !== 'string'
							)
						)
							throw new MediaError('MediaInvalid');
						return {
							json: JSON.stringify({
								model: { multilingual: parsed.model.multilingual },
								params: { language: parsed.params.language, translate: parsed.params.translate },
								result: { language: parsed.result.language },
								transcription: parsed.transcription.map((segment: { text: string }) => ({
									text: segment.text,
								})),
							}),
						};
					}
					return value;
				} catch (error) {
					job.operation = undefined;
					await this.close(job, 'MediaProcessFailed');
					throw error;
				} finally {
					job.operation = undefined;
				}
			},
			close: () => this.close(job, 'MediaCancelled'),
		};
	}

	/** No paths and no provider-selected runtime; caller is reauthorized by the service host. */
	serviceStatus(): Promise<MediaToolStatus> {
		return this.status();
	}

	private close(job: Job, code: MediaErrorCode): Promise<void> {
		if (job.closing) return job.closing;
		job.watchdog.disarm();
		clearInterval(job.recheck);
		// Abort synchronously: download signal and process kill listener fire before any await.
		job.controller.abort(new MediaError(code));
		job.closing = (async () => {
			await job.operation?.catch(() => {});
			if (job.dir)
				await fs.rm(job.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			job.audio.clear();
			this.jobs.delete(job.id);
		})().catch(() => {
			job.closing = undefined; // Retain the job/slot; a later close can retry cleanup.
			throw new MediaError('MediaProcessFailed');
		});
		return job.closing;
	}

	/** Host-only, no-I/O query. Only a valid close for an owned retained job can bypass rate limits. */
	ownsCloseRequest(pluginId: string, raw: unknown): boolean {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
		const params = raw as Record<string, unknown>;
		return (
			Object.keys(params).length === 1 &&
			typeof params.jobId === 'string' &&
			this.jobs.get(params.jobId)?.pluginId === pluginId
		);
	}

	cleanupPlugin(pluginId: string): Promise<void> {
		const drain = Promise.all(
			[...this.jobs.values()]
				.filter((job) => job.pluginId === pluginId)
				.map((job) => this.close(job, 'MediaCancelled'))
		).then(() => {});
		void drain.catch(() => {});
		return drain;
	}

	/** Lookups do not accept a signal. Settle on cancellation; a late answer may never cause I/O. */
	private async awaitLookup<T>(job: Job, lookup: Promise<T>): Promise<T> {
		this.check(job);
		let abort: () => void = () => {};
		try {
			return await Promise.race([
				lookup,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(job.controller.signal.reason);
					job.controller.signal.addEventListener('abort', abort, { once: true });
				}),
			]);
		} finally {
			job.controller.signal.removeEventListener('abort', abort);
		}
	}

	private async execute(job: Job, method: string, p: Record<string, unknown>): Promise<unknown> {
		this.check(job);
		if (!job.dir) {
			job.dir = await fs.mkdtemp(path.join(this.deps.tempDir ?? os.tmpdir(), 'maestro-media-'));
			await fs.chmod(job.dir, 0o700);
			this.check(job);
		}
		if (method === 'media.download') return this.download(job, p.url);
		if (typeof p.audioId !== 'string') throw new MediaError('MediaInvalid');
		const audio = job.audio.get(p.audioId);
		if (!audio) throw new MediaError('MediaInvalid');
		const runtime = await this.awaitLookup(
			job,
			(this.deps.resolveRuntime ?? resolveMediaRuntime)()
		);
		this.check(job);
		if (method === 'media.probe') {
			const result = await this.probe(job, audio, runtime);
			audio.probe = result;
			return result;
		}
		if (method === 'media.decode') {
			if (audio.kind !== 'ogg' || job.decoded) throw new MediaError('MediaInvalid');
			job.decoded = true;
			await this.probe(job, audio, runtime);
			const file = path.join(job.dir, 'pcm.wav');
			await this.runProcess(job, runtime, 'ffmpeg', [
				'-nostdin',
				'-hide_banner',
				'-loglevel',
				'error',
				'-threads',
				'1',
				'-protocol_whitelist',
				'file',
				'-f',
				'ogg',
				'-i',
				audio.file,
				'-map',
				'0:a:0',
				'-vn',
				'-t',
				'121',
				'-ac',
				'1',
				'-ar',
				'16000',
				'-c:a',
				'pcm_s16le',
				'-map_metadata',
				'-1',
				'-fs',
				String(MEDIA_LIMITS.maxPcmBytes),
				'-f',
				'wav',
				'-y',
				file,
			]);
			if ((await fs.stat(file)).size > MEDIA_LIMITS.maxPcmBytes)
				throw new MediaError('MediaTooLarge');
			const decoded: Audio = { file, kind: 'wav' };
			const probe = await this.probe(job, decoded, runtime);
			decoded.probe = probe;
			const audioId = randomUUID();
			job.audio.set(audioId, decoded);
			return { audioId, durationSeconds: probe.durationSeconds };
		}
		if (method === 'media.run') {
			if (audio.kind !== 'wav' || !audio.probe || job.ran) throw new MediaError('MediaInvalid');
			const options = p.options;
			if (!options || typeof options !== 'object' || Array.isArray(options))
				throw new MediaError('MediaInvalid');
			const o = options as Record<string, unknown>;
			if (
				Object.keys(o).some((k) => !['profile', 'model', 'language'].includes(k)) ||
				o.profile !== 'whisper-cli' ||
				!MEDIA_MODEL_IDS.includes(o.model as MediaModelId)
			)
				throw new MediaError('MediaInvalid');
			const language = o.language ?? 'de';
			if (typeof language !== 'string' || !/^[a-z]{2,3}$/.test(language))
				throw new MediaError('MediaInvalid');
			const model = runtime.models[o.model as MediaModelId];
			if (!model) throw new MediaError('MediaUnavailable');
			job.ran = true;
			const output = path.join(job.dir, 'result');
			await this.runProcess(
				job,
				runtime,
				'whisper-cli',
				[
					'-m',
					model,
					'-l',
					language,
					'-f',
					audio.file,
					'-oj',
					'-of',
					output,
					'-np',
					'-nt',
					'-t',
					'4',
					'-ng',
				],
				output + '.json'
			);
			const file = await fs.open(output + '.json', 'r');
			try {
				if ((await file.stat()).size > MEDIA_LIMITS.maxResultBytes)
					throw new MediaError('MediaOutputTooLarge');
				const buffer = Buffer.alloc(MEDIA_LIMITS.maxResultBytes + 1);
				const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
				if (bytesRead > MEDIA_LIMITS.maxResultBytes) throw new MediaError('MediaOutputTooLarge');
				return { json: buffer.subarray(0, bytesRead).toString('utf8') };
			} finally {
				await file.close();
			}
		}
		throw new MediaError('MediaInvalid');
	}

	private async download(job: Job, rawUrl: unknown): Promise<{ audioId: string; bytes: number }> {
		if (
			job.downloaded ||
			typeof rawUrl !== 'string' ||
			rawUrl.length > 4096 ||
			/[\s\x00-\x1f\x7f]/.test(rawUrl) ||
			!/^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/\d{1,20}\/\d{1,20}\/[^/?#]+(?:\?[^#]*)?$/.test(
				rawUrl
			)
		)
			throw new MediaError('MediaInvalid');
		const url = new URL(rawUrl);
		if (
			!/^\/attachments\/\d{1,20}\/\d{1,20}\/[^/?#]+$/.test(url.pathname) ||
			['.', '..'].includes(decodeURIComponent(url.pathname.split('/').pop() ?? ''))
		)
			throw new MediaError('MediaInvalid');
		if (
			url.username ||
			url.password ||
			url.port ||
			/[\\/\x00-\x1f\x7f]/.test(decodeURIComponent(url.pathname.split('/').pop() ?? ''))
		)
			throw new MediaError('MediaInvalid');
		job.downloaded = true;
		await this.awaitLookup(job, this.deps.egressGuard.assertUrlAllowed(rawUrl));
		if (this.deps.egressGuard.dispatcher === undefined) throw new MediaError('MediaDenied');
		this.check(job);
		const response = await fetchWithTimeout(
			rawUrl,
			{
				method: 'GET',
				redirect: 'error',
				credentials: 'omit',
				referrerPolicy: 'no-referrer',
				signal: job.controller.signal,
				// Node fetch extension; the renderer type graph also includes DOM RequestInit.
				dispatcher: this.deps.egressGuard.dispatcher,
			} as RequestInit,
			MEDIA_LIMITS.jobTimeoutMs
		);
		const reader = response.body?.getReader();
		if (!response.ok || !reader) {
			await response.body?.cancel();
			throw new MediaError('MediaProcessFailed');
		}
		const file = await fs.open(path.join(job.dir!, 'source.ogg'), 'wx', 0o600);
		let bytes = 0;
		try {
			if (Number(response.headers.get('content-length')) > MEDIA_LIMITS.maxDownloadBytes)
				throw new MediaError('MediaTooLarge');
			for (;;) {
				this.check(job);
				const part = await reader.read();
				if (part.done) break;
				bytes += part.value.byteLength;
				if (bytes > MEDIA_LIMITS.maxDownloadBytes) throw new MediaError('MediaTooLarge');
				await file.writeFile(part.value);
			}
			if (bytes === 0) throw new MediaError('MediaInvalid');
		} finally {
			await reader.cancel().catch(() => {});
			await file.close();
		}
		const audioId = randomUUID();
		job.audio.set(audioId, { file: path.join(job.dir!, 'source.ogg'), kind: 'ogg' });
		return { audioId, bytes };
	}

	private async probe(job: Job, audio: Audio, runtime: Runtime): Promise<MediaProbe> {
		const json = await this.runProcess(job, runtime, 'ffprobe', [
			'-v',
			'error',
			'-protocol_whitelist',
			'file',
			'-f',
			audio.kind,
			'-i',
			audio.file,
			'-show_entries',
			'format=format_name,duration:stream=codec_type,codec_name,sample_rate,channels',
			'-of',
			'json',
		]);
		const report = JSON.parse(json);
		const durationSeconds = Number(report?.format?.duration);
		if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
			throw new MediaError('MediaInvalid');
		if (durationSeconds > MEDIA_LIMITS.maxDurationSeconds) throw new MediaError('MediaTooLong');
		if (
			report?.format?.format_name !== audio.kind ||
			!Array.isArray(report.streams) ||
			report.streams.length !== 1
		)
			throw new MediaError('MediaInvalid');
		const stream = report.streams[0];
		const sampleRate = Number(stream?.sample_rate);
		const channels = Number(stream?.channels);
		if (
			stream?.codec_type !== 'audio' ||
			stream?.codec_name !== (audio.kind === 'ogg' ? 'opus' : 'pcm_s16le') ||
			!Number.isInteger(sampleRate) ||
			sampleRate <= 0 ||
			!Number.isInteger(channels) ||
			channels < 1 ||
			channels > 8 ||
			(audio.kind === 'wav' && (sampleRate !== 16000 || channels !== 1))
		)
			throw new MediaError('MediaInvalid');
		return {
			container: audio.kind,
			durationSeconds,
			streams: [{ type: 'audio', codec: stream.codec_name, sampleRate, channels }],
		};
	}

	private runProcess(
		job: Job,
		runtime: Runtime,
		tool: Tool,
		args: string[],
		resultFile?: string
	): Promise<string> {
		this.check(job);
		const binary = runtime.binaries[tool];
		if (!binary) throw new MediaError('MediaUnavailable');
		return new Promise((resolve, reject) => {
			let failure: MediaError | undefined;
			const child = execFile(
				binary,
				args,
				{
					cwd: job.dir,
					env: {},
					shell: false,
					windowsHide: true,
					maxBuffer: MEDIA_LIMITS.maxProcessOutputBytes,
					killSignal: 'SIGKILL',
					encoding: 'utf8',
				},
				(error, stdout) => {
					clearInterval(monitor);
					job.controller.signal.removeEventListener('abort', abort);
					if (job.controller.signal.aborted) reject(job.controller.signal.reason);
					else if (failure) reject(failure);
					else if (error)
						reject(
							new MediaError(
								error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
									? 'MediaOutputTooLarge'
									: 'MediaProcessFailed'
							)
						);
					else resolve(stdout);
				}
			);
			child.stdin?.end();
			const abort = () => {
				child.kill('SIGKILL');
			};
			job.controller.signal.addEventListener('abort', abort, { once: true });
			// The only writable child result has a separate on-disk quota; never relay diagnostics.
			const monitor = setInterval(() => {
				if (resultFile)
					void fs
						.stat(resultFile)
						.then((stat) => {
							if (stat.size > MEDIA_LIMITS.maxResultBytes) {
								failure = new MediaError('MediaOutputTooLarge');
								child.kill('SIGKILL');
							}
						})
						.catch(() => {});
			}, 100);
		});
	}
}
