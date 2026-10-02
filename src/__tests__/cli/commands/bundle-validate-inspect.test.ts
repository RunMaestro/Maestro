/**
 * @file bundle-validate-inspect.test.ts
 * @description `maestro-cli bundle validate` and `bundle inspect` against real
 * zips on disk: text and JSON output, and the exit code a script branches on.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bundleInspect, bundleValidate } from '../../../cli/commands/bundle';
import { ExitCode } from '../../../cli/exit-codes';
import { writeCueBundle } from '../../helpers/cueBundleFixture';

let tmp: string;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

function stdout(): string {
	return logSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bundle-')));
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('bundle validate', () => {
	it('prints PASS and exits 0 for a valid bundle', async () => {
		const file = writeCueBundle(path.join(tmp, 'ok.zip'));
		await bundleValidate('0.18.6', file, {});
		expect(exitSpy).not.toHaveBeenCalled();
		expect(stdout()).toMatch(/^PASS {2}.*ok\.zip {2}\(0 errors, 0 warnings\)$/);
	});

	it('prints FAIL with structured issues and exits 1', async () => {
		const file = writeCueBundle(path.join(tmp, 'bad.zip'), {
			unlisted: { 'extra.txt': 'x' },
		});
		await expect(bundleValidate('0.18.6', file, {})).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		const out = stdout();
		expect(out).toContain('FAIL');
		expect(out).toContain('Errors:');
		expect(out).toContain(
			'[unlisted-file] Present in the archive but not listed in manifest.files (extra.txt)'
		);
	});

	it('names the required engine version when this CLI is too old', async () => {
		const file = writeCueBundle(path.join(tmp, 'new.zip'), {
			manifest: (m) => (m.minEngineVersion = '0.19.0'),
		});
		await expect(bundleValidate('0.18.6-RC', file, {})).rejects.toThrow('__exit__');
		expect(stdout()).toContain('requires Cue engine 0.19.0 or newer; this is 0.18.6-RC');
	});

	it('emits the JSON payload with valid, errors, and warnings', async () => {
		const file = writeCueBundle(path.join(tmp, 'bad.zip'), {
			tamper: { 'README.md': 'changed' },
		});
		await expect(bundleValidate('0.18.6', file, { json: true })).rejects.toThrow('__exit__');
		const payload = JSON.parse(stdout());
		expect(payload.success).toBe(true);
		expect(payload.valid).toBe(false);
		expect(payload.errors).toContainEqual({
			code: 'hash-mismatch',
			message: 'SHA-256 does not match the manifest',
			file: 'README.md',
		});
		expect(payload.warnings).toEqual([]);
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('reports unset secrets as warnings with --check-env and still exits 0', async () => {
		const file = writeCueBundle(path.join(tmp, 'ok.zip'));
		vi.stubEnv('API_KEY', 'set');
		vi.stubEnv('HOOK_SECRET', '');
		try {
			await bundleValidate('0.18.6', file, { json: true, checkEnv: true });
		} finally {
			vi.unstubAllEnvs();
		}
		expect(exitSpy).not.toHaveBeenCalled();
		const payload = JSON.parse(stdout());
		expect(payload.valid).toBe(true);
		expect(payload.warnings).toEqual([
			{ code: 'secret-unset', message: 'HOOK_SECRET is not set in this environment' },
		]);
	});

	it('returns success:false when the archive cannot be read', async () => {
		const file = path.join(tmp, 'not.zip');
		fs.writeFileSync(file, 'plain text');
		await expect(bundleValidate('0.18.6', file, { json: true })).rejects.toThrow('__exit__');
		const payload = JSON.parse(stdout());
		expect(payload.success).toBe(false);
		expect(payload.error).toContain('Could not read bundle');
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});
});

describe('bundle inspect', () => {
	it('prints an overview from the manifest', async () => {
		const file = writeCueBundle(path.join(tmp, 'ok.zip'), {
			manifest: (m) => (m.warnings = ['Agent "Alpha" runs over SSH']),
		});
		await bundleInspect(file, {});
		expect(exitSpy).not.toHaveBeenCalled();
		const out = stdout();
		expect(out).toContain('Fixture (pipeline bundle)');
		expect(out).toContain('needs Cue engine 0.18.0 or newer');
		expect(out).toContain('Alpha (claude-code) in workspace proj');
		expect(out).toContain(
			'proj (proj) from https://github.com/acme/proj.git (main) @ aaaaaaaaaaaa'
		);
		expect(out).toContain('Secrets: API_KEY, HOOK_SECRET');
		expect(out).toContain('Agent "Alpha" runs over SSH');
	});

	it('emits the manifest and README as JSON', async () => {
		const file = writeCueBundle(path.join(tmp, 'ok.zip'));
		await bundleInspect(file, { json: true });
		const payload = JSON.parse(stdout());
		expect(payload.success).toBe(true);
		expect(payload.manifest.name).toBe('Fixture');
		expect(payload.readme).toBe('# Fixture\n');
	});

	it('does not need the rest of the archive to be intact', async () => {
		const file = writeCueBundle(path.join(tmp, 'tampered.zip'), {
			tamper: { 'agents/agent-a.json': 'not json' },
		});
		await bundleInspect(file, { json: true });
		expect(JSON.parse(stdout()).success).toBe(true);
	});

	it('fails with exit 1 on a non-zip', async () => {
		const file = path.join(tmp, 'not.zip');
		fs.writeFileSync(file, 'plain text');
		await expect(bundleInspect(file, {})).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		expect(String(errorSpy.mock.calls[0][0])).toContain('Could not read bundle');
	});
});
