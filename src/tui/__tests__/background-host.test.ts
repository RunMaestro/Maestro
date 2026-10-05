import { describe, expect, it, vi } from 'vitest';
import type { MaestroClient, MaestroRuntime } from '../../shared/maestro-lib';
import {
	parseHostStartOutput,
	runMaestroCliHostStart,
	startBackgroundHost,
	type BackgroundHostDeps,
} from '../background-host';
import type { TuiStartup } from '../startup';

const attached = { branch: 'attach', client: { tag: 'ws' } as unknown as MaestroClient } as const;

function runtimeWith(options: { turns?: number; runs?: number } = {}) {
	const close = vi.fn(async () => undefined);
	const client = {
		turnsInFlight: () => options.turns ?? 0,
		runs: { activeRuns: () => Array.from({ length: options.runs ?? 0 }, () => ({})) },
		connection: { close },
	} as unknown as MaestroRuntime;
	return { startup: { branch: 'in-process', client } as TuiStartup, close };
}

function deps(
	start: Awaited<ReturnType<BackgroundHostDeps['runHostStart']>>,
	next: TuiStartup
): BackgroundHostDeps & { order: string[] } {
	const order: string[] = [];
	return {
		order,
		runHostStart: async () => {
			order.push('start');
			return start;
		},
		restart: async () => {
			order.push('restart');
			return next;
		},
	};
}

describe('startBackgroundHost', () => {
	it('closes the runtime, starts the host, then attaches', async () => {
		const { startup, close } = runtimeWith();
		const d = deps({ ok: true }, attached);
		close.mockImplementation(async () => void d.order.push('close'));
		const outcome = await startBackgroundHost(startup, d);
		expect(d.order).toEqual(['close', 'start', 'restart']);
		expect(outcome.startup).toBe(attached);
		expect(outcome.notice).toContain('Background host started');
	});

	it('takes the directory back when the host does not come up, so the TUI keeps a client', async () => {
		const { startup } = runtimeWith();
		const again = runtimeWith().startup;
		const outcome = await startBackgroundHost(
			startup,
			deps({ ok: false, message: 'port in use' }, again)
		);
		expect(outcome.startup).toBe(again);
		expect(outcome.notice).toBe('Could not start the background host: port in use');
	});

	it('says so when the host started but nothing attached', async () => {
		const { startup } = runtimeWith();
		const again = runtimeWith().startup;
		const outcome = await startBackgroundHost(startup, deps({ ok: true }, again));
		expect(outcome.startup).toBe(again);
		expect(outcome.notice).toContain('could not attach');
	});

	it.each([
		[{ turns: 2 }, '2 turns running here'],
		[{ runs: 1 }, '1 Auto Run running here'],
		[{ turns: 1, runs: 1 }, '1 turn and 1 Auto Run running here'],
	])('refuses without touching the runtime while %j is running', async (work, text) => {
		const { startup, close } = runtimeWith(work);
		const d = deps({ ok: true }, attached);
		const outcome = await startBackgroundHost(startup, d);
		expect(outcome.notice).toContain(text);
		expect(outcome.startup).toBeUndefined();
		expect(close).not.toHaveBeenCalled();
		expect(d.order).toEqual([]);
	});

	it('does nothing when already attached to a host', async () => {
		const d = deps({ ok: true }, attached);
		const outcome = await startBackgroundHost(attached, d);
		expect(outcome.notice).toContain('Already attached');
		expect(outcome.startup).toBeUndefined();
		expect(d.order).toEqual([]);
	});

	it('does nothing when the TUI is read-only, and says why', async () => {
		const d = deps({ ok: true }, attached);
		const outcome = await startBackgroundHost(
			{ branch: 'read-only', label: 'read-only (synced data directory)', notice: 'n' },
			d
		);
		expect(outcome.notice).toBe(
			'Cannot start a host from here: read-only (synced data directory).'
		);
		expect(d.order).toEqual([]);
	});
});

describe('parseHostStartOutput', () => {
	it('reads a started host and one that was already running', () => {
		expect(parseHostStartOutput('{"started":true,"pid":9,"port":1}')).toEqual({ ok: true });
		expect(parseHostStartOutput('{"started":false,"alreadyRunning":true}')).toEqual({ ok: true });
	});

	it('carries the reason of a failed start', () => {
		expect(parseHostStartOutput('{"error":"The host exited before it was ready."}')).toEqual({
			ok: false,
			message: 'The host exited before it was ready.',
		});
	});

	it('falls back to the last line when the output is not JSON', () => {
		expect(parseHostStartOutput('warming up\nboom\n')).toEqual({ ok: false, message: 'boom' });
	});
});

describe('runMaestroCliHostStart', () => {
	it('runs host start on the resolved directory with JSON output', async () => {
		const run = vi.fn(async () => ({ stdout: '{"started":true,"pid":9,"port":1}' }));
		const result = await runMaestroCliHostStart({
			cliScript: '/opt/maestro/maestro-cli.js',
			userDataDir: '/data',
			run,
		});
		expect(result).toEqual({ ok: true });
		const [file, args, env] = run.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv];
		expect(file).toBe(process.execPath);
		expect(args).toEqual([
			'/opt/maestro/maestro-cli.js',
			'host',
			'start',
			'--data-dir',
			'/data',
			'--json',
		]);
		expect(env.MAESTRO_USER_DATA).toBe('/data');
	});

	it('fails with a message when maestro-cli is not beside the TUI', async () => {
		const run = vi.fn();
		const result = await runMaestroCliHostStart({ cliScript: undefined, userDataDir: '/d', run });
		expect(result).toEqual({ ok: false, message: 'maestro-cli was not found beside the TUI.' });
		expect(run).not.toHaveBeenCalled();
	});

	it('turns a spawn failure into a result, never a throw', async () => {
		const result = await runMaestroCliHostStart({
			cliScript: '/x.js',
			userDataDir: '/d',
			run: async () => {
				throw new Error('spawn ENOENT');
			},
		});
		expect(result).toEqual({ ok: false, message: 'spawn ENOENT' });
	});
});
