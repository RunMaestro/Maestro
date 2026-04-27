import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (must be declared before imports)
// ============================================================================

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock('../../../main/utils/remote-fs', () => ({
	readFileRemote: vi.fn(),
	readDirRemote: vi.fn(),
	directorySizeRemote: vi.fn(),
	bulkStatFileInSubdirsRemote: vi.fn(),
}));

vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
	},
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { CopilotSessionStorage } from '../../../main/storage/copilot-session-storage';
import * as remoteFs from '../../../main/utils/remote-fs';
import type { SshRemoteConfig } from '../../../shared/types';

// ============================================================================
// Helpers
// ============================================================================

const sshConfig: SshRemoteConfig = {
	id: 'r1',
	name: 'r1',
	host: 'h',
	port: 22,
	username: 'u',
	privateKeyPath: '~/.ssh/id_ed25519',
	enabled: true,
};

/** Minimal workspace.yaml that matches the project path. */
function workspaceYaml(sessionId: string, cwd: string): string {
	return [
		`id: ${sessionId}`,
		`cwd: ${cwd}`,
		`summary: test session`,
		`created_at: 2026-04-25T00:00:00.000Z`,
		`updated_at: 2026-04-25T01:00:00.000Z`,
	].join('\n');
}

/** Minimal events.jsonl with one user/assistant pair so `hasMeaningfulContent` is true. */
function eventsJsonl(): string {
	return [
		JSON.stringify({
			type: 'user.message',
			id: 'evt-u1',
			timestamp: '2026-04-25T00:00:00.000Z',
			data: { content: 'hello' },
		}),
		JSON.stringify({
			type: 'assistant.message',
			id: 'evt-a1',
			timestamp: '2026-04-25T00:00:01.000Z',
			data: { content: 'hi back' },
		}),
	].join('\n');
}

// ============================================================================
// Tests
// ============================================================================

