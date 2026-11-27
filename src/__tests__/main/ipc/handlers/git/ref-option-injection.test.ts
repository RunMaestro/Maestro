/**
 * Git names that start with `-` (#19), against a real git.
 *
 * git.test.ts mocks execFile, so it can only check the argv the handlers build.
 * This suite runs the real handlers on a throwaway repository to show what git
 * does with that argv. The old argv made git write a file the caller named
 * (`--output=<file>`) or throw away local changes (`checkout -f`). The new argv
 * does neither, and a path that starts with `-` still reads as a path.
 */

import { spawnSync } from 'child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerReadHandlers } from '../../../../../main/ipc/handlers/git/read';
import { registerBranchHandlers } from '../../../../../main/ipc/handlers/git/branch';

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, handler: Handler) => {
			handlers.set(channel, handler);
		},
	},
	BrowserWindow: { getAllWindows: () => [] },
}));

// No SSH remote: every handler runs the local git.
vi.mock('../../../../../main/stores', () => ({ getSshRemoteById: () => undefined }));

vi.mock('../../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const gitAvailable = spawnSync('git', ['--version'], { timeout: 5000 }).status === 0;

// Git exports its repository-location variables (GIT_DIR and friends) to hooks,
// so a pre-push run of this suite inherits them. The handlers run git with this
// process's environment, and those variables would point every call at the
// host repository instead of the fixture.
const gitLocalEnvVars = gitAvailable
	? (
			spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8', timeout: 5000 })
				.stdout ?? ''
		)
			.split(/\r?\n/)
			.filter(Boolean)
	: [];

function call(channel: string, ...args: unknown[]): Promise<any> {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`${channel} is not registered`);
	return handler({}, ...args);
}

describe.skipIf(!gitAvailable)('git names that start with "-" (real git)', () => {
	let fixtureRoot: string;
	let repo: string;

	/** Overrides that keep git off the host repository and off the developer's config. */
	function hermeticEnv(): Record<string, string | undefined> {
		return {
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: path.join(fixtureRoot, 'gitconfig'),
			...Object.fromEntries(gitLocalEnvVars.map((name) => [name, undefined])),
		};
	}

	function fixtureEnv(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const [name, value] of Object.entries(hermeticEnv())) {
			if (value === undefined) delete env[name];
			else env[name] = value;
		}
		return env;
	}

	function fixtureGit(...args: string[]) {
		return spawnSync(
			'git',
			[
				'-c',
				'user.name=Maestro Test',
				'-c',
				'user.email=test@example.invalid',
				'-c',
				'commit.gpgsign=false',
				...args,
			],
			{ cwd: repo, encoding: 'utf8', timeout: 5000, env: fixtureEnv() }
		);
	}

	/** Every entry in the fixture folder whose name starts with `name`. */
	function entriesNamed(name: string): string[] {
		return readdirSync(fixtureRoot).filter((entry) => entry.startsWith(name));
	}

	beforeAll(() => {
		// Keep the fixture out of the checkout: a stray repository must never sit
		// inside the project being tested.
		fixtureRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'maestro-git-argv-')));
		repo = path.join(fixtureRoot, 'repo');
		mkdirSync(repo);
		writeFileSync(path.join(fixtureRoot, 'gitconfig'), '');
		const setup = (...args: string[]) => {
			const result = fixtureGit(...args);
			expect(result.status, result.stderr).toBe(0);
		};
		setup('init', '-q');
		writeFileSync(path.join(repo, '-notes.txt'), 'one\n');
		setup('add', '--', '-notes.txt');
		setup('commit', '-q', '-m', 'notes');
		// A local change, which every handler below must leave alone.
		writeFileSync(path.join(repo, '-notes.txt'), 'two\n');

		registerReadHandlers();
		registerBranchHandlers({ settingsStore: { get: () => undefined }, getMainWindow: () => null });
	});

	beforeEach(() => {
		for (const [name, value] of Object.entries(hermeticEnv())) vi.stubEnv(name, value);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	afterAll(() => {
		handlers.clear();
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	});

	// The control: without it, "no file was written" below could only mean that
	// this git ignores --output, not that the handler stopped it.
	it('lets the old git:diff argv write the file the caller names', () => {
		const marker = path.join(fixtureRoot, 'old-diff-output');

		const result = fixtureGit('diff', `--output=${marker}`);

		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});

	it('git:diff reads a path of --output=<file> as a path and writes no file', async () => {
		const marker = path.join(fixtureRoot, 'diff-output');

		const result = await call('git:diff', repo, `--output=${marker}`);

		expect(result).toEqual({ stdout: '', stderr: '' });
		expect(entriesNamed('diff-output')).toEqual([]);
	});

	it('git:diff diffs a file whose name starts with "-"', async () => {
		const result = await call('git:diff', repo, '-notes.txt');

		expect(result.stdout).toContain('-notes.txt');
		expect(result.stdout).toContain('+two');
	});

	it('git:show refuses a revision of --output=<file> and writes no file', async () => {
		const marker = path.join(fixtureRoot, 'show-output');

		const result = await call('git:show', repo, `--output=${marker}`);

		expect(result.stdout).toBe('');
		expect(result.stderr).toMatch(/^Invalid revision: --output=/);
		expect(entriesNamed('show-output')).toEqual([]);
	});

	it('git:show still shows a commit', async () => {
		const result = await call('git:show', repo, 'HEAD');

		expect(result.stdout).toContain('-notes.txt');
		expect(result.stdout).toContain('+one');
	});

	// The old argv was `--output=<file>:notes.txt`, one argument git read as an option.
	it('git:showFile refuses a ref of --output=<file> and writes no file', async () => {
		const marker = path.join(fixtureRoot, 'show-file-output');

		const result = await call('git:showFile', repo, `--output=${marker}`, 'notes.txt');

		expect(result.error).toMatch(/^Invalid ref: --output=/);
		expect(entriesNamed('show-file-output')).toEqual([]);
	});

	it('git:showFile reads a file whose name starts with "-" at HEAD', async () => {
		const result = await call('git:showFile', repo, 'HEAD', '-notes.txt');

		expect(result.content.trim()).toBe('one');
	});

	// `git checkout -f` throws away local changes.
	it('git:checkoutBranch refuses -f and the local change survives', async () => {
		const result = await call('git:checkoutBranch', repo, '-f');

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/^Invalid branch name: -f /);
		expect(readFileSync(path.join(repo, '-notes.txt'), 'utf8')).toBe('two\n');
	});
});
