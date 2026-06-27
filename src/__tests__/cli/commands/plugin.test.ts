/**
 * @file plugin.test.ts
 * @description Tests for the `maestro plugin` authoring CLI commands. Exercises
 * the real filesystem against throwaway temp dirs (no fs mock) so the
 * sign/validate round-trip uses the same hashing the host verifier does.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { pluginInit, pluginValidate, pluginSign, pluginPack } from '../../../cli/commands/plugin';
import { validatePluginManifest } from '../../../shared/plugins/plugin-manifest';

let consoleSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;
let tmpDirs: string[] = [];

/** Make a fresh temp dir tracked for teardown. */
function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-plugin-'));
	tmpDirs.push(dir);
	return dir;
}

/** Parse the most recent JSON object emitted to console.log. */
function lastJson(): Record<string, unknown> {
	const calls = consoleSpy.mock.calls as unknown[][];
	for (let i = calls.length - 1; i >= 0; i--) {
		const arg = calls[i][0];
		if (typeof arg !== 'string') continue;
		try {
			const parsed: unknown = JSON.parse(arg);
			if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
		} catch {
			// Not a JSON line; keep scanning older calls.
		}
	}
	throw new Error('no JSON output captured');
}

/** Read a required string field off a parsed payload. */
function asString(obj: Record<string, unknown>, key: string): string {
	const value = obj[key];
	if (typeof value !== 'string') throw new Error(`expected string field "${key}"`);
	return value;
}

/** Pull the signature.status off a validate payload, if present. */
function signatureStatus(obj: Record<string, unknown>): unknown {
	const sig = obj.signature;
	return sig && typeof sig === 'object' ? (sig as Record<string, unknown>).status : undefined;
}

