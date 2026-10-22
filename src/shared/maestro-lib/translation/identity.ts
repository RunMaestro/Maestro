import { createHash } from 'node:crypto';
import { canonicalJson } from '../../canonicalJson';
import type { RecordOrigin, TranslationArtifact, TranslationIdentity } from './types';

export function translationHash(bytes: string | Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export function recordKey(origin: RecordOrigin): string {
	return canonicalJson(origin);
}

export function nativeRecordKey(
	identity: TranslationIdentity,
	sessionId: string,
	eventId: string
): string {
	return recordKey({
		provider: identity.provider,
		account: translationHash(identity.accountRoot),
		sessionId,
		eventId,
	});
}

export function translationArtifact(
	kind: TranslationArtifact['kind'],
	sourcePath: string,
	relativePath: string,
	bytes: Buffer,
	scope: TranslationArtifact['scope'] = 'project'
): TranslationArtifact {
	const sha256 = translationHash(bytes);
	return {
		id: translationHash(canonicalJson({ kind, sourcePath })),
		kind,
		sourcePath,
		originPath: sourcePath,
		relativePath,
		sha256,
		originSha256: sha256,
		bytesBase64: bytes.toString('base64'),
		scope,
	};
}
