import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { readPcmWavFile } from '../../../main/utils/wav-file';
import { encodeWav } from '../../../shared/audio/pcm';

const OPTIONS = { maxBytes: 1024 * 1024, purpose: 'a transcription', reader: 'Dictation' };

describe('readPcmWavFile', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-wav-file-'));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('decodes a 16-bit PCM WAV at its own sample rate', async () => {
		const file = path.join(dir, 'clip.wav');
		const samples = new Int16Array([0, 16384, -16384, 32767]);
		await fs.writeFile(file, encodeWav(samples, 22050));

		const clip = await readPcmWavFile(file, OPTIONS);

		expect(clip.sampleRate).toBe(22050);
		expect(Array.from(clip.pcm)).toEqual(Array.from(samples));
	});

	it.each([[undefined], [null], [42], [''], ['   '], ['relative/clip.wav']])(
		'refuses %j, which is not an absolute path',
		async (filePath) => {
			await expect(readPcmWavFile(filePath, OPTIONS)).rejects.toThrow(
				'An absolute path to a WAV file is required.'
			);
		}
	);

	it('names a file that does not exist', async () => {
		const missing = path.join(dir, 'nope.wav');
		await expect(readPcmWavFile(missing, OPTIONS)).rejects.toThrow(`No such file: ${missing}`);
	});

	it('refuses a directory', async () => {
		await expect(readPcmWavFile(dir, OPTIONS)).rejects.toThrow(`Not a file: ${dir}`);
	});

	// The bound is checked against the size on disk, so a file over it is
	// refused even when its bytes are not a WAV at all: nothing was read.
	it('refuses a file over the bound before reading it', async () => {
		const file = path.join(dir, 'big.wav');
		await fs.writeFile(file, Buffer.alloc(2048));

		await expect(
			readPcmWavFile(file, { ...OPTIONS, maxBytes: 1024, purpose: 'a wake recording' })
		).rejects.toThrow(
			`${file} is larger than the ${1024 / (1024 * 1024)} MB a wake recording reads.`
		);
	});

	it('reads a file exactly at the bound', async () => {
		const file = path.join(dir, 'edge.wav');
		const bytes = encodeWav(new Int16Array(8));
		await fs.writeFile(file, bytes);

		const clip = await readPcmWavFile(file, { ...OPTIONS, maxBytes: bytes.byteLength });

		expect(clip.pcm.length).toBe(8);
	});

	it('says which format the reader takes when the bytes are not a WAV', async () => {
		const file = path.join(dir, 'notes.wav');
		await fs.writeFile(file, 'this is not audio');

		await expect(readPcmWavFile(file, { ...OPTIONS, reader: 'Wake training' })).rejects.toThrow(
			'Not a WAV file. Wake training reads 16-bit PCM WAV files.'
		);
	});
});
