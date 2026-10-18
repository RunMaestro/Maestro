/**
 * Where a Cue `command.mode: cli` run finds `maestro-cli.js` when the engine is not inside Electron.
 *
 * `maestro-cli host` and `maestro-cli cue engine` run the engine from inside a maestro-cli bundle,
 * and that bundle can sit in any directory. Looking only under Electron's resources or a directory
 * named `cli` failed such a run with `Cannot find module .../cli/maestro-cli.js`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { resolveMaestroCliScriptPath } from '../../../main/cue/cue-cli-executor';

describe('resolveMaestroCliScriptPath outside Electron', () => {
	let dir: string;
	let argv1: string;

	beforeEach(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-bundle-')));
		argv1 = process.argv[1];
	});

	afterEach(() => {
		process.argv[1] = argv1;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('finds the running bundle when it does not live in a directory named cli', () => {
		const bundle = path.join(dir, 'maestro-cli.js');
		fs.writeFileSync(bundle, '');
		process.argv[1] = bundle;

		expect(resolveMaestroCliScriptPath()).toBe(bundle);
	});

	it('finds maestro-cli.js beside another running script', () => {
		const bundle = path.join(dir, 'maestro-cli.js');
		fs.writeFileSync(bundle, '');
		process.argv[1] = path.join(dir, 'maestro-p.js');

		expect(resolveMaestroCliScriptPath()).toBe(bundle);
	});

	it('keeps the first of the original candidates as the path a failure names', () => {
		// Nothing readable anywhere: the fallback is unchanged, so the error still names the dev layout.
		process.argv[1] = path.join(dir, 'maestro-cli.js');

		expect(resolveMaestroCliScriptPath()).toMatch(/[\\/]cli[\\/]maestro-cli\.js$/);
	});
});
