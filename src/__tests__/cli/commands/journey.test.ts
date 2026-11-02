/**
 * @file journey.test.ts
 * @description Tests for `maestro-cli journey`: the filters, text grouping, and
 * `--json`. The journey files are real JSONL in a temp data directory, so the
 * storage reader and the shared parser run for real; only the agent list is
 * mocked.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../../shared/types';
import type { UserJourneyEntry } from '../../../shared/userJourney';

const mockReadLiveSessions = vi.fn<() => SessionInfo[]>();

vi.mock('../../../cli/services/storage', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../cli/services/storage')>();
	return { ...actual, readLiveSessions: () => mockReadLiveSessions() };
});

import { journey } from '../../../cli/commands/journey';

const NOW = Date.now();
const MIN = 60 * 1000;

const alpha = { id: 'agent-alpha', name: 'Alpha', cwd: '/proj/alpha' } as SessionInfo;
const beta = { id: 'agent-beta', name: 'Beta', cwd: '/proj/beta' } as SessionInfo;

const alphaEntries: UserJourneyEntry[] = [
	{ ts: NOW - 30 * MIN, agentId: alpha.id, kind: 'file.open', target: '/proj/alpha/src/a.ts' },
	{
		ts: NOW - 20 * MIN,
		agentId: alpha.id,
		kind: 'file.save',
		target: '/proj/alpha/src/a.ts',
		linesAdded: 4,
		linesRemoved: 1,
	},
	{
		ts: NOW - 10 * MIN,
		agentId: alpha.id,
		kind: 'browser.navigate',
		target: 'https://docs.runmaestro.ai/cue',
	},
];
const betaEntries: UserJourneyEntry[] = [
	{ ts: NOW - 15 * MIN, agentId: beta.id, kind: 'file.open', target: '/proj/beta/README.md' },
];

let dataDir: string;
let priorDataDir: string | undefined;
let log: ReturnType<typeof vi.spyOn>;
let errorLog: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;

function writeJourney(agentId: string, entries: UserJourneyEntry[], extra = ''): void {
	const dir = path.join(dataDir, 'journey');
	fs.mkdirSync(dir, { recursive: true });
	const body = entries.map((e) => JSON.stringify(e)).join('\n');
	fs.writeFileSync(path.join(dir, `${agentId}.jsonl`), `${body}\n${extra}`);
}

function output(): string {
	return log.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
}

function jsonOutput(): {
	success: boolean;
	entries?: (UserJourneyEntry & { agentName: string })[];
	error?: string;
} {
	return JSON.parse(String(log.mock.calls[0]?.[0]));
}

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-cli-'));
	priorDataDir = process.env.MAESTRO_USER_DATA;
	process.env.MAESTRO_USER_DATA = dataDir;
	mockReadLiveSessions.mockReturnValue([alpha, beta]);
	writeJourney(alpha.id, alphaEntries);
	writeJourney(beta.id, betaEntries);
	log = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
	exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	mockReadLiveSessions.mockReset();
	if (priorDataDir === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = priorDataDir;
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('journey --json', () => {
	it('returns every agent, oldest first, with the agent name on each entry', () => {
		journey({ json: true });
		const result = jsonOutput();
		expect(result.success).toBe(true);
		expect(result.entries?.map((e) => [e.agentId, e.kind])).toEqual([
			[alpha.id, 'file.open'],
			[alpha.id, 'file.save'],
			[beta.id, 'file.open'],
			[alpha.id, 'browser.navigate'],
		]);
		expect(result.entries?.[3]).toMatchObject({
			agentName: 'Alpha',
			target: 'https://docs.runmaestro.ai/cue',
		});
	});

	it('skips a torn line instead of failing', () => {
		writeJourney(alpha.id, alphaEntries, '{"ts":');
		journey({ agent: alpha.id, json: true });
		expect(jsonOutput().entries).toHaveLength(3);
	});
});

describe('journey filters', () => {
	it('--agent resolves an ID prefix or a name to one agent', () => {
		journey({ agent: 'Beta', json: true });
		expect(jsonOutput().entries?.map((e) => e.agentId)).toEqual([beta.id]);
	});

	it('--since keeps entries at or after the timestamp (ISO-8601 and epoch)', () => {
		journey({ agent: alpha.id, since: new Date(NOW - 20 * MIN).toISOString(), json: true });
		expect(jsonOutput().entries?.map((e) => e.kind)).toEqual(['file.save', 'browser.navigate']);

		log.mockClear();
		journey({ agent: alpha.id, since: String(Math.floor((NOW - 15 * MIN) / 1000)), json: true });
		expect(jsonOutput().entries?.map((e) => e.kind)).toEqual(['browser.navigate']);
	});

	it('--tail keeps the newest N per agent', () => {
		journey({ tail: '1', json: true });
		expect(jsonOutput().entries?.map((e) => [e.agentId, e.kind])).toEqual([
			[beta.id, 'file.open'],
			[alpha.id, 'browser.navigate'],
		]);
	});

	it('--kind keeps only the listed kinds', () => {
		journey({ kind: 'file.save, browser.navigate', json: true });
		expect(jsonOutput().entries?.map((e) => e.kind)).toEqual(['file.save', 'browser.navigate']);
	});

	it('rejects an unknown kind and names the valid ones', () => {
		journey({ kind: 'file.save,file.edit', json: true });
		const result = jsonOutput();
		expect(result.success).toBe(false);
		expect(result.error).toContain('file.edit');
		expect(result.error).toContain('browser.navigate');
		expect(exit).toHaveBeenCalledWith(1);
	});

	it('rejects a malformed --since or --tail', () => {
		journey({ since: 'yesterday-ish', json: true });
		expect(jsonOutput().error).toContain('Invalid --since');

		log.mockClear();
		journey({ tail: '5abc' });
		expect(String(errorLog.mock.calls[0]?.[0])).toContain('Invalid --tail');
		expect(exit).toHaveBeenCalledTimes(2);
	});
});

describe('journey text output', () => {
	it('prints one line per entry, paths relative to the agent cwd, with no header for one agent', () => {
		journey({ agent: alpha.id });
		const text = output();
		expect(text).not.toContain('Alpha (agent-alpha)');
		expect(text).toMatch(/opened src\/a\.ts$/m);
		expect(text).toMatch(/saved src\/a\.ts \(\+4\/-1\)$/m);
		expect(text).toMatch(/browsed docs\.runmaestro\.ai\/cue$/m);
	});

	it('groups under an agent header when more than one agent is shown', () => {
		journey({});
		const text = output();
		expect(text).toContain('Alpha (agent-alpha)');
		expect(text).toContain('Beta (agent-beta)');
		expect(text).toMatch(/^ {2}.*opened README\.md$/m);
	});

	it('says so when nothing matches', () => {
		journey({ kind: 'file.delete' });
		expect(output()).toBe('No journey entries.');
	});
});
