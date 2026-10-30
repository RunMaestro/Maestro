/**
 * Tests for `DataviewQueryRunner` (src/main/dataview/query-runner.ts) and the query worker it drives
 * (src/main/dataview/query-worker-host.ts): answers that match the main-process index, the mirror following
 * commits, CSV reads served by main, the watchdog that stops a hung query, a worker that dies, and the
 * inline fallback. The worker is an in-process stand-in that runs the real host and clones every message,
 * as `postMessage` does.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { executeDql, executeInlineDql } from '../../../shared/dataview';
import { createLocalVaultFs } from '../../../main/dataview/vault-fs';
import { VaultIndex } from '../../../main/dataview/vault-index';
import {
	DataviewQueryRunner,
	dataviewQueryTimeoutMessage,
	type QueryWorkerLike,
} from '../../../main/dataview/query-runner';
import { createQueryWorkerHost } from '../../../main/dataview/query-worker-host';
import type {
	QueryWorkerRequest,
	QueryWorkerResponse,
} from '../../../main/dataview/query-worker-protocol';
import {
	DATAVIEW_FIXTURE_VAULT,
	withFixtureCreatedTimes,
} from '../../helpers/dataviewFixtureVault';

const THIS_PATH = 'People/Pedram Amini.md';
const CONNECTIONS_QUERY = [
	'TABLE Company, Role',
	'FROM "People"',
	'WHERE contains(Connection, this.file.link)',
	'SORT file.cday DESC',
].join('\n');

type Listener = (value: never) => void;

/** A worker stand-in running the real host. Messages are cloned and delivered on a later turn. */
class FakeWorker implements QueryWorkerLike {
	readonly requests: QueryWorkerRequest[] = [];
	terminated = false;
	/** Swallow every query: it never answers, like a catastrophic regex. */
	hangQueries = false;
	private readonly listeners: Record<'message' | 'error' | 'exit', Listener[]> = {
		message: [],
		error: [],
		exit: [],
	};
	private readonly handle = createQueryWorkerHost((response: QueryWorkerResponse) => {
		const copy = structuredClone(response);
		setImmediate(() => {
			if (!this.terminated) this.emit('message', copy);
		});
	});

	postMessage(message: QueryWorkerRequest): void {
		if (this.terminated) return;
		const copy = structuredClone(message);
		this.requests.push(copy);
		if (this.hangQueries && copy.type === 'query') return;
		setImmediate(() => {
			if (!this.terminated) this.handle(copy);
		});
	}

	on(event: 'message' | 'error' | 'exit', listener: (value: never) => void): this {
		this.listeners[event].push(listener);
		return this;
	}

	async terminate(): Promise<number> {
		this.terminated = true;
		return 1;
	}

	emit(event: 'message' | 'error' | 'exit', value: unknown): void {
		for (const listener of this.listeners[event]) listener(value as never);
	}

	sent(type: QueryWorkerRequest['type']): QueryWorkerRequest[] {
		return this.requests.filter((request) => request.type === type);
	}
}

/** A spawn function that records every worker it starts. */
function recordingSpawn(configure: (worker: FakeWorker) => void = () => {}) {
	const workers: FakeWorker[] = [];
	const spawn = () => {
		const worker = new FakeWorker();
		configure(worker);
		workers.push(worker);
		return worker;
	};
	return { workers, spawn };
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setImmediate(r));
	expect(check()).toBe(true);
}

let tempDir: string;
let index: VaultIndex;

beforeAll(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-query-runner-'));
	fs.cpSync(DATAVIEW_FIXTURE_VAULT, tempDir, { recursive: true });
	index = new VaultIndex(withFixtureCreatedTimes(createLocalVaultFs(tempDir)), {
		onWarning: () => {},
		watch: false,
	});
	await index.scan();
});

