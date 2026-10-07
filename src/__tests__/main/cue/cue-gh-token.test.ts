/**
 * The GitHub token handed to Cue's own gh calls: looked up as a server secret
 * (systemd credential, then /run/secrets, then the environment) under gh's two
 * names, and placed in the child's environment only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildGhEnv, redactGhTokens } from '../../../main/cue/cue-gh-token';

describe('buildGhEnv', () => {
	let credentials: string;
	let runSecrets: string;

	beforeEach(() => {
		credentials = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-cred-')));
		runSecrets = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-run-')));
	});

	afterEach(() => {
		fs.rmSync(credentials, { recursive: true, force: true });
		fs.rmSync(runSecrets, { recursive: true, force: true });
	});

	it('prefers a systemd credential, then /run/secrets, then the environment', () => {
		const base = { CREDENTIALS_DIRECTORY: credentials, GH_TOKEN: 'env', PATH: '/bin' };

		expect(buildGhEnv(base, { runSecretsDir: runSecrets }).env.GH_TOKEN).toBe('env');

		fs.writeFileSync(path.join(runSecrets, 'GH_TOKEN'), 'docker\n');
		expect(buildGhEnv(base, { runSecretsDir: runSecrets }).env.GH_TOKEN).toBe('docker');

		fs.writeFileSync(path.join(credentials, 'GH_TOKEN'), 'systemd\n');
		const built = buildGhEnv(base, { runSecretsDir: runSecrets });
		expect(built.env.GH_TOKEN).toBe('systemd');
		expect(built.env.PATH).toBe('/bin');
		expect(built.tokens).toEqual(['systemd']);
		expect(base.GH_TOKEN).toBe('env');
	});

	it('resolves GITHUB_TOKEN too, leaving gh to rank the two names', () => {
		fs.writeFileSync(path.join(runSecrets, 'GITHUB_TOKEN'), 'docker');
		const built = buildGhEnv({ GH_TOKEN: 'env' }, { runSecretsDir: runSecrets });
		expect(built.env).toMatchObject({ GH_TOKEN: 'env', GITHUB_TOKEN: 'docker' });
		expect(built.problems).toEqual([]);
	});

	it('drops the variable and reports the file, not a value, when the file is unusable', () => {
		fs.writeFileSync(path.join(runSecrets, 'GH_TOKEN'), '');
		const built = buildGhEnv({ GH_TOKEN: 'stale' }, { runSecretsDir: runSecrets });
		expect(built.env.GH_TOKEN).toBeUndefined();
		expect(built.tokens).toEqual([]);
		expect(built.problems).toEqual([`GH_TOKEN (${path.join(runSecrets, 'GH_TOKEN')}) is empty`]);
		expect(built.problems.join()).not.toContain('stale');
	});

	it('leaves the environment alone when no token is set anywhere', () => {
		const built = buildGhEnv({ PATH: '/bin' }, { runSecretsDir: null });
		expect(built.env).toEqual({ PATH: '/bin' });
		expect(built.tokens).toEqual([]);
	});
});

describe('redactGhTokens', () => {
	it('replaces every occurrence of every token', () => {
		expect(redactGhTokens('a tok b tok c other', ['tok', 'other'])).toBe(
			'a [redacted] b [redacted] c [redacted]'
		);
		expect(redactGhTokens('unchanged', [])).toBe('unchanged');
	});
});
