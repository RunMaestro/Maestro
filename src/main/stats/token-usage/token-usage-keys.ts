/**
 * The keys the token-usage breakdown cache files a session under. Pure, with no Electron import,
 * so `project-breakdowns.ts` (which a plain-Node `maestro-cli host` loads) can share them with
 * the desktop's cache (`token-usage-cache.ts`).
 */

/** The cache key of one session of a provider (and, where the caller adds it, an account). */
export function tokenCacheKey(agentType: string, sessionId: string): string {
	return `${agentType}:${sessionId}`;
}

/** Fingerprint a session from the cheap metadata `listSessions` already returns. */
export function sessionFingerprint(modifiedAt: string, sizeBytes: number): string {
	return `${modifiedAt}-${sizeBytes}`;
}
