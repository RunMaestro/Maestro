/**
 * The one lookup every server secret goes through: systemd credential, then
 * `/run/secrets`, then the environment. Real files in a temp dir; the
 * `/run/secrets` location is injected so the host's own mounts never leak in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	MAX_SECRET_FILE_BYTES,
	describeSecretProblem,
	isValidSecretName,
	lookupSecret,
	resolveSecrets,
} from '../../shared/serverSecrets';

// Pass-through, so the default-location tests can see which paths were statted.
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

let tmp: string;
let credentials: string;
let runSecrets: string;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'server-secrets-')));
	credentials = path.join(tmp, 'credentials');
	runSecrets = path.join(tmp, 'run-secrets');
	fs.mkdirSync(credentials);
	fs.mkdirSync(runSecrets);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

const options = (env: NodeJS.ProcessEnv = {}) => ({
	env: { CREDENTIALS_DIRECTORY: credentials, ...env },
	runSecretsDir: runSecrets,
});

describe('lookupSecret precedence', () => {
	it('prefers the systemd credential, then /run/secrets, then the environment', () => {
		fs.writeFileSync(path.join(credentials, 'TOKEN'), 'from-credentials');
		fs.writeFileSync(path.join(runSecrets, 'TOKEN'), 'from-run-secrets');
		expect(lookupSecret('TOKEN', options({ TOKEN: 'from-env' }))).toEqual({
			status: 'found',
			value: 'from-credentials',
			source: 'credentials',
		});

		fs.rmSync(path.join(credentials, 'TOKEN'));
		expect(lookupSecret('TOKEN', options({ TOKEN: 'from-env' }))).toMatchObject({
			value: 'from-run-secrets',
			source: 'run-secrets',
		});

		fs.rmSync(path.join(runSecrets, 'TOKEN'));
		expect(lookupSecret('TOKEN', options({ TOKEN: 'from-env' }))).toMatchObject({
			value: 'from-env',
			source: 'env',
		});
	});

	it('reports missing when no source sets it, and treats an empty env value as unset', () => {
		expect(lookupSecret('TOKEN', options())).toEqual({ status: 'missing' });
		expect(lookupSecret('TOKEN', options({ TOKEN: '' }))).toEqual({ status: 'missing' });
	});

	it('skips the credentials directory when systemd did not set one, or set a relative path', () => {
		fs.writeFileSync(path.join(credentials, 'TOKEN'), 'from-credentials');
		const env = { TOKEN: 'from-env' };
		expect(lookupSecret('TOKEN', { env, runSecretsDir: null })).toMatchObject({ source: 'env' });
		expect(
			lookupSecret('TOKEN', {
				env: { ...env, CREDENTIALS_DIRECTORY: 'relative' },
				runSecretsDir: null,
			})
		).toMatchObject({ source: 'env' });
	});

	it('does not fall through to the environment when a file exists but is unusable', () => {
		fs.writeFileSync(path.join(runSecrets, 'TOKEN'), '');
		expect(lookupSecret('TOKEN', options({ TOKEN: 'stale-env' }))).toEqual({
			status: 'unusable',
			problem: 'empty',
			path: path.join(runSecrets, 'TOKEN'),
		});
	});

	it.skipIf(process.platform === 'win32')(
		'follows a symlink, the way Kubernetes mounts secret files',
		() => {
			fs.writeFileSync(path.join(tmp, 'actual'), 'linked-value\n');
			fs.symlinkSync(path.join(tmp, 'actual'), path.join(runSecrets, 'TOKEN'));
			expect(lookupSecret('TOKEN', options())).toMatchObject({ value: 'linked-value' });
		}
	);
});

describe('secret file contents', () => {
	it('drops exactly one trailing line ending', () => {
		const read = (content: string) => {
			fs.writeFileSync(path.join(runSecrets, 'TOKEN'), content);
			const lookup = lookupSecret('TOKEN', options());
			return lookup.status === 'found' ? lookup.value : lookup;
		};
		expect(read('abc\n')).toBe('abc');
		expect(read('abc\r\n')).toBe('abc');
		expect(read('abc')).toBe('abc');
		expect(read('abc\n\n')).toBe('abc\n');
		expect(read('  spaced  \n')).toBe('  spaced  ');
	});

	it('refuses a file over the size cap, a directory, and an empty file', () => {
		fs.writeFileSync(path.join(runSecrets, 'BIG'), 'x'.repeat(MAX_SECRET_FILE_BYTES + 1));
		fs.mkdirSync(path.join(runSecrets, 'DIR'));
		fs.writeFileSync(path.join(runSecrets, 'BLANK'), '\n');
		expect(lookupSecret('BIG', options())).toMatchObject({
			status: 'unusable',
			problem: 'too-large',
		});
		expect(lookupSecret('DIR', options())).toMatchObject({
			status: 'unusable',
			problem: 'not-a-file',
		});
		expect(lookupSecret('BLANK', options())).toMatchObject({
			status: 'unusable',
			problem: 'empty',
		});
	});

	it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
		'reports an unreadable file rather than throwing',
		() => {
			const file = path.join(runSecrets, 'LOCKED');
			fs.writeFileSync(file, 'value');
			fs.chmodSync(file, 0o000);
			expect(lookupSecret('LOCKED', options())).toEqual({
				status: 'unusable',
				problem: 'unreadable',
				path: file,
			});
		}
	);
});

describe('secret names', () => {
	it('accepts environment variable names only', () => {
		for (const name of ['GITHUB_TOKEN', '_X', 'a1']) expect(isValidSecretName(name)).toBe(true);
		for (const name of ['', '..', '../etc/passwd', 'a/b', 'a\\b', '1TOKEN', 'MY-TOKEN', 'A.B']) {
			expect(isValidSecretName(name)).toBe(false);
		}
	});

	it('never touches the filesystem for an invalid name', () => {
		fs.writeFileSync(path.join(tmp, 'outside'), 'escaped');
		expect(lookupSecret('../outside', options())).toEqual({
			status: 'unusable',
			problem: 'invalid-name',
		});
	});
});

describe('resolveSecrets', () => {
	it('de-duplicates, sorts, and splits found, missing and unusable names', () => {
		fs.writeFileSync(path.join(runSecrets, 'B_TOKEN'), 'b\n');
		fs.writeFileSync(path.join(runSecrets, 'C_TOKEN'), '');
		const result = resolveSecrets(
			['C_TOKEN', 'B_TOKEN', 'A_TOKEN', 'B_TOKEN', 'bad/name'],
			options()
		);
		expect(result.values).toEqual({ B_TOKEN: 'b' });
		expect(result.found).toEqual([{ name: 'B_TOKEN', source: 'run-secrets' }]);
		expect(result.missing).toEqual(['A_TOKEN']);
		expect(result.unusable.map((u) => [u.name, u.problem])).toEqual([
			['C_TOKEN', 'empty'],
			['bad/name', 'invalid-name'],
		]);
	});

	it('describes a problem by name and path, never by value', () => {
		const message = describeSecretProblem({
			name: 'TOKEN',
			problem: 'empty',
			path: '/run/secrets/TOKEN',
		});
		expect(message).toBe('TOKEN (/run/secrets/TOKEN) is empty');
	});
});

describe('the default /run/secrets location', () => {
	const originalPlatform = process.platform;
	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
	});

	function statted(platform: NodeJS.Platform): string[] {
		Object.defineProperty(process, 'platform', { value: platform, configurable: true });
		const stat = vi.mocked(fs.statSync);
		stat.mockClear();
		lookupSecret('TOKEN', { env: { TOKEN: 'from-env' } });
		return stat.mock.calls.map(([file]) => String(file));
	}

	it('is read on Linux', () => {
		expect(statted('linux')).toEqual([path.join('/run/secrets', 'TOKEN')]);
	});

	it('is not read on Windows, where it would mean C:\\run\\secrets', () => {
		expect(statted('win32')).toEqual([]);
	});
});
