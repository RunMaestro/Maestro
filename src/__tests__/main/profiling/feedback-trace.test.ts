/**
 * @file feedback-trace.test.ts
 * @description The Feedback trace bundle check (src/main/profiling/feedback-trace.ts), against a real
 * temp folder with real files and symlinks. Feedback submit uploads the file a caller names to a
 * public repo and then deletes it, so only a bundle the capture wrote may pass: a path outside the
 * folder, a `..` path out of it, a symlink in it that points out, a wrong name, and a folder are refused.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The folder `app.getPath('temp')` answers with, set per suite.
const electronPaths = vi.hoisted(() => ({ temp: '' }));

vi.mock('electron', () => ({
	app: {
		getPath: (name: string) => {
			if (name !== 'temp') throw new Error(`unexpected app.getPath(${name})`);
			return electronPaths.temp;
		},
	},
}));

import {
	checkFeedbackTraceBundle,
	feedbackTraceBundlePath,
	forgetFeedbackTraceBundle,
	recordFeedbackTraceBundle,
	resetCapturedFeedbackTraceBundlesForTests,
} from '../../../main/profiling/feedback-trace';

/** The timestamp `debug:stopProfilingToFile` builds, for a fixed time. */
const captureTimestamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-').slice(0, 19);

const VALID_NAME = 'maestro-profile-2026-11-24T12-34-56.zip';

// Fixture folders resolve with `realpathSync.native`, the resolver `fs.promises.realpath` uses, so a
// Windows 8.3 temp path (`RUNNER~1` on CI) expands the same way in the test and in the check.

describe('checkFeedbackTraceBundle', () => {
	let base: string;
	let bundleDir: string;
	let outside: string;

	beforeAll(() => {
		base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-trace-')));
		bundleDir = path.join(base, 'temp');
		outside = path.join(base, 'outside');
		fs.mkdirSync(path.join(bundleDir, 'nested'), { recursive: true });
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(bundleDir, VALID_NAME), 'zip');
		fs.writeFileSync(path.join(bundleDir, 'nested', VALID_NAME), 'zip');
		fs.writeFileSync(path.join(bundleDir, 'notes.zip'), 'zip');
		fs.mkdirSync(path.join(bundleDir, 'maestro-profile-2026-11-24T01-01-01.zip'));
		fs.writeFileSync(path.join(outside, VALID_NAME), 'secret');
		electronPaths.temp = bundleDir;
	});

	beforeEach(() => {
		resetCapturedFeedbackTraceBundlesForTests();
	});

	afterEach(() => {
		resetCapturedFeedbackTraceBundlesForTests();
	});

	afterAll(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	it('accepts a trace bundle the capture wrote, at its real path', async () => {
		const candidate = path.join(bundleDir, VALID_NAME);
		await recordFeedbackTraceBundle(candidate);
		await expect(checkFeedbackTraceBundle(candidate)).resolves.toEqual({
			ok: true,
			realPath: candidate,
		});
	});

	it('refuses a temp file with a valid bundle name that Maestro did not capture', async () => {
		const candidate = path.join(bundleDir, VALID_NAME);
		await expect(checkFeedbackTraceBundle(candidate)).resolves.toEqual({
			ok: false,
			reason: 'not a trace bundle Maestro captured',
		});
	});

	it('refuses a previously captured bundle once forgotten', async () => {
		const candidate = path.join(bundleDir, VALID_NAME);
		await recordFeedbackTraceBundle(candidate);
		forgetFeedbackTraceBundle(candidate);
		await expect(checkFeedbackTraceBundle(candidate)).resolves.toEqual({
			ok: false,
			reason: 'not a trace bundle Maestro captured',
		});
	});

	it('refuses a registered trace bundle whose contents were replaced after capture', async () => {
		const candidate = path.join(bundleDir, 'maestro-profile-2026-11-24T12-34-57.zip');
		fs.writeFileSync(candidate, 'original-zip-bytes');
		await recordFeedbackTraceBundle(candidate);
		// Same-length replacement defeats a size-only check; different-length also fails.
		fs.writeFileSync(candidate, 'replaced-key-bytes');
		await expect(checkFeedbackTraceBundle(candidate)).resolves.toEqual({
			ok: false,
			reason: 'trace bundle was modified after capture',
		});
		fs.writeFileSync(candidate, 'much-longer-private-key-contents');
		await expect(checkFeedbackTraceBundle(candidate)).resolves.toEqual({
			ok: false,
			reason: 'trace bundle was modified after capture',
		});
	});

	it('refuses a path outside the bundle folder, even with the right name', async () => {
		const result = await checkFeedbackTraceBundle(path.join(outside, VALID_NAME));
		expect(result).toEqual({ ok: false, reason: 'not in the folder Maestro writes traces to' });
	});

	it('refuses a `..` path that starts in the bundle folder and climbs out of it', async () => {
		// Spelled out by hand: path.join would fold the `..` away. A prefix check on the
		// raw string (the old debug:discardTrace guard) accepts this path.
		const climbing = [bundleDir, '..', 'outside', VALID_NAME].join(path.sep);
		expect(climbing.startsWith(bundleDir)).toBe(true);
		const result = await checkFeedbackTraceBundle(climbing);
		expect(result).toEqual({ ok: false, reason: 'not in the folder Maestro writes traces to' });
	});

	it('refuses a bundle in a subfolder of the bundle folder', async () => {
		const result = await checkFeedbackTraceBundle(path.join(bundleDir, 'nested', VALID_NAME));
		expect(result.ok).toBe(false);
	});

	it('refuses a file in the bundle folder whose name the capture never writes', async () => {
		const result = await checkFeedbackTraceBundle(path.join(bundleDir, 'notes.zip'));
		expect(result).toEqual({ ok: false, reason: 'not named like a trace Maestro captured' });
	});

	it('refuses a folder named like a bundle', async () => {
		const result = await checkFeedbackTraceBundle(
			path.join(bundleDir, 'maestro-profile-2026-11-24T01-01-01.zip')
		);
		expect(result).toEqual({ ok: false, reason: 'not a regular file' });
	});

	it('refuses a bundle name with no file behind it', async () => {
		const result = await checkFeedbackTraceBundle(
			path.join(bundleDir, 'maestro-profile-2026-11-24T02-02-02.zip')
		);
		expect(result).toEqual({ ok: false, reason: 'no readable file there (ENOENT)' });
	});

	it('refuses a relative path and anything that is not a string', async () => {
		await expect(checkFeedbackTraceBundle(VALID_NAME)).resolves.toEqual({
			ok: false,
			reason: 'not an absolute path',
		});
		for (const value of [undefined, null, 42, { path: VALID_NAME }]) {
			await expect(checkFeedbackTraceBundle(value)).resolves.toMatchObject({ ok: false });
		}
	});
});

