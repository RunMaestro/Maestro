/**
 * Which store holds a provider session's origin record (name, star, pins).
 *
 * Claude Code and Codex share the legacy Claude origins store; every other
 * provider uses the generic per-agent store. The read side
 * (`loadResumableSession`) and every writer must agree on this, or a value
 * written to one store is never read back from the other.
 */

export type SessionOriginStoreKind = 'claude' | 'generic';

/** The origins store for `toolType`. A missing provider means Claude Code. */
export function sessionOriginStoreFor(toolType: string | null | undefined): SessionOriginStoreKind {
	return !toolType || toolType === 'claude-code' || toolType === 'codex' ? 'claude' : 'generic';
}
