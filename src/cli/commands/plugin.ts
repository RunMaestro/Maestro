/**
 * Maestro plugin authoring CLI commands.
 *
 * `maestro plugin` lets a plugin author scaffold, validate, sign, and package a
 * plugin without the desktop app. The manifest/signature contracts are the pure
 * shared modules under src/shared/plugins (the same ones the host loads against),
 * so a plugin that validates and signs here is byte-identical to what the main
 * process verifies at install time.
 *
 * The hashing/payload/verification logic mirrors
 * src/main/plugins/plugin-signature.ts EXACTLY (SHA-256 of every file except
 * signature.json, the canonical buildSigningPayload, ed25519 over those bytes,
 * an exact file-set match) so a CLI-produced signature.json verifies in the host
 * and a host-rejected plugin is rejected here too. Re-implemented (not imported)
 * because the CLI bundle deliberately does not depend on src/main; the shared
 * primitives keep both sides in lockstep.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
	createHash,
	createPublicKey,
	createPrivateKey,
	generateKeyPairSync,
	sign as cryptoSign,
	verify as cryptoVerify,
} from 'crypto';
import type { KeyObject } from 'crypto';
import archiver from 'archiver';
import { HOST_API_VERSION } from '../../shared/plugins/host-api';
import { PLUGIN_ID_PATTERN, validatePluginManifest } from '../../shared/plugins/plugin-manifest';
import type { PluginTier } from '../../shared/plugins/plugin-manifest';
import {
	SIGNATURE_FILENAME,
	SIGNATURE_ALGORITHM,
	SIGNATURE_EXCLUDED_DIRS,
	isExcludedSignaturePath,
	buildSigningPayload,
	validateSignatureManifest,
	isTrustedKey,
	normalizeRelPath,
} from '../../shared/plugins/signing';
import type { SignatureManifest, SignatureStatus } from '../../shared/plugins/signing';

// tsconfig.cli.json targets the ES2020 lib, whose typings predate
// Promise.withResolvers (ES2024). The method exists at runtime on Node >= 22
// (this repo's engine floor), so declare its type rather than fall back to the
// new Promise(executor) form.
declare global {
	interface PromiseConstructor {
		withResolvers<T>(): {
			promise: Promise<T>;
			resolve: (value: T | PromiseLike<T>) => void;
			reject: (reason?: unknown) => void;
		};
	}
}

/** Version of @maestro/plugin-sdk the scaffold pins (kept in sync with the SDK). */
const PLUGIN_SDK_VERSION = '0.2.0';

export interface PluginInitOptions {
	tier?: string;
	id?: string;
	name?: string;
	force?: boolean;
	json?: boolean;
}

export interface PluginValidateOptions {
	/** Comma-separated base64 SPKI public keys to treat as trusted. */
	trustedKey?: string;
	json?: boolean;
}

export interface PluginSignOptions {
	/** Path to an ed25519 private key (PEM, or base64-encoded PKCS8 DER). */
	key?: string;
	/** Generate a fresh ed25519 keypair instead of loading --key. */
	genKey?: boolean;
	/** Where to write the generated private key (required with --gen-key). */
	keyOut?: string;
	json?: boolean;
}

export interface PluginPackOptions {
	/** Output archive path (default <id>-<version>.tgz). */
	out?: string;
	json?: boolean;
}

/** A json-aware failure reporter mirroring the other CLI commands. */
function makeFail(json?: boolean): (message: string) => never {
	return (message: string): never => {
		if (json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(message);
		process.exit(1);
	};
}

/** Derive a PLUGIN_ID_PATTERN-safe id from arbitrary text (e.g. a folder name). */
function slugifyId(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^[^a-z]+/, '')
		.replace(/-+$/, '');
}

/** Parse a --tier string into a PluginTier, or null when invalid. */
function parseTier(value: string | undefined): PluginTier | null {
	const t = value === undefined ? 1 : Number(value);
	return t === 0 || t === 1 || t === 2 ? (t as PluginTier) : null;
}

/** Split a comma-separated --trusted-key value into trimmed base64 keys. */
function parseTrustedKeys(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(',')
		.map((k) => k.trim())
		.filter(Boolean);
}

