/**
 * @file wake-front-end.test.ts
 *
 * The wake word's front-end graphs run on every 80 ms hop for as long as
 * hands-free is on. They must open with the single-thread always-on policy: the
 * ONNX Runtime default (one spinning worker per core) held about one and a half
 * cores busy on an idle 18-core machine.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/local-models/model-store', () => ({
	modelFilePath: (id: string, file: string) => `/models/${id}/${file}`,
}));

const create = vi.fn(async () => ({ inputNames: ['x'], outputNames: ['y'], run: vi.fn() }));
vi.mock('../../../../main/acappella/providers/local/runtime', () => ({
	loadVoiceRuntime: vi.fn(async () => ({ InferenceSession: { create }, Tensor: class {} })),
}));

import { loadWakeFrontEndModels } from '../../../../main/acappella/wake/wake-front-end';
import { ALWAYS_ON_ONNX_SESSION_OPTIONS } from '../../../../main/local-models/runtime/onnx-types';

describe('loadWakeFrontEndModels', () => {
	it('opens both graphs with one intra-op thread, never the per-core default pool', async () => {
		const models = await loadWakeFrontEndModels();

		expect(models).not.toBeNull();
		expect(create).toHaveBeenCalledTimes(2);
		for (const [path, options] of create.mock.calls as unknown as Array<[string, unknown]>) {
			expect(path).toMatch(/\.onnx$/);
			expect(options).toBe(ALWAYS_ON_ONNX_SESSION_OPTIONS);
		}
		expect(ALWAYS_ON_ONNX_SESSION_OPTIONS).toEqual({
			intraOpNumThreads: 1,
			interOpNumThreads: 1,
			executionMode: 'sequential',
		});
	});
});
