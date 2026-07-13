import { describe, expect, it } from 'vitest';
import {
	OmpDiscoveryError,
	ValidatedOmpDiscovery,
	assertSafeOmpCwd,
	type OmpExecutableCandidate,
} from '../../../main/omp';

const trustedCandidate: OmpExecutableCandidate = {
	path: 'C:/Program Files/OMP/omp.exe',
	provenance: { source: 'system', sha256: 'a'.repeat(64) },
};

describe('ValidatedOmpDiscovery', () => {
	it('executes only a provenance-pinned absolute binary and accepts exactly omp/16.4.8', async () => {
		const calls: Array<{ executable: string; args: readonly string[] }> = [];
		const discovery = new ValidatedOmpDiscovery({
			locate: async () => [trustedCandidate],
			probeVersion: async (executable, args) => {
				calls.push({ executable, args });
				return { exitCode: 0, stdout: 'omp/16.4.8\n', stderr: '' };
			},
			trustedDigests: [trustedCandidate.provenance.sha256],
		});

		await expect(discovery.discover()).resolves.toEqual({
			path: trustedCandidate.path,
			version: '16.4.8',
			provenance: 'system',
		});
		expect(calls).toEqual([{ executable: trustedCandidate.path, args: ['--version'] }]);
	});

	it.each([
		[
			'untrusted digest',
			{ ...trustedCandidate, provenance: { source: 'system' as const, sha256: 'b'.repeat(64) } },
			'omp/16.4.8',
		],
		['wrong version', trustedCandidate, 'omp/16.4.9'],
		['relative executable', { ...trustedCandidate, path: 'omp.exe' }, 'omp/16.4.8'],
	])('rejects %s before launch', async (_caseName, candidate, version) => {
		const discovery = new ValidatedOmpDiscovery({
			locate: async () => [candidate],
			probeVersion: async () => ({ exitCode: 0, stdout: `${version}\n`, stderr: '' }),
			trustedDigests: [trustedCandidate.provenance.sha256],
		});

		await expect(discovery.discover()).rejects.toBeInstanceOf(OmpDiscoveryError);
	});

	it('rejects relative and filesystem-root working directories before any process may launch', () => {
		expect(() => assertSafeOmpCwd('relative/path')).toThrow(/absolute/);
		expect(() => assertSafeOmpCwd('C:/')).toThrow(/root/);
		expect(assertSafeOmpCwd('C:/workspace/project')).toBe('C:/workspace/project');
	});
});
