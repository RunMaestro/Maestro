/**
 * @file model-store-win32-paths.test.ts
 *
 * `modelFilePath` on a Windows host, run on any host: Node's `path` is swapped
 * for `path.win32`, and the working directory is a drive path, so
 * `path.resolve` adds a drive letter the way it does on a Windows runner.
 *
 * The bug this pins: the containment check compared the resolved file path
 * (`D:\tmp\...\voices\af_heart.bin`) against the unresolved install directory
 * (`\tmp\...`), so whenever the data directory had no drive letter every
 * legitimate file was refused as `UnsafeModelFilePath` (Kokoro's voice pack,
 * the embedding model's ONNX file). A `..` escape must still be refused,
 * written with either separator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('path', async () => {
	const actual = await vi.importActual<typeof import('path')>('path');
	return { ...actual.win32, default: actual.win32 };
});

// A data directory with no drive letter, as a test mock (or a rooted path)
// gives it: the case where `resolve` and `join` disagree on Windows.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestro-win32-test' } }));

import { modelDir, modelFilePath } from '../../../main/local-models/model-store';
import { KOKORO_82M_ID } from '../../../shared/local-models/model-catalog';

const win32 = (await vi.importActual<typeof import('path')>('path')).win32;

describe('modelFilePath on a Windows host', () => {
	let previousUserData: string | undefined;

	beforeEach(() => {
		previousUserData = process.env.MAESTRO_USER_DATA;
		delete process.env.MAESTRO_USER_DATA;
		vi.spyOn(process, 'cwd').mockReturnValue('D:\\a\\maestro');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousUserData === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = previousUserData;
	});

	it('locates a model file named with forward slashes', () => {
		const dir = modelDir(KOKORO_82M_ID);
		expect(modelFilePath(KOKORO_82M_ID, 'voices/af_heart.bin')).toBe(
			win32.resolve(dir, 'voices', 'af_heart.bin')
		);
		expect(modelFilePath(KOKORO_82M_ID, 'onnx\\model_quantized.onnx')).toBe(
			win32.resolve(dir, 'onnx', 'model_quantized.onnx')
		);
	});

	it('answers the install directory itself for the root', () => {
		const dir = win32.resolve(modelDir(KOKORO_82M_ID));
		expect(modelFilePath(KOKORO_82M_ID, '.')).toBe(dir);
		expect(modelFilePath(KOKORO_82M_ID, '')).toBe(dir);
	});

	it('still refuses a path that leaves the install directory', () => {
		for (const escape of [
			'../other/model.onnx',
			'..\\other\\model.onnx',
			'voices/../../x.bin',
			'C:\\Windows\\x.bin',
			'\\\\server\\share\\x.bin',
			'/etc/passwd',
		]) {
			expect(() => modelFilePath(KOKORO_82M_ID, escape)).toThrow(/UnsafeModelFilePath/);
		}
	});
});
