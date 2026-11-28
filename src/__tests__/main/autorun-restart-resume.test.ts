/**
 * Durable store for Auto Runs saved across an update restart. Runs against a
 * real temp directory so the read/write/delete cycle is the one that ships.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ipcMain } from 'electron';
import {
	AUTO_RUN_RESTART_RESUME_FILE,
	createAutoRunRestartResumeStore,
	registerAutoRunRestartResumeHandlers,
} from '../../main/autorun-restart-resume';

const entry = (sessionId: string, documentIndex = 0) => ({
	sessionId,
	folderPath: '/project/playbooks',
	config: { documents: [{ filename: 'tasks', resetOnCompletion: false }] },
	resumeFrom: { documentIndex, loopIteration: 0 },
	savedAt: 1_000,
});

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-autorun-restart-'));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('createAutoRunRestartResumeStore', () => {
	it('takes nothing when nothing was saved', async () => {
		expect(await createAutoRunRestartResumeStore(dir).take()).toEqual([]);
	});

	it('hands saved runs back once, then forgets them', async () => {
		const store = createAutoRunRestartResumeStore(dir);
		expect(await store.save([entry('a'), entry('b')])).toBe(2);

		expect((await store.take()).map((e) => e.sessionId)).toEqual(['a', 'b']);
		expect(fs.existsSync(path.join(dir, AUTO_RUN_RESTART_RESUME_FILE))).toBe(false);
		expect(await store.take()).toEqual([]);
	});

	it('replaces an agent saved again and keeps the rest', async () => {
		const store = createAutoRunRestartResumeStore(dir);
		await store.save([entry('a', 0), entry('b', 0)]);
		await store.save([entry('a', 3)]);

		const taken = await store.take();
		expect(taken.find((e) => e.sessionId === 'a')?.resumeFrom.documentIndex).toBe(3);
		expect(taken.map((e) => e.sessionId).sort()).toEqual(['a', 'b']);
	});

	it('never saves an entry it would refuse to read back', async () => {
		const store = createAutoRunRestartResumeStore(dir);
		const saved = await store.save([entry('a'), { ...entry('b'), folderPath: 7 } as never]);
		expect(saved).toBe(1);
		expect((await store.take()).map((e) => e.sessionId)).toEqual(['a']);
	});

	it('treats an unreadable file as empty and removes it', async () => {
		fs.writeFileSync(path.join(dir, AUTO_RUN_RESTART_RESUME_FILE), '{ torn');
		const store = createAutoRunRestartResumeStore(dir);
		expect(await store.take()).toEqual([]);
		expect(fs.existsSync(path.join(dir, AUTO_RUN_RESTART_RESUME_FILE))).toBe(false);
	});
});

describe('registerAutoRunRestartResumeHandlers', () => {
	it('registers the save and take channels', () => {
		registerAutoRunRestartResumeHandlers(dir);
		const channels = vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel);
		expect(channels).toEqual(['autorun:saveRestartResume', 'autorun:takeRestartResume']);
	});
});
