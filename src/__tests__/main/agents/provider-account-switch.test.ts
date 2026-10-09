/**
 * Tests for src/main/agents/provider-account-switch.ts
 *
 * Runs against real temp directories, because the behavior under test IS the
 * filesystem: which `.claude.json` the default account is read from, whether a
 * symlinked transcript folder counts as shared, and that a carried transcript
 * lands where `--resume` will look for it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
	carryProviderSession,
	readProviderAccountIdentities,
} from '../../../main/agents/provider-account-switch';
import { encodeClaudeProjectPath } from '../../../shared/pathUtils';

let home: string;

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function jwtWithEmail(email: string): string {
	const payload = Buffer.from(JSON.stringify({ email })).toString('base64url');
	return `header.${payload}.signature`;
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-switch-'));
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

describe('readProviderAccountIdentities', () => {
	it('reads the default Claude account from $HOME and the others from their dir', async () => {
		write(
			path.join(home, '.claude.json'),
			JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } })
		);
		write(
			path.join(home, '.claude-work', '.claude.json'),
			JSON.stringify({ oauthAccount: { emailAddress: 'b@x.com' } })
		);
		fs.mkdirSync(path.join(home, '.claude-empty'));

		const identities = await readProviderAccountIdentities(
			'claude-code',
			[
				path.join(home, '.claude'),
				path.join(home, '.claude-work'),
				path.join(home, '.claude-empty'),
			],
			home
		);
		expect(identities.map((i) => [i.email, i.signedIn])).toEqual([
			['a@x.com', true],
			['b@x.com', true],
			[undefined, false],
		]);
	});

	it('reads the Codex email out of the id token', async () => {
		write(
			path.join(home, '.codex-work', 'auth.json'),
			JSON.stringify({ tokens: { id_token: jwtWithEmail('c@x.com') } })
		);
		const [signedIn, signedOut] = await readProviderAccountIdentities(
			'codex',
			[path.join(home, '.codex-work'), path.join(home, '.codex')],
			home
		);
		expect(signedIn).toMatchObject({ email: 'c@x.com', signedIn: true });
		expect(signedOut).toMatchObject({ signedIn: false });
	});
});

describe('carryProviderSession', () => {
	const cwd = '/Users/me/project';

	it('reports shared when both accounts resolve to one transcript folder', async () => {
		fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
		fs.mkdirSync(path.join(home, '.claude-work'));
		// A junction on Windows, where a plain directory symlink needs admin rights.
		fs.symlinkSync(
			path.join(home, '.claude', 'projects'),
			path.join(home, '.claude-work', 'projects'),
			'junction'
		);

		await expect(
			carryProviderSession({
				toolType: 'claude-code',
				fromAccountKey: path.join(home, '.claude'),
				toAccountKey: path.join(home, '.claude-work'),
				sessionId: 'abc',
				cwd,
			})
		).resolves.toBe('shared');
	});

	it('copies a Claude transcript into the target project folder, once', async () => {
		const relative = path.join(encodeClaudeProjectPath(cwd), 'abc.jsonl');
		write(path.join(home, '.claude', 'projects', relative), '{"line":1}\n');
		const req = {
			toolType: 'claude-code',
			fromAccountKey: path.join(home, '.claude'),
			toAccountKey: path.join(home, '.claude-work'),
			sessionId: 'abc',
			cwd,
		};

		await expect(carryProviderSession(req)).resolves.toBe('copied');
		expect(fs.readFileSync(path.join(home, '.claude-work', 'projects', relative), 'utf8')).toBe(
			'{"line":1}\n'
		);
		await expect(carryProviderSession(req)).resolves.toBe('present');
	});

	it('reports missing when the source has no such transcript', async () => {
		await expect(
			carryProviderSession({
				toolType: 'claude-code',
				fromAccountKey: path.join(home, '.claude'),
				toAccountKey: path.join(home, '.claude-work'),
				sessionId: 'nope',
				cwd,
			})
		).resolves.toBe('missing');
	});

	it('finds a Codex rollout by id and keeps its dated path', async () => {
		const relative = path.join('2026', '10', '03', 'rollout-2026-10-03T10-00-00-abc-123.jsonl');
		write(path.join(home, '.codex', 'sessions', relative), '{}\n');

		await expect(
			carryProviderSession({
				toolType: 'codex',
				fromAccountKey: path.join(home, '.codex'),
				toAccountKey: path.join(home, '.codex-work'),
				sessionId: 'abc-123',
				cwd,
			})
		).resolves.toBe('copied');
		expect(fs.existsSync(path.join(home, '.codex-work', 'sessions', relative))).toBe(true);
	});

	it('refuses a provider with no per-account transcripts', async () => {
		await expect(
			carryProviderSession({
				toolType: 'opencode',
				fromAccountKey: 'a',
				toAccountKey: 'b',
				sessionId: 'x',
				cwd,
			})
		).rejects.toThrow(/no per-account transcripts/);
	});
});
