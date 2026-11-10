import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
vi.mock('electron', () => ({
	ipcRenderer: { invoke: (...args: unknown[]) => mockInvoke(...args) },
}));

import { createLocalModelsApi } from '../../../main/preload/localModels';

describe('Local Models proxy block preload', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('keeps hash-only callers compatible with the full-block diff result', async () => {
		const hash = 'a'.repeat(64);
		const block = { hash, original: 'long', compressed: 'short' };
		mockInvoke.mockResolvedValueOnce(block);
		await expect(createLocalModelsApi().proxy.block(hash)).resolves.toBe(block);
		expect(mockInvoke).toHaveBeenCalledExactlyOnceWith('localModels:proxy:block', hash, undefined);
		expect(block).not.toHaveProperty('originalRange');
	});

	it('forwards a typed original range and returns its completeness metadata unchanged', async () => {
		const hash = 'a'.repeat(64);
		const range = { startLine: 2, endLine: 4 };
		const block = {
			hash,
			original: 'selected\r\nlast',
			originalRange: {
				hash,
				source: 'original',
				requested: range,
				returned: { startLine: 2, endLine: 3 },
				complete: false,
				hasMore: false,
			},
			compressed: 'full frozen replacement',
		};
		mockInvoke.mockResolvedValueOnce(block);
		await expect(createLocalModelsApi().proxy.block(hash, range)).resolves.toBe(block);
		expect(mockInvoke).toHaveBeenCalledExactlyOnceWith('localModels:proxy:block', hash, range);
	});

	it('preserves missing-original and missing-block responses', async () => {
		const hash = 'a'.repeat(64);
		const range = { startLine: 1, endLine: 2 };
		const block = { hash, original: null, originalRange: null, compressed: 'short' };
		mockInvoke.mockResolvedValueOnce(block).mockResolvedValueOnce(null);
		const api = createLocalModelsApi().proxy;
		await expect(api.block(hash, range)).resolves.toBe(block);
		await expect(api.block(hash, range)).resolves.toBeNull();
	});

	it('propagates server validation and archive failures', async () => {
		const failure = new Error('Original line range exceeds the byte limit.');
		mockInvoke.mockRejectedValueOnce(failure);
		await expect(
			createLocalModelsApi().proxy.block('a'.repeat(64), { startLine: 1, endLine: 2 })
		).rejects.toBe(failure);
	});
});

describe('Local Models dictation preload', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('sends a clip the browser recorded itself to the host for transcription', async () => {
		const request = { audio: 'data:audio/wav;base64,UklGRg==' };
		const answer = { status: 'ok', text: 'Ship it.', audioMs: 700 };
		mockInvoke.mockResolvedValueOnce(answer);
		await expect(createLocalModelsApi().dictation.transcribe(request)).resolves.toBe(answer);
		expect(mockInvoke).toHaveBeenCalledExactlyOnceWith('localModels:dictation:transcribe', request);
	});
});
