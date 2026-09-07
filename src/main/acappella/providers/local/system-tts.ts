/**
 * Text-to-speech through the operating system's own voice.
 *
 * **Why this exists.** The local tier promised a downloaded neural voice
 * (Kokoro), and that voice cannot speak yet: it takes phoneme ids, and the
 * grapheme-to-phoneme front end it needs is not part of this build. Until it
 * is, every desktop Maestro runs on already ships a speech synthesiser that
 * needs no download, no key, and sends nothing anywhere: `say` on macOS, the
 * System.Speech API on Windows, and `espeak-ng` on Linux. Using it is what
 * makes "enable the feature and talk" true with a single download (the
 * recogniser) instead of two and a missing component.
 *
 * **One process per sentence, cancellable between and during them.** The
 * synthesiser is a short-lived child process writing one WAV file, so barge-in
 * has something small to kill: the sentence being made is aborted and the queue
 * behind it is dropped. Nothing is streamed from a long-lived process, because
 * none of the three engines offers a cancellable stream and a paragraph that
 * cannot be interrupted is the one thing a spoken reply must never be.
 *
 * **The audio never touches a shell.** Text goes to the engine on stdin (or
 * through a temp file on Windows), never as an argument, so a reply that starts
 * with `-` is spoken rather than parsed, and nothing the agent wrote can become
 * a flag.
 *
 * Voices are the OS's. `listVoices()` is what the picker shows, and a voice id
 * that is not installed here is omitted rather than passed through: a stale
 * ElevenLabs id in settings must not make every sentence fail.
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { SYSTEM_TTS_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type {
	TtsChunk,
	TtsProvider,
	TtsSpeakOptions,
} from '../../../../shared/acappella/providers';
import { splitIntoSpokenSentences } from '../../../../shared/acappella/sentences';
import { isLinux, isMacOS, isWindows } from '../../../../shared/platformDetection';
import { decodeWavPcm16 } from '../pcm';

/** What the picker renders. The id is what the engine is handed back. */
export interface SystemVoice {
	id: string;
	name: string;
}

export interface SystemVoiceRequest {
	text: string;
	/** An id from {@link SystemVoiceTtsProvider.listVoices}, already validated. */
	voiceId?: string;
	/** 1 is the engine's natural pace. */
	rate?: number;
	signal: AbortSignal;
}

export interface SystemVoiceAudio {
	sampleRate: number;
	pcm: Int16Array;
}

/** One sentence in, one buffer of samples out. Injected in tests. */
export type SystemVoiceSynthesizer = (request: SystemVoiceRequest) => Promise<SystemVoiceAudio>;

/**
 * Why the system voice cannot run here, or null when it can.
 *
 * Reported through the capability gate BEFORE a session opens the microphone:
 * a Linux box without `espeak-ng` would otherwise listen perfectly and fail on
 * the first reply, which is the one moment the user has no screen to read.
 */
export interface SystemVoiceUnavailable {
	message: string;
	suggestedAction: string;
}

/** The speaking rate the engines treat as natural, in words per minute. */
const BASE_WORDS_PER_MINUTE = 175;

/** macOS `say` emits at whatever rate is asked for; this is what playback wants. */
const MAC_SAMPLE_RATE = 24_000;

/** Windows' synthesiser is asked for the same. Linux's engine fixes its own. */
const WINDOWS_SAMPLE_RATE = 24_000;

/** Linux engines, in preference order. The first one on PATH is used. */
const LINUX_ENGINES = ['espeak-ng', 'espeak'] as const;

/** A single sentence that takes longer than this has hung, not synthesised. */
const SYNTHESIS_TIMEOUT_MS = 30_000;

export interface SystemVoiceTtsOptions {
	/** Injected in tests. Production spawns the platform's engine. */
	synthesize?: SystemVoiceSynthesizer;
	/** Injected in tests. Production asks the platform's engine. */
	listVoices?: () => Promise<SystemVoice[]>;
}

