/**
 * @file routing-log.test.ts
 *
 * The log, and the one number it exists to produce: a hit rate that counts a
 * dispatch the user immediately corrected as a miss.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	flushRoutingLog,
	lastRoutingTurn,
	loadRoutingLog,
	MAX_ENTRIES,
	noteRoutingOutcome,
	readRoutingLog,
	recordRoutingTurn,
	resetRoutingLog,
	routingQuality,
	setRoutingLogPath,
} from '../../../../main/acappella/router/routing-log';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';

function decision(overrides: Partial<RouteDecision> = {}): RouteDecision {
	return {
		target: { sessionId: 'agent-backend' },
		tabAction: 'current',
		prompt: 'run the tests',
		confidence: 0.9,
		...overrides,
	};
}

function record(id: string, overrides: Partial<Parameters<typeof recordRoutingTurn>[0]> = {}) {
	return recordRoutingTurn({
		id,
		utterance: 'run the tests',
		decision: decision(),
		brainProviderId: 'qwen3-local',
		latencyMs: 120,
		contextChars: 900,
		...overrides,
	});
}

let tempDir: string;

beforeEach(async () => {
	resetRoutingLog();
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'acappella-routing-log-'));
	setRoutingLogPath(path.join(tempDir, 'routing-log.json'));
});

afterEach(async () => {
	resetRoutingLog();
	setRoutingLogPath(null);
	await fs.rm(tempDir, { recursive: true, force: true });
});

describe('recordRoutingTurn', () => {
	it('flattens the decision into one readable entry', () => {
		record('turn-1');

		expect(readRoutingLog()[0]).toMatchObject({
			id: 'turn-1',
			utterance: 'run the tests',
			targetSessionId: 'agent-backend',
			tabAction: 'current',
			confidence: 0.9,
			latencyMs: 120,
			contextChars: 900,
			outcome: 'dispatched',
		});
	});

	it('records a question as clarified rather than dispatched', () => {
		record('turn-1', { decision: decision({ clarify: 'Backend or API?', confidence: 0.3 }) });

		expect(readRoutingLog()[0].outcome).toBe('clarified');
	});

	it('truncates the utterance: this is a log, not a transcript', () => {
		record('turn-1', { utterance: 'a'.repeat(1000) });

		expect(readRoutingLog()[0].utterance.length).toBeLessThanOrEqual(200);
	});

	it('keeps the newest entries when it overflows', () => {
		for (let index = 0; index < MAX_ENTRIES + 10; index++) record(`turn-${index}`);

		const entries = readRoutingLog();
		expect(entries).toHaveLength(MAX_ENTRIES);
		expect(entries[entries.length - 1].id).toBe(`turn-${MAX_ENTRIES + 9}`);
	});

	it('hands back a copy, so a reader cannot rewrite history', () => {
		record('turn-1');

		readRoutingLog()[0].outcome = 'failed';

		expect(readRoutingLog()[0].outcome).toBe('dispatched');
	});
});

describe('noteRoutingOutcome', () => {
	it('attaches what actually happened', () => {
		record('turn-1');

		noteRoutingOutcome('turn-1', 'corrected', 'moved to API');

		expect(readRoutingLog()[0]).toMatchObject({ outcome: 'corrected', detail: 'moved to API' });
	});

	it('ignores an id that has aged out', () => {
		record('turn-1');

		expect(() => noteRoutingOutcome('turn-gone', 'failed')).not.toThrow();
		expect(readRoutingLog()).toHaveLength(1);
	});
});

describe('routingQuality', () => {
	it('counts a correction as a miss even though nothing errored', () => {
		record('turn-1');
		record('turn-2');
		record('turn-3');
		noteRoutingOutcome('turn-2', 'corrected');

		const quality = routingQuality();

		expect(quality).toMatchObject({ turns: 3, dispatched: 2, corrected: 1 });
		expect(quality.hitRate).toBeCloseTo(2 / 3);
	});

	it('excludes clarifications from the hit rate entirely', () => {
		record('turn-1');
		record('turn-2', { decision: decision({ clarify: 'Backend or API?' }) });

		const quality = routingQuality();

		expect(quality.clarified).toBe(1);
		// Asking is the correct behaviour below the threshold. Counting it either
		// way would make the threshold impossible to tune.
		expect(quality.hitRate).toBe(1);
	});

	it('reports no hit rate before anything has been decided', () => {
		expect(routingQuality().hitRate).toBeNull();
	});

	it('averages the routing latency', () => {
		record('turn-1', { latencyMs: 100 });
		record('turn-2', { latencyMs: 300 });

		expect(routingQuality().meanLatencyMs).toBe(200);
	});
});

describe('persistence', () => {
	it('writes atomically and reads back', async () => {
		record('turn-1');
		await flushRoutingLog();

		resetRoutingLog();
		await loadRoutingLog();

		expect(readRoutingLog()[0].id).toBe('turn-1');
	});

	it('starts fresh rather than failing when the file is unreadable', async () => {
		await fs.writeFile(path.join(tempDir, 'routing-log.json'), 'not json');

		await loadRoutingLog();

		expect(readRoutingLog()).toEqual([]);
	});

	it('survives a directory that does not exist yet', async () => {
		setRoutingLogPath(path.join(tempDir, 'nested', 'deeper', 'routing-log.json'));
		record('turn-1');

		await flushRoutingLog();

		const raw = await fs.readFile(
			path.join(tempDir, 'nested', 'deeper', 'routing-log.json'),
			'utf-8'
		);
		expect(JSON.parse(raw)[0].id).toBe('turn-1');
	});
});

describe('lastRoutingTurn', () => {
	it('is null before the first decision, then the newest one', () => {
		expect(lastRoutingTurn()).toBeNull();

		record('turn-1');
		record('turn-2');

		expect(lastRoutingTurn()?.id).toBe('turn-2');
	});
});
