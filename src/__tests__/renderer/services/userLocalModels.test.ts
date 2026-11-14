/**
 * Tests for the renderer's user-model sync: one memory read at startup and one
 * subscription put the models the user added from Hugging Face into this
 * window's catalog, and keep them in step with the main process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { getLocalModel, setUserLocalModels } from '../../../shared/local-models/model-catalog';
import { userLocalModelEntry } from '../../../shared/local-models/user-models';
import { startUserLocalModelsSync } from '../../../renderer/services/userLocalModels';

const ENTRY = userLocalModelEntry({
	id: 'hf-someone-model-q4_k_m',
	displayName: 'model-Q4_K_M',
	repo: 'someone/model-GGUF',
	revision: '0'.repeat(40),
	license: { spdx: 'mit', url: 'https://huggingface.co/someone/model-GGUF' },
	files: [{ path: 'model-Q4_K_M.gguf', sha256: 'a'.repeat(64), bytes: 1_000_000_000 }],
	parametersB: 1.5,
	contextLength: 8192,
	addedAt: 0,
});

const hf = () =>
	(
		window.maestro.localModels as unknown as {
			huggingFace: Record<string, ReturnType<typeof vi.fn>>;
		}
	).huggingFace;

describe('startUserLocalModelsSync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setUserLocalModels([]);
	});
	afterEach(() => setUserLocalModels([]));

	it('reads the list once, follows every change, and starts only once', async () => {
		let push: ((entries: unknown[]) => void) | undefined;
		hf().list.mockResolvedValue([ENTRY]);
		hf().onChanged.mockImplementation((handler: (entries: unknown[]) => void) => {
			push = handler;
			return () => {};
		});

		startUserLocalModelsSync();
		startUserLocalModelsSync();
		expect(hf().list).toHaveBeenCalledTimes(1);
		expect(hf().onChanged).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(getLocalModel(ENTRY.id)).toEqual(ENTRY));

		// A remove in the main process reaches this window's catalog.
		push?.([]);
		expect(getLocalModel(ENTRY.id)).toBeUndefined();
	});
});
