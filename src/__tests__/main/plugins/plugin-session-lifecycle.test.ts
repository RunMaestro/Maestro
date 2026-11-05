import { afterEach, describe, expect, it, vi } from 'vitest';
import Conf from 'conf';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createPluginSessionLifecycle } from '../../../main/plugins/plugin-session-lifecycle';
import { nativeCurrentTurns } from '../../../main/pianola/current-turn';

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	nativeCurrentTurns.setEnabled(false);
	nativeCurrentTurns.setEnabled(true);
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const root = path.resolve('.maestro/pianola-agent-supervision-20261104/Working');
	mkdirSync(root, { recursive: true });
	const directory = mkdtempSync(path.join(root, 'm02-plugin-'));
	directories.push(directory);
	const store = new Conf<{ sessions: Array<Record<string, unknown>>; activeSessionId: string }>({
		cwd: directory,
		defaults: { sessions: [], activeSessionId: 'unchanged' },
	});
	const flush = vi.fn(async () => {});
	const autoWatchNewSessions = vi.fn(async () => {});
	const adapter = createPluginSessionLifecycle({
		readSessions: () => store.get('sessions'),
		writeSessions: (sessions) => store.set('sessions', sessions),
		flush,
		getActiveSessionId: () => store.get('activeSessionId'),
		setActiveSessionId: (id) => store.set('activeSessionId', id),
		getSupervisor: () => ({ autoWatchNewSessions }),
	});
	return { store, flush, autoWatchNewSessions, adapter };
}

describe('production plugin session lifecycle', () => {
	it('rejects concurrent duplicate IDs before any persistence, activation or notification', async () => {
		const f = fixture();
		let release!: () => void;
		f.flush.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const create = f.adapter.create({
			id: 'same',
			title: 'Original',
			agentId: 'codex',
			projectPath: '/project',
		});
		const disk = readFileSync(f.store.path, 'utf8');
		await expect(f.adapter.create({ id: 'same', title: 'Duplicate' })).rejects.toThrow(
			'Session already exists'
		);
		expect(readFileSync(f.store.path, 'utf8')).toBe(disk);
		expect(f.store.get('activeSessionId')).toBe('unchanged');
		expect(f.autoWatchNewSessions).not.toHaveBeenCalled();
		release();
		await expect(create).resolves.toMatchObject({
			id: 'same',
			title: 'Original',
			agentId: 'codex',
			projectPath: '/project',
			status: 'idle',
		});
		expect(f.autoWatchNewSessions).toHaveBeenCalledOnce();
		expect(f.store.get('sessions')).toHaveLength(1);
	});

	it('does not reactivate a session deleted while creation awaits its flush', async () => {
		const f = fixture();
		let release!: () => void;
		f.flush.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const create = f.adapter.create({ id: 'removed' });
		expect(await f.adapter.remove('removed')).toBe(true);
		release();
		await expect(create).rejects.toThrow('Session changed during creation');
		expect(f.store.get('sessions')).toEqual([]);
		expect(f.store.get('activeSessionId')).toBe('unchanged');
		expect(f.autoWatchNewSessions).toHaveBeenCalledExactlyOnceWith([], [], ['removed']);
	});

	it('does not enroll or activate a failed durable create', async () => {
		const f = fixture();
		f.flush.mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
		await expect(f.adapter.create({ id: 'failed' })).rejects.toThrow('disk full');
		expect(f.autoWatchNewSessions).not.toHaveBeenCalled();
		expect(f.store.get('activeSessionId')).toBe('unchanged');
		const session = f.store.get('sessions')[0];
		const tab = (session.aiTabs as Array<{ id: string; createdAt: number }>)[0];
		nativeCurrentTurns.commit({
			sessionId: 'failed',
			tabId: tab.id,
			field: 'logs',
			snapshot: true,
			upserts: [],
			removedIds: [],
			orderIds: [],
			runtime: { state: 'idle' },
			observation: {
				sourceGeneration: 'renderer',
				sequence: 1,
				createdAt: tab.createdAt,
				provider: 'claude-code',
			},
		});
		expect(
			nativeCurrentTurns.read({
				agentId: 'failed',
				tabId: tab.id,
				createdAt: tab.createdAt,
				provider: 'claude-code',
				agentSessionId: null,
				open: true,
			}).status
		).toBe('incomplete');
	});
});
