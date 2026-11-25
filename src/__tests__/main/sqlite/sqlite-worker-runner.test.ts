import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The child-process path, with `fork` faked: the compiled entry is reported
// present, and each fork hands back an emitter that records what it was sent
// and how it was killed. (Without the entry the runner runs inline; the
// query and integrity suites cover that path.)
class FakeChild extends EventEmitter {
	sent: unknown[] = [];
	killed: string[] = [];
	send(message: unknown) {
		this.sent.push(message);
		return true;
	}
	kill(signal: string) {
		this.killed.push(signal);
		return true;
	}
}

const forks = vi.hoisted(() => ({
	children: [] as unknown[],
	calls: [] as Array<{ script: string; options: Record<string, unknown> }>,
}));

vi.mock('fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs')>()),
	existsSync: () => true,
}));

vi.mock('child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('child_process')>()),
	fork: (script: string, _args: string[], options: Record<string, unknown>) => {
		forks.calls.push({ script, options });
		const child = new FakeChild();
		forks.children.push(child);
		return child;
	},
}));

import { startSqliteWorkerTask } from '../../../main/sqlite/sqlite-worker-runner';

const TASK = {
	kind: 'query' as const,
	task: { filePath: '/data/app.db', sql: 'SELECT 1', offset: 0, limit: 10 },
};
const OPTIONS = { closedMessage: 'closed', label: 'The query' };

function lastChild(): FakeChild {
	return forks.children[forks.children.length - 1] as FakeChild;
}

describe('startSqliteWorkerTask in a child process', () => {
	const releaseHooks = new Set<() => void>();
	const database = { displayPath: '/data/app.db', releaseHooks };

	beforeEach(() => {
		forks.children = [];
		forks.calls = [];
		releaseHooks.clear();
	});

	it("forks this app's binary as Node and sends it the task", () => {
		startSqliteWorkerTask(database, TASK, OPTIONS);
		const [call] = forks.calls;
		expect(call.script).toMatch(/sqlite-worker\.js$/);
		expect(call.options).toMatchObject({
			execPath: process.execPath,
			serialization: 'advanced',
			env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
		});
		expect(lastChild().sent).toEqual([TASK]);
	});

	it('resolves with the reply and leaves no hook behind', async () => {
		const run = startSqliteWorkerTask(database, TASK, OPTIONS);
		lastChild().emit('message', { ok: true, result: { rows: [[1]] } });
		await expect(run.result).resolves.toEqual({ rows: [[1]] });
		expect(releaseHooks.size).toBe(0);
	});

	it("rejects with the child's error, code kept", async () => {
		const run = startSqliteWorkerTask(database, TASK, OPTIONS);
		lastChild().emit('message', {
			ok: false,
			error: { message: 'no such table: userz', code: 'SQLITE_ERROR' },
		});
		await expect(run.result).rejects.toMatchObject({
			message: 'no such table: userz',
			code: 'SQLITE_ERROR',
		});
	});

	it('kills the child on stop, which works even inside native SQLite code', async () => {
		const run = startSqliteWorkerTask(database, TASK, OPTIONS);
		run.stop('stopped');
		await expect(run.result).rejects.toThrow('stopped');
		expect(lastChild().killed).toEqual(['SIGKILL']);
		// The exit that follows the kill does not change the answer.
		lastChild().emit('exit', null, 'SIGKILL');
		await expect(run.result).rejects.toThrow('stopped');
	});

	it('kills the child when the database is released', async () => {
		const run = startSqliteWorkerTask(database, TASK, OPTIONS);
		for (const hook of [...releaseHooks]) hook();
		await expect(run.result).rejects.toThrow('closed');
		expect(lastChild().killed).toEqual(['SIGKILL']);
	});

	it('kills the child at the timeout', async () => {
		vi.useFakeTimers();
		try {
			const run = startSqliteWorkerTask(database, TASK, {
				...OPTIONS,
				timeoutMs: 1000,
				timeoutMessage: 'too slow',
			});
			vi.advanceTimersByTime(1000);
			await expect(run.result).rejects.toThrow('too slow');
			expect(lastChild().killed).toEqual(['SIGKILL']);
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports a child that exits without answering', async () => {
		const run = startSqliteWorkerTask(database, TASK, OPTIONS);
		lastChild().emit('exit', 1, null);
		await expect(run.result).rejects.toThrow('The query ended (exit code 1) without a result.');
	});
});