/** SHA-256 (lowercase hex) of a file's bytes. */
function hashFile(absPath: string): string {
	return createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/**
 * Map every file under `dir` to its plugin-relative POSIX path and SHA-256,
 * excluding signature.json and the shared exclusion set (node_modules/, .git/,
 * *.pem, *.key). Mirrors the host verifier: the same shared policy and an
 * identical symlink rule (a symlink is never legitimate signed content, so
 * encountering one throws and the caller maps that to an invalid signature).
 */
function hashTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const abs = path.join(current, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(`plugin contains a symlink: ${normalizeRelPath(path.relative(dir, abs))}`);
			}
			if (entry.isDirectory()) {
				if (SIGNATURE_EXCLUDED_DIRS.has(entry.name)) continue;
				walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			const rel = normalizeRelPath(path.relative(dir, abs));
			if (rel === SIGNATURE_FILENAME) continue;
			if (isExcludedSignaturePath(rel)) continue;
			out[rel] = hashFile(abs);
		}
	};
	walk(dir);
	return out;
}

/** Do two file-hash maps describe exactly the same files with the same hashes? */
function fileSetsMatch(a: Record<string, string>, b: Record<string, string>): boolean {
	const aKeys = Object.keys(a).sort();
	const bKeys = Object.keys(b).sort();
	if (aKeys.length !== bKeys.length) return false;
	for (let i = 0; i < aKeys.length; i++) {
		if (aKeys[i] !== bKeys[i]) return false;
		if (a[aKeys[i]].toLowerCase() !== b[bKeys[i]].toLowerCase()) return false;
	}
	return true;
}

/** Verify an ed25519 signature (base64) over `payload` with a base64 SPKI key. */
function verifyEd25519(payload: string, publicKeyB64: string, signatureB64: string): boolean {
	try {
		const keyObject = createPublicKey({
			key: Buffer.from(publicKeyB64, 'base64'),
			format: 'der',
			type: 'spki',
		});
		return cryptoVerify(
			null,
			Buffer.from(payload, 'utf-8'),
			keyObject,
			Buffer.from(signatureB64, 'base64')
		);
	} catch {
		return false;
	}
}

interface SignatureResolution {
	status: SignatureStatus;
	signerKey?: string;
	detail?: string;
}

/**
 * Resolve <dir>/signature.json status against the trusted key set. Mirrors
 * verifyPluginSignature in the main process step for step.
 */
function resolveSignature(dir: string, trustedKeys: readonly string[]): SignatureResolution {
	const sigPath = path.join(dir, SIGNATURE_FILENAME);
	let raw: string;
	try {
		raw = fs.readFileSync(sigPath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unsigned' };
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: 'invalid', detail: 'signature.json is not valid JSON' };
	}

	const { manifest, errors } = validateSignatureManifest(parsed);
	if (!manifest) return { status: 'invalid', detail: errors.join('; ') };

	let actual: Record<string, string>;
	try {
		actual = hashTree(dir);
	} catch (err) {
		return {
			status: 'invalid',
			signerKey: manifest.publicKey,
			detail: err instanceof Error ? err.message : 'could not hash plugin files',
		};
	}
	if (!fileSetsMatch(actual, manifest.files)) {
		return {
			status: 'invalid',
			signerKey: manifest.publicKey,
			detail: 'plugin files do not match the signed file set',
		};
	}

	const payload = buildSigningPayload(manifest.files);
	if (!verifyEd25519(payload, manifest.publicKey, manifest.signature)) {
		return { status: 'invalid', signerKey: manifest.publicKey, detail: 'signature did not verify' };
	}

	return {
		status: isTrustedKey(manifest.publicKey, trustedKeys) ? 'trusted' : 'untrusted',
		signerKey: manifest.publicKey,
	};
}

