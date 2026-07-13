import { createHash, createHmac } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	buildPluginArtifact,
	type ImmutableTrustRoot,
} from '../../../main/omp-distribution/plugin-artifact';
import {
	OMP_PLUGIN_ID,
	OmpPluginTrustRootService,
} from '../../../main/plugins/plugin-trust-root-service';

const trustRoot: ImmutableTrustRoot = Object.freeze({
	keyId: 'maestro-omp-plugin-root-test',
	algorithm: 'hmac-sha256',
	publicKey: 'fixture-public-key',
});

const signer = (payload: Uint8Array): string =>
	createHmac('sha256', 'fixture-private-key').update(payload).digest('base64url');
const verifier = (payload: Uint8Array, signature: string): boolean => signer(payload) === signature;

function manifest(version: string, permissions: unknown[] = []): Record<string, unknown> {
	return {
		id: 'com.maestro.omp',
		name: 'Maestro OMP',
		version,
		tier: 1,
		entry: 'index.js',
		maestro: { minHostApi: '1.0.0' },
		permissions,
	};
}

function artifact(version: string, permissions: unknown[] = [], extraFiles: Record<string, string> = {}): Buffer {
	return buildPluginArtifact({
		pluginId: 'com.maestro.omp',
		version,
		contractSha256: 'a'.repeat(64),
		trustRoot,
		files: [
			{ path: 'plugin.json', content: Buffer.from(JSON.stringify(manifest(version, permissions))) },
			{ path: 'index.js', content: Buffer.from('module.exports = "omp";') },
			...Object.entries(extraFiles).map(([filePath, content]) => ({
				path: filePath,
				content: Buffer.from(content),
			})),
		],
		sign: signer,
	});
}

function writeArchive(bytes: Buffer, name = 'com.maestro.omp.omp-plugin.json'): {
	archivePath: string;
	expectedSha256: string;
} {
	const archivePath = path.join(workDir, name);
	fs.writeFileSync(archivePath, bytes);
	return {
		archivePath,
		expectedSha256: createHash('sha256').update(bytes).digest('hex'),
	};
}

function makeService(
	overrides: Partial<ConstructorParameters<typeof OmpPluginTrustRootService>[0]> = {}
): OmpPluginTrustRootService {
	return new OmpPluginTrustRootService({
		pluginsDir: path.join(workDir, 'plugins'),
		trustRoot,
		verifySignature: verifier,
		...overrides,
	});
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
}

function unsafeArtifact(): Buffer {
	const parsed = JSON.parse(artifact('1.0.0').toString('utf8')) as Record<string, unknown>;
	const files = parsed.files as Array<{ path: string; content: string }>;
	files[1]!.path = '../escape.js';
	const { signature: _signature, ...unsigned } = parsed;
	return Buffer.from(
		JSON.stringify({
			...unsigned,
			signature: signer(Buffer.from(canonicalJson(unsigned))),
		})
	);
}

let workDir: string;

beforeEach(() => {
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-trust-root-'));
});

afterEach(() => {
	fs.rmSync(workDir, { recursive: true, force: true });
});