// Symlinks need a privilege Windows runners may lack; real-path-containment.test.ts skips the same way.
describe.skipIf(process.platform === 'win32')('checkFeedbackTraceBundle with symlinks', () => {
	let base: string;
	let bundleDir: string;
	let outside: string;

	beforeAll(() => {
		base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-trace-links-')));
		bundleDir = path.join(base, 'temp');
		outside = path.join(base, 'outside');
		fs.mkdirSync(bundleDir);
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(bundleDir, VALID_NAME), 'zip');
		fs.writeFileSync(path.join(outside, 'id_rsa'), 'secret');
		// A link in the bundle folder, named like a bundle, that points out of it.
		fs.symlinkSync(
			path.join(outside, 'id_rsa'),
			path.join(bundleDir, 'maestro-profile-2026-11-24T00-00-00.zip')
		);
		// The bundle folder reached through a symlink, as macOS reaches /var through /private/var.
		fs.symlinkSync(bundleDir, path.join(base, 'temp-link'));
	});

	afterAll(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	it('refuses a symlink in the bundle folder that points out of it', async () => {
		electronPaths.temp = bundleDir;
		const result = await checkFeedbackTraceBundle(
			path.join(bundleDir, 'maestro-profile-2026-11-24T00-00-00.zip')
		);
		expect(result).toEqual({ ok: false, reason: 'not in the folder Maestro writes traces to' });
	});

	it('accepts a bundle when the bundle folder is reached through a symlink', async () => {
		resetCapturedFeedbackTraceBundlesForTests();
		electronPaths.temp = path.join(base, 'temp-link');
		const linkedCandidate = path.join(base, 'temp-link', VALID_NAME);
		await recordFeedbackTraceBundle(linkedCandidate);
		const result = await checkFeedbackTraceBundle(linkedCandidate);
		expect(result).toEqual({ ok: true, realPath: path.join(bundleDir, VALID_NAME) });
		resetCapturedFeedbackTraceBundlesForTests();
	});
});

describe('feedbackTraceBundlePath', () => {
	let bundleDir: string;

	beforeAll(() => {
		bundleDir = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-trace-path-'))
		);
		electronPaths.temp = bundleDir;
	});

	afterAll(() => {
		fs.rmSync(bundleDir, { recursive: true, force: true });
	});

	it('names the bundle from the capture timestamp, in the temp folder', () => {
		const timestamp = captureTimestamp(new Date('2026-11-24T12:34:56.789Z'));
		expect(feedbackTraceBundlePath(timestamp)).toBe(path.join(bundleDir, VALID_NAME));
	});

	it('writes only names the check accepts', async () => {
		resetCapturedFeedbackTraceBundlesForTests();
		electronPaths.temp = bundleDir;
		const written = feedbackTraceBundlePath(captureTimestamp(new Date()));
		fs.writeFileSync(written, 'zip');
		await recordFeedbackTraceBundle(written);
		await expect(checkFeedbackTraceBundle(written)).resolves.toEqual({
			ok: true,
			realPath: written,
		});
		resetCapturedFeedbackTraceBundlesForTests();
	});

	it('throws for a timestamp the check would refuse', () => {
		expect(() => feedbackTraceBundlePath('../../escape')).toThrow(/Not a trace capture timestamp/);
		expect(() => feedbackTraceBundlePath('2026-11-24')).toThrow(/Not a trace capture timestamp/);
	});
});
