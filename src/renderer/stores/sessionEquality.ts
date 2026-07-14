import type { AITab, Session } from '../types';

// Fields on Session that the sidebar (SessionList, useSessionCategories) actually
// reads to render. Streaming-heavy fields (aiLogs, shellLogs, workLog, usageStats,
// contextUsage, currentCycleBytes, currentCycleTokens, fileTree, etc.) are
// excluded so that log streaming does not bust the equality check and force a
// sidebar re-render every 200 ms batched flush.
function aiTabEqual(a: AITab, b: AITab): boolean {
	if (a === b) return true;
	return (
		a.id === b.id &&
		a.name === b.name &&
		a.state === b.state &&
		a.starred === b.starred &&
		a.hasUnread === b.hasUnread &&
		a.readOnlyMode === b.readOnlyMode &&
		a.agentSessionId === b.agentSessionId
	);
}

/**
 * Equality function for `useStoreWithEqualityFn(useSessionStore, s => s.sessions, ...)`.
 *
 * Returns true when the two arrays are sidebar-equivalent — i.e. nothing the
 * left-bar / categorization layer cares about has changed. This lets the
 * batched session-update flush rebuild the array reference every 200 ms without
 * forcing the sidebar tree to re-render unless a user-visible field actually
 * changed (name, state, bookmark, group membership, worktree expansion, AI tab
 * busy/unread state, etc.).
 */
export function sidebarSessionEquality(a: Session[], b: Session[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;

		if (
			x.id !== y.id ||
			x.name !== y.name ||
			x.state !== y.state ||
			x.toolType !== y.toolType ||
			x.bookmarked !== y.bookmarked ||
			x.groupId !== y.groupId ||
			x.parentSessionId !== y.parentSessionId ||
			x.worktreesExpanded !== y.worktreesExpanded ||
			x.worktreeBranch !== y.worktreeBranch ||
			x.isGitRepo !== y.isGitRepo ||
			x.isLive !== y.isLive ||
			x.inputMode !== y.inputMode ||
			x.activeTabId !== y.activeTabId
		) {
			return false;
		}

		const ax = x.aiTabs;
		const bx = y.aiTabs;
		if (ax !== bx) {
			if (!ax || !bx) return false;
			if (ax.length !== bx.length) return false;
			for (let j = 0; j < ax.length; j++) {
				if (!aiTabEqual(ax[j], bx[j])) return false;
			}
		}
	}

	return true;
}

/**
 * Fields useGitStatusPolling reads for poll cwd / SSH / isGitRepo gating.
 * Ignores logs, tokens, and other streaming-heavy fields.
 */
export function gitPollSessionEquality(a: Session[], b: Session[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;

		if (
			x.id !== y.id ||
			x.isGitRepo !== y.isGitRepo ||
			x.inputMode !== y.inputMode ||
			x.cwd !== y.cwd ||
			x.shellCwd !== y.shellCwd ||
			x.sshRemoteId !== y.sshRemoteId ||
			x.sessionSshRemoteConfig?.remoteId !== y.sessionSshRemoteConfig?.remoteId
		) {
			return false;
		}
	}

	return true;
}

/**
 * Fields GroupChat @mention autocomplete needs (id, name, toolType, groupId).
 */
export function mentionSessionEquality(a: Session[], b: Session[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;

		if (
			x.id !== y.id ||
			x.name !== y.name ||
			x.toolType !== y.toolType ||
			x.groupId !== y.groupId
		) {
			return false;
		}
	}

	return true;
}

/**
 * Fields that need a live id → projectRoot map (e.g. GroupChat participant paths).
 * Ignores logs, tokens, and other streaming-heavy fields. Unlike
 * `sidebarSessionEquality`, this *does* compare `projectRoot`.
 */
export function projectRootSessionEquality(a: Session[], b: Session[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x === y) continue;

		if (x.id !== y.id || x.projectRoot !== y.projectRoot) {
			return false;
		}
	}

	return true;
}

/**
 * Compact signature of session id + projectRoot for Cue auto-discovery.
 * Changes only when agents are added/removed or their project root moves.
 */
export function selectCueDiscoverySignature(state: { sessions: Session[] }): string {
	return state.sessions.map((s) => `${s.id}\0${s.projectRoot ?? ''}`).join('\n');
}