describe('OmpPluginTrustRootService', () => {
	it('cold-installs a signed bundled artifact through the verified archive operation', () => {
		const bytes = artifact('1.0.0');
		const archivePath = path.join(workDir, 'com.maestro.omp.omp-plugin.json');
		fs.writeFileSync(archivePath, bytes);
		const service = new OmpPluginTrustRootService({
			pluginsDir: path.join(workDir, 'plugins'),
			trustRoot,
			verifySignature: verifier,
		});

		const result = service.bootstrapBundledArchive({
			archivePath,
			expectedSha256: createHash('sha256').update(bytes).digest('hex'),
		});

		expect(result.action).toBe('installed');
		expect(fs.readFileSync(path.join(workDir, 'plugins', 'com.maestro.omp', 'index.js'), 'utf8')).toBe(
			'module.exports = "omp";'
		);
	});

	it('rejects a digest mismatch before installing any bytes', () => {
		const bytes = artifact('1.0.0');
		const service = makeService();

		expect(() =>
			service.bootstrapBundledArchive({
				archivePath: writeArchive(bytes).archivePath,
				expectedSha256: '0'.repeat(64),
			})
		).toThrow('digest');
		expect(fs.existsSync(path.join(workDir, 'plugins', OMP_PLUGIN_ID))).toBe(false);
	});

	it('rejects an invalid signature even when the archive digest matches', () => {
		const parsed = JSON.parse(artifact('1.0.0').toString('utf8')) as Record<string, unknown>;
		parsed.signature = 'not-a-valid-signature';
		const service = makeService();
		const input = writeArchive(Buffer.from(JSON.stringify(parsed)));

		expect(() => service.bootstrapBundledArchive(input)).toThrow('signature verification failed');
		expect(fs.existsSync(path.join(workDir, 'plugins', OMP_PLUGIN_ID))).toBe(false);
	});

	it('refuses an archive signed under a different immutable signer root', () => {
		const otherRoot: ImmutableTrustRoot = Object.freeze({
			keyId: 'other-first-party-root',
			algorithm: trustRoot.algorithm,
			publicKey: trustRoot.publicKey,
		});
		const bytes = buildPluginArtifact({
			pluginId: OMP_PLUGIN_ID,
			version: '1.0.0',
			contractSha256: 'a'.repeat(64),
			trustRoot: otherRoot,
			files: [
				{ path: 'plugin.json', content: Buffer.from(JSON.stringify(manifest('1.0.0'))) },
				{ path: 'index.js', content: Buffer.from('module.exports = "omp";') },
			],
			sign: signer,
		});

		expect(() => makeService().bootstrapBundledArchive(writeArchive(bytes))).toThrow(
			'trust root mismatch'
		);
	});

	it('rejects unsafe archive entries before materializing them', () => {
		const service = makeService();
		const input = writeArchive(unsafeArtifact());

		expect(() => service.bootstrapBundledArchive(input)).toThrow('unsafe OMP archive entry');
		expect(fs.existsSync(path.join(workDir, 'escape.js'))).toBe(false);
	});

	it('treats byte-identical verified archives as a no-op', () => {
		const service = makeService();
		const input = writeArchive(artifact('1.0.0'));

		expect(service.bootstrapBundledArchive(input).action).toBe('installed');
		expect(service.bootstrapBundledArchive(input).action).toBe('unchanged');
	});

	it('updates a managed archive only when the immutable signer and version advance', () => {
		const service = makeService();
		expect(service.bootstrapBundledArchive(writeArchive(artifact('1.0.0'))).action).toBe('installed');

		const update = writeArchive(artifact('1.1.0'), 'omp-1.1.0.omp-plugin.json');
		expect(
			service.installOrUpdateArchive({
				...update,
				owner: 'external',
			}).action
		).toBe('updated');
		expect(
			JSON.parse(
				fs.readFileSync(path.join(workDir, 'plugins', OMP_PLUGIN_ID, 'plugin.json'), 'utf8')
			).version
		).toBe('1.1.0');
	});

	it('repairs tampered installed bytes instead of calling a verified archive a no-op', () => {
		const service = makeService();
		const input = writeArchive(artifact('1.0.0'));
		expect(service.bootstrapBundledArchive(input).action).toBe('installed');
		fs.writeFileSync(
			path.join(workDir, 'plugins', OMP_PLUGIN_ID, 'index.js'),
			'module.exports = "tampered";'
		);

		expect(service.bootstrapBundledArchive(input).action).toBe('updated');
		expect(fs.readFileSync(path.join(workDir, 'plugins', OMP_PLUGIN_ID, 'index.js'), 'utf8')).toBe(
			'module.exports = "omp";'
		);
	});

	it('does not derive capability consent from a mutable installed plugin.json', () => {
		const service = makeService();
		expect(service.bootstrapBundledArchive(writeArchive(artifact('1.0.0'))).action).toBe('installed');
		fs.writeFileSync(
			path.join(workDir, 'plugins', OMP_PLUGIN_ID, 'plugin.json'),
			JSON.stringify(manifest('1.0.0', [{ capability: 'net:fetch', scope: 'api.maestro.test' }]))
		);

		expect(() =>
			service.installOrUpdateArchive({
				...writeArchive(
					artifact('1.1.0', [{ capability: 'net:fetch', scope: 'api.maestro.test' }]),
					'omp-capability-tampered.omp-plugin.json'
				),
				owner: 'external',
			})
		).toThrow('bytes do not match');
	});

	it('refuses downgrade and equal-version equivocation after a verified installation', () => {
		const service = makeService();
		expect(service.bootstrapBundledArchive(writeArchive(artifact('1.1.0'))).action).toBe('installed');

		expect(() =>
			service.installOrUpdateArchive({
				...writeArchive(artifact('1.0.0'), 'omp-1.0.0.omp-plugin.json'),
				owner: 'external',
			})
		).toThrow('downgrade');
		expect(() =>
			service.installOrUpdateArchive({
				...writeArchive(artifact('1.1.0', [], { 'different.txt': 'different' }), 'omp-equivocal.omp-plugin.json'),
				owner: 'external',
			})
		).toThrow('equivocation');
	});

	it('preserves a user-managed OMP installation during bundled bootstrap', () => {
		const service = makeService();
		expect(
			service.installOrUpdateArchive({
				...writeArchive(artifact('2.0.0')),
				owner: 'external',
			}).action
		).toBe('installed');

		expect(service.bootstrapBundledArchive(writeArchive(artifact('1.0.0'))).action).toBe('preserved');
		expect(
			JSON.parse(
				fs.readFileSync(path.join(workDir, 'plugins', OMP_PLUGIN_ID, 'plugin.json'), 'utf8')
			).version
		).toBe('2.0.0');
	});

	it('requires explicit consent for a capability delta before promotion', () => {
		const service = makeService();
		expect(service.bootstrapBundledArchive(writeArchive(artifact('1.0.0'))).action).toBe('installed');
		const update = writeArchive(
			artifact('1.1.0', [{ capability: 'net:fetch', scope: 'api.maestro.test' }]),
			'omp-capability.omp-plugin.json'
		);

		expect(() => service.installOrUpdateArchive({ ...update, owner: 'external' })).toThrow(
			'capability delta requires explicit consent'
		);
		expect(
			service.installOrUpdateArchive({
				...update,
				owner: 'external',
				requestCapabilityConsent: (delta) => {
					expect(delta.added).toEqual([{ capability: 'net:fetch', scope: 'api.maestro.test' }]);
					return true;
				},
			}).action
		).toBe('updated');
	});

	it('rolls back the old verified tree when atomic promotion fails', () => {
		let failPromotion = false;
		const service = makeService({
			renameSync: (oldPath, newPath) => {
				if (
					failPromotion &&
					oldPath.includes('.omp-stage-') &&
					path.basename(oldPath) === OMP_PLUGIN_ID &&
					path.basename(newPath) === OMP_PLUGIN_ID
				) {
					throw new Error('simulated promotion failure');
				}
				fs.renameSync(oldPath, newPath);
			},
		});
		expect(service.bootstrapBundledArchive(writeArchive(artifact('1.0.0'))).action).toBe('installed');
		failPromotion = true;

		expect(() =>
			service.installOrUpdateArchive({
				...writeArchive(artifact('1.1.0'), 'omp-failing.omp-plugin.json'),
				owner: 'external',
			})
		).toThrow('simulated promotion failure');
		expect(
			JSON.parse(
				fs.readFileSync(path.join(workDir, 'plugins', OMP_PLUGIN_ID, 'plugin.json'), 'utf8')
			).version
		).toBe('1.0.0');
	});

	it('fails closed instead of accepting mutable settings as a trust root', () => {
		expect(
			() =>
				new OmpPluginTrustRootService({
					pluginsDir: path.join(workDir, 'plugins'),
					trustRoot: { ...trustRoot },
					verifySignature: verifier,
				})
		).toThrow('immutable compiled metadata');
	});
});
