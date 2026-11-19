import crypto from 'crypto';

/**
 * sha256 hex of a playbook document's text, the value stored in
 * `PlaybookSourceProvenance.documentHashes`. The ZIP import and the
 * marketplace import both hash through this, so a hash recorded by one
 * compares equal to the same text recorded by the other.
 */
export function hashPlaybookDocument(content: string): string {
	return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}