export class SystemVoiceTtsProvider implements TtsProvider {
	readonly id = SYSTEM_TTS_PROVIDER_ID;
	readonly label = 'System voice (built in)';
	readonly tier = 'local' as const;

	private readonly synthesize: SystemVoiceSynthesizer;
	private readonly listVoicesImpl: () => Promise<SystemVoice[]>;

	/** Bumped by `cancel()` and by every new run, so a stale iterator returns. */
	private run = 0;
	private inFlight: AbortController | null = null;
	/** The installed voices, read once. Null until the first ask. */
	private voices: Promise<SystemVoice[]> | null = null;

	constructor(options: SystemVoiceTtsOptions = {}) {
		this.synthesize = options.synthesize ?? synthesizeWithPlatformEngine;
		this.listVoicesImpl = options.listVoices ?? listPlatformVoices;
	}

	speak(text: string, options: TtsSpeakOptions): AsyncIterable<TtsChunk> {
		// The run is claimed here, not in the generator body: a generator does not
		// start until its first `next()`, and a second `speak()` must supersede the
		// first immediately.
		return this.stream(splitIntoSpokenSentences(text), ++this.run, options);
	}

	cancel(): void {
		this.run += 1;
		this.inFlight?.abort();
		this.inFlight = null;
	}

	/** The voices installed on this machine, for the picker. Cached per provider. */
	async listVoices(): Promise<SystemVoice[]> {
		this.voices ??= this.listVoicesImpl().catch(() => []);
		return this.voices;
	}

	// -- Internals -----------------------------------------------------------

	private async *stream(
		sentences: string[],
		run: number,
		options: TtsSpeakOptions
	): AsyncGenerator<TtsChunk> {
		if (sentences.length === 0) return;
		// Resolved once per run rather than per sentence, and BEFORE the first
		// synthesis: an id the engine does not know is dropped here, so a voice
		// chosen for a different provider costs nothing rather than failing every
		// sentence of every reply.
		const voiceId = await this.resolveVoice(options.voiceId);
		if (this.run !== run) return;

		for (let index = 0; index < sentences.length; index++) {
			if (this.run !== run) return;

			const controller = new AbortController();
			this.inFlight = controller;
			let audio: SystemVoiceAudio;
			try {
				audio = await this.synthesize({
					text: sentences[index],
					voiceId,
					rate: options.rate,
					signal: controller.signal,
				});
			} catch (error) {
				// A barge-in aborts the engine, and an abort is not a failure: the run
				// it belonged to is already over, so it ends quietly.
				if (this.run !== run) return;
				throw error;
			} finally {
				if (this.inFlight === controller) this.inFlight = null;
			}

			// Re-checked after the await: a barge-in during synthesis must not
			// deliver the sentence it interrupted.
			if (this.run !== run) return;

			yield {
				utteranceId: options.utteranceId,
				index,
				text: sentences[index],
				format: 'pcm16',
				audio: new Uint8Array(audio.pcm.buffer, audio.pcm.byteOffset, audio.pcm.byteLength),
				sampleRate: audio.sampleRate,
			};
		}
	}

