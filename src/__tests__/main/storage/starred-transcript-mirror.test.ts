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
	deleteStarredMirror,
	restoreStarredTranscript,
	listMirroredStarredSessions,
	flushStarredMirrorsSync,
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

describe('deleteStarredMirror', () => {
	it('removes the mirror file and its index entry on unstar', async () => {
		await writeProviderFile(SESSION, 'bye\n');
		await snapshotStarredTranscript({ agentId: AGENT, projectPath: PROJECT, sessionId: SESSION });
		expect(await listMirroredStarredSessions()).toHaveLength(1);

		await deleteStarredMirror({ agentId: AGENT, sessionId: SESSION });
		expect(await listMirroredStarredSessions()).toHaveLength(0);
		const mirrorFile = path.join(mirrorRoot, AGENT, `${SESSION}.jsonl`);
		expect(await readMaybe(mirrorFile)).toBeNull();
	});
});

describe('flushStarredMirrorsSync', () => {
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

		flushStarredMirrorsSync(sessions);

		const entries = await listMirroredStarredSessions();
		expect(entries.map((e) => e.sessionId)).toEqual(['s-starred']);
		const mirrorFile = path.join(mirrorRoot, AGENT, 's-starred.jsonl');
		expect(realFs.readFileSync(mirrorFile, 'utf-8')).toBe('starred-content\n');
	});
});
