/**
 * @file voice-runtime.test.ts
 *
 * Voice providers reach native runtimes through the core loader, which throws a
 * `LocalModelError`. The session only announces `VoiceProviderError`s, so the
 * adapter must restate every core failure as the provider that hit it, as
 * `unavailable` (fixed in Voice Setup, not by Retry), with the cause intact.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/local-models/runtime/load-runtime', () => ({
	loadLocalRuntime: vi.fn(),
}));

import { loadLocalRuntime } from '../../../../main/local-models/runtime/load-runtime';
import { LocalModelError } from '../../../../main/local-models/errors';
import {
	loadVoiceRuntime,
	voiceErrorFromLocalModel,
} from '../../../../main/acappella/providers/local/runtime';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';

const CAUSE = { kind: 'runtime-unavailable', failure: 'not-downloaded' };

function coreError(): LocalModelError {
	return new LocalModelError('ONNX Runtime is not downloaded yet.', {
		code: 'runtime-unavailable',
		recovery: 'Download it in Voice Setup.',
		consumerId: 'local-parakeet',
		cause: CAUSE,
	});
}

describe('voice runtime adapter', () => {
	beforeEach(() => {
		vi.mocked(loadLocalRuntime).mockReset();
	});

	it('passes a loaded module straight through', async () => {
		const module = { InferenceSession: {} };
		vi.mocked(loadLocalRuntime).mockResolvedValue(module);

		await expect(loadVoiceRuntime('onnx', 'local-parakeet')).resolves.toBe(module);
		expect(loadLocalRuntime).toHaveBeenCalledWith('onnx', 'local-parakeet');
	});

	it('restates a core failure as an unavailable voice provider error', async () => {
		vi.mocked(loadLocalRuntime).mockRejectedValue(coreError());

		const caught: unknown = await loadVoiceRuntime('onnx', 'local-parakeet').catch((e) => e);

		expect(caught).toBeInstanceOf(VoiceProviderError);
		const error = caught as VoiceProviderError & { cause?: unknown };
		expect(error.kind).toBe('unavailable');
		expect(error.providerId).toBe('local-parakeet');
		expect(error.message).toBe('ONNX Runtime is not downloaded yet.');
		expect(error.recoverable).toBe(false);
		expect(error.cause).toBe(CAUSE);
	});

	it('lets anything that is not a core failure through untouched, so bugs reach Sentry as bugs', async () => {
		const bug = new TypeError('undefined is not a function');
		vi.mocked(loadLocalRuntime).mockRejectedValue(bug);

		await expect(loadVoiceRuntime('onnx', 'local-parakeet')).rejects.toBe(bug);
	});

	it('maps a core error directly too', () => {
		const error = voiceErrorFromLocalModel(coreError(), 'local-kokoro');
		expect(error.providerId).toBe('local-kokoro');
		expect(error.sessionErrorCode).toBe('provider-unavailable');
	});
});