/** Load an ed25519 private key from a PEM or base64 (PKCS8 DER) file. */
function loadPrivateKey(keyPath: string): KeyObject {
	const content = fs.readFileSync(path.resolve(keyPath), 'utf-8');
	if (content.includes('-----BEGIN')) {
		return createPrivateKey(content);
	}
	const der = Buffer.from(content.trim(), 'base64');
	return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** Build a scaffold plugin.json that passes validatePluginManifest. */
function buildManifest(id: string, name: string, tier: PluginTier): Record<string, unknown> {
	const manifest: Record<string, unknown> = {
		id,
		name,
		version: '0.1.0',
		tier,
		maestro: { minHostApi: HOST_API_VERSION },
		description: `${name} - a Maestro plugin.`,
		contributes: {},
	};
	if (tier !== 0) {
		// Tier >= 1 runs sandboxed code: it must declare an entry. Permissions start
		// empty; the author adds the host capabilities they need.
		manifest.entry = 'entry.js';
		manifest.permissions = [];
	}
	return manifest;
}

/** The tier-1 sandboxed entrypoint stub (typed against @maestro/plugin-sdk). */
function entryJsTemplate(): string {
	return [
		'// Maestro plugin entrypoint (tier 1).',
		'//',
		'// Maestro loads this file in a sandbox as a CommonJS-style script (no',
		'// bundler and no Node `require`): assign an object with optional',
		'// activate() / deactivate() to `module.exports`. activate() runs once when',
		'// the plugin is enabled and receives the brokered host API; deactivate()',
		'// runs once on unload. Everything you can do is mediated by the capabilities',
		'// you declare in plugin.json and the user grants at install.',
		'//',
		'// Types come from @maestro/plugin-sdk via the JSDoc @import tag below, so',
		'// editors type-check this plain-JS entrypoint without a build step.',
		'',
		"/** @import { MaestroSdk, PluginModule } from '@maestro/plugin-sdk' */",
		'',
		'/**',
		' * Called once when the plugin is activated.',
		' * @param {MaestroSdk} maestro The brokered Maestro host API.',
		' * @returns {void | Promise<void>}',
		' */',
		'function activate(maestro) {',
		'\t// Your plugin code goes here.',
		'\tvoid maestro;',
		'}',
		'',
		'/**',
		' * Called once when the plugin is being unloaded. Release timers, listeners,',
		' * and any other resources here.',
		' * @returns {void | Promise<void>}',
		' */',
		'function deactivate() {}',
		'',
		'/** @type {PluginModule} */',
		'module.exports = { activate, deactivate };',
		'',
	].join('\n');
}

/** package.json for a code-tier scaffold, pinning the SDK so imports resolve. */
function packageJsonTemplate(id: string): string {
	const pkg = {
		name: id,
		version: '0.1.0',
		private: true,
		type: 'commonjs',
		main: 'entry.js',
		devDependencies: {
			'@maestro/plugin-sdk': `^${PLUGIN_SDK_VERSION}`,
		},
	};
	return JSON.stringify(pkg, null, 2) + '\n';
}

/** tsconfig.json for a code-tier scaffold (type-checks the JS entrypoint). */
function tsconfigTemplate(): string {
	const tsconfig = {
		compilerOptions: {
			target: 'ES2020',
			module: 'NodeNext',
			moduleResolution: 'NodeNext',
			allowJs: true,
			checkJs: true,
			strict: true,
			noEmit: true,
			skipLibCheck: true,
		},
		include: ['entry.js'],
	};
	return JSON.stringify(tsconfig, null, 2) + '\n';
}

/** README for the scaffolded plugin. */
function readmeTemplate(id: string, name: string, tier: PluginTier): string {
	const lines = [`# ${name}`, '', `A Maestro plugin (\`${id}\`, tier ${tier}).`, ''];
	if (tier !== 0) {
		lines.push(
			'## Develop',
			'',
			'```bash',
			'bun install',
			'```',
			'',
			'Edit `entry.js` (the sandboxed entrypoint) and declare the host capabilities',
			'you need in `plugin.json` under `permissions`.',
			''
		);
	} else {
		lines.push(
			'This is a data-only (tier 0) plugin: it contributes declarative data via',
			'`plugin.json` and runs no code.',
			''
		);
	}
	lines.push(
		'## Validate, sign, and package',
		'',
		'```bash',
		'maestro-cli plugin validate .',
		'maestro-cli plugin sign . --gen-key --key-out ./signing-key.pem',
		'maestro-cli plugin pack .',
		'```',
		''
	);
	return lines.join('\n');
}

/** .gitignore for the scaffolded plugin (never commit secrets or build output). */
function gitignoreTemplate(): string {
	return [
		'node_modules/',
		'*.tgz',
		'',
		'# Never commit your signing private key.',
		'*.pem',
		'*.key',
		'',
	].join('\n');
}

/**
 * Scaffold a new plugin in <dir>. Writes a plugin.json that passes the shared
 * validator, plus an entry.js stub (tier >= 1), README.md, .gitignore, and (for
 * code tiers) a package.json + tsconfig referencing @maestro/plugin-sdk.
 */
export function pluginInit(dir: string | undefined, options: PluginInitOptions): void {
	const fail = makeFail(options.json);
	const targetDir = path.resolve(dir ?? '.');

	const tier = parseTier(options.tier);
	if (tier === null) return fail(`--tier must be 0, 1, or 2 (got "${options.tier}")`);

	const id = options.id
		? options.id.trim()
		: slugifyId(path.basename(targetDir)) || 'maestro-plugin';
	if (!PLUGIN_ID_PATTERN.test(id)) {
		return fail(
			`plugin id "${id}" is invalid: use lowercase letters, digits, and . _ - separators, ` +
				'starting with a letter (pass --id to override)'
		);
	}
	const name = options.name?.trim() || id;

	if (fs.existsSync(targetDir)) {
		const entries = fs.readdirSync(targetDir);
		if (entries.length > 0 && !options.force) {
			return fail(`directory ${targetDir} is not empty (use --force to scaffold anyway)`);
		}
	}
	fs.mkdirSync(targetDir, { recursive: true });

	const manifest = buildManifest(id, name, tier);

	// Guard against a regression: the manifest we are about to write must pass the
	// same validator the host uses, or the scaffold is useless.
	const validation = validatePluginManifest(manifest);
	if (!validation.manifest) {
		return fail(`internal error: scaffolded manifest is invalid: ${validation.errors.join('; ')}`);
	}

	const written: string[] = [];
	const writeFile = (rel: string, content: string): void => {
		fs.writeFileSync(path.join(targetDir, rel), content, 'utf-8');
		written.push(normalizeRelPath(rel));
	};

	writeFile('plugin.json', JSON.stringify(manifest, null, 2) + '\n');
	writeFile('README.md', readmeTemplate(id, name, tier));
	writeFile('.gitignore', gitignoreTemplate());
	if (tier !== 0) {
		writeFile('entry.js', entryJsTemplate());
		writeFile('package.json', packageJsonTemplate(id));
		writeFile('tsconfig.json', tsconfigTemplate());
	}

	written.sort();
	if (options.json) {
		console.log(JSON.stringify({ success: true, dir: targetDir, id, name, tier, files: written }));
	} else {
		console.log(`Scaffolded plugin "${id}" (tier ${tier}) in ${targetDir}`);
		console.log(`Files: ${written.join(', ')}`);
	}
}

/**
 * Validate <dir>/plugin.json against the shared validator and, when a
 * signature.json is present, resolve its trust status. Trusted keys come from
 * --trusted-key (comma-separated base64 SPKI keys).
 */
export function pluginValidate(dir: string | undefined, options: PluginValidateOptions): void {
	const fail = makeFail(options.json);
	const targetDir = path.resolve(dir ?? '.');
	const manifestPath = path.join(targetDir, 'plugin.json');

	let raw: string;
	try {
		raw = fs.readFileSync(manifestPath, 'utf-8');
	} catch {
		return fail(`no plugin.json found in ${targetDir}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return fail(
			`plugin.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	const { manifest, errors } = validatePluginManifest(parsed);
	if (!manifest) {
		if (options.json) {
			console.log(JSON.stringify({ success: false, valid: false, errors }));
		} else {
			console.error(`Invalid plugin.json in ${targetDir}:`);
			for (const e of errors) console.error(`  - ${e}`);
		}
		process.exit(1);
		return;
	}

	const signature = resolveSignature(targetDir, parseTrustedKeys(options.trustedKey));

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				valid: true,
				manifest: {
					id: manifest.id,
					name: manifest.name,
					version: manifest.version,
					tier: manifest.tier,
				},
				signature,
			})
		);
	} else {
		console.log(`OK: ${manifest.id} v${manifest.version} (tier ${manifest.tier})`);
		console.log(
			`Signature: ${signature.status}${signature.detail ? ` (${signature.detail})` : ''}`
		);
	}
}

