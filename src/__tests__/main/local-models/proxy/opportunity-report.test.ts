/**
 * @file opportunity-report.test.ts
 *
 * The read opportunities the user sees, through the product's own path: the
 * proxy service starts a real server for an agent in a compress mode, the real
 * compressor and the real observer run behind it, and the report the Gateway
 * section and `models proxy status` read says what the proxy noticed. Only the
 * provider (a loopback server) and the stats database are stood in for.
 *
 * What it pins: the upstream receives the request byte for byte, the agent's
 * working directories come from its stored record, a passthrough agent is never
 * examined, and what was noticed sits in the report apart from what was removed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

const tempRoot = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({ app: { getPath: () => tempRoot.dir } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn(async () => {}) }));
vi.mock('../../../../main/prompt-manager', () => ({ getPrompt: vi.fn() }));
vi.mock('../../../../main/local-models/task-router', () => ({ runLocalTask: vi.fn() }));
vi.mock('../../../../main/local-models/task-notices', () => ({
	reportLocalTaskUnavailable: vi.fn(),
}));

// The stats database is its own suite. The request recorder is what the realized side reads.
const requestStats = vi.hoisted(() => ({
	recordTokenProxyRequest: vi.fn(),
	readTokenProxyUsage: vi.fn(() => ({ usage: null, recentCompressions: [] as unknown[] })),
}));
vi.mock('../../../../main/local-models/proxy/request-stats', () => requestStats);

import {
	configureTokenProxy,
	ensureTokenProxyPort,
	getTokenProxyReport,
	resetTokenProxyForTests,
	syncTokenProxy,
} from '../../../../main/local-models/proxy/service';
import { createTokenProxyServer } from '../../../../main/local-models/proxy/server';
import { tokenProxyGatewayUrl } from '../../../../shared/local-models/token-proxy';
import { body, numbered, read, ROOT } from '../../../helpers/proxyReadRequests';

const lines = Array.from(
	{ length: 60 },
	(_, i) => `line ${i}: text that makes this line long enough`
);
const notes = () => read(numbered(lines), { file_path: `${ROOT}/docs/notes.txt` });

let upstream: http.Server;
let received: string[];
let agents: Array<Record<string, unknown>>;
let port: number;

async function post(agentId: string, text: string): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${port}/agent/${agentId}/anthropic/v1/messages`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test' },
		body: text,
	});
	return response.text();
}

async function observed(): Promise<number> {
	return (await getTokenProxyReport()).readOpportunities?.coverage.observed ?? 0;
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.stubEnv('MAESTRO_USER_DATA', undefined as unknown as string);
	tempRoot.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-opportunity-report-'));
	received = [];
	upstream = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			received.push(Buffer.concat(chunks).toString('utf-8'));
			res.end('ok');
		});
	});
	await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

	configureTokenProxy({
		sessions: () => agents,
		dataDir: () => tempRoot.dir,
		createServer: (options) =>
			createTokenProxyServer({
				...options,
				upstreams: { anthropic: origin, openai: origin, chatgpt: origin },
			}) as never,
	});
	port = await ensureTokenProxyPort();
	const gatewayUrl = tokenProxyGatewayUrl(port, 'anthropic');
	agents = [
		{
			id: 'compressing',
			name: 'Compressing',
			toolType: 'claude-code',
			gatewayUrl,
			tokenProxyMode: 'compress',
			projectRoot: ROOT,
			cwd: ROOT,
		},
		{
			id: 'passing',
			name: 'Passing',
			toolType: 'claude-code',
			gatewayUrl,
			tokenProxyMode: 'passthrough',
			projectRoot: ROOT,
			cwd: ROOT,
		},
		{
			id: 'homeless',
			name: 'Homeless',
			toolType: 'claude-code',
			gatewayUrl,
			tokenProxyMode: 'compress',
		},
	];
	await syncTokenProxy();
});

afterEach(async () => {
	await resetTokenProxyForTests();
	await new Promise<void>((resolve) => {
		upstream.close(() => resolve());
		upstream.closeAllConnections();
	});
	vi.unstubAllEnvs();
	await fs.rm(tempRoot.dir, { recursive: true, force: true });
});

describe('read opportunities through the proxy service', () => {
	it('notices a re-read for an agent in a compress mode and sends the request as it came', async () => {
		const text = body('anthropic-messages', [notes(), notes()]);

		expect(await post('compressing', text)).toBe('ok');
		await vi.waitFor(async () => expect(await observed()).toBe(1));

		// The provider got exactly what the agent sent.
		expect(received).toEqual([text]);
		const report = await getTokenProxyReport();
		expect(report.readOpportunities).toMatchObject({
			mode: 'observation',
			realized: false,
			coverage: { observed: 1, withReads: 1 },
			reads: { examined: 1, identical: 1 },
			previews: { unchanged: 1 },
		});
		expect(report.readOpportunities?.recent[0]).toMatchObject({
			kind: 'unchanged-read',
			agentId: 'compressing',
			path: `${ROOT}/docs/notes.txt`,
			potential: { realized: false },
		});
	});

	it('keeps what was noticed apart from what the proxy removed', async () => {
		await post('compressing', body('anthropic-messages', [notes(), notes()]));
		await vi.waitFor(async () => expect(await observed()).toBe(1));

		// The recorder saw a request that lost nothing: the compressor left it alone.
		const logged = requestStats.recordTokenProxyRequest.mock.calls[0][0];
		expect(logged.compression).toMatchObject({ changed: false });
		expect(logged.compression.sentTokens).toBe(logged.compression.originalTokens);
		expect(JSON.stringify(logged)).not.toMatch(/potential|opportunit/i);
		// The opportunity is a field of its own, beside the usage, never inside it.
		const report = await getTokenProxyReport();
		expect(Object.keys(report)).toEqual(
			expect.arrayContaining(['usage', 'recentCompressions', 'readOpportunities'])
		);
		expect(JSON.stringify(report.usage)).not.toMatch(/potential|opportunit/i);
		expect(report.readOpportunities?.previews.potentialTokens).toBeGreaterThan(0);
	});

	it('never examines an agent in passthrough, whose body the proxy does not read', async () => {
		const text = body('anthropic-messages', [notes(), notes()]);

		await post('passing', text);
		await vi.waitFor(() => expect(received).toHaveLength(1));
		// Give a deferred observation every chance to run.
		for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));

		expect(received).toEqual([text]);
		expect((await getTokenProxyReport()).readOpportunities).toMatchObject({
			coverage: { observed: 0, skipped: { busy: 0, 'no-workspace': 0 } },
			reads: { examined: 0 },
		});
	});

	it('counts a request for an agent with no working directory instead of guessing one', async () => {
		await post('homeless', body('anthropic-messages', [notes(), notes()]));

		await vi.waitFor(async () =>
			expect(
				(await getTokenProxyReport()).readOpportunities?.coverage.skipped['no-workspace']
			).toBe(1)
		);
		expect((await getTokenProxyReport()).readOpportunities).toMatchObject({
			coverage: { observed: 0 },
			reads: { examined: 0 },
			recent: [],
		});
	});

	it('lists the identity it cannot see, and forgets everything with the rest of its state', async () => {
		await post('compressing', body('anthropic-messages', [notes(), notes()]));
		await vi.waitFor(async () => expect(await observed()).toBe(1));
		expect((await getTokenProxyReport()).readOpportunities?.identity.unavailable).toEqual([
			'tab',
			'native-session',
			'subagent',
			'window',
		]);

		await resetTokenProxyForTests();

		expect((await getTokenProxyReport()).readOpportunities).toMatchObject({
			coverage: { observed: 0 },
			recent: [],
		});
	});
});
