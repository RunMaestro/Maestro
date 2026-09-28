/**
 * Tests for the starred-transcript mirror: Maestro's own copy of a starred
 * session's provider transcript, so the conversation survives provider-side
 * deletion. Uses real fs against temp dirs and a fake session storage whose
 * getSessionPath() points at a temp "provider" file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as realFs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: { getPath: vi.fn().mockReturnValue('/should-be-overridden') },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// Fake storage: one transcript file per (projectPath, sessionId) under providerRoot.
let providerRoot = '';
const getSessionPathMock = vi.fn((projectPath: string, sessionId: string): string | null => {
	const safeProject = projectPath.replace(/[^a-zA-Z0-9]/g, '_');
	return path.join(providerRoot, safeProject, `${sessionId}.jsonl`);
});

vi.mock('../../../main/agents/session-storage', () => ({
	getSessionStorage: vi.fn(() => ({
		agentId: 'claude-code',
		getSessionPath: getSessionPathMock,
	})),
}));

import {
	snapshotStarredTranscript,
	releaseTranscriptMirror,
	releaseSnoozedTranscriptMirror,
	restoreStarredTranscript,
	listMirroredStarredSessions,
	flushTranscriptMirrorsSync,
	setMirrorRootForTest,
} from '../../../main/storage/starred-transcript-mirror';

const AGENT = 'claude-code';
const PROJECT = '/Users/me/proj';
const SESSION = 'abc-123';

let mirrorRoot = '';

async function writeProviderFile(sessionId: string, content: string): Promise<string> {
	const p = getSessionPathMock(PROJECT, sessionId)!;
	await fsp.mkdir(path.dirname(p), { recursive: true });
	await fsp.writeFile(p, content, 'utf-8');
	return p;
}

async function readMaybe(p: string): Promise<string | null> {
	try {
		return await fsp.readFile(p, 'utf-8');
	} catch {
		return null;
	}
}

/** Raw index entry for a session, so tests can assert on retention reasons. */
async function readIndexEntry(
	sessionId: string
): Promise<{ retain?: string[]; sessionName?: string } | undefined> {
	const raw = await readMaybe(path.join(mirrorRoot, 'index.json'));
	if (!raw) return undefined;
	return JSON.parse(raw)[`${AGENT}::${sessionId}`];
}

/** Rewrite the index without `retain`, simulating a pre-retention-reasons entry. */
async function stripRetainFromIndex(): Promise<void> {
	const indexPath = path.join(mirrorRoot, 'index.json');
	const index = JSON.parse((await readMaybe(indexPath))!);
	for (const entry of Object.values(index) as Array<Record<string, unknown>>) {
		delete entry.retain;
	}
	await fsp.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
}

beforeEach(async () => {
	const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'stm-test-'));
	providerRoot = path.join(base, 'provider');
	mirrorRoot = path.join(base, 'mirror');
	setMirrorRootForTest(mirrorRoot);
	getSessionPathMock.mockClear();
});

afterEach(() => {
	setMirrorRootForTest(null);
});