	private async resolveVoice(voiceId: string | undefined): Promise<string | undefined> {
		if (!voiceId) return undefined;
		const voices = await this.listVoices();
		return voices.some((voice) => voice.id === voiceId) ? voiceId : undefined;
	}
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Whether this machine has a speech engine at all.
 *
 * macOS and Windows always do. Linux needs `espeak-ng` (or `espeak`) on PATH,
 * and the check is a PATH walk rather than a spawn so the capability gate can
 * ask on every Settings render without starting a process each time.
 */
export async function systemVoiceUnavailability(): Promise<SystemVoiceUnavailable | null> {
	if (isMacOS() || isWindows()) return null;
	if (await findLinuxEngine()) return null;
	return {
		message: 'No system speech engine is installed (espeak-ng).',
		suggestedAction: 'Install espeak-ng, or switch Text-to-Speech to a hosted voice.',
	};
}

// ---------------------------------------------------------------------------
// Platform engines
// ---------------------------------------------------------------------------

async function synthesizeWithPlatformEngine(
	request: SystemVoiceRequest
): Promise<SystemVoiceAudio> {
	if (isMacOS()) return synthesizeMac(request);
	if (isWindows()) return synthesizeWindows(request);
	if (isLinux()) return synthesizeLinux(request);
	throw unavailable(`There is no system voice for ${process.platform}.`);
}

async function listPlatformVoices(): Promise<SystemVoice[]> {
	if (isMacOS()) return listMacVoices();
	if (isWindows()) return listWindowsVoices();
	return [];
}

/** A scratch directory for the WAV files, created once per process. */
let scratchDir: Promise<string> | null = null;
let scratchSeq = 0;

async function scratchFile(extension: string): Promise<string> {
	scratchDir ??= fs.mkdtemp(path.join(os.tmpdir(), 'maestro-voice-'));
	return path.join(await scratchDir, `${process.pid}-${++scratchSeq}.${extension}`);
}

/** Read a finished WAV and delete it, whatever happens on the way. */
async function consumeWav(file: string): Promise<SystemVoiceAudio> {
	try {
		const bytes = await fs.readFile(file);
		const decoded = decodeWavPcm16(bytes);
		return { sampleRate: decoded.sampleRate, pcm: decoded.pcm };
	} catch (error) {
		throw unavailable('The system voice produced audio Maestro could not read.', error);
	} finally {
		await fs.rm(file, { force: true }).catch(() => undefined);
	}
}

function wordsPerMinute(rate: number | undefined): number | null {
	if (rate === undefined || !(rate > 0) || rate === 1) return null;
	return Math.round(BASE_WORDS_PER_MINUTE * rate);
}

async function synthesizeMac(request: SystemVoiceRequest): Promise<SystemVoiceAudio> {
	const wav = await scratchFile('wav');
	const args = [`--data-format=LEI16@${MAC_SAMPLE_RATE}`, '-o', wav];
	if (request.voiceId) args.push('-v', request.voiceId);
	const wpm = wordsPerMinute(request.rate);
	if (wpm !== null) args.push('-r', String(wpm));
	// No message argument, so `say` reads the sentence from stdin.
	await runEngine('say', args, request.signal, request.text);
	return consumeWav(wav);
}

async function synthesizeWindows(request: SystemVoiceRequest): Promise<SystemVoiceAudio> {
	const wav = await scratchFile('wav');
	const txt = await scratchFile('txt');
	await fs.writeFile(txt, request.text, 'utf8');
	// System.Speech's rate is -10..10 around the natural pace. The slider's
	// 0.7..1.4 lands on -3..4, which is roughly what those steps mean.
	const rate = Math.max(-10, Math.min(10, Math.round(((request.rate ?? 1) - 1) * 10)));
	const script = [
		'Add-Type -AssemblyName System.Speech',
		'$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
		request.voiceId ? `$s.SelectVoice('${psQuote(request.voiceId)}')` : '',
		`$s.Rate = ${rate}`,
		`$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${WINDOWS_SAMPLE_RATE}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)`,
		`$s.SetOutputToWaveFile('${psQuote(wav)}', $f)`,
		`$s.Speak([IO.File]::ReadAllText('${psQuote(txt)}'))`,
		'$s.Dispose()',
	]
		.filter(Boolean)
		.join('; ');
	try {
		await runEngine(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
			request.signal
		);
	} finally {
		await fs.rm(txt, { force: true }).catch(() => undefined);
	}
	return consumeWav(wav);
}

async function synthesizeLinux(request: SystemVoiceRequest): Promise<SystemVoiceAudio> {
	const engine = await findLinuxEngine();
	if (!engine) {
		throw unavailable(
			'No system speech engine is installed. Install espeak-ng, or switch Text-to-Speech to a hosted voice.'
		);
	}
	const wav = await scratchFile('wav');
	const args = ['-w', wav, '--stdin'];
	if (request.voiceId) args.push('-v', request.voiceId);
	const wpm = wordsPerMinute(request.rate);
	if (wpm !== null) args.push('-s', String(wpm));
	await runEngine(engine, args, request.signal, request.text);
	return consumeWav(wav);
}

/** `say -v ?` prints `Name<spaces>lang_REGION<spaces># sample`. */
export function parseMacVoiceList(output: string): SystemVoice[] {
	const voices: SystemVoice[] = [];
	for (const line of output.split('\n')) {
		const match = /^(.+?)\s+([A-Za-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(line);
		if (!match) continue;
		voices.push({ id: match[1].trim(), name: `${match[1].trim()} (${match[2]})` });
	}
	// English first, then everything else, each group in the order the OS listed
	// them. A user of another language still finds theirs; an English speaker is
	// not scrolling past forty voices to reach one.
	const english = voices.filter((voice) => /\(en[_-]/.test(voice.name));
	const others = voices.filter((voice) => !/\(en[_-]/.test(voice.name));
	return [...english, ...others];
}

async function listMacVoices(): Promise<SystemVoice[]> {
	const output = await runEngine('say', ['-v', '?'], new AbortController().signal);
	return parseMacVoiceList(output);
}

async function listWindowsVoices(): Promise<SystemVoice[]> {
	const output = await runEngine(
		'powershell.exe',
		[
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-Command',
			'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }',
		],
		new AbortController().signal
	);
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((name) => ({ id: name, name }));
}

/** The first Linux engine on PATH, or null. Not cached: the user may install one. */
async function findLinuxEngine(): Promise<string | null> {
	const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
	for (const engine of LINUX_ENGINES) {
		for (const dir of dirs) {
			try {
				await fs.access(path.join(dir, engine), fs.constants.X_OK);
				return engine;
			} catch {
				/* not here */
			}
		}
	}
	return null;
}

/**
 * Run one engine process to completion, with the text on stdin.
 *
 * Resolves to stdout (the voice list uses it; synthesis ignores it). A non-zero
 * exit, a missing binary, and a hang are all classified rather than thrown raw,
 * because they arrive from inside a speech run where the session can only act on
 * a named failure.
 */
function runEngine(
	command: string,
	args: string[],
	signal: AbortSignal,
	stdin?: string
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		let stdout = '';
		let stderr = '';
		let settled = false;

		const finish = (error: Error | null, output = '') => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			if (error) reject(error);
			else resolve(output);
		};
		const onAbort = () => {
			child.kill();
			finish(new Error('cancelled'));
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(unavailable('The system voice did not finish speaking in time.'));
		}, SYNTHESIS_TIMEOUT_MS);

		signal.addEventListener('abort', onAbort, { once: true });
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8');
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', (error: NodeJS.ErrnoException) => {
			finish(
				error.code === 'ENOENT'
					? unavailable(
							`The system speech engine (${command}) is not installed. Switch Text-to-Speech to a hosted voice.`,
							error
						)
					: unavailable(`The system voice could not be started: ${error.message}`, error)
			);
		});
		child.on('close', (code) => {
			if (code === 0) finish(null, stdout);
			else
				finish(
					unavailable(`The system voice failed (exit ${code}): ${stderr.trim() || 'no output'}`)
				);
		});

		if (stdin !== undefined && child.stdin) {
			child.stdin.on('error', () => undefined);
			child.stdin.end(stdin, 'utf8');
		}
	});
}

/** Single-quote for PowerShell: the only escape inside `'...'` is doubling. */
function psQuote(value: string): string {
	return value.replace(/'/g, "''");
}

function unavailable(message: string, cause?: unknown): VoiceProviderError {
	return new VoiceProviderError(message, {
		kind: 'unavailable',
		providerId: SYSTEM_TTS_PROVIDER_ID,
		cause,
	});
}
