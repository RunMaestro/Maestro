/**
 * @file tier-options.test.ts
 *
 * What each harness can launch a tier on: which harnesses get a row, that the
 * sources are asked once and only for a harness that can run on one, that a
 * disabled source is never asked, and that an id with no tiers is refused by
 * name before anything is listed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';

const endpointService = vi.hoisted(() => ({
	getConfiguredLocalModelEndpoints: vi.fn((): unknown[] => []),
	listLocalModelEndpointModels: vi.fn(async (): Promise<unknown> => ({ ok: true, models: [] })),
}));

vi.mock('../../../main/local-models/endpoint-service', () => endpointService);

import {
	configureHarnessTierOptions,
	listHarnessTierOptions,
	listHarnessTierOptionsRequest,
	resetHarnessTierOptionsForTests,
} from '../../../main/local-models/tier-options';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../shared/local-models/model-server';

const ollama: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};
const lmStudio: LocalModelEndpoint = {
	id: 'ep-lm',
	name: 'LM Studio',
	kind: 'lm-studio',
	baseUrl: 'http://127.0.0.1:1234',
	enabled: true,
};
const disabled: LocalModelEndpoint = { ...ollama, id: 'ep-off', name: 'Off', enabled: false };

const installed = vi.fn(async (harness: string) =>
	['claude-code', 'codex', 'factory-droid'].includes(harness)
);
const catalog = vi.fn(async (harness: string, _refresh: boolean) =>
	harness === 'codex' ? [{ id: 'gpt-6-luna', priority: 4 }] : [{ id: `${harness}-model` }]
);

describe('listHarnessTierOptions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetHarnessTierOptionsForTests();
		configureHarnessTierOptions({ installed, catalog });
		endpointService.getConfiguredLocalModelEndpoints.mockReturnValue([ollama, lmStudio, disabled]);
		endpointService.listLocalModelEndpointModels.mockImplementation(async (ref: unknown) => {
			if (ref === MODEL_SERVER_ENDPOINT_ID) return { ok: true, models: [{ id: 'gpt-oss-20b' }] };
			if ((ref as LocalModelEndpoint).id === ollama.id) {
				return { ok: true, models: [{ id: 'qwen3:latest' }] };
			}
			return { ok: false, error: { kind: 'unreachable', message: 'connection refused' } };
		});
	});

	it('answers one row per installed harness that can select a model', async () => {
		const rows = await listHarnessTierOptions();

		expect(rows.map((row) => row.harness)).toEqual(['claude-code', 'codex', 'factory-droid']);
		expect(rows.every((row) => row.installed)).toBe(true);
		expect(rows[1]).toMatchObject({
			name: 'Codex',
			catalog: [{ id: 'gpt-6-luna', priority: 4 }],
			runOn: { supported: true },
		});
		// A harness that is not installed is not asked for its catalogue.
		expect(catalog).toHaveBeenCalledTimes(3);
	});

	it('lists the model server and each enabled source once, for every row', async () => {
		const rows = await listHarnessTierOptions();

		expect(endpointService.listLocalModelEndpointModels).toHaveBeenCalledTimes(3);
		expect(endpointService.listLocalModelEndpointModels).not.toHaveBeenCalledWith(disabled);
		const sources = [
			{
				endpointId: MODEL_SERVER_ENDPOINT_ID,
				name: 'Maestro model server',
				models: ['gpt-oss-20b'],
			},
			{ endpointId: ollama.id, name: 'Ollama', models: ['qwen3:latest'] },
		];
		expect(rows[0].sources).toEqual(sources);
		expect(rows[1].sources).toEqual(sources);
		expect(rows[0].problems).toEqual([
			{ endpointId: lmStudio.id, name: 'LM Studio', message: 'connection refused' },
		]);
	});

	it('gives a harness with no Run on recipe its reason and no sources', async () => {
		const rows = await listHarnessTierOptions();
		const droid = rows[2];

		expect(droid.runOn.supported).toBe(false);
		expect(!droid.runOn.supported && droid.runOn.reason).toMatch(/factory-droid|Factory Droid/);
		expect(droid.sources).toEqual([]);
		expect(droid.problems).toEqual([]);
	});

	it('asks no source when no listed harness can run on one', async () => {
		const rows = await listHarnessTierOptions({ harness: 'factory-droid' });

		expect(rows).toHaveLength(1);
		expect(endpointService.listLocalModelEndpointModels).not.toHaveBeenCalled();
	});

	it('answers a named harness that is not installed, without asking it', async () => {
		const rows = await listHarnessTierOptions({ harness: 'opencode' });

		expect(rows).toEqual([
			expect.objectContaining({ harness: 'opencode', installed: false, catalog: [] }),
		]);
		expect(catalog).not.toHaveBeenCalled();
	});

	it('passes refresh through to the catalogue', async () => {
		await listHarnessTierOptionsRequest({ harness: ' codex ', refresh: true });
		expect(catalog).toHaveBeenCalledWith('codex', true);

		await listHarnessTierOptionsRequest({ harness: 'codex', refresh: 'yes' });
		expect(catalog).toHaveBeenLastCalledWith('codex', false);
	});

	it('refuses an id that names no harness with tiers, before it lists anything', async () => {
		await expect(listHarnessTierOptions({ harness: 'terminal' })).rejects.toThrow(
			/Unknown harness "terminal"/
		);
		await expect(listHarnessTierOptions({ harness: 42 })).rejects.toThrow(/Unknown harness ""/);
		expect(installed).not.toHaveBeenCalled();
		expect(endpointService.listLocalModelEndpointModels).not.toHaveBeenCalled();
	});

	it('reads a request that is not an object as a request for every harness', async () => {
		const rows = await listHarnessTierOptionsRequest(undefined);
		expect(rows).toHaveLength(3);
	});

	it('says so when it is asked before the app wired it', async () => {
		resetHarnessTierOptionsForTests();
		await expect(listHarnessTierOptions()).rejects.toThrow(/still starting/);
	});
});
