import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { OmpSessionStorage } from '../../../main/storage/omp-session-storage';
import type { SshRemoteConfig } from '../../../shared/types';

/**
 * These tests exercise OmpSessionStorage against REAL temp transcript files
 * (os.homedir spied to a temp root) so they are deterministic and never touch a
 * developer's `~/.omp`. The on-disk shape mirrors omp's actual JSONL layout:
 * `~/.omp/agent/sessions/<cwd-slug>/<ISO-ts>_<id>.jsonl`.
 */
describe('OmpSessionStorage', () => {
	let tmpHome: string;
	let projectPath: string;
	let storage: OmpSessionStorage;

	const sshConfig: SshRemoteConfig = {
		enabled: true,
		remoteId: 'remote-1',
	} as SshRemoteConfig;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'omp-store-'));
		vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
		projectPath = path.join(tmpHome, 'code', 'proj'); // slug -> "-code-proj"
		storage = new OmpSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(tmpHome, { recursive: true, force: true });
	});

	async function writeTranscript(
		slug: string,
		filename: string,
		events: Record<string, unknown>[]
	): Promise<void> {
		const dir = path.join(tmpHome, '.omp', 'agent', 'sessions', slug);
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, filename),
			events.map((e) => JSON.stringify(e)).join('\n') + '\n'
		);
	}

	function fullTranscript(cwd: string, sessionId: string): Record<string, unknown>[] {
		return [
			{ type: 'title', title: 'Fix the parser bug' },
			{ type: 'session', id: sessionId, cwd, timestamp: '2026-07-14T06:38:15.818Z' },
			{ type: 'model_change', model: 'anthropic/claude-opus-4-8' },
			{
				type: 'message',
				id: 'm0',
				timestamp: '2026-07-14T06:38:16.000Z',
				message: {
					role: 'user',
					content: [{ type: 'text', text: '# Maestro System Context\n\nYou are ...' }],
				},
			},
			{
				type: 'message',
				id: 'm1',
				timestamp: '2026-07-14T06:39:00.000Z',
				message: { role: 'user', content: [{ type: 'text', text: 'Please fix the parser' }] },
			},
			{
				type: 'message',
				id: 'm2',
				timestamp: '2026-07-14T06:40:00.000Z',
				message: {
					role: 'assistant',
					model: 'anthropic/claude-opus-4-8',
					content: [
						{ type: 'thinking', thinking: 'internal reasoning' },
						{ type: 'text', text: 'Done, fixed it.' },
					],
					usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.02 },
				},
			},
			{ type: 'message', id: 'm3', message: { role: 'toolResult', content: 'tool output' } },
		];
	}

	it('lists a session for the matching project with metadata, usage, and title', async () => {
		await writeTranscript(
			'-code-proj',
			'2026-07-14T06-38-15_sess-1.jsonl',
			fullTranscript(projectPath, 'sess-1')
		);

		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toHaveLength(1);
		const s = sessions[0];
		expect(s.sessionId).toBe('sess-1');
		expect(s.sessionName).toBe('Fix the parser bug');
		// System-context turn is skipped for the preview; real request wins.
		expect(s.firstMessage).toBe('Please fix the parser');
		// user (system) + user + assistant = 3; toolResult excluded.
		expect(s.messageCount).toBe(3);
		expect(s.inputTokens).toBe(100);
		expect(s.outputTokens).toBe(50);
		expect(s.cacheReadTokens).toBe(10);
		expect(s.cacheCreationTokens).toBe(5);
		expect(s.costUsd).toBeCloseTo(0.02);
		expect(s.byModel && s.byModel.length).toBeGreaterThan(0);
	});

	it('excludes sessions whose transcript cwd does not match the project', async () => {
		await writeTranscript('-code-proj', 'a_sess-1.jsonl', fullTranscript(projectPath, 'sess-1'));
		await writeTranscript(
			'-code-proj',
			'b_sess-2.jsonl',
			fullTranscript('/somewhere/else', 'sess-2')
		);

		const sessions = await storage.listSessions(projectPath);

		expect(sessions.map((s) => s.sessionId)).toEqual(['sess-1']);
	});

	it('finds the matching session even when another dir holds unrelated transcripts', async () => {
		// A non-matching transcript sits in the dir that a slug guess would target;
		// the real match lives elsewhere. Always-scan + authoritative cwd filter
		// must still surface it (no fast-path short-circuit hides sessions).
		await writeTranscript(
			'-code-proj',
			'stale_sess-0.jsonl',
			fullTranscript('/other/project', 'sess-0')
		);
		await writeTranscript('legacy-slug', 'x_sess-9.jsonl', fullTranscript(projectPath, 'sess-9'));

		const sessions = await storage.listSessions(projectPath);

		expect(sessions.map((s) => s.sessionId)).toEqual(['sess-9']);
	});

	it('reads user + assistant messages, extracts text, and skips thinking/toolResult', async () => {
		await writeTranscript('-code-proj', 'a_sess-1.jsonl', fullTranscript(projectPath, 'sess-1'));

		const result = await storage.readSessionMessages(projectPath, 'sess-1');

		expect(result.total).toBe(3);
		const roles = result.messages.map((m) => m.role);
		expect(roles).toEqual(['user', 'user', 'assistant']);
		const assistant = result.messages.find((m) => m.role === 'assistant');
		expect(assistant?.content).toBe('Done, fixed it.'); // thinking block excluded
	});

	it('deletes a user message and its following assistant turn, stopping at the next user', async () => {
		const events: Record<string, unknown>[] = [
			{ type: 'session', id: 'sess-1', cwd: projectPath, timestamp: '2026-07-14T06:38:15.818Z' },
			{
				type: 'message',
				id: 'u1',
				message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
			},
			{
				type: 'message',
				id: 'a1',
				message: { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
			},
			{ type: 'message', id: 'tr', message: { role: 'toolResult', content: 'tool' } },
			{
				type: 'message',
				id: 'u2',
				message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
			},
			{
				type: 'message',
				id: 'a2',
				message: { role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] },
			},
		];
		await writeTranscript('-code-proj', 'a_sess-1.jsonl', events);

		const del = await storage.deleteMessagePair(projectPath, 'sess-1', 'u1');
		expect(del.success).toBe(true);
		expect(del.linesRemoved).toBe(3); // u1 + a1 + toolResult, stop at u2

		const result = await storage.readSessionMessages(projectPath, 'sess-1');
		expect(result.messages.map((m) => m.uuid)).toEqual(['u2', 'a2']);
	});

	it('degrades to empty for SSH-remote sessions (local-only v1)', async () => {
		await writeTranscript('-code-proj', 'a_sess-1.jsonl', fullTranscript(projectPath, 'sess-1'));

		const sessions = await storage.listSessions(projectPath, sshConfig);
		expect(sessions).toEqual([]);

		const messages = await storage.readSessionMessages(projectPath, 'sess-1', undefined, sshConfig);
		expect(messages.messages).toEqual([]);
	});
});
