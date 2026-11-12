/**
 * @file retrieve-tool.test.ts
 *
 * The core `retrieve_compressed_original` tool: who is offered it, how the
 * model's arguments become a line range, and what a call answers (a header
 * line, then the exact original text, or a tool error that says why).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
	agentHasTokenProxyRetrieval: vi.fn(async (_agentId: string) => false),
	readTokenProxyBlock: vi.fn(),
}));
vi.mock('../../../../main/local-models/proxy/service', () => service);

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({ logger }));

const sentry = vi.hoisted(() => ({ captureException: vi.fn(async () => {}) }));
vi.mock('../../../../main/utils/sentry', () => sentry);

import {
	callTokenProxyRetrieveTool,
	coreBridgeToolsFor,
	formatRetrieveHeader,
	isCoreBridgeToolId,
	parseRetrieveToolArgs,
} from '../../../../main/local-models/proxy/retrieve-tool';
import {
	TOKEN_PROXY_RETRIEVE_INSTRUCTIONS,
	TOKEN_PROXY_RETRIEVE_TOOL_ID,
	TOKEN_PROXY_RETRIEVE_TOOL_NAME,
} from '../../../../shared/local-models/token-proxy-retrieve-tool';
import type { TokenProxyBlockDetail } from '../../../../shared/local-models/token-proxy';
import { PLUGIN_ID_PATTERN } from '../../../../shared/plugins/plugin-manifest';

const hash = 'a'.repeat(64);

function block(
	original: string | null,
	range: { startLine: number; endLine: number } | null,
	hasMore = false
): TokenProxyBlockDetail {
	return {
		hash,
		original,
		originalRange:
			original === null
				? null
				: {
						hash,
						source: 'original' as const,
						requested: range ?? { startLine: 1, endLine: 200 },
						returned: range,
						complete: true,
						hasMore,
					},
		compressed: 'short',
		originalTokens: 100,
		compressedTokens: 10,
		compressors: ['json'],
		createdAt: 1,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	service.agentHasTokenProxyRetrieval.mockResolvedValue(false);
});

describe('coreBridgeToolsFor', () => {
	it('offers nothing to a caller with no valid proof', async () => {
		expect(await coreBridgeToolsFor(null)).toEqual({ tools: [] });
		expect(service.agentHasTokenProxyRetrieval).not.toHaveBeenCalled();
	});

	it('offers nothing to an agent without retrieval in effect', async () => {
		expect(await coreBridgeToolsFor('agent-1')).toEqual({ tools: [] });
		expect(service.agentHasTokenProxyRetrieval).toHaveBeenCalledWith('agent-1');
	});

	it('offers the retrieve tool and the server instructions to an agent with it on', async () => {
		service.agentHasTokenProxyRetrieval.mockResolvedValue(true);
		const offer = await coreBridgeToolsFor('agent-1');
		expect(offer.instructions).toBe(TOKEN_PROXY_RETRIEVE_INSTRUCTIONS);
		expect(offer.tools).toEqual([
			expect.objectContaining({
				name: TOKEN_PROXY_RETRIEVE_TOOL_NAME,
				toolId: TOKEN_PROXY_RETRIEVE_TOOL_ID,
				inputSchema: expect.objectContaining({ required: ['hash'] }),
			}),
		]);
		// The instructions name the marker the model will see.
		expect(offer.instructions).toContain('[maestro-compressed sha256=<hash>');
	});
});

describe('isCoreBridgeToolId', () => {
	it('names the retrieve tool, and that id can never be a plugin tool', () => {
		expect(isCoreBridgeToolId(TOKEN_PROXY_RETRIEVE_TOOL_ID)).toBe(true);
		expect(isCoreBridgeToolId('maestro/retrieve_compressed_original')).toBe(false);
		const pluginId = TOKEN_PROXY_RETRIEVE_TOOL_ID.split('/')[0];
		expect(PLUGIN_ID_PATTERN.test(pluginId)).toBe(false);
	});
});

describe('parseRetrieveToolArgs', () => {
	it('defaults to lines 1 to 200, and to 200 lines from start_line', () => {
		expect(parseRetrieveToolArgs({ hash })).toEqual({
			ok: true,
			hash,
			range: { startLine: 1, endLine: 200 },
		});
		expect(parseRetrieveToolArgs({ hash, start_line: 201 })).toEqual({
			ok: true,
			hash,
			range: { startLine: 201, endLine: 400 },
		});
		expect(parseRetrieveToolArgs({ hash, end_line: 5 })).toEqual({
			ok: true,
			hash,
			range: { startLine: 1, endLine: 5 },
		});
	});

	it('refuses a missing or malformed hash and an invalid range with a message', () => {
		for (const args of [undefined, null, [], 'x', {}, { hash: 'A'.repeat(64) }, { hash: 'abc' }]) {
			const parsed = parseRetrieveToolArgs(args);
			expect(parsed.ok).toBe(false);
		}
		for (const range of [
			{ start_line: 0 },
			{ start_line: 1.5 },
			{ start_line: '1' },
			{ start_line: 5, end_line: 4 },
			{ start_line: 1, end_line: 1001 },
		]) {
			const parsed = parseRetrieveToolArgs({ hash, ...range });
			expect(parsed).toEqual({ ok: false, error: expect.stringContaining('start_line') });
		}
		// A full 1000-line range is allowed.
		expect(parseRetrieveToolArgs({ hash, start_line: 1, end_line: 1000 }).ok).toBe(true);
	});
});

describe('formatRetrieveHeader', () => {
	it('says which lines came back and whether more follow', () => {
		expect(
			formatRetrieveHeader(
				hash,
				{ startLine: 1, endLine: 200 },
				block('x', { startLine: 1, endLine: 200 }, true)
			)
		).toBe(
			`[original sha256=${hash} lines 1-200; more lines follow, call again with start_line=201]`
		);
		expect(
			formatRetrieveHeader(
				hash,
				{ startLine: 1, endLine: 200 },
				block('x', { startLine: 1, endLine: 3 })
			)
		).toBe(`[original sha256=${hash} lines 1-3; this is the end of the original]`);
		expect(formatRetrieveHeader(hash, { startLine: 50, endLine: 60 }, block('', null))).toBe(
			`[original sha256=${hash}: no lines from line 50; the original has fewer lines]`
		);
	});
});

describe('callTokenProxyRetrieveTool', () => {
	it('returns the header line, then the exact original lines', async () => {
		const text = 'line 2\r\n  "id": 3,\n\tline 4\n';
		service.readTokenProxyBlock.mockResolvedValueOnce(
			block(text, { startLine: 2, endLine: 4 }, true)
		);

		const result = await callTokenProxyRetrieveTool({ hash, start_line: 2, end_line: 4 });

		expect(service.readTokenProxyBlock).toHaveBeenCalledWith(hash, { startLine: 2, endLine: 4 });
		expect(result).toEqual({
			ok: true,
			text: `[original sha256=${hash} lines 2-4; more lines follow, call again with start_line=5]\n${text}`,
		});
	});

	it('asks for lines 1 to 200 when the call names no range', async () => {
		service.readTokenProxyBlock.mockResolvedValueOnce(block('a\n', { startLine: 1, endLine: 1 }));
		await callTokenProxyRetrieveTool({ hash });
		expect(service.readTokenProxyBlock).toHaveBeenCalledWith(hash, { startLine: 1, endLine: 200 });
	});

	it('is a tool error for an unknown hash', async () => {
		service.readTokenProxyBlock.mockResolvedValueOnce(null);
		expect(await callTokenProxyRetrieveTool({ hash })).toEqual({
			ok: false,
			error: expect.stringContaining(`No compressed block with hash ${hash}`),
		});
	});

	it('is a tool error for a missing original', async () => {
		service.readTokenProxyBlock.mockResolvedValueOnce(block(null, null));
		expect(await callTokenProxyRetrieveTool({ hash })).toEqual({
			ok: false,
			error: expect.stringContaining('no longer stored'),
		});
	});

	it('is a tool error for an invalid range, without reading the cache', async () => {
		expect(await callTokenProxyRetrieveTool({ hash, start_line: 9, end_line: 2 })).toEqual({
			ok: false,
			error: expect.stringContaining('start_line'),
		});
		expect(service.readTokenProxyBlock).not.toHaveBeenCalled();
	});

	it('passes a byte-limit refusal on to the model, and reports any other failure', async () => {
		service.readTokenProxyBlock.mockRejectedValueOnce(
			new RangeError(
				'Original line range exceeds the 262144-byte output limit; request fewer or shorter lines.'
			)
		);
		expect(await callTokenProxyRetrieveTool({ hash })).toEqual({
			ok: false,
			error: expect.stringContaining('request fewer or shorter lines'),
		});
		expect(sentry.captureException).not.toHaveBeenCalled();

		const failure = new Error('EIO');
		service.readTokenProxyBlock.mockRejectedValueOnce(failure);
		expect(await callTokenProxyRetrieveTool({ hash })).toEqual({
			ok: false,
			error: `The original of block ${hash} could not be read.`,
		});
		expect(sentry.captureException).toHaveBeenCalledWith(failure, expect.any(Object));
	});
});
