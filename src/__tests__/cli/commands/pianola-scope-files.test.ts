import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PianolaScopeFiles } from '../../../cli/commands/pianola-scope-files';
import { createPianolaScopeWorkerDeps } from '../../../cli/commands/pianola-scope-watch';
import * as storage from '../../../cli/services/storage';
import * as cliStore from '../../../cli/services/pianola-store';
import { resolveSyncDir } from '../../../shared/syncPath';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import type { PianolaDecisionRecord } from '../../../shared/pianola/storage';

vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }));

const root = path.resolve('.maestro/pianola-agent-supervision-20261104/Working');
const directories: string[] = [];
const watchers: PianolaScopeFiles[] = [];
const scopeId = '11111111-1111-4111-8111-111111111111';
afterEach(() => {
	for (const watcher of watchers.splice(0)) watcher.dispose();
	vi.restoreAllMocks();
	for (const directory of directories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

function setup() {
	fs.mkdirSync(root, { recursive: true });
	const directory = fs.mkdtempSync(path.join(root, 'J03-files-'));
	directories.push(directory);
	vi.spyOn(storage, 'getConfigDirectory').mockReturnValue(directory);
	vi.spyOn(storage, 'getSyncDir').mockImplementation(() => resolveSyncDir(directory));
	const signal = vi.fn();
	const files = new PianolaScopeFiles(scopeId, signal);
	watchers.push(files);
	files.refresh();
	signal.mockClear();
	return { directory, files, signal };
}

describe('scope file wakeups', () => {
	it('does not reread unchanged files and inspects only the named mutation', () => {
		const { directory, files, signal } = setup();
		const file = path.join(directory, 'maestro-pianola-rules.json');
		fs.writeFileSync(file, '{}');
		files.refresh();
		signal.mockClear();
		const read = vi.spyOn(fs, 'readFileSync');
		files.refresh();
		expect(read.mock.calls.map((args) => path.basename(String(args[0])))).toEqual([
			'maestro-bootstrap.json',
		]);
		read.mockClear();
		fs.writeFileSync(file, '{"rules":[]}');
		const watcher = (files as unknown as { watchers: Map<string, fs.FSWatcher> }).watchers.get(
			directory
		)!;
		watcher.emit('change', 'rename', path.basename(file));
		expect(read.mock.calls.map((args) => args[0])).toEqual([file]);
		expect(signal).toHaveBeenCalledOnce();
	});

	it('detects atomic registry and synced settings changes, then rebinds the sync location', async () => {
		const { directory, files, signal } = setup();
		const sync = path.join(directory, 'synced');
		fs.mkdirSync(sync);
		fs.writeFileSync(
			path.join(directory, 'bootstrap.tmp'),
			JSON.stringify({ customSyncPath: sync })
		);
		fs.renameSync(
			path.join(directory, 'bootstrap.tmp'),
			path.join(directory, 'maestro-bootstrap.json')
		);
		await vi.waitFor(() => expect(signal).toHaveBeenCalled());
		files.refresh();
		signal.mockClear();
		fs.writeFileSync(path.join(sync, 'settings.tmp'), '{"encoreFeatures":{}}');
		fs.renameSync(path.join(sync, 'settings.tmp'), path.join(sync, 'maestro-settings.json'));
		await vi.waitFor(() => expect(signal).toHaveBeenCalled());
		signal.mockClear();
		fs.writeFileSync(path.join(directory, 'registry.tmp'), '{}');
		fs.renameSync(
			path.join(directory, 'registry.tmp'),
			path.join(directory, 'maestro-pianola-supervisor.json')
		);
		await vi.waitFor(() => expect(signal).toHaveBeenCalled());
	});

	it('suppresses exact own decision writes but wakes for foreign appends before or during one', async () => {
		const { directory, files, signal } = setup();
		const store = createPianolaFsStore({
			resolveDir: () => directory,
			indent: 2,
			trailingNewline: true,
		});
		const append = vi
			.spyOn(cliStore, 'appendPianolaDecision')
			.mockImplementation(store.appendDecision);
		const deps = createPianolaScopeWorkerDeps({ sendCommand: vi.fn() } as never, files);
		const own = { id: 'own' } as PianolaDecisionRecord;
		const foreign = { id: 'manager' } as PianolaDecisionRecord;
		deps.watch.recordDecision(own);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(signal).not.toHaveBeenCalled();
		store.appendDecision(foreign);
		deps.watch.recordDecision(own);
		expect(signal).toHaveBeenCalled();
		signal.mockClear();
		append.mockImplementationOnce((record, receipt) => {
			store.appendDecision(foreign);
			store.appendDecision(record, receipt);
		});
		deps.watch.recordDecision(own);
		expect(signal).toHaveBeenCalled();
		signal.mockClear();
		append.mockImplementationOnce((record, receipt) => {
			store.appendDecision(record, receipt);
			store.appendDecision(foreign);
		});
		deps.watch.recordDecision(own);
		expect(signal).toHaveBeenCalled();
	});

	it('suppresses its checkpoint write but detects an external suspension of that checkpoint', async () => {
		const { directory, files, signal } = setup();
		const store = createPianolaFsStore({
			resolveDir: () => directory,
			indent: 2,
			trailingNewline: true,
		});
		vi.spyOn(cliStore, 'writePianolaScopeCheckpoint').mockImplementation(
			store.writeScopeCheckpoint
		);
		const deps = createPianolaScopeWorkerDeps({ sendCommand: vi.fn() } as never, files);
		const checkpoint = {
			version: 1 as const,
			scopeId,
			configurationFingerprint: 'a'.repeat(64),
			activatedAt: 1,
			status: 'armed' as const,
			tabs: [],
		};
		deps.store.writeScopeCheckpoint(checkpoint);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(signal).not.toHaveBeenCalled();
		store.writeScopeCheckpoint({ ...checkpoint, status: 'suspended' });
		await vi.waitFor(() => expect(signal).toHaveBeenCalled());
		expect(store.readScopeCheckpoint(scopeId)?.status).toBe('suspended');
	});

	it('rescans missed changes and closes its watchers on disposal', async () => {
		const { directory, files, signal } = setup();
		fs.writeFileSync(path.join(directory, 'maestro-pianola-rules.json'), '{}');
		files.refresh();
		expect(signal).toHaveBeenCalled();
		files.dispose();
		signal.mockClear();
		fs.writeFileSync(path.join(directory, 'maestro-pianola-profiles.json'), '{}');
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(signal).not.toHaveBeenCalled();
	});

	it('rescans a null-filename event and retries after a real watcher error', async () => {
		const { directory, files, signal } = setup();
		const native = (files as unknown as { watchers: Map<string, fs.FSWatcher> }).watchers.get(
			directory
		)!;
		fs.writeFileSync(path.join(directory, 'maestro-pianola-rules.json'), '{}');
		native.emit('change', 'rename', null);
		expect(signal).toHaveBeenCalled();
		signal.mockClear();
		native.emit('error', new Error('watch failed'));
		expect(signal).toHaveBeenCalled();
		signal.mockClear();
		fs.writeFileSync(path.join(directory, 'maestro-pianola-profiles.json'), '{}');
		files.refresh();
		expect(signal).toHaveBeenCalled();
		signal.mockClear();
		fs.writeFileSync(path.join(directory, 'maestro-pianola-rules.json'), '{"rules":[]}');
		await vi.waitFor(() => expect(signal).toHaveBeenCalled());
	});

	it('suppresses receipt-proven own compaction while still detecting foreign writes', async () => {
		const { directory, files, signal } = setup();
		const store = createPianolaFsStore({
			resolveDir: () => directory,
			indent: 2,
			trailingNewline: true,
		});
		const file = path.join(directory, 'pianola-decisions.jsonl');
		fs.writeFileSync(
			file,
			Array.from(
				{ length: 5000 },
				(_, id) => JSON.stringify({ id, padding: 'x'.repeat(60) }) + '\n'
			).join('')
		);
		files.refresh();
		signal.mockClear();
		const append = vi
			.spyOn(cliStore, 'appendPianolaDecision')
			.mockImplementation(store.appendDecision);
		const deps = createPianolaScopeWorkerDeps({ sendCommand: vi.fn() } as never, files);
		const own = { id: 'own', padding: 'x'.repeat(60) } as unknown as PianolaDecisionRecord;
		const foreign = { id: 'manager', padding: 'x'.repeat(60) } as unknown as PianolaDecisionRecord;
		deps.watch.recordDecision(own);
		expect(signal).not.toHaveBeenCalled();
		signal.mockClear();
		deps.watch.recordDecision(own);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(signal).not.toHaveBeenCalled();
		append.mockImplementationOnce((record, receipt) => {
			store.appendDecision(foreign);
			store.appendDecision(record, receipt);
		});
		deps.watch.recordDecision(own);
		expect(signal).toHaveBeenCalled();
	});
});
