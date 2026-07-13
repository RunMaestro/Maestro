import {
	parseNpmProvenance,
	verifyManagedPackage,
	type ManagedPackageInput,
	type NpmProvenanceDocument,
	type VerifiedManagedPackage,
	type VerifiedProvenance,
} from './integrity';
import { extractVerifiedTarball, type ExtractedTarFile } from './safe-extract';
import { MANAGED_OMP_NOTICE_INPUT } from './notice-inputs';

export interface ManagedPackageMetadata {
	packageJson: string;
	integrity: string;
	provenance: NpmProvenanceDocument;
}

export interface ManagedPackageFetcher {
	fetchMetadata(): Promise<ManagedPackageMetadata>;
	fetchTarball(): Promise<Uint8Array>;
}

export interface VerifiedManagedPackageSource extends VerifiedManagedPackage {
	provenance: VerifiedProvenance;
	files: readonly ExtractedTarFile[];
	notices: readonly ExtractedTarFile[];
}

/** Verifies a registry-provided package source; GitHub executables are deliberately not a fallback source. */
export function verifyManagedPackageSource(
	metadata: ManagedPackageMetadata,
	tarball: Uint8Array
): VerifiedManagedPackageSource {
	const packageInput: ManagedPackageInput = {
		packageJson: metadata.packageJson,
		tarball,
		integrity: metadata.integrity,
	};
	const managedPackage = verifyManagedPackage(packageInput);
	const provenance = parseNpmProvenance(metadata.provenance);
	const expectedDigest = metadata.integrity.slice('sha512-'.length);
	if (provenance.digest !== expectedDigest)
		throw new Error('npm provenance does not match the verified tarball digest');

	const files = extractVerifiedTarball(tarball);
	if (!files.some((file) => file.path === managedPackage.executable)) {
		throw new Error('managed package executable is absent from the verified tarball');
	}
	const notices = files.filter((file) =>
		MANAGED_OMP_NOTICE_INPUT.requiredFiles.includes(file.path)
	);
	if (notices.length !== MANAGED_OMP_NOTICE_INPUT.requiredFiles.length) {
		throw new Error('verified managed package is missing a required license notice');
	}
	return { ...managedPackage, provenance, files, notices };
}

export async function fetchVerifiedManagedPackage(
	fetcher: ManagedPackageFetcher
): Promise<VerifiedManagedPackageSource> {
	const metadata = await fetcher.fetchMetadata();
	const tarball = await fetcher.fetchTarball();
	return verifyManagedPackageSource(metadata, tarball);
}
