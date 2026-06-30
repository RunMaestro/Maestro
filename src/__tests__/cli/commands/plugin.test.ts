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
import * as zlib from 'zlib';
import * as vm from 'vm';

import { pluginInit, pluginValidate, pluginSign, pluginPack } from '../../../cli/commands/plugin';
import { validatePluginManifest } from '../../../shared/plugins/plugin-manifest';
import { verifyPluginSignature } from '../../../main/plugins/plugin-signature';

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
		expect(entry).toContain('function activate(maestro)');
		expect(entry).toContain('module.exports = { activate, deactivate }');
		// The sandbox runs entry.js via `new vm.Script` (CommonJS, no module loader),
		// so the scaffold must not use ESM `export` syntax or it fails to parse.
		expect(entry).not.toContain('export ');
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as {
			devDependencies?: Record<string, string>;
		};
		expect(pkg.devDependencies?.['@maestro/plugin-sdk']).toBe('^0.2.0');
		expect(fs.existsSync(path.join(dir, 'tsconfig.json'))).toBe(true);

		expect(lastJson().success).toBe(true);
	});

	it('scaffolds an entry.js that loads under the CommonJS sandbox', () => {
		const dir = makeTmpDir();
		pluginInit(dir, { tier: '1', id: 'com.example.run', name: 'Run', json: true });
		const code = fs.readFileSync(path.join(dir, 'entry.js'), 'utf-8');

		// Mirror plugin-sandbox-entry.ts: a CommonJS script in a vm context with a
		// bare `module` shim and no `require`. This is the real loader, so a parse
		// failure here is a dead-on-arrival plugin (regression guard for the ESM bug).
		const moduleShim: { exports: Record<string, unknown> } = { exports: {} };
		const context = vm.createContext({
			module: moduleShim,
			exports: moduleShim.exports,
			console: { log() {}, warn() {}, error() {} },
		});
		expect(() => new vm.Script(code).runInContext(context)).not.toThrow();
		expect(typeof moduleShim.exports.activate).toBe('function');
		expect(typeof moduleShim.exports.deactivate).toBe('function');
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

/** Recursively list a directory's files as plugin-relative POSIX paths. */
function listFilesRel(dir: string): string[] {
	const out: string[] = [];
	const walk = (cur: string): void => {
		for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
			const abs = path.join(cur, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
				continue;
			}
			out.push(path.relative(dir, abs).replace(/\\/g, '/'));
		}
	};
	walk(dir);
	return out.sort();
}

/**
 * Extract a gzip-tar archive (what pluginPack writes) into destDir. Minimal
 * ustar reader: file entries only, which is all the packer emits. Reading the
 * REAL archive bytes is what proves pack's on-disk file set, not a re-derived one.
 */
function extractTgz(tgzPath: string, destDir: string): void {
	const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
	let offset = 0;
	while (offset + 512 <= buf.length) {
		const header = buf.subarray(offset, offset + 512);
		if (header.every((b) => b === 0)) break; // two zero blocks terminate the archive
		const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '');
		const size = parseInt(
			header.subarray(124, 136).toString('utf-8').replace(/\0.*$/, '').trim() || '0',
			8
		);
		const typeFlag = String.fromCharCode(header[156]);
		offset += 512;
		const data = buf.subarray(offset, offset + size);
		offset += Math.ceil(size / 512) * 512;
		if (typeFlag === '0' || typeFlag === '\0') {
			const abs = path.join(destDir, name);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, data);
		}
	}
}

describe('plugin sign + pack + host verify agree on one file set', () => {
	it('applies the same exclusions across sign/pack/verify for a .pem + node_modules tree', async () => {
		const dir = makeTmpDir();
		pluginInit(dir, { tier: '1', id: 'roundtrip.me', name: 'Roundtrip', json: true });

		// Reproduce the scaffold README flow: --gen-key writes the private key
		// INTO the plugin dir, and `bun install` leaves a node_modules/. Both are
		// present at sign time and must be stripped consistently everywhere.
		fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'module.exports = 1;\n', 'utf-8');
		const keyOut = path.join(dir, 'signing-key.pem');

		consoleSpy.mockClear();
		pluginSign(dir, { genKey: true, keyOut, json: true });
		expect(exitSpy).not.toHaveBeenCalled();
		const publicKey = asString(lastJson(), 'publicKey');
		expect(fs.existsSync(keyOut)).toBe(true);

		// SIGN: the signed set excludes the secret key and node_modules.
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'signature.json'), 'utf-8')) as {
			files: Record<string, string>;
		};
		const signedFiles = Object.keys(manifest.files).sort();
		expect(signedFiles).not.toContain('signing-key.pem');
		expect(signedFiles.some((f) => f.startsWith('node_modules/'))).toBe(false);

		// PACK the dir and extract the REAL archive into a fresh install dir.
		const outPath = path.join(makeTmpDir(), 'roundtrip.tgz');
		consoleSpy.mockClear();
		await pluginPack(dir, { out: outPath, json: true });
		expect(exitSpy).not.toHaveBeenCalled();

		const installDir = makeTmpDir();
		extractTgz(outPath, installDir);
		const packed = listFilesRel(installDir);

		// PACK strips the same secrets/junk SIGN did but ships signature.json.
		expect(packed).toContain('signature.json');
		expect(packed).not.toContain('signing-key.pem');
		expect(packed.some((f) => f.startsWith('node_modules/'))).toBe(false);

		// The packed set minus signature.json is EXACTLY the signed set.
		expect(packed.filter((f) => f !== 'signature.json')).toEqual(signedFiles);

		// VERIFY: the host re-hashes the installed tree and it matches the
		// signature - the bug ("plugin files do not match the signed file set")
		// is gone end to end.
		const check = verifyPluginSignature(installDir, [publicKey]);
		expect(check.status).toBe('trusted');
	});
});
