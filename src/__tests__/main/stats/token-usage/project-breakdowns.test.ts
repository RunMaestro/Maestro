/**
 * The host side of the token totals for agents on another computer, under load: a repeat ask
 * during a long cold parse joins it, only a few listings run at once, and a storage that walks a
 * whole account (Codex) walks it once per request, not once per project.
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import {
	createSessionListGate,
	projectTokenUsage,
	type ProjectSessionStorage,
} from '../../../../main/stats/token-usage/project-breakdowns';
import type { AgentSessionInfo } from '../../../../main/agents/session-storage';

function info(sessionId: string, projectPath: string): AgentSessionInfo {
	return {
		sessionId,
		projectPath,
		timestamp: '2026-11-20T10:00:00Z',
		modifiedAt: '2026-11-20T10:00:00Z',
		inputTokens: 3,
		outputTokens: 4,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		sizeBytes: 10,
	} as AgentSessionInfo;
}

/** A promise and the function that settles it. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

describe('session list gate', () => {
	it('joins a second ask for the same listing while the first is still running', async () => {
		const gate = createSessionListGate();
		const parse = deferred<string>();
		const list = vi.fn(() => parse.promise);
		const first = gate.run('k', list);
		const second = gate.run('k', list);
		parse.resolve('done');
		expect(await first).toBe('done');
		expect(await second).toBe('done');
		expect(list).toHaveBeenCalledTimes(1);
		// Once settled, a new ask lists again (the storage's own cache keeps it cheap).
		await gate.run('k', async () => 'again');
		expect(list).toHaveBeenCalledTimes(1);
	});

	it('runs at most its limit at once, and the rest as slots free', async () => {
		const gate = createSessionListGate(2);
		let active = 0;
		let peak = 0;
		const parses = [deferred<void>(), deferred<void>(), deferred<void>()];
		const runs = parses.map((parse, i) =>
			gate.run(`k${i}`, async () => {
				active++;
				peak = Math.max(peak, active);
				await parse.promise;
				active--;
			})
		);
		await Promise.resolve();
		expect(active).toBe(2);
		parses[0].resolve();
		await vi.waitFor(() => expect(active).toBe(2));
		parses[1].resolve();
		parses[2].resolve();
		await Promise.all(runs);
		expect(peak).toBe(2);
	});

	it('frees the slot and the key when a listing fails', async () => {
		const gate = createSessionListGate(1);
		await expect(gate.run('k', async () => Promise.reject(new Error('EACCES')))).rejects.toThrow(
			'EACCES'
		);
		expect(await gate.run('k', async () => 'ok')).toBe('ok');
	});
});

describe('projectTokenUsage under load', () => {
	it('walks a whole-account storage once per account for every project of a request', async () => {
		const listSessions = vi.fn(async () => [] as AgentSessionInfo[]);
		const listSessionsForProjects = vi.fn(async (paths: readonly string[], account?: string) => {
			return new Map(
				paths.map((p) => [p, p === '/a' ? [info(`s-${account ?? 'default'}`, '/a')] : []])
			);
		});
		const storage: ProjectSessionStorage = { listSessions, listSessionsForProjects };
		const usage = await projectTokenUsage(
			[
				{ provider: 'codex', projectPath: '/a' },
				{ provider: 'codex', projectPath: '/b' },
				{ provider: 'codex', projectPath: '/c' },
			],
			{
				storageFor: () => storage,
				accountDirsFor: async () => ['/acct/1', '/acct/2'],
				gate: createSessionListGate(),
			}
		);
		expect(listSessionsForProjects).toHaveBeenCalledTimes(2);
		expect(listSessions).not.toHaveBeenCalled();
		expect(usage.projects.map((p) => [p.status, p.breakdowns.length])).toEqual([
			['read', 2],
			['read', 0],
			['read', 0],
		]);
	});

	it('answers two asks that arrive during one cold parse with one parse', async () => {
		const parse = deferred<AgentSessionInfo[]>();
		const listSessions = vi.fn(() => parse.promise);
		const deps = {
			storageFor: () => ({ listSessions }),
			accountDirsFor: async () => [],
			gate: createSessionListGate(),
		};
		const asked = [{ provider: 'claude-code', projectPath: '/a' }];
		const first = projectTokenUsage(asked, deps);
		const second = projectTokenUsage(asked, deps);
		await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
		parse.resolve([info('s1', '/a')]);
		const [a, b] = await Promise.all([first, second]);
		expect(listSessions).toHaveBeenCalledTimes(1);
		expect(a).toEqual(b);
		expect(a.projects[0].breakdowns).toHaveLength(1);
	});

	it('answers every project of a failed walk as failed, and reports the failure once', async () => {
		const onError = vi.fn();
		const usage = await projectTokenUsage(
			[
				{ provider: 'codex', projectPath: '/a' },
				{ provider: 'codex', projectPath: '/b' },
			],
			{
				storageFor: () => ({
					listSessions: vi.fn(),
					listSessionsForProjects: vi.fn(async () => Promise.reject(new Error('EACCES'))),
				}),
				accountDirsFor: async () => [],
				onError,
			}
		);
		expect(usage.projects.map((p) => p.status)).toEqual(['failed', 'failed']);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it('fails only the provider whose accounts could not be found, and reads the rest', async () => {
		const onError = vi.fn();
		const usage = await projectTokenUsage(
			[
				{ provider: 'codex', projectPath: '/a' },
				{ provider: 'claude-code', projectPath: '/a' },
			],
			{
				storageFor: () => ({ listSessions: async () => [info('s1', '/a')] }),
				accountDirsFor: async (agentType) => {
					if (agentType === 'codex') throw Object.assign(new Error('EIO'), { code: 'EIO' });
					return [];
				},
				onError,
			}
		);
		expect(usage.projects.map((p) => [p.status, p.breakdowns.length])).toEqual([
			['failed', 0],
			['read', 1],
		]);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it('reads a folder asked as ~/... under this machine home, and answers it as asked', async () => {
		const listSessions = vi.fn(async (projectPath: string) => [info('s1', projectPath)]);
		const usage = await projectTokenUsage([{ provider: 'codex', projectPath: '~/work/app' }], {
			storageFor: () => ({ listSessions }),
			accountDirsFor: async () => [],
			homeDir: '/home/dev',
		});
		expect(listSessions).toHaveBeenCalledWith(
			path.join('/home/dev', 'work/app'),
			undefined,
			undefined,
			expect.anything()
		);
		expect(usage.projects[0].breakdowns.map((b) => b.projectPath)).toEqual(['~/work/app']);
	});
});
