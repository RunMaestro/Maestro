import * as path from 'node:path';
import { assertOmpProtocolVersion } from './compatibility';
import type { OmpBinaryDiscovery, OmpDiscoveredBinary } from './types';

export interface OmpExecutableCandidate {
	readonly path: string;
	readonly provenance: {
		readonly source: 'system';
		readonly sha256: string;
	};
}

export interface OmpVersionProbeResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ValidatedOmpDiscoveryOptions {
	readonly locate: () => Promise<readonly OmpExecutableCandidate[]>;
	readonly probeVersion: (
		executable: string,
		args: readonly string[]
	) => Promise<OmpVersionProbeResult>;
	readonly trustedDigests: readonly string[];
}

export class OmpDiscoveryError extends Error {
	readonly code: 'not_found' | 'untrusted_binary' | 'version_probe_failed' | 'unsupported_version';

	constructor(code: OmpDiscoveryError['code'], message: string) {
		super(message);
		this.name = 'OmpDiscoveryError';
		this.code = code;
	}
}

/**
 * Pins OMP execution to an explicitly trusted system-installed binary and exact protocol release.
 * The caller owns the platform-specific locator and digest source; this class never probes untrusted paths.
 */
export class ValidatedOmpDiscovery implements OmpBinaryDiscovery {
	constructor(private readonly options: ValidatedOmpDiscoveryOptions) {}

	async discover(): Promise<OmpDiscoveredBinary> {
		const candidates = await this.options.locate();
		if (candidates.length === 0) {
			throw new OmpDiscoveryError('not_found', 'No system OMP executable was found');
		}

		const candidate = candidates.find((entry) => this.isTrustedCandidate(entry));
		if (!candidate) {
			throw new OmpDiscoveryError('untrusted_binary', 'No trusted system OMP executable was found');
		}

		const result = await this.options.probeVersion(candidate.path, ['--version']);
		if (result.exitCode !== 0) {
			throw new OmpDiscoveryError('version_probe_failed', 'OMP version probe failed');
		}
		try {
			assertOmpProtocolVersion(result.stdout);
		} catch {
			throw new OmpDiscoveryError(
				'unsupported_version',
				'System OMP is not compatible with protocol 16.4.8'
			);
		}
		return { path: candidate.path, version: '16.4.8', provenance: 'system' };
	}

	private isTrustedCandidate(candidate: OmpExecutableCandidate): boolean {
		return (
			candidate.provenance.source === 'system' &&
			isAbsoluteFilePath(candidate.path) &&
			isSha256(candidate.provenance.sha256) &&
			this.options.trustedDigests.includes(candidate.provenance.sha256)
		);
	}
}

export function assertSafeOmpCwd(cwd: string): string {
	if (!isAbsoluteFilePath(cwd)) {
		throw new Error('OMP working directory must be absolute');
	}
	if (isFilesystemRoot(cwd)) {
		throw new Error('OMP working directory must not be a filesystem root');
	}
	return cwd;
}

function isAbsoluteFilePath(value: string): boolean {
	return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function isFilesystemRoot(value: string): boolean {
	const windows = path.win32.parse(value);
	if (
		path.win32.isAbsolute(value) &&
		windows.root.replace(/[\\/]/g, '/') === value.replace(/[\\/]/g, '/')
	) {
		return true;
	}
	const posix = path.posix.parse(value);
	return path.posix.isAbsolute(value) && posix.root === path.posix.normalize(value);
}

function isSha256(value: string): boolean {
	return /^[a-f0-9]{64}$/i.test(value);
}