/**
 * Sign <dir> by hashing every file (except signature.json) exactly as the host
 * verifier does, signing the canonical payload with ed25519, and writing
 * signature.json. Provide a key via --key, or --gen-key + --key-out to mint one.
 */
export function pluginSign(dir: string, options: PluginSignOptions): void {
	const fail = makeFail(options.json);
	const targetDir = path.resolve(dir);
	if (!fs.existsSync(path.join(targetDir, 'plugin.json'))) {
		return fail(`no plugin.json found in ${targetDir}`);
	}

	let privateKey: KeyObject;
	let publicKeyB64: string;
	let generatedKeyOut: string | undefined;

	if (options.genKey) {
		if (!options.keyOut) {
			return fail('--gen-key requires --key-out <path> to write the private key');
		}
		const pair = generateKeyPairSync('ed25519');
		privateKey = pair.privateKey;
		generatedKeyOut = path.resolve(options.keyOut);
		fs.writeFileSync(
			generatedKeyOut,
			pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
			{
				encoding: 'utf-8',
				mode: 0o600,
			}
		);
		publicKeyB64 = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
	} else if (options.key) {
		try {
			privateKey = loadPrivateKey(options.key);
		} catch (error) {
			return fail(
				`could not load --key: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		if (privateKey.asymmetricKeyType !== 'ed25519') {
			return fail(
				`--key must be an ed25519 private key (got ${privateKey.asymmetricKeyType ?? 'unknown'})`
			);
		}
		publicKeyB64 = createPublicKey(privateKey)
			.export({ format: 'der', type: 'spki' })
			.toString('base64');
	} else {
		return fail(
			'provide a signing key via --key <path>, or generate one with --gen-key --key-out <path>'
		);
	}

	let files: Record<string, string>;
	try {
		files = hashTree(targetDir);
	} catch (error) {
		return fail(
			`could not hash plugin files: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	const payload = buildSigningPayload(files);
	const signatureB64 = cryptoSign(null, Buffer.from(payload, 'utf-8'), privateKey).toString(
		'base64'
	);

	const signatureManifest: SignatureManifest = {
		algorithm: SIGNATURE_ALGORITHM,
		publicKey: publicKeyB64,
		signature: signatureB64,
		files,
	};
	const sigPath = path.join(targetDir, SIGNATURE_FILENAME);
	fs.writeFileSync(sigPath, JSON.stringify(signatureManifest, null, 2) + '\n', 'utf-8');

	const fileCount = Object.keys(files).length;
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				out: sigPath,
				publicKey: publicKeyB64,
				files: fileCount,
				...(generatedKeyOut ? { keyOut: generatedKeyOut } : {}),
			})
		);
	} else {
		console.log(`Signed ${targetDir} -> ${SIGNATURE_FILENAME} (${fileCount} files)`);
		console.log(`Public key (base64): ${publicKeyB64}`);
		if (generatedKeyOut) console.log(`Private key written to ${generatedKeyOut} (keep it secret).`);
	}
}

