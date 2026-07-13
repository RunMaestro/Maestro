import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import { MANAGED_OMP_PACKAGE, MANAGED_OMP_VERSION } from '../integrity';
import { fetchVerifiedManagedPackage, verifyManagedPackageSource } from '../managed-package-source';

function packageTarball(): Buffer {
	const createEntry = (name: string, content: string): Buffer => {
		const header = Buffer.alloc(512);
		header.write(name, 0);
		header.write('0000777\0', 100);
		header.write('0000000\0', 108);
		header.write('0000000\0', 116);
		header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
		header.write('00000000000\0', 136);
		header.write('        ', 148);
		header.write('ustar\0', 257);
		header.write('00', 263);
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
		return Buffer.concat([
			header,
			Buffer.from(content),
			Buffer.alloc((512 - (content.length % 512)) % 512),
		]);
	};
	return gzipSync(
		Buffer.concat([
			createEntry('package/dist/cli.js', 'cli'),
			createEntry('package/LICENSE', 'MIT'),
			Buffer.alloc(1024),
		])
	);
}

const tarball = packageTarball();
const digest = createHash('sha512').update(tarball).digest('base64');

function realProvenance(integrityDigest: string) {
	return {
		signatures: [{ keyid: 'publisher', sig: 'signature' }],
		attestations: [
			{
				predicateType: 'https://slsa.dev/provenance/v1',
				bundle: {
					dsseEnvelope: {
						payload: Buffer.from(
							JSON.stringify({
								subject: [
									{
										name: 'pkg:npm/%40oh-my-pi/pi-coding-agent@16.4.8',
										digest: {
											sha512: Buffer.from(integrityDigest, 'base64').toString('hex'),
										},
									},
								],
							})
						).toString('base64'),
					},
				},
			},
		],
	};
}
const metadata = {
	packageJson: JSON.stringify({
		name: MANAGED_OMP_PACKAGE,
		version: MANAGED_OMP_VERSION,
		bin: { omp: 'dist/cli.js' },
	}),
	integrity: `sha512-${digest}`,
	provenance: realProvenance(digest),
};
const verifyFixtureSignature = (keyId: string, signature: string): boolean =>
	keyId === 'publisher' && signature === 'signature';

describe('managed package source', () => {
	it('binds exact manifest, tarball digest, signature, attestation and extracted executable', () => {
		const verified = verifyManagedPackageSource(metadata, tarball, verifyFixtureSignature);
		expect(verified).toMatchObject({
			version: '16.4.8',
			executable: 'dist/cli.js',
			provenance: { digest },
		});
	});

	it('fails closed without network fallback or provenance bound to the tarball', async () => {
		await expect(
			fetchVerifiedManagedPackage({
				fetchMetadata: async () => {
					throw new Error('offline');
				},
				fetchTarball: async () => tarball,
				verifyNpmSignature: verifyFixtureSignature,
			})
		).rejects.toThrow('offline');
		expect(() =>
			verifyManagedPackageSource(
				{
					...metadata,
					provenance: realProvenance('ZmFrZQ=='),
				},
				tarball,
				verifyFixtureSignature
			)
		).toThrow('missing matching npm attestation evidence');
		expect(() =>
			verifyManagedPackageSource(
				metadata,
				tarball,
				undefined as unknown as typeof verifyFixtureSignature
			)
		).toThrow('missing npm signature verifier');
	});
});
