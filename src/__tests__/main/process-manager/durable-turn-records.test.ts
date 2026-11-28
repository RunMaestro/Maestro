/**
 * The restart record of durable SSH turns: written at a turn's start and at
 * a detach, removed at its settle, read back by the next launch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dataDir = '';
vi.mock('../../../main/utils/app-user-data', () => ({ getAppUserDataDir: () => dataDir }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	__resetDurableTurnRecordsForTests,
	forgetDurableTurn,
	noteDurableTurn,
	recordedDurableTurns,
	type DurableTurnRecord,
} from '../../../main/process-manager/durable-turn-records';

const DIR = '/tmp/maestro-turn-0b5c6a52-4bb4-4f6f-8f0e-1f2a3b4c5d6e';

function record(overrides: Partial<DurableTurnRecord> = {}): DurableTurnRecord {
	return {
		sessionId: 'agent-1-ai-tab-1',
		toolType: 'claude-code',
		cwd: '/home/me',
		sshCommand: '/usr/bin/ssh',
		sshArgs: ['-o', 'BatchMode=yes', 'me@host', '/bin/bash', '--norc', '--noprofile', '-s'],
		dir: DIR,
		pidFile: '/tmp/maestro-agent-0b5c6a52-4bb4-4f6f-8f0e-1f2a3b4c5d6e.pid',
		outOffset: 0,
		errOffset: 0,
		isStreamJsonMode: true,
		isBatchMode: true,
		tabId: 'tab-1',
		startTime: Date.now(),
		...overrides,
	};
}

const file = () => path.join(dataDir, 'durable-ssh-turns.json');

describe('durable SSH turn records', () => {
	beforeEach(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-records-'));
		__resetDurableTurnRecordsForTests();
	});
	afterEach(() => {
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	it('a recorded turn is read back by the next launch, with its latest offsets', () => {
		noteDurableTurn(record());
		noteDurableTurn(record({ outOffset: 120, errOffset: 7 }));
		__resetDurableTurnRecordsForTests();
		expect(recordedDurableTurns()).toEqual([
			record({ outOffset: 120, errOffset: 7, startTime: expect.any(Number) }),
		]);
	});

	it('a settled turn leaves no file', () => {
		noteDurableTurn(record());
		expect(fs.existsSync(file())).toBe(true);
		forgetDurableTurn('agent-1-ai-tab-1', DIR);
		expect(fs.existsSync(file())).toBe(false);
		__resetDurableTurnRecordsForTests();
		expect(recordedDurableTurns()).toEqual([]);
	});

	it("an older turn's settle never removes the newer turn's record on the same tab", () => {
		const newer = '/tmp/maestro-turn-11111111-2222-3333-4444-555555555555';
		noteDurableTurn(record({ dir: newer }));
		forgetDurableTurn('agent-1-ai-tab-1', DIR);
		expect(recordedDurableTurns().map((r) => r.dir)).toEqual([newer]);
	});

	it('drops what it cannot trust: a torn file, a bad entry, a record older than a week', () => {
		fs.writeFileSync(file(), '{not json');
		expect(recordedDurableTurns()).toEqual([]);
		__resetDurableTurnRecordsForTests();
		fs.writeFileSync(
			file(),
			JSON.stringify([
				record({ sessionId: 'kept' }),
				{ ...record({ sessionId: 'bad' }), outOffset: -1 },
				record({ sessionId: 'old', startTime: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
			])
		);
		expect(recordedDurableTurns().map((r) => r.sessionId)).toEqual(['kept']);
	});
});