/**
 * Collect plugin-relative POSIX file paths to pack. Uses the SAME shared
 * exclusion policy as the signer and host verifier (node_modules/, .git/,
 * *.pem, *.key) so the packed archive's file set matches what was signed and
 * what the host re-hashes. `signature.json` is kept: the host needs it to
 * verify (the shared policy intentionally does not strip it).
 */
function collectPackFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			const abs = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (SIGNATURE_EXCLUDED_DIRS.has(entry.name)) continue;
				walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			const rel = normalizeRelPath(path.relative(dir, abs));
			if (isExcludedSignaturePath(rel)) continue;
			out.push(rel);
		}
	};
	walk(dir);
	return out.sort();
}

/** Write the given plugin-relative files into a gzip tar archive at outPath. */
function writeArchive(dir: string, files: readonly string[], outPath: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const output = fs.createWriteStream(outPath);
	const archive = archiver('tar', { gzip: true });
	output.on('close', () => resolve());
	output.on('error', reject);
	archive.on('error', reject);
	archive.pipe(output);
	for (const rel of files) {
		archive.file(path.join(dir, rel), { name: rel });
	}
	void archive.finalize();
	return promise;
}

/**
 * Pack <dir> into a distributable gzip tar archive, excluding node_modules, .git,
 * and signing-key files (*.pem/*.key). Defaults the output name to
 * <id>-<version>.tgz read from plugin.json.
 */
export async function pluginPack(dir: string, options: PluginPackOptions): Promise<void> {
	const fail = makeFail(options.json);
	const targetDir = path.resolve(dir);
	const manifestPath = path.join(targetDir, 'plugin.json');

	let manifest: { id?: unknown; version?: unknown };
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
	} catch {
		return fail(
			`could not read ${manifestPath}; run "plugin init" first or pass a valid plugin dir`
		);
	}
	const id = typeof manifest.id === 'string' && manifest.id.trim() ? manifest.id.trim() : 'plugin';
	const version =
		typeof manifest.version === 'string' && manifest.version.trim()
			? manifest.version.trim()
			: '0.0.0';

	const outPath = path.resolve(options.out ?? `${id}-${version}.tgz`);
	const files = collectPackFiles(targetDir);
	if (files.length === 0) return fail(`no packable files found in ${targetDir}`);

	try {
		await writeArchive(targetDir, files, outPath);
	} catch (error) {
		return fail(
			`failed to create archive: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	const bytes = fs.statSync(outPath).size;
	if (options.json) {
		console.log(JSON.stringify({ success: true, out: outPath, files: files.length, bytes }));
	} else {
		console.log(`Packed ${files.length} file(s) into ${outPath} (${bytes} bytes)`);
	}
}