describe('CopilotSessionStorage — remote SSH listing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns every session when the remote dir has hundreds of session subdirectories', async () => {
		// Regression for the bug where listing over SSH dropped sessions because
		// `Promise.all` over per-session `readFileRemote`/`directorySizeRemote`
		// blew past sshd's `MaxStartups`. Bounded fan-out + bulk stat must
		// surface every session id.
		const ids = Array.from({ length: 239 }, (_, i) => `sess-${i}`);
		const projectPath = '/remote/project';

		vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
			success: true,
			data: ids.map((name) => ({ name, isDirectory: true, isSymlink: false })),
		});

		vi.mocked(remoteFs.bulkStatFileInSubdirsRemote).mockResolvedValue({
			success: true,
			data: ids.map((name, i) => ({
				name,
				size: 2048,
				mtime: 1_776_000_000_000 + i * 1000,
			})),
		});

		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (filePath: string) => {
			if (filePath.endsWith('/workspace.yaml')) {
				const id = filePath.split('/').slice(-2, -1)[0];
				return { success: true, data: workspaceYaml(id, projectPath) };
			}
			return { success: true, data: eventsJsonl() };
		});

		const storage = new CopilotSessionStorage();
		const sessions = await storage.listSessions(projectPath, sshConfig);

		expect(sessions).toHaveLength(239);
		// Bulk stat must be a single SSH round-trip, not one-per-session.
		expect(vi.mocked(remoteFs.bulkStatFileInSubdirsRemote)).toHaveBeenCalledTimes(1);
	});

	it('skips sessions whose events.jsonl exceeds the 100MB read budget', async () => {
		// One oversized session must be dropped before any read attempt; the
		// rest must come back. This is the safety net for files that would
		// otherwise blow past EXEC_MAX_BUFFER on `cat`.
		const projectPath = '/remote/project';
		const ids = ['ok-1', 'too-big', 'ok-2'];

		vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
			success: true,
			data: ids.map((name) => ({ name, isDirectory: true, isSymlink: false })),
		});

		vi.mocked(remoteFs.bulkStatFileInSubdirsRemote).mockResolvedValue({
			success: true,
			data: [
				{ name: 'ok-1', size: 4096, mtime: 1_776_000_000_000 },
				{ name: 'too-big', size: 200 * 1024 * 1024, mtime: 1_776_000_001_000 },
				{ name: 'ok-2', size: 8192, mtime: 1_776_000_002_000 },
			],
		});

		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (filePath: string) => {
			const id = filePath.split('/').slice(-2, -1)[0];
			if (filePath.endsWith('/workspace.yaml')) {
				return { success: true, data: workspaceYaml(id, projectPath) };
			}
			return { success: true, data: eventsJsonl() };
		});

		const storage = new CopilotSessionStorage();
		const sessions = await storage.listSessions(projectPath, sshConfig);

		const returnedIds = sessions.map((s) => s.sessionId).sort();
		expect(returnedIds).toEqual(['ok-1', 'ok-2']);
		// `too-big` must not be touched at all.
		const readPaths = vi.mocked(remoteFs.readFileRemote).mock.calls.map((c) => c[0]);
		expect(readPaths.some((p) => p.includes('too-big'))).toBe(false);
	});

	it('caps parallel remote file reads to the concurrency limit', async () => {
		// If concurrency were unbounded, all per-session reads would be in
		// flight at once. The cap is 6, so peak in-flight must be <= 6.
		const projectPath = '/remote/project';
		const ids = Array.from({ length: 30 }, (_, i) => `sess-${i}`);

		vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
			success: true,
			data: ids.map((name) => ({ name, isDirectory: true, isSymlink: false })),
		});

		vi.mocked(remoteFs.bulkStatFileInSubdirsRemote).mockResolvedValue({
			success: true,
			data: ids.map((name, i) => ({ name, size: 1024, mtime: 1_776_000_000_000 + i })),
		});

		let inFlight = 0;
		let peakInFlight = 0;
		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (filePath: string) => {
			inFlight++;
			peakInFlight = Math.max(peakInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			const id = filePath.split('/').slice(-2, -1)[0];
			if (filePath.endsWith('/workspace.yaml')) {
				return { success: true, data: workspaceYaml(id, projectPath) };
			}
			return { success: true, data: eventsJsonl() };
		});

		const storage = new CopilotSessionStorage();
		await storage.listSessions(projectPath, sshConfig);

		// Each session reads two files; the per-call worker holds the slot
		// for the duration of the SSH call, so peak in-flight equals the
		// concurrency cap (6) when the work queue is large enough.
		expect(peakInFlight).toBeLessThanOrEqual(6);
		// Sanity-check we actually exercised parallelism.
		expect(peakInFlight).toBeGreaterThan(1);
	});

	it('returns an empty list when the remote session-state directory does not exist', async () => {
		vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
			success: false,
			error: 'Directory not found or not accessible',
		});

		const storage = new CopilotSessionStorage();
		const sessions = await storage.listSessions('/remote/project', sshConfig);

		expect(sessions).toEqual([]);
		// Bulk stat should not be attempted when the dir doesn't exist.
		expect(vi.mocked(remoteFs.bulkStatFileInSubdirsRemote)).not.toHaveBeenCalled();
	});

	it('falls back gracefully when bulk stat fails (proceeds without size guard)', async () => {
		// A failed bulk stat is best-effort metadata, not gating: we still
		// load every session, just without the upfront oversize filter.
		const projectPath = '/remote/project';
		const ids = ['s1', 's2'];

		vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
			success: true,
			data: ids.map((name) => ({ name, isDirectory: true, isSymlink: false })),
		});

		vi.mocked(remoteFs.bulkStatFileInSubdirsRemote).mockResolvedValue({
			success: false,
			error: 'unexpected SSH failure',
		});

		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (filePath: string) => {
			const id = filePath.split('/').slice(-2, -1)[0];
			if (filePath.endsWith('/workspace.yaml')) {
				return { success: true, data: workspaceYaml(id, projectPath) };
			}
			return { success: true, data: eventsJsonl() };
		});

		// With no precomputed size, the SSH path falls back to directorySizeRemote.
		vi.mocked(remoteFs.directorySizeRemote).mockResolvedValue({
			success: true,
			data: 4096,
		});

		const storage = new CopilotSessionStorage();
		const sessions = await storage.listSessions(projectPath, sshConfig);

		expect(sessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
		expect(vi.mocked(remoteFs.directorySizeRemote)).toHaveBeenCalledTimes(2);
	});

	it('uses the bulk-stat size as sizeBytes, avoiding a per-session du call', async () => {
		const projectPath = '/remote/project';

		vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
			success: true,
			data: [{ name: 's1', isDirectory: true, isSymlink: false }],
		});

		vi.mocked(remoteFs.bulkStatFileInSubdirsRemote).mockResolvedValue({
			success: true,
			data: [{ name: 's1', size: 12345, mtime: 1_776_000_000_000 }],
		});

		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (filePath: string) => {
			if (filePath.endsWith('/workspace.yaml')) {
				return { success: true, data: workspaceYaml('s1', projectPath) };
			}
			return { success: true, data: eventsJsonl() };
		});

		const storage = new CopilotSessionStorage();
		const sessions = await storage.listSessions(projectPath, sshConfig);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sizeBytes).toBe(12345);
		expect(vi.mocked(remoteFs.directorySizeRemote)).not.toHaveBeenCalled();
	});
});
