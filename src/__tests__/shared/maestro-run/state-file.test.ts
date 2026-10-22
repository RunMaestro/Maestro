/**
 * @file state-file.test.ts
 * @description How the CLI learns MaestroRun is ready: the state file the
 * desktop app writes. Anything short of a valid "ready" reads as not ready.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMaestroRunReadyPath } from '../../../shared/maestro-run/state-file';

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-run-state-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function write(content: string): void {
	fs.mkdirSync(path.join(dir, 'maestro-run'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'maestro-run', 'state.json'), content);
}

describe('readMaestroRunReadyPath', () => {
	it('returns the launcher path when the app recorded it as ready', () => {
		write(
			JSON.stringify({ ready: true, binaryPath: '/a/maestro-run', version: '0.2.0', checkedAt: 1 })
		);
		expect(readMaestroRunReadyPath(dir)).toBe('/a/maestro-run');
	});

	it('returns undefined when the launcher is installed but not ready', () => {
		write(JSON.stringify({ ready: false, binaryPath: '/a/maestro-run', version: '0.2.0' }));
		expect(readMaestroRunReadyPath(dir)).toBeUndefined();
	});

	it('returns undefined when the file is missing or is not a state file', () => {
		expect(readMaestroRunReadyPath(dir)).toBeUndefined();
		write('not json');
		expect(readMaestroRunReadyPath(dir)).toBeUndefined();
		write(JSON.stringify({ ready: true }));
		expect(readMaestroRunReadyPath(dir)).toBeUndefined();
	});
});
