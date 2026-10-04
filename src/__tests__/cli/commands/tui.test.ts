/**
 * @file tui.test.ts
 * @description Tests for the `maestro-cli tui` launcher: bundle lookup and
 * argument pass-through, with child_process mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
// The real bundle may or may not be built in this checkout; fake its presence.
vi.mock('fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs')>()),
	existsSync: vi.fn(() => true),
}));

import { spawn } from 'child_process';
import {
	buildTuiArgs,
	resolveTuiBundlePath,
	tui,
	tuiBundleCandidates,
} from '../../../cli/commands/tui';

describe('tui bundle lookup', () => {
	it('prefers the bundle beside the running CLI', () => {
		const dir = path.join('/app', 'dist', 'cli');
		expect(resolveTuiBundlePath(dir, () => true)).toBe(path.join(dir, 'maestro-tui.mjs'));
	});

	it('falls back to dist/cli of a dev checkout when run from source', () => {
		const dir = path.join('/repo', 'src', 'cli');
		const expected = path.join('/repo', 'dist', 'cli', 'maestro-tui.mjs');
		expect(resolveTuiBundlePath(dir, (f) => f === expected)).toBe(expected);
		expect(tuiBundleCandidates(dir)).toHaveLength(2);
	});

	it('returns null when the bundle was never built', () => {
		expect(resolveTuiBundlePath('/repo/src/cli', () => false)).toBeNull();
	});
});

describe('buildTuiArgs', () => {
	it('passes through nothing by default', () => {
		expect(buildTuiArgs({})).toEqual([]);
	});

	it('passes --data-dir, --dev and --doctor through', () => {
		expect(buildTuiArgs({ dataDir: '/tmp/d', dev: true, doctor: true })).toEqual([
			'--data-dir',
			'/tmp/d',
			'--dev',
			'--doctor',
		]);
	});
});

describe('tui launcher', () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.mocked(spawn).mockReset();
	});

	it('spawns the current node with inherited stdio and exits with the child code', async () => {
		const child = new EventEmitter();
		vi.mocked(spawn).mockReturnValue(child as never);
		await tui({ dataDir: '/tmp/d', doctor: true });

		const [command, args, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [
			string,
			string[],
			{ stdio: string },
		];
		expect(command).toBe(process.execPath);
		expect(args[0]).toMatch(/maestro-tui\.mjs$/);
		expect(args.slice(1)).toEqual(['--data-dir', '/tmp/d', '--doctor']);
		expect(opts.stdio).toBe('inherit');

		child.emit('exit', 7, null);
		expect(exitSpy).toHaveBeenCalledWith(7);
	});
});
