/**
 * @file models-tiers.test.ts
 * @description Tests for `maestro-cli models tiers list|options|suggest|set|reset`:
 * list reads the settings file and names the layer of every value, options and
 * suggest cross the WS bridge in the shape the desktop handler expects, and the
 * writers check and store through the same shared helpers as the Tier defaults
 * table (a source named by id prefix is stored by full id, a source on a
 * harness with no Run on recipe is refused, `default` clears one tier).
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readHarnessTierDefaults: vi.fn(() => ({})),
	writeHarnessTierDefaults: vi.fn(),
	readLocalModelEndpoints: vi.fn(() => []),
}));

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	modelsTiersList,
	modelsTiersOptions,
	modelsTiersReset,
	modelsTiersSet,
	modelsTiersSuggest,
} from '../../../cli/commands/models-tiers';
import {
	readHarnessTierDefaults,
	readLocalModelEndpoints,
	writeHarnessTierDefaults,
} from '../../../cli/services/storage';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../shared/local-models/model-server';
import type { HarnessTierOptions } from '../../../shared/local-models/tier-options';
import type { HarnessTierDefaults } from '../../../shared/modelTiers';

const ollama: LocalModelEndpoint = {
	id: 'aaaa-1111-2222',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

const CODEX_OPTIONS: HarnessTierOptions = {
	harness: 'codex',
	name: 'Codex',
	installed: true,
	catalog: [
		{ id: 'gpt-6.1-sol', description: 'Latest workhorse model.', priority: 1 },
		{ id: 'gpt-6-astra', description: 'Frontier intelligence.', priority: 2 },
		{ id: 'gpt-7-luna', description: 'Fast and affordable model.', priority: 3 },
	],
	runOn: { supported: true },
	sources: [{ endpointId: ollama.id, name: 'Ollama', models: ['qwen3:latest'] }],
	problems: [{ endpointId: 'bbbb', name: 'LM Studio', message: 'connection refused' }],
};

function mockSend(reply: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string } = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				captured.payload = payload;
				captured.responseType = rt;
				return Promise.resolve(reply);
			}),
		} as never)
	);
	return captured;
}

describe('models tiers commands', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;
	let stored: HarnessTierDefaults;

	const printed = () => logSpy.mock.calls.map(([line]) => String(line)).join('\n');
	const json = () => JSON.parse(String(logSpy.mock.calls[0][0]));

	beforeEach(() => {
		vi.clearAllMocks();
		stored = {};
		// A write is what the next read returns, as with the real settings file.
		vi.mocked(readHarnessTierDefaults).mockImplementation(() => stored);
		vi.mocked(writeHarnessTierDefaults).mockImplementation((next) => {
			stored = next;
		});
		vi.mocked(readLocalModelEndpoints).mockReturnValue([ollama]);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	describe('list', () => {
		it('prints each tier with its value and the layer it came from', () => {
			stored = { 'claude-code': { low: { type: 'source', endpointId: ollama.id, model: 'q' } } };
			modelsTiersList({ harness: 'claude-code' });

			const out = printed();
			expect(out).toMatch(/Claude Code/);
			expect(out).toMatch(/low\s+aaaa-1111-2222:q\s+Harness default/);
			expect(out).toMatch(/medium\s+provider:sonnet\s+Built-in/);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('lists every harness that has tiers, with a tier nothing maps', () => {
			modelsTiersList({ json: true });

			const reply = json();
			expect(reply.success).toBe(true);
			const harnesses = reply.harnesses.map((row: { harness: string }) => row.harness);
			expect(harnesses).toEqual(expect.arrayContaining(['claude-code', 'codex', 'opencode']));
			const opencode = reply.harnesses.find(
				(row: { harness: string }) => row.harness === 'opencode'
			);
			expect(opencode.tiers[0]).toEqual({
				tier: 'low',
				target: null,
				spec: null,
				label: null,
				source: null,
				builtIn: null,
			});
		});

		it('refuses a harness that has no tiers', () => {
			expect(() => modelsTiersList({ harness: 'terminal' })).toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(/Unknown harness "terminal"/);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});
	});

	describe('options', () => {
		it('asks the desktop for one harness and prints each choice as set takes it', async () => {
			const captured = mockSend({ success: true, options: [CODEX_OPTIONS] });
			await modelsTiersOptions('codex', {});

			expect(captured.payload).toEqual({ type: 'local_models_tier_options', harness: 'codex' });
			expect(captured.responseType).toBe('local_models_tier_options_result');
			const out = printed();
			expect(out).toMatch(/provider:gpt-6\.1-sol\s+priority 1\s+Latest workhorse model\./);
			expect(out).toMatch(/aaaa-1111-2222:qwen3:latest/);
			expect(out).toMatch(/LM Studio: connection refused/);
			// The built-in low slug (gpt-6-luna) is not in this catalogue.
			expect(out).toMatch(/"low" tier is gpt-6-luna \(Built-in\).*Suggest would use gpt-7-luna/);
		});

		it('passes --refresh and answers whole as JSON', async () => {
			const captured = mockSend({ success: true, options: [CODEX_OPTIONS] });
			await modelsTiersOptions('codex', { json: true, refresh: true });

			expect(captured.payload).toMatchObject({ refresh: true });
			const reply = json();
			expect(reply).toMatchObject({ success: true, harness: 'codex', installed: true });
			expect(reply.stale).toEqual([
				{ tier: 'low', model: 'gpt-6-luna', source: 'built-in', replacement: 'gpt-7-luna' },
			]);
		});

		it('fails with the desktop error', async () => {
			mockSend({ success: false, error: 'the app is still starting' });
			await expect(modelsTiersOptions('codex', {})).rejects.toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(/still starting/);
		});

		it('validates the harness before it sends anything', async () => {
			await expect(modelsTiersOptions('nope', {})).rejects.toThrow('__exit__');
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('suggest', () => {
		it('prints a suggestion and its reason per tier and saves nothing', async () => {
			mockSend({ success: true, options: [CODEX_OPTIONS] });
			await modelsTiersSuggest('codex', {});

			const out = printed();
			expect(out).toMatch(/low\s+provider:gpt-7-luna\s+the only Luna listed/);
			expect(out).toMatch(/medium\s+provider:gpt-6\.1-sol\s+the only Sol listed/);
			expect(out).toMatch(/models tiers suggest codex --apply/);
			expect(writeHarnessTierDefaults).not.toHaveBeenCalled();
		});

		it('saves the suggested tiers with --apply and keeps a tier nothing was suggested for', async () => {
			stored = { codex: { high: { type: 'provider-model', model: 'mine' } } };
			const noAstra = {
				...CODEX_OPTIONS,
				catalog: CODEX_OPTIONS.catalog.filter((model) => model.id !== 'gpt-6-astra'),
			};
			mockSend({ success: true, options: [noAstra] });
			await modelsTiersSuggest('codex', { apply: true, json: true });

			expect(stored).toEqual({
				codex: {
					low: { type: 'provider-model', model: 'gpt-7-luna' },
					medium: { type: 'provider-model', model: 'gpt-6.1-sol' },
					high: { type: 'provider-model', model: 'mine' },
				},
			});
			expect(json().applied).toEqual(['low', 'medium']);
		});

		it('says so when there is nothing to save', async () => {
			mockSend({
				success: true,
				options: [
					{ ...CODEX_OPTIONS, harness: 'opencode', name: 'OpenCode', catalog: [], sources: [] },
				],
			});
			await modelsTiersSuggest('opencode', { apply: true });

			expect(writeHarnessTierDefaults).not.toHaveBeenCalled();
			expect(printed()).toMatch(/Nothing to save/);
		});
	});

	describe('set', () => {
		it('stores a provider model and reads it back', () => {
			modelsTiersSet('claude-code', 'high', 'provider:claude-opus-4-8', {});

			expect(stored).toEqual({
				'claude-code': { high: { type: 'provider-model', model: 'claude-opus-4-8' } },
			});
			expect(printed()).toMatch(/Claude Code high -> provider:claude-opus-4-8 \(Harness default\)/);
		});

		it('stores a source named by id prefix under its full id', () => {
			modelsTiersSet('claude-code', 'low', 'aaaa:qwen3:latest', { json: true });

			expect(stored).toEqual({
				'claude-code': { low: { type: 'source', endpointId: ollama.id, model: 'qwen3:latest' } },
			});
			expect(json()).toMatchObject({
				success: true,
				harness: 'claude-code',
				tiers: [{ tier: 'low', spec: 'aaaa-1111-2222:qwen3:latest', source: 'harness-default' }],
			});
		});

		it('takes the Maestro model server by its own id', () => {
			modelsTiersSet('codex', 'low', `${MODEL_SERVER_ENDPOINT_ID}:gpt-oss-20b-mxfp4`, {});
			expect(stored.codex?.low).toEqual({
				type: 'source',
				endpointId: MODEL_SERVER_ENDPOINT_ID,
				model: 'gpt-oss-20b-mxfp4',
			});
		});

		it('clears one tier with default, back to the built-in table', () => {
			stored = {
				'claude-code': {
					low: { type: 'provider-model', model: 'x' },
					high: { type: 'provider-model', model: 'y' },
				},
			};
			modelsTiersSet('claude-code', 'low', 'default', {});

			expect(stored).toEqual({ 'claude-code': { high: { type: 'provider-model', model: 'y' } } });
			expect(printed()).toMatch(/Claude Code low -> provider:haiku \(Built-in\)/);
		});

		it('refuses a source for a harness with no Run on recipe', () => {
			expect(() => modelsTiersSet('factory-droid', 'low', 'aaaa:qwen3', {})).toThrow('__exit__');
			expect(writeHarnessTierDefaults).not.toHaveBeenCalled();
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});

		it('refuses a source that names nothing, an unknown tier, and a bare word', () => {
			expect(() => modelsTiersSet('claude-code', 'low', 'zzzz:m', {})).toThrow('__exit__');
			expect(() => modelsTiersSet('claude-code', 'max', 'provider', {})).toThrow('__exit__');
			expect(errorSpy.mock.calls[1][0]).toMatch(/Unknown tier "max"/);
			expect(() => modelsTiersSet('claude-code', 'low', 'opus', {})).toThrow('__exit__');
			expect(errorSpy.mock.calls[2][0]).toMatch(/provider:<model>.*Got "opus"/);
			expect(writeHarnessTierDefaults).not.toHaveBeenCalled();
		});

		it('warns when the source is disabled', () => {
			vi.mocked(readLocalModelEndpoints).mockReturnValue([{ ...ollama, enabled: false }]);
			modelsTiersSet('claude-code', 'low', 'Ollama:qwen3', {});
			expect(printed()).toMatch(/source is disabled/);
		});
	});

	describe('reset', () => {
		beforeEach(() => {
			stored = {
				'claude-code': {
					low: { type: 'provider-model', model: 'x' },
					high: { type: 'provider-model', model: 'y' },
				},
				codex: { low: { type: 'provider-model', model: 'z' } },
			};
		});

		it('puts the whole harness back on the built-in table', () => {
			modelsTiersReset('claude-code', {});

			expect(stored).toEqual({ codex: { low: { type: 'provider-model', model: 'z' } } });
			expect(printed()).toMatch(/Claude Code high -> provider:opus \(Built-in\)/);
		});

		it('resets one tier with --tier', () => {
			modelsTiersReset('claude-code', { tier: 'low', json: true });

			expect(stored['claude-code']).toEqual({ high: { type: 'provider-model', model: 'y' } });
			expect(json().tiers).toEqual([
				expect.objectContaining({ tier: 'low', spec: 'provider:haiku', source: 'built-in' }),
			]);
		});
	});
});
