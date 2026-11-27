/**
 * @file load-runtime.test.ts
 *
 * The core loader speaks one error vocabulary for every consumer. What matters:
 * a loaded runtime comes back as itself, and a refused one becomes a
 * `LocalModelError` carrying the loader's recovery sentence and the original
 * classification, so a consumer can restate it without losing the cause.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/local-models/runtime/native-loader', () => ({
	tryLoadNativeRuntime: vi.fn(),
}));

import { tryLoadNativeRuntime } from '../../../../main/local-models/runtime/native-loader';
import { loadLocalRuntime } from '../../../../main/local-models/runtime/load-runtime';
import { LocalModelError, isLocalModelError } from '../../../../main/local-models/errors';

const REFUSAL = {
	kind: 'runtime-unavailable' as const,
	runtimeId: 'onnx' as const,
	moduleId: 'onnxruntime-node',
	platform: 'darwin',
	arch: 'arm64',
	failure: 'not-downloaded' as const,
	message: 'ONNX Runtime is not downloaded yet.',
	suggestedAction: 'Download it in Voice Setup.',
};

describe('loadLocalRuntime', () => {
	beforeEach(() => {
		vi.mocked(tryLoadNativeRuntime).mockReset();
	});

	it('returns the module when the runtime loads', async () => {
		const module = { InferenceSession: {} };
		vi.mocked(tryLoadNativeRuntime).mockResolvedValue({ ok: true, module });

		await expect(loadLocalRuntime('onnx', 'tab-naming')).resolves.toBe(module);
	});

	it('throws a classified LocalModelError when it does not', async () => {
		vi.mocked(tryLoadNativeRuntime).mockResolvedValue({ ok: false, error: REFUSAL });

		const caught: unknown = await loadLocalRuntime('onnx', 'tab-naming').catch((e) => e);

		expect(isLocalModelError(caught)).toBe(true);
		expect(caught).toBeInstanceOf(LocalModelError);
		const error = caught as LocalModelError & { cause?: unknown };
		expect(error.code).toBe('runtime-unavailable');
		expect(error.message).toBe(REFUSAL.message);
		expect(error.recovery).toBe(REFUSAL.suggestedAction);
		expect(error.consumerId).toBe('tab-naming');
		// The classification travels, so a consumer can map it without re-deriving it.
		expect(error.cause).toBe(REFUSAL);
	});
});
