/**
 * @file cue-yaml-write.test.ts
 * @description Unit tests for the shared write-side cue.yaml helpers extracted
 * from `cue-self-destruct.ts` and `cli/commands/cue-schedule.ts` so the
 * comment-preservation and atomic-write logic lives in one place.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	extractLeadingCommentBlock,
	writeCueYamlAtomicSync,
} from '../../../main/cue/cue-yaml-write';

describe('extractLeadingCommentBlock', () => {
	it('captures the leading comment + blank lines including the trailing newline', () => {
		const raw = '# Pipeline: Tasks (color: #abc)\n# second line\n\nsubscriptions:\n  - name: x\n';
		expect(extractLeadingCommentBlock(raw)).toBe(
			'# Pipeline: Tasks (color: #abc)\n# second line\n\n'
		);
	});

	it('returns an empty string when the file opens with content', () => {
		expect(extractLeadingCommentBlock('subscriptions:\n  - name: x\n')).toBe('');
	});

	it('stops at the first non-comment, non-blank line', () => {
		const raw = '# header\nsubscriptions: []\n# trailing comment is NOT part of the header\n';
		expect(extractLeadingCommentBlock(raw)).toBe('# header\n');
	});
});

describe('writeCueYamlAtomicSync', () => {
	let dir = '';

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-yaml-write-'));
	});

	afterEach(() => {
		if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it('writes the content and leaves no temp file behind', () => {
		const target = path.join(dir, 'cue.yaml');
		writeCueYamlAtomicSync(target, 'subscriptions: []\n');
		expect(fs.readFileSync(target, 'utf-8')).toBe('subscriptions: []\n');
		expect(fs.existsSync(target + '.tmp')).toBe(false);
	});

	it('overwrites an existing file in place', () => {
		const target = path.join(dir, 'cue.yaml');
		fs.writeFileSync(target, 'old\n', 'utf-8');
		writeCueYamlAtomicSync(target, 'new\n');
		expect(fs.readFileSync(target, 'utf-8')).toBe('new\n');
	});

	it('rethrows and preserves the original file when the rename target is unwritable', () => {
		// Point at a path whose parent does not exist so writeFileSync throws; the
		// original (here, absent) file must be left untouched and the error surfaced.
		const target = path.join(dir, 'no-such-subdir', 'cue.yaml');
		expect(() => writeCueYamlAtomicSync(target, 'data\n')).toThrow();
		expect(fs.existsSync(target)).toBe(false);
		expect(fs.existsSync(target + '.tmp')).toBe(false);
	});
});
