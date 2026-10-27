/**
 * @file pianola-memory.test.ts
 * @description Tests for the memory CLI's configuration of the recall qualifier.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoryConfig, MemoryState } from '../../../shared/pianola/memory';

const { sendCommandMock, ensurePianolaEnabledMock } = vi.hoisted(() => ({
	sendCommandMock: vi.fn(),
	ensurePianolaEnabledMock: vi.fn(),
}));

vi.mock('../../../cli/services/maestro-client', () => ({
	MaestroClient: class {
		async connect() {}
		disconnect() {}
		async sendCommand(command: { args: unknown[] }) {
			return sendCommandMock(command);
		}
	},
}));
vi.mock('../../../cli/commands/pianola', () => ({
	ensurePianolaEnabled: ensurePianolaEnabledMock,
}));

import { pianolaMemory } from '../../../cli/commands/pianola-memory';

const baseConfig: MemoryConfig = {
	enabled: true,
	userId: 'owner',
	roots: [],
	exclusions: [],
	mode: 'local',
	hostedProvider: 'openai',
	endpoint: 'http://127.0.0.1:11434',
	model: 'qwen3:8b',
	hostedConsent: false,
	inputPrice: 0,
	outputPrice: 0,
	tokenBudget: 1000,
	dollarBudget: 0,
	ongoing: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	sendCommandMock.mockImplementation(async (command: { args: unknown[] }) => {
		const request = command.args[0] as { action: string };
		if (request.action === 'status')
			return {
				ok: true,
				result: {
					config: baseConfig,
					progress: {
						running: false,
						paused: false,
						phase: 'idle',
						sources: 0,
						completed: 0,
						failed: 0,
						excluded: 0,
						pending: 0,
						memories: 0,
						inputTokens: 0,
						outputTokens: 0,
						reservedTokens: 0,
						dollars: 0,
						error: null,
						embeddingSpace: 'synthetic',
					},
				},
			};
		return { ok: true, result: {} };
	});
});

/** The configure request the CLI sent. */
const sentConfigure = (): Partial<MemoryConfig> => {
	const call = sendCommandMock.mock.calls.at(-1)?.[0] as { args: unknown[] };
	const request = call.args[0] as { action: string; config: Partial<MemoryConfig> };
	return request.config;
};

describe('memory qualification configuration', () => {
	it('leaves the qualification unset when no qualification option is given', async () => {
		await pianolaMemory('configure', [], { mode: 'local' });
		const config = sentConfigure();
		expect(config.qualification).toBeUndefined();
	});

	it('sets the qualification provider, model and endpoint from the options', async () => {
		await pianolaMemory('configure', [], {
			qualifyProvider: 'hosted',
			qualifyModel: 'qwen3.6',
			qualifyEndpoint: 'https://api.nan.builders',
		});
		const config = sentConfigure();
		expect(config.qualification).toEqual({
			provider: 'hosted',
			model: 'qwen3.6',
			endpoint: 'https://api.nan.builders',
		});
	});

	it('keeps the existing qualification when only the model changes', async () => {
		sendCommandMock.mockImplementation(async (command: { args: unknown[] }) => {
			const request = command.args[0] as { action: string };
			if (request.action === 'status')
				return {
					ok: true,
					result: {
						config: {
							...baseConfig,
							qualification: {
								provider: 'hosted',
								model: 'qwen3.6',
								endpoint: 'https://api.nan.builders',
								apiKeyEnv: 'NAN_API_KEY',
							},
						},
					},
				};
			return { ok: true, result: {} };
		});
		await pianolaMemory('configure', [], { qualifyModel: 'qwen3.8-flash' });
		const config = sentConfigure();
		expect(config.qualification).toEqual({
			provider: 'hosted',
			model: 'qwen3.8-flash',
			endpoint: 'https://api.nan.builders',
			apiKeyEnv: 'NAN_API_KEY',
		});
	});

	it('does not change the extraction provider or consent', async () => {
		await pianolaMemory('configure', [], { qualifyModel: 'qwen3.6' });
		const config = sentConfigure();
		expect(config.model).toBeUndefined();
		expect(config.hostedProvider).toBeUndefined();
		expect(config.hostedConsent).toBeUndefined();
	});
});

describe('memory root attribution', () => {
	it('attributes only enabled roots without re-enabling disabled history', async () => {
		const disabled = {
			provider: 'codex',
			path: '/disabled',
			userId: null,
			authorship: 'unknown' as const,
			enabled: false,
		};
		const enabled = { ...disabled, provider: 'omp', path: '/enabled', enabled: true };
		sendCommandMock.mockImplementation(async (command: { args: unknown[] }) => {
			const request = command.args[0] as { action: string };
			if (request.action === 'status')
				return { ok: true, result: { config: { ...baseConfig, roots: [disabled, enabled] } } };
			return { ok: true, result: {} };
		});
		await pianolaMemory('configure', [], { mine: true });
		expect(sentConfigure().roots).toEqual([
			disabled,
			{ ...enabled, userId: 'owner', authorship: 'human' },
		]);
	});
});

describe('memory rerank configuration', () => {
	it('sets the hosted reranker without changing extraction consent', async () => {
		await pianolaMemory('configure', [], {
			rerankModel: 'rerank-v2',
			rerankEndpoint: 'https://api.nan.builders',
		});
		const config = sentConfigure();
		expect(config.rerank).toEqual({
			provider: 'hosted',
			model: 'rerank-v2',
			endpoint: 'https://api.nan.builders',
		});
		expect(config.hostedConsent).toBeUndefined();
		expect(config.model).toBeUndefined();
	});

	it('opts only the current recall into reranking', async () => {
		await pianolaMemory('recall', ['storage', 'decision'], {
			rerank: true,
			intent: 'current',
			json: true,
		});
		const call = sendCommandMock.mock.calls.at(-1)?.[0] as {
			args: [{ query: { query: string; rerank?: boolean; qualify?: boolean } }];
		};
		expect(call.args[0].query).toMatchObject({
			query: 'storage decision',
			rerank: true,
		});
		expect(call.args[0].query.qualify).toBeUndefined();
	});
});