afterAll(async () => {
	await index.dispose();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('DataviewQueryRunner with a worker', () => {
	it('answers a block and an inline expression exactly as the main-process index does', async () => {
		const { workers, spawn } = recordingSpawn();
		const runner = new DataviewQueryRunner(index, { spawn });

		expect(await runner.dql(CONNECTIONS_QUERY, THIS_PATH)).toEqual(
			await executeDql(CONNECTIONS_QUERY, THIS_PATH, index)
		);
		expect(await runner.inlineQuery('= length(this.file.outlinks)', THIS_PATH)).toEqual(
			executeInlineDql('= length(this.file.outlinks)', THIS_PATH, index)
		);
		// One worker, synced once from the whole index, then two queries.
		expect(workers).toHaveLength(1);
		expect(workers[0].sent('begin')).toEqual([expect.objectContaining({ reset: true })]);
		expect(workers[0].sent('query')).toHaveLength(2);
		await runner.dispose();
		expect(workers[0].terminated).toBe(true);
	});

	it('follows the commits that land after its sync', async () => {
		const { workers, spawn } = recordingSpawn();
		const runner = new DataviewQueryRunner(index, { spawn });
		const query = 'LIST FROM "Inbox"';
		expect(await runner.dql(query, THIS_PATH)).toEqual(await executeDql(query, THIS_PATH, index));

		fs.mkdirSync(path.join(tempDir, 'Inbox'), { recursive: true });
		fs.writeFileSync(path.join(tempDir, 'Inbox', 'Fresh.md'), '# Fresh\n');
		await index.applyChangedPaths(['Inbox', 'Inbox/Fresh.md']);

		const after = await runner.dql(query, THIS_PATH);
		expect(after).toEqual(await executeDql(query, THIS_PATH, index));
		expect(after).toMatchObject({ kind: 'list' });
		expect((after as { items: unknown[] }).items).toHaveLength(1);
		// The change arrived as an update, not as a second full sync.
		expect(workers).toHaveLength(1);
		expect(workers[0].sent('begin').map((b) => (b as { reset: boolean }).reset)).toEqual([
			true,
			false,
		]);
		await runner.dispose();
	});

	it('serves the CSV reads the worker asks for from main', async () => {
		const { workers, spawn } = recordingSpawn();
		const runner = new DataviewQueryRunner(index, { spawn });
		const query = 'TABLE company FROM csv("data/people.csv")';

		expect(await runner.dql(query, THIS_PATH)).toEqual(await executeDql(query, THIS_PATH, index));
		expect(workers[0].sent('readResult')).toEqual([
			expect.objectContaining({ text: expect.stringContaining('Rami Example') }),
		]);
		await runner.dispose();
	});

	it('stops a query that runs past its budget, holds it off, and restarts for the next one', async () => {
		let hang = true;
		const { workers, spawn } = recordingSpawn((worker) => {
			worker.hangQueries = hang;
		});
		const runner = new DataviewQueryRunner(index, { spawn, timeoutMs: 50, retryAfterMs: 60_000 });
		const stuck = 'LIST WHERE regexmatch("(a+)+$", file.name)';
		const timeout = { kind: 'error', message: dataviewQueryTimeoutMessage(50, 60_000) };

		expect(await runner.dql(stuck, THIS_PATH)).toEqual(timeout);
		expect(workers[0].terminated).toBe(true);
		expect(runner.workerRunning).toBe(false);

		// The same query on the same note answers the error at once, without a new worker.
		expect(await runner.dql(stuck, THIS_PATH)).toEqual(timeout);
		expect(workers).toHaveLength(1);

		// Another query starts a new worker, synced from scratch.
		hang = false;
		expect(await runner.dql(CONNECTIONS_QUERY, THIS_PATH)).toEqual(
			await executeDql(CONNECTIONS_QUERY, THIS_PATH, index)
		);
		expect(workers).toHaveLength(2);
		expect(workers[1].sent('begin')).toEqual([expect.objectContaining({ reset: true })]);
		await runner.dispose();
	});

	it('words a stopped inline expression the way Dataview words an inline failure', async () => {
		const { spawn } = recordingSpawn((worker) => {
			worker.hangQueries = true;
		});
		const runner = new DataviewQueryRunner(index, { spawn, timeoutMs: 20, retryAfterMs: 2000 });

		expect(await runner.inlineQuery('= this.file.name', THIS_PATH)).toEqual({
			kind: 'error',
			message: `Dataview (for inline query 'this.file.name'): the query ran longer than 0.02 seconds and was stopped. It runs again after 2 seconds, or as soon as you edit it.`,
		});
		await runner.dispose();
	});

	it('answers an error when the worker dies under a query, and starts fresh for the next', async () => {
		let hang = true;
		const { workers, spawn } = recordingSpawn((worker) => {
			worker.hangQueries = hang;
		});
		const runner = new DataviewQueryRunner(index, { spawn });

		const pending = runner.dql('LIST', THIS_PATH);
		await waitFor(() => workers[0]?.sent('query').length === 1);
		workers[0].emit('exit', 1);
		expect(await pending).toEqual({
			kind: 'error',
			message: 'Dataview: the query worker stopped (code 1).',
		});

		hang = false;
		expect(await runner.dql(CONNECTIONS_QUERY, THIS_PATH)).toMatchObject({ kind: 'table' });
		expect(workers).toHaveLength(2);
		await runner.dispose();
	});
});

describe('DataviewQueryRunner without a worker', () => {
	it('runs queries on the calling thread when no worker can start', async () => {
		const spawn = vi.fn(() => null);
		const runner = new DataviewQueryRunner(index, { spawn });

		expect(await runner.dql(CONNECTIONS_QUERY, THIS_PATH)).toEqual(
			await executeDql(CONNECTIONS_QUERY, THIS_PATH, index)
		);
		await runner.dql('LIST', THIS_PATH);
		// Decided once: a build without the worker script does not keep trying.
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(runner.workerRunning).toBe(false);
		await runner.dispose();
	});
});
