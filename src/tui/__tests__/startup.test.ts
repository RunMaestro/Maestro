import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	createMaestroRuntime,
	type MaestroClient,
	type MaestroRuntimeOptions,
	type RuntimeRefusal,
	type RuntimeStart,
} from '../../shared/maestro-lib';
import { readOnlyLabelFor, resolveTuiTurnOptions, startTuiHost } from '../startup';

const paths = { userDataDir: '/data', productionDataDir: '/data-prod' };
const fakeClient = { tag: 'fake' } as unknown as MaestroClient;

function deps(start: RuntimeStart) {
	const calls: { runtime: MaestroRuntimeOptions[]; attach: number } = { runtime: [], attach: 0 };
	return {
		calls,
		deps: {
			startRuntime: async (options: MaestroRuntimeOptions) => {
				calls.runtime.push(options);
				return start;
			},
			attachToHost: () => {
				calls.attach++;
				return fakeClient;
			},
		},
	};
}

const refused = (refusal: RuntimeRefusal): RuntimeStart => ({ ok: false, refusal });

describe('startTuiHost', () => {
	it('hosts in process when nothing holds the directory, and uses the runtime as the client', async () => {
		const runtime = { tag: 'runtime' } as unknown as Extract<RuntimeStart, { ok: true }>['runtime'];
		const { deps: d, calls } = deps({ ok: true, runtime });
		const result = await startTuiHost(paths, d);
		expect(result).toEqual({ branch: 'in-process', client: runtime });
		expect(calls.attach).toBe(0);
		// The TUI asks for its own mode and never creates a directory it was not given.
		expect(calls.runtime).toEqual([
			{ dataDir: '/data', productionDataDir: '/data-prod', mode: 'tui' },
		]);
	});

	it('attaches to a desktop that serves the directory', async () => {
		const { deps: d, calls } = deps(
			refused({
				reason: 'host-running',
				attachable: true,
				host: { kind: 'desktop', label: 'desktop pid 9', pid: 9 } as never,
				message: 'A desktop serves this directory.',
			})
		);
		const result = await startTuiHost(paths, d);
		expect(result).toEqual({ branch: 'attach', client: fakeClient });
		expect(calls.attach).toBe(1);
	});

	it('reads the files when a desktop is starting and cannot be attached to yet', async () => {
		const { deps: d, calls } = deps(
			refused({
				reason: 'host-running',
				attachable: false,
				host: { kind: 'desktop', label: 'desktop pid 9', pid: 9 } as never,
				message: 'A desktop is starting.',
			})
		);
		const result = await startTuiHost(paths, d);
		expect(result).toEqual({
			branch: 'read-only',
			label: 'read-only',
			notice: 'A desktop is starting.',
		});
		expect(calls.attach).toBe(0);
	});

	it('opens read-only, naming the holder, when another TUI holds the lock', async () => {
		const { deps: d, calls } = deps(
			refused({
				reason: 'held',
				holder: { mode: 'tui', pid: 812 } as never,
				message: 'tui pid 812 holds this data directory.',
			})
		);
		const result = await startTuiHost(paths, d);
		expect(result).toEqual({
			branch: 'read-only',
			label: 'read-only (TUI pid 812 holds this data dir)',
			notice: 'tui pid 812 holds this data directory.',
		});
		expect(calls.attach).toBe(0);
	});

	it.each<[RuntimeRefusal, string]>([
		[{ reason: 'data-dir-missing', tried: ['/x'], message: 'm' }, 'read-only (no data directory)'],
		[
			{ reason: 'synced-data-dir', syncDir: '/s', message: 'm' },
			'read-only (synced data directory)',
		],
		[
			{ reason: 'store-corrupt', file: 'f', detail: 'd', message: 'm' },
			'read-only (a store file is corrupt)',
		],
		[
			{ reason: 'store-too-new', file: 'f', version: 9, message: 'm' },
			'read-only (update maestro-cli)',
		],
		[
			{ reason: 'lock-failed', file: 'f', detail: 'd', message: 'm' },
			'read-only (data directory not lockable)',
		],
	])('labels the %j refusal', (refusal, label) => {
		expect(readOnlyLabelFor(refusal)).toBe(label);
	});
});

describe('startTuiHost on a real data directory', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-startup-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** The lock takes another process's liveness from the probe, so the first TUI plays a separate process. */
	const asPid = (pid: number) => ({
		startRuntime: (options: MaestroRuntimeOptions) =>
			createMaestroRuntime({ ...options, deps: { pid, isPidAlive: () => true } }),
		attachToHost: () => {
			throw new Error('no desktop here');
		},
	});
	const real = () => ({
		startRuntime: createMaestroRuntime,
		attachToHost: () => {
			throw new Error('no desktop here');
		},
	});

	it('releases the lock on quit, and a second TUI meanwhile opens read-only', async () => {
		const tuiPaths = { userDataDir: dir, productionDataDir: dir };
		const first = await startTuiHost(tuiPaths, asPid(4242));
		expect(first.branch).toBe('in-process');
		if (first.branch !== 'in-process') return;

		const second = await startTuiHost(tuiPaths, asPid(4343));
		expect(second.branch).toBe('read-only');
		if (second.branch === 'read-only') expect(second.label).toContain('pid 4242 holds');

		await first.client.connection.close();
		const third = await startTuiHost(tuiPaths, real());
		expect(third.branch).toBe('in-process');
		if (third.branch === 'in-process') await third.client.connection.close();
	});
});

describe('resolveTuiTurnOptions', () => {
	const bundle = path.join('/opt', 'maestro', 'dist', 'cli');

	it('finds the CLI script and maestro-p beside the running bundle', () => {
		const present = new Set([
			path.join(bundle, 'maestro-cli.js'),
			path.join(bundle, 'maestro-p.js'),
		]);
		const options = resolveTuiTurnOptions(bundle, (file) => present.has(file));
		expect(options.moduleDirectory).toBe(bundle);
		expect(options.maestroCliPath).toBe(path.join(bundle, 'maestro-cli.js'));
		expect(options.maestroPBinPath).toBe(path.join(bundle, 'maestro-p.js'));
		expect(typeof options.loadSqlite).toBe('function');
	});

	it('leaves a sibling that is not there absent, so the turn degrades instead of naming a missing file', () => {
		const options = resolveTuiTurnOptions(bundle, () => false);
		expect(options.maestroCliPath).toBeUndefined();
		expect(options.maestroPBinPath).toBeNull();
	});
});
