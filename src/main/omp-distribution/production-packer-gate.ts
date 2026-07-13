import type { ImmutableTrustRoot } from './plugin-artifact';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/=_-]{16,}$/;

export interface PackerGateInput {
	fixture: boolean;
	trustRoot: ImmutableTrustRoot;
	signature: string;
	expectedSha256?: string;
	actualSha256: string;
	outputPaths: readonly string[];
	trustRootPath: string;
}

export function assertPackerGate(input: PackerGateInput): void {
	if (input.fixture) return;
	if (!SHA256_PATTERN.test(input.expectedSha256 ?? ''))
		throw new Error('production build requires a published expected SHA-256');
	if (input.actualSha256.toLowerCase() !== input.expectedSha256?.toLowerCase())
		throw new Error('production artifact SHA-256 differs from published expected SHA-256');
	if (input.trustRoot.algorithm !== 'ed25519')
		throw new Error('production trust root must use supported ed25519');
	if (
		isFixture(input.trustRoot.keyId) ||
		isFixture(input.trustRoot.publicKey) ||
		isFixture(input.trustRootPath)
	)
		throw new Error('production build rejects fixture trust metadata');
	if (!SIGNATURE_PATTERN.test(input.signature))
		throw new Error('production build requires a valid signature input');
	if (input.outputPaths.some(isFixture))
		throw new Error('production build rejects fixture output paths');
}

function isFixture(value: string): boolean {
	return value.toLowerCase().includes('fixture');
}