describe('snapshotStarredTranscript', () => {
	it('copies the provider transcript into the mirror and records the index', async () => {
		await writeProviderFile(SESSION, 'line1\nline2\n');
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			sessionName: 'My Session',
		});

		const entries = await listMirroredStarredSessions();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			sessionName: 'My Session',
		});
		const mirrorFile = path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBe('line1\nline2\n');
	});

	it('is a no-op when the provider mtime is unchanged (mtime gate)', async () => {
		await writeProviderFile(SESSION, 'original\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });

		// Drop a sentinel into the mirror. If snapshot #2 respects the mtime gate
		// (provider file untouched), it won't re-copy and the sentinel survives.
		const mirrorFile = path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		await fsp.writeFile(mirrorFile, 'SENTINEL\n', 'utf-8');

		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		expect(await readMaybe(mirrorFile)).toBe('SENTINEL\n');
	});

	it('re-copies when the provider mtime advances', async () => {
		const providerPath = await writeProviderFile(SESSION, 'v1\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });

		await fsp.writeFile(providerPath, 'v1\nv2\n', 'utf-8');
		const future = new Date(Date.now() + 10_000);
		await fsp.utimes(providerPath, future, future);

		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		const mirrorFile = path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBe('v1\nv2\n');
	});

	it('does not clobber an existing mirror when the provider file is gone', async () => {
		await writeProviderFile(SESSION, 'kept\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		await fsp.rm(getSessionPathMock(PROJECT, SESSION)!);

		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		const mirrorFile = path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBe('kept\n');
	});
});

describe('restoreStarredTranscript', () => {
	it('rehydrates the provider file from the mirror when it has aged out', async () => {
		const providerPath = await writeProviderFile(SESSION, 'restore-me\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		await fsp.rm(providerPath);

		const restored = await restoreStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
		});
		expect(restored).toBe(true);
		expect(await readMaybe(providerPath)).toBe('restore-me\n');
	});

	it('is a no-op when the provider file still exists', async () => {
		await writeProviderFile(SESSION, 'present\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });

		const restored = await restoreStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
		});
		expect(restored).toBe(false);
	});

	it('returns false when there is no mirror to restore from', async () => {
		const restored = await restoreStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: 'never-mirrored',
		});
		expect(restored).toBe(false);
	});
});

