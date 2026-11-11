import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { unusableCwdReason, unusableDirectoryReason } from '../cwd';

describe('unusableDirectoryReason', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cwd-'));
		fs.writeFileSync(path.join(root, 'file'), '');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('accepts a directory and an absent path', () => {
		expect(unusableDirectoryReason(root, 'Config dir')).toBeNull();
		expect(unusableDirectoryReason(undefined, 'Config dir')).toBeNull();
		expect(unusableDirectoryReason('', 'Config dir')).toBeNull();
	});

	it('names the directory by its label', () => {
		const missing = path.join(root, 'gone');
		const file = path.join(root, 'file');
		expect(unusableDirectoryReason(missing, 'Config dir')).toBe(
			`Config dir does not exist: ${missing}`
		);
		expect(unusableDirectoryReason(file, 'Config dir')).toBe(
			`Config dir is not a directory: ${file}`
		);
	});

	it('is what unusableCwdReason reports for a working directory', () => {
		const missing = path.join(root, 'gone');
		expect(unusableCwdReason(missing)).toBe(`Working directory does not exist: ${missing}`);
	});
});
