import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	copyOmpSettings,
	detectCopyableOmpSettings,
	ompDefaultBase,
	ompProfileBase,
} from '../omp-settings';
import { offerOmpSettingsCopy } from '../launcher';

let home: string;

function write(filePath: string, content = 'x'): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function env(): Record<string, string> {
	return { USERPROFILE: home, HOME: home };
}

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), 'mae-omp-'));
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

describe('detectCopyableOmpSettings', () => {
	test('no setup -> hasExistingSetup false, empty items', () => {
		const d = detectCopyableOmpSettings(env(), 'maestro');
		expect(d.hasExistingSetup).toBe(false);
		expect(d.items).toEqual([]);
	});

	test('detects default config + lists only allowlisted items', () => {
		const base = ompDefaultBase(env());
		write(path.join(base, 'config.yml'));
		write(path.join(base, 'mcp.json'));
		write(path.join(base, 'skills', 'a.md'));
		write(path.join(base, 'agent.db')); // credential vault - excluded
		write(path.join(base, 'sessions', 's.jsonl')); // state - excluded
		const d = detectCopyableOmpSettings(env(), 'maestro');
		expect(d.hasExistingSetup).toBe(true);
		expect(d.maestroConfigured).toBe(false);
		expect(d.items).toContain('config.yml');
		expect(d.items).toContain('mcp.json');
		expect(d.items).toContain('skills/');
		expect(d.items).not.toContain('agent.db');
		expect(d.items).not.toContain('sessions/');
	});

	test('detects setup from non-marker config alone (mcp.json / skills only)', () => {
		const base = ompDefaultBase(env());
		write(path.join(base, 'mcp.json'));
		write(path.join(base, 'skills', 'a.md'));
		const d = detectCopyableOmpSettings(env(), 'maestro');
		expect(d.hasExistingSetup).toBe(true); // no config.yml/settings.json, still detected
		expect(d.items).toEqual(['mcp.json', 'skills/']);
	});

	test('maestroConfigured true when the profile already has settings', () => {
		write(path.join(ompDefaultBase(env()), 'config.yml'));
		write(path.join(ompProfileBase(env(), 'maestro'), 'config.yml'));
		expect(detectCopyableOmpSettings(env(), 'maestro').maestroConfigured).toBe(true);
	});
});

describe('copyOmpSettings', () => {
	test('copies allowlisted config only, never state/credentials', () => {
		const def = ompDefaultBase(env());
		const prof = ompProfileBase(env(), 'maestro');
		write(path.join(def, 'config.yml'), 'cfg');
		write(path.join(def, 'mcp.json'), 'mcp');
		write(path.join(def, 'skills', 'a.md'), 'skill');
		write(path.join(def, 'agent.db'), 'SECRET-CREDENTIALS');
		write(path.join(def, 'history.db'), 'hist');
		write(path.join(def, 'sessions', 's.jsonl'), 'sess');
		write(path.join(def, 'memories', 'mnemopi', 'm.json'), 'mem');

		const r = copyOmpSettings(def, prof);

		expect(r.copied).toContain('config.yml');
		expect(r.copied).toContain('mcp.json');
		expect(r.copied).toContain('skills/');
		expect(fs.readFileSync(path.join(prof, 'config.yml'), 'utf8')).toBe('cfg');
		expect(fs.existsSync(path.join(prof, 'skills', 'a.md'))).toBe(true);
		// excluded state/credentials never copied
		for (const excluded of ['agent.db', 'history.db', 'sessions', 'memories']) {
			expect(fs.existsSync(path.join(prof, excluded))).toBe(false);
		}
	});

	test('backs up existing profile items before overwrite (never destroys)', () => {
		const def = ompDefaultBase(env());
		const prof = ompProfileBase(env(), 'maestro');
		write(path.join(def, 'config.yml'), 'new');
		write(path.join(prof, 'config.yml'), 'old');

		const r = copyOmpSettings(def, prof);

		expect(r.backedUp).toContain('config.yml');
		expect(fs.readFileSync(path.join(prof, 'config.yml'), 'utf8')).toBe('new');
		const backups = fs.readdirSync(prof).filter((f) => f.startsWith('config.yml.pre-mae-'));
		expect(backups.length).toBe(1);
		expect(fs.readFileSync(path.join(prof, backups[0]!), 'utf8')).toBe('old');
	});

	test('no-op when default has only excluded files', () => {
		const def = ompDefaultBase(env());
		const prof = ompProfileBase(env(), 'maestro');
		write(path.join(def, 'agent.db'), 'SECRET');
		const r = copyOmpSettings(def, prof);
		expect(r.copied).toEqual([]);
		expect(fs.existsSync(path.join(prof, 'agent.db'))).toBe(false);
	});
});

describe('offerOmpSettingsCopy (orchestration)', () => {
	function seedDefault(): void {
		write(path.join(ompDefaultBase(env()), 'config.yml'), 'cfg');
	}

	test('auto-offers on a fresh profile, copies on confirm yes', async () => {
		seedDefault();
		const out: string[] = [];
		await offerOmpSettingsCopy({
			env: env(),
			profile: 'maestro',
			explicit: false,
			isResume: false,
			confirm: async () => true,
			writeOut: (t) => out.push(t),
		});
		expect(fs.existsSync(path.join(ompProfileBase(env(), 'maestro'), 'config.yml'))).toBe(true);
		expect(out.join('')).toContain('copied omp config');
		expect(out.join('')).toContain('NOT copied'); // auth note
	});

	test('confirm no -> nothing copied', async () => {
		seedDefault();
		await offerOmpSettingsCopy({
			env: env(),
			profile: 'maestro',
			explicit: false,
			isResume: false,
			confirm: async () => false,
			writeOut: () => {},
		});
		expect(fs.existsSync(path.join(ompProfileBase(env(), 'maestro'), 'config.yml'))).toBe(false);
	});

	test('does not auto-offer on resume (confirm never called)', async () => {
		seedDefault();
		let asked = false;
		await offerOmpSettingsCopy({
			env: env(),
			profile: 'maestro',
			explicit: false,
			isResume: true,
			confirm: async () => {
				asked = true;
				return true;
			},
			writeOut: () => {},
		});
		expect(asked).toBe(false);
		expect(fs.existsSync(path.join(ompProfileBase(env(), 'maestro'), 'config.yml'))).toBe(false);
	});

	test('explicit copies without prompting', async () => {
		seedDefault();
		let asked = false;
		await offerOmpSettingsCopy({
			env: env(),
			profile: 'maestro',
			explicit: true,
			isResume: false,
			confirm: async () => {
				asked = true;
				return false;
			},
			writeOut: () => {},
		});
		expect(asked).toBe(false);
		expect(fs.existsSync(path.join(ompProfileBase(env(), 'maestro'), 'config.yml'))).toBe(true);
	});

	test('no default setup -> no offer, confirm never called', async () => {
		let asked = false;
		await offerOmpSettingsCopy({
			env: env(),
			profile: 'maestro',
			explicit: true,
			isResume: false,
			confirm: async () => {
				asked = true;
				return true;
			},
			writeOut: () => {},
		});
		expect(asked).toBe(false);
	});
});
