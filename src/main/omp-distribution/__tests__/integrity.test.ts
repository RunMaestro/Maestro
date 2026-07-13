import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
	MANAGED_OMP_PACKAGE,
	MANAGED_OMP_VERSION,
	parseNpmProvenance,
	verifyManagedPackage,
	verifySha512Integrity,
} from '../integrity';
import { MANAGED_OMP_NOTICE_INPUT } from '../notice-inputs';

const packageJson = JSON.stringify({
	name: MANAGED_OMP_PACKAGE,
	version: MANAGED_OMP_VERSION,
	bin: { omp: 'dist/cli.js' },
});

const integrityFor = (value: string): string =>
	`sha512-${createHash('sha512').update(value).digest('base64')}`;

describe('managed OMP package verification', () => {
	it('accepts only the exact managed package manifest and sha512 integrity', () => {
		const tarball = Buffer.from('offline-fixture-tarball');
		const result = verifyManagedPackage({
			packageJson,
			tarball,
			integrity: integrityFor(tarball.toString()),
		});

		expect(result).toEqual({ executable: 'dist/cli.js', version: '16.4.8' });
	});

	it('rejects package name, version, missing executable, and invalid sha512', () => {
		expect(() =>
			verifyManagedPackage({
				packageJson: JSON.stringify({ name: MANAGED_OMP_PACKAGE, version: '16.4.7', bin: {} }),
				tarball: Buffer.from('fixture'),
				integrity: integrityFor('fixture'),
			})
		).toThrow('exactly 16.4.8');
		expect(() => verifySha512Integrity(Buffer.from('fixture'), 'sha512-not-base64')).toThrow(
			'invalid sha512 integrity'
		);
	});

	it('accepts the real npm 16.4.8 signature and DSSE provenance shape', () => {
		const digest = createHash('sha512').update('fixture').digest('base64');
		const provenance = parseNpmProvenance(
			{
				integrity: `sha512-${digest}`,
				signatures: [{ keyid: 'SHA256:publisher-key', sig: 'signature' }],
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
												digest: { sha512: Buffer.from(digest, 'base64').toString('hex') },
											},
										],
									})
								).toString('base64'),
							},
						},
					},
				],
			},
			() => true
		);

		expect(provenance).toEqual({ keyId: 'SHA256:publisher-key', digest, attested: true });
	});

	it('fails closed on missing or mismatched provenance', () => {
		expect(() => parseNpmProvenance({ signatures: [], attestations: [] })).toThrow(
			'invalid npm signature integrity evidence'
		);
		expect(() =>
			parseNpmProvenance(
				{
					integrity: 'sha512-ZmFrZQ==',
					signatures: [{ keyid: 'key', sig: 'signature' }],
					attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', subject: [] }],
				},
				() => true
			)
		).toThrow('missing matching npm attestation evidence');
		expect(() =>
			parseNpmProvenance(
				{
					integrity: 'sha512-ZmFrZQ==',
					signatures: [{ keyid: 'key', sig: 'signature' }],
					attestations: [
						{
							predicateType: 'https://slsa.dev/provenance/v1',
							subject: [{ name: MANAGED_OMP_PACKAGE, digest: { sha512: 'ZmFrZQ==' } }],
						},
					],
				},
				() => false
			)
		).toThrow('npm signature verification failed');
	});

	it('pins MIT notice aggregation to the exact managed package', () => {
		expect(MANAGED_OMP_NOTICE_INPUT).toEqual({
			packageName: MANAGED_OMP_PACKAGE,
			version: MANAGED_OMP_VERSION,
			license: 'MIT',
			requiredFiles: ['LICENSE'],
		});
	});
});