describe('releaseTranscriptMirror', () => {
	it('removes the mirror file and its index entry on unstar', async () => {
		await writeProviderFile(SESSION, 'bye\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		expect(await listMirroredStarredSessions()).toHaveLength(1);

		await releaseTranscriptMirror({ agentId: AGENT, sessionId: SESSION });
		expect(await listMirroredStarredSessions()).toHaveLength(0);
		const mirrorFile = path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBeNull();
	});
});

describe('flushTranscriptMirrorsSync', () => {
	it('mirrors only starred open tabs with a provider session id', async () => {
		await writeProviderFile('s-starred', 'starred-content\n');
		await writeProviderFile('s-unstarred', 'unstarred-content\n');

		const sessions = [
			{
				toolType: AGENT,
				projectRoot: PROJECT,
				aiTabs: [
					{ agentSessionId: 's-starred', starred: true, name: 'Keep me' },
					{ agentSessionId: 's-unstarred', starred: false, name: 'Skip me' },
					{ starred: true, name: 'No session id' },
				],
			},
		];

		flushTranscriptMirrorsSync(sessions);

		const entries = await listMirroredStarredSessions();
		expect(entries.map((e) => e.sessionId)).toEqual(['s-starred']);
		const mirrorFile = path.join(mirrorRoot, AGENT, 's-starred.jsonl');
		expect(realFs.readFileSync(mirrorFile, 'utf-8')).toBe('starred-content\n');
	});

	it('mirrors snoozed tabs, which are not in aiTabs and outlive provider retention', async () => {
		await writeProviderFile('s-snoozed', 'snoozed-content\n');

		flushTranscriptMirrorsSync([
			{
				toolType: AGENT,
				projectRoot: PROJECT,
				aiTabs: [],
				snoozedTabs: [
					{
						id: 'snooze-1',
						wakeAt: Date.now() + 86_400_000,
						tab: { agentSessionId: 's-snoozed', starred: false, name: 'Back tomorrow' },
					},
				],
			},
		]);

		const mirrorFile = path.join(mirrorRoot, AGENT, 's-snoozed.jsonl');
		expect(realFs.readFileSync(mirrorFile, 'utf-8')).toBe('snoozed-content\n');

		// Retained for snooze only, so it must NOT surface as a starred session.
		expect(await listMirroredStarredSessions()).toHaveLength(0);
		expect(await readIndexEntry('s-snoozed')).toMatchObject({ retain: ['snoozed'] });
	});

	it('records both reasons for a tab that is snoozed and starred', async () => {
		await writeProviderFile('s-both', 'both\n');

		flushTranscriptMirrorsSync([
			{
				toolType: AGENT,
				projectRoot: PROJECT,
				aiTabs: [],
				snoozedTabs: [{ id: 'x', tab: { agentSessionId: 's-both', starred: true, name: 'Both' } }],
			},
		]);

		const entry = await readIndexEntry('s-both');
		expect(entry?.retain?.slice().sort()).toEqual(['snoozed', 'starred']);
		// Starred, so it still belongs in the aged-out starred listing.
		expect((await listMirroredStarredSessions()).map((e) => e.sessionId)).toEqual(['s-both']);
	});
});

describe('retention reasons', () => {
	it('keeps the mirror when unstarring a session that is still snoozed', async () => {
		// The whole point: a months-long snooze must not be collected by an unstar.
		await writeProviderFile(SESSION, 'precious\n');
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'starred',
		});
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'snoozed',
		});

		await releaseTranscriptMirror({ agentId: AGENT, sessionId: SESSION, reason: 'starred' });

		const mirrorFile = path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBe('precious\n');
		expect(await readIndexEntry(SESSION)).toMatchObject({ retain: ['snoozed'] });
		// No longer starred, so it drops out of the starred listing.
		expect(await listMirroredStarredSessions()).toHaveLength(0);
	});

	it('deletes the mirror once the last reason is released', async () => {
		await writeProviderFile(SESSION, 'temp\n');
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'snoozed',
		});

		await releaseTranscriptMirror({ agentId: AGENT, sessionId: SESSION, reason: 'snoozed' });

		const mirrorFile = path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBeNull();
		expect(await readIndexEntry(SESSION)).toBeUndefined();
	});

	it('treats a legacy entry with no retain field as starred', async () => {
		// Entries written before retention reasons existed were all stars.
		await writeProviderFile(SESSION, 'legacy\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		await stripRetainFromIndex();

		expect((await listMirroredStarredSessions()).map((e) => e.sessionId)).toEqual([SESSION]);

		// Releasing a snooze it never had must not delete it.
		await releaseTranscriptMirror({ agentId: AGENT, sessionId: SESSION, reason: 'snoozed' });
		expect(await readMaybe(path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`))).toBe('legacy\n');

		// Unstarring it does.
		await releaseTranscriptMirror({ agentId: AGENT, sessionId: SESSION, reason: 'starred' });
		expect(await readMaybe(path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`))).toBeNull();
	});

	it('widens retention on an unchanged transcript without re-copying', async () => {
		await writeProviderFile(SESSION, 'v1\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });

		// Sentinel proves the mtime gate still suppresses the copy while the new
		// reason is recorded.
		const mirrorFile = path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		await fsp.writeFile(mirrorFile, 'SENTINEL\n', 'utf-8');

		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'snoozed',
		});

		expect(await readMaybe(mirrorFile)).toBe('SENTINEL\n');
		expect((await readIndexEntry(SESSION))?.retain?.slice().sort()).toEqual(['snoozed', 'starred']);
	});
});

describe('releaseSnoozedTranscriptMirror', () => {
	it('rehydrates an aged-out transcript before letting the mirror go', async () => {
		// A wake must never be the thing that loses the conversation.
		const providerPath = await writeProviderFile(SESSION, 'survived\n');
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'snoozed',
		});
		await fsp.rm(providerPath); // provider ages it out during the snooze

		await releaseSnoozedTranscriptMirror({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
		});

		// Conversation is back where the provider expects it...
		expect(await readMaybe(providerPath)).toBe('survived\n');
		// ...and the now-unneeded mirror is gone.
		expect(await readMaybe(path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`))).toBeNull();
	});

	it('leaves the mirror in place when the session is also starred', async () => {
		await writeProviderFile(SESSION, 'still-starred\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		await snapshotStarredTranscript({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
			reason: 'snoozed',
		});

		await releaseSnoozedTranscriptMirror({
			agentId: AGENT,
			projectPath: PROJECT,
			sessionId: SESSION,
		});

		expect(await readMaybe(path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`))).toBe(
			'still-starred\n'
		);
		expect(await readIndexEntry(SESSION)).toMatchObject({ retain: ['starred'] });
	});
});
