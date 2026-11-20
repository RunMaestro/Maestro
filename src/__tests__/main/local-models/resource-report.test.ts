/**
 * @file resource-report.test.ts
 *
 * What Local Models reports to the Application Stats panel: disk per area
 * (the server engine is inside the runtimes total and not added twice), model
 * directories named from the catalog and sorted largest first, what the shared
 * in-process engines hold, and a model server pid only while it runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../main/local-models/model-store', () => ({
	totalFootprint: vi.fn(),
}));
vi.mock('../../../main/local-models/runtime/runtime-store', () => ({
	runtimesFootprint: vi.fn(),
}));
vi.mock('../../../main/local-models/server/engine-store', () => ({
	serverEngineDir: vi.fn(() => '/data/runtimes/llama-server'),
}));
vi.mock('../../../main/local-models/server/supervisor', () => ({
	getModelServerStatus: vi.fn(),
	modelServerDir: vi.fn(() => '/data/model-server'),
}));
vi.mock('../../../main/utils/directory-size', () => ({
	directoryBytes: vi.fn(),
}));
vi.mock('../../../main/local-models/embedding-store', () => ({
	getEmbeddingStore: vi.fn(() => ({ diskUsageBytes: vi.fn(async () => 40) })),
}));
vi.mock('../../../main/local-models/text-gen', () => ({
	getLocalTextEngine: vi.fn(() => ({ loadedModelId: 'qwen3-4b' })),
}));
vi.mock('../../../main/local-models/onnx-encoder', () => ({
	getOnnxEncoderPool: vi.fn(() => ({ loadedModelIds: ['embedder'] })),
}));
vi.mock('../../../main/local-models/speech-to-text', () => ({
	getSpeechToTextPool: vi.fn(() => ({ loadedModelIds: [] })),
}));
vi.mock('../../../shared/local-models/model-catalog', () => ({
	getLocalModel: vi.fn((id: string) =>
		id === 'qwen3-4b' ? { displayName: 'Qwen3 4B', kind: 'text-gen' } : undefined
	),
}));

import { collectLocalModelResources } from '../../../main/local-models/resource-report';
import { totalFootprint } from '../../../main/local-models/model-store';
import { runtimesFootprint } from '../../../main/local-models/runtime/runtime-store';
import { getModelServerStatus } from '../../../main/local-models/server/supervisor';
import { directoryBytes } from '../../../main/utils/directory-size';

function serverStatus(overrides: Record<string, unknown> = {}) {
	return {
		state: 'running',
		pid: 4321,
		port: 8090,
		models: ['qwen3-4b'],
		loadedModels: ['qwen3-4b'],
		startedAt: 5,
		...overrides,
	} as never;
}

describe('collectLocalModelResources', () => {
	beforeEach(() => {
		vi.mocked(totalFootprint).mockResolvedValue({
			bytes: 1100,
			models: [
				{ id: 'stray-dir', bytes: 100 },
				{ id: 'qwen3-4b', bytes: 1000 },
			],
		});
		vi.mocked(runtimesFootprint).mockResolvedValue(300);
		vi.mocked(directoryBytes).mockImplementation(async (dir: string) =>
			dir.includes('llama-server') ? 120 : 7
		);
		vi.mocked(getModelServerStatus).mockResolvedValue(serverStatus());
	});

	it('totals disk without counting the server engine twice', async () => {
		const { disk } = await collectLocalModelResources();
		expect(disk).toMatchObject({
			modelsBytes: 1100,
			runtimesBytes: 300,
			serverEngineBytes: 120,
			serverDataBytes: 7,
			semanticIndexBytes: 40,
			totalBytes: 1100 + 300 + 7 + 40,
		});
	});

	it('names model directories from the catalog, largest first', async () => {
		const { disk } = await collectLocalModelResources();
		expect(disk.models).toEqual([
			{ id: 'qwen3-4b', name: 'Qwen3 4B', kind: 'text-gen', bytes: 1000, userAdded: false },
			{ id: 'stray-dir', name: 'stray-dir', kind: null, bytes: 100, userAdded: false },
		]);
	});

	it('reports what the shared in-process engines hold', async () => {
		const { inProcess } = await collectLocalModelResources();
		expect(inProcess).toEqual({
			textModel: 'qwen3-4b',
			encoders: ['embedder'],
			speechToText: [],
		});
	});

	it('keeps the server pid while it runs and leaves usage to the caller', async () => {
		const { modelServer } = await collectLocalModelResources();
		expect(modelServer).toMatchObject({ state: 'running', pid: 4321, usage: null });
	});

	it('drops a pid the stopped server no longer owns', async () => {
		vi.mocked(getModelServerStatus).mockResolvedValue(serverStatus({ state: 'stopped' }));
		const { modelServer } = await collectLocalModelResources();
		expect(modelServer.pid).toBeNull();
	});
});