beforeEach(() => {
	tmpDirs = [];
	consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterEach(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('plugin init', () => {
	it('writes a tier-1 manifest that passes validatePluginManifest', () => {
		const dir = makeTmpDir();
		pluginInit(dir, { tier: '1', id: 'com.example.demo', name: 'Demo Plugin', json: true });
		expect(exitSpy).not.toHaveBeenCalled();

		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8'));
		const { manifest, errors } = validatePluginManifest(parsed);
		expect(errors).toEqual([]);
		expect(manifest).not.toBeNull();
		expect(manifest?.id).toBe('com.example.demo');
		expect(manifest?.name).toBe('Demo Plugin');
		expect(manifest?.tier).toBe(1);
		expect(manifest?.entry).toBe('entry.js');
		expect(manifest?.maestro.minHostApi).toMatch(/^\d+\.\d+\.\d+$/);

		// Code-tier scaffold ships the entrypoint + SDK references.
		expect(fs.existsSync(path.join(dir, 'entry.js'))).toBe(true);
		const entry = fs.readFileSync(path.join(dir, 'entry.js'), 'utf-8');
		expect(entry).toContain('@maestro/plugin-sdk');
		expect(entry).toContain('export function activate');
		expect(entry).toContain('export function deactivate');
		const pkg = fs.readFileSync(path.join(dir, 'package.json'), 'utf-8');
		expect(pkg).toContain('@maestro/plugin-sdk');
		expect(fs.existsSync(path.join(dir, 'tsconfig.json'))).toBe(true);

		expect(lastJson().success).toBe(true);
	});

	it('scaffolds a valid tier-0 (data-only) manifest with no entry', () => {
		const dir = makeTmpDir();
		pluginInit(dir, { tier: '0', id: 'data.only', json: true });
		expect(exitSpy).not.toHaveBeenCalled();

		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8'));
		const { manifest, errors } = validatePluginManifest(parsed);
		expect(errors).toEqual([]);
		expect(manifest?.tier).toBe(0);
		expect(manifest?.entry).toBeUndefined();
		expect(fs.existsSync(path.join(dir, 'entry.js'))).toBe(false);
	});

	it('refuses a non-empty directory without --force', () => {
		const dir = makeTmpDir();
		fs.writeFileSync(path.join(dir, 'existing.txt'), 'hi', 'utf-8');
		pluginInit(dir, { tier: '1', id: 'busy.dir', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(lastJson().success).toBe(false);
	});
});

describe('plugin sign + validate', () => {
	it('reports trusted when the signing key is trusted, untrusted otherwise', () => {
		const dir = makeTmpDir();
		const keyOut = path.join(makeTmpDir(), 'signing-key.pem');

		pluginInit(dir, { tier: '1', id: 'sign.me', name: 'Sign Me', json: true });
		consoleSpy.mockClear();

		pluginSign(dir, { genKey: true, keyOut, json: true });
		expect(exitSpy).not.toHaveBeenCalled();
		const signOut = lastJson();
		const publicKey = asString(signOut, 'publicKey');
		expect(fs.existsSync(path.join(dir, 'signature.json'))).toBe(true);
		expect(fs.existsSync(keyOut)).toBe(true);

		// Trusted: the signer public key is supplied as the trusted set.
		consoleSpy.mockClear();
		pluginValidate(dir, { json: true, trustedKey: publicKey });
		const trusted = lastJson();
		expect(trusted.valid).toBe(true);
		expect(signatureStatus(trusted)).toBe('trusted');

		// Untrusted: valid signature but unknown publisher (no trusted keys).
		consoleSpy.mockClear();
		pluginValidate(dir, { json: true });
		expect(signatureStatus(lastJson())).toBe('untrusted');

		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('reports invalid when a signed file is tampered after signing', () => {
		const dir = makeTmpDir();
		const keyOut = path.join(makeTmpDir(), 'k.pem');
		pluginInit(dir, { tier: '1', id: 'tamper.me', json: true });
		pluginSign(dir, { genKey: true, keyOut, json: true });

		fs.writeFileSync(path.join(dir, 'README.md'), 'tampered contents\n', 'utf-8');
		consoleSpy.mockClear();
		pluginValidate(dir, { json: true });
		expect(signatureStatus(lastJson())).toBe('invalid');
	});

	it('signs with a supplied PEM key (round-trips to trusted)', () => {
		const dir = makeTmpDir();
		const keyDir = makeTmpDir();
		const keyOut = path.join(keyDir, 'priv.pem');

		// Mint a key via --gen-key, then re-sign a second plugin with that same key
		// passed via --key to exercise the load-from-file path.
		const seed = makeTmpDir();
		pluginInit(seed, { tier: '0', id: 'seed.only', json: true });
		pluginSign(seed, { genKey: true, keyOut, json: true });
		consoleSpy.mockClear();

		pluginInit(dir, { tier: '1', id: 'pem.me', json: true });
		pluginSign(dir, { key: keyOut, json: true });
		const signOut = lastJson();
		const publicKey = asString(signOut, 'publicKey');

		consoleSpy.mockClear();
		pluginValidate(dir, { json: true, trustedKey: publicKey });
		expect(signatureStatus(lastJson())).toBe('trusted');
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

describe('plugin validate errors', () => {
	it('flags a malformed manifest', () => {
		const dir = makeTmpDir();
		fs.writeFileSync(
			path.join(dir, 'plugin.json'),
			JSON.stringify({ id: 'Bad Id', version: 'not-semver', tier: 7 }),
			'utf-8'
		);
		pluginValidate(dir, { json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		const out = lastJson();
		expect(out.success).toBe(false);
		expect(out.valid).toBe(false);
		expect(Array.isArray(out.errors)).toBe(true);
		expect((out.errors as unknown[]).length).toBeGreaterThan(0);
	});

	it('fails when no plugin.json is present', () => {
		const dir = makeTmpDir();
		pluginValidate(dir, { json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(lastJson().success).toBe(false);
	});
});

describe('plugin pack', () => {
	it('creates a distributable archive excluding key files', async () => {
		const dir = makeTmpDir();
		pluginInit(dir, { tier: '1', id: 'pack.me', json: true });
		// A stray private key in the dir must never be packed.
		fs.writeFileSync(path.join(dir, 'secret.pem'), 'PRIVATE KEY\n', 'utf-8');
		const outPath = path.join(makeTmpDir(), 'pack.tgz');
		consoleSpy.mockClear();

		await pluginPack(dir, { out: outPath, json: true });
		expect(exitSpy).not.toHaveBeenCalled();
		expect(fs.existsSync(outPath)).toBe(true);
		expect(fs.statSync(outPath).size).toBeGreaterThan(0);

		const out = lastJson();
		expect(out.success).toBe(true);
		const expectedFiles = fs.readdirSync(dir).filter((f) => !f.endsWith('.pem')).length;
		expect(out.files).toBe(expectedFiles);
	});

	it('defaults the archive name to <id>-<version>.tgz', async () => {
		const dir = makeTmpDir();
		pluginInit(dir, { tier: '0', id: 'named.pack', json: true });
		consoleSpy.mockClear();

		// Default name resolves relative to cwd; run from the temp dir so the
		// archive lands there and gets cleaned up with it.
		const prevCwd = process.cwd();
		process.chdir(dir);
		try {
			await pluginPack(dir, { json: true });
		} finally {
			process.chdir(prevCwd);
		}
		const out = lastJson();
		const outPath = asString(out, 'out');
		expect(path.basename(outPath)).toBe('named.pack-0.1.0.tgz');
		expect(fs.existsSync(outPath)).toBe(true);
	});
});
