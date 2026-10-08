/**
 * @file agent-run-store-concurrency.test.ts
 * @description Store write-safety tests (F0): the locked mutators must persist
 * every record without dropping the loser of an interleaved read-modify-write.
 * Uses a real temp MAESTRO_USER_DATA dir + real fs (not fs mocks) so the writes
 * go through the actual withStoreLock + atomicWriteJson path and round-trip
 * through the real readers on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	appendAgentRunEvent,
	readAgentRunEvents,
	readAgentRuns,
	readCampaigns,
	upsertAgentRun,
	writeAgentRuns,
	writeCampaigns,
	type AgentRun,
	type AgentRunEvent,
	type Campaign,
} from '../../../cli/services/agent-run-store';

const AGENT_RUN_EVENTS_FILE = 'maestro-agent-run-events.jsonl';

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
	prevEnv = process.env.MAESTRO_USER_DATA;
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-store-conc-'));
	process.env.MAESTRO_USER_DATA = tmpDir;
});

afterEach(() => {
	if (prevEnv === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = prevEnv;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
	id: 'run-1',
	createdAt: 100,
	updatedAt: 100,
	provider: 'claude-code',
	status: 'queued',
	artifacts: [],
	touchedFiles: [],
	checks: [],
	reviews: [],
	...overrides,
});

const event = (overrides: Partial<AgentRunEvent> = {}): AgentRunEvent => ({
	id: 'event-1',
	runId: 'run-1',
	timestamp: 200,
	type: 'status',
	...overrides,
});

const campaign = (overrides: Partial<Campaign> = {}): Campaign => ({
	id: 'campaign-1',
	title: 'Campaign One',
	createdAt: 100,
	updatedAt: 100,
	status: 'queued',
	runIds: [],
	tasks: [],
	...overrides,
});

describe('agent-run store write-safety', () => {
	it('persists two sequential upserts of different run ids without dropping either', () => {
		// The classic lost-update shape: the second upsert must re-read the snapshot
		// the first one committed, not an empty in-memory baseline.
		upsertAgentRun(run({ id: 'run-a' }));
		upsertAgentRun(run({ id: 'run-b' }));

		const ids = readAgentRuns()
			.map((entry) => entry.id)
			.sort();
		expect(ids).toEqual(['run-a', 'run-b']);
	});

	it('appends events for two different runs: both JSONL lines land and each snapshot updates', () => {
		writeAgentRuns([
			run({ id: 'run-a', status: 'running', updatedAt: 100 }),
			run({ id: 'run-b', status: 'running', updatedAt: 100 }),
		]);

		appendAgentRunEvent(
			event({ id: 'ev-a', runId: 'run-a', type: 'status', status: 'completed', timestamp: 500 })
		);
		appendAgentRunEvent(
			event({ id: 'ev-b', runId: 'run-b', type: 'status', status: 'failed', timestamp: 600 })
		);

		// The JSONL append is additive: both lines survive on disk in order.
		const rawLines = fs
			.readFileSync(path.join(tmpDir, AGENT_RUN_EVENTS_FILE), 'utf-8')
			.trim()
			.split('\n');
		expect(rawLines.map((line) => (JSON.parse(line) as AgentRunEvent).id)).toEqual([
			'ev-a',
			'ev-b',
		]);

		// Each run's events are retrievable independently through the public reader.
		expect(readAgentRunEvents('run-a').map((e) => e.id)).toEqual(['ev-a']);
		expect(readAgentRunEvents('run-b').map((e) => e.id)).toEqual(['ev-b']);

		// Each run snapshot picked up its own event's status + timestamp, no cross-talk.
		const runs = new Map(readAgentRuns().map((entry) => [entry.id, entry]));
		expect(runs.get('run-a')).toMatchObject({ status: 'completed', updatedAt: 500 });
		expect(runs.get('run-b')).toMatchObject({ status: 'failed', updatedAt: 600 });
	});

	it('round-trips writeAgentRuns full-snapshot writes through readAgentRuns', () => {
		writeAgentRuns([
			run({ id: 'run-a', status: 'running', updatedAt: 10 }),
			run({ id: 'run-b', status: 'completed', updatedAt: 20 }),
		]);

		const persisted = new Map(readAgentRuns().map((entry) => [entry.id, entry]));
		expect([...persisted.keys()].sort()).toEqual(['run-a', 'run-b']);
		expect(persisted.get('run-a')).toMatchObject({ status: 'running', updatedAt: 10 });
		expect(persisted.get('run-b')).toMatchObject({ status: 'completed', updatedAt: 20 });
	});

	it('round-trips writeCampaigns full-snapshot writes through readCampaigns', () => {
		writeCampaigns([
			campaign({ id: 'campaign-a', title: 'Alpha', status: 'running', updatedAt: 10 }),
			campaign({ id: 'campaign-b', title: 'Beta', status: 'complete', updatedAt: 20 }),
		]);

		const persisted = new Map(readCampaigns().map((entry) => [entry.id, entry]));
		expect([...persisted.keys()].sort()).toEqual(['campaign-a', 'campaign-b']);
		expect(persisted.get('campaign-a')).toMatchObject({ title: 'Alpha', status: 'running' });
		expect(persisted.get('campaign-b')).toMatchObject({ title: 'Beta', status: 'complete' });
	});
});
