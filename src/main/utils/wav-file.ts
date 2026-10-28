/**
 * Reading a WAV file a caller named by path.
 *
 * For features whose audio normally comes from the microphone and whose CLI
 * path brings it as a file instead: an agent has no microphone. The path
 * arrives from a bridge, so it is validated here rather than trusted, and the
 * file is bounded before it is read.
 *
 * Only 16-bit PCM is decoded (`decodeWavPcm16`): compressed audio would need a
 * codec this process does not ship, and saying so by name beats guessing.
 */

import fs from 'fs/promises';
import path from 'path';

import { decodeWavPcm16 } from '../../shared/audio/pcm';

export interface ReadWavFileOptions {
	/** Largest file read. A WAV is uncompressed, so this is also a bound on its length. */
	maxBytes: number;
	/** What reads the file, as it completes "... MB ___ reads": "a transcription". */
	purpose: string;
	/** Who needs the format, as it completes "___ reads 16-bit PCM WAV files": "Dictation". */
	reader: string;
}

/**
 * Read a 16-bit PCM WAV file.
 *
 * @throws With a sentence naming the problem: not an absolute path, no such
 *         file, not a file, too large, or not a WAV this build can decode.
 */
export async function readPcmWavFile(
	filePath: unknown,
	options: ReadWavFileOptions
): Promise<{ sampleRate: number; pcm: Int16Array }> {
	if (typeof filePath !== 'string' || filePath.trim() === '' || !path.isAbsolute(filePath)) {
		throw new Error('An absolute path to a WAV file is required.');
	}
	let size: number;
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
		size = stat.size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`No such file: ${filePath}`);
		}
		throw error;
	}
	if (size > options.maxBytes) {
		throw new Error(
			`${filePath} is larger than the ${options.maxBytes / (1024 * 1024)} MB ${options.purpose} reads.`
		);
	}

	try {
		return decodeWavPcm16(await fs.readFile(filePath));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${reason}. ${options.reader} reads 16-bit PCM WAV files.`);
	}
}
