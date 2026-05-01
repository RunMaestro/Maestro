/**
 * In-Memory Claim Tracker — #444
 *
 * Replaces the SQLite work_item_claims table as the authoritative runtime
 * source of claim state. Persists nothing — the ground truth is GitHub
 * Projects v2 (AI Assigned Slot field). On restart the reconciler in
 * main/index.ts releases any stale GitHub claims before pickup resumes.
 *
 * Used by:
 *   - DispatchEngine  (claim / release)
 *   - ClaimHeartbeat  (iterate active claims, detect stale)
 *   - pm-tools        (resolve agent's current claim)
 *   - pm-audit        (iterate active claims)
 *   - Renderer        (via agentDispatch:claimStarted/Ended IPC events)
 */

export interface ClaimInfo {
	/** Stable identifier — "<projectPath>:<role>:<issueNumber>" */
	claimId: string;
	projectPath: string;
	role: string;
	issueNumber: number;
	issueTitle: string;
	/** GitHub Projects v2 item ID */
	projectItemId: string;
	/** GitHub node-ID of the project (for writes) */
	projectId: string;
	/** The agentDispatch slot agent session ID that owns this claim */
	agentSessionId: string;
	claimedAt: string;
	lastHeartbeatAt: string;
}

export class ClaimTracker {
	/**
	 * Outer key: agentSessionId
	 * Inner key: role
	 */
	private readonly claims = new Map<string, Map<string, ClaimInfo>>();

	// ---------------------------------------------------------------------------
	// Write API
	// ---------------------------------------------------------------------------

	addClaim(claim: ClaimInfo): void {
		let byRole = this.claims.get(claim.agentSessionId);
		if (!byRole) {
			byRole = new Map();
			this.claims.set(claim.agentSessionId, byRole);
		}
		byRole.set(claim.role, claim);
	}

	removeClaim(agentSessionId: string, role: string): ClaimInfo | undefined {
		const byRole = this.claims.get(agentSessionId);
		if (!byRole) return undefined;
		const existing = byRole.get(role);
		byRole.delete(role);
		if (byRole.size === 0) this.claims.delete(agentSessionId);
		return existing;
	}

	/**
	 * Update the lastHeartbeatAt for a claim identified by workItemId.
	 * Returns true if the claim was found.
	 */
	renewHeartbeat(projectItemId: string): boolean {
		const now = new Date().toISOString();
		for (const byRole of this.claims.values()) {
			for (const claim of byRole.values()) {
				if (claim.projectItemId === projectItemId) {
					claim.lastHeartbeatAt = now;
					return true;
				}
			}
		}
		return false;
	}

	// ---------------------------------------------------------------------------
	// Read API
	// ---------------------------------------------------------------------------

	/**
	 * Return all active claims as a flat array.
	 */
	getAll(): ClaimInfo[] {
		const result: ClaimInfo[] = [];
		for (const byRole of this.claims.values()) {
			for (const claim of byRole.values()) {
				result.push(claim);
			}
		}
		return result;
	}

	/**
	 * Find the claim owned by the given agentSessionId, optionally scoped to
	 * a role.
	 */
	getByAgent(agentSessionId: string, role?: string): ClaimInfo | undefined {
		const byRole = this.claims.get(agentSessionId);
		if (!byRole) return undefined;
		if (role) return byRole.get(role);
		// Return any claim for this agent (first one)
		return byRole.values().next().value;
	}

	/**
	 * Find a claim by projectItemId (GitHub item ID).
	 */
	getByProjectItemId(projectItemId: string): ClaimInfo | undefined {
		for (const byRole of this.claims.values()) {
			for (const claim of byRole.values()) {
				if (claim.projectItemId === projectItemId) return claim;
			}
		}
		return undefined;
	}

	/**
	 * Return all claims older than `staleMs` ms since lastHeartbeatAt.
	 */
	getStaleClaims(staleMs: number): ClaimInfo[] {
		const threshold = Date.now() - staleMs;
		const stale: ClaimInfo[] = [];
		for (const byRole of this.claims.values()) {
			for (const claim of byRole.values()) {
				const lastBeat = new Date(claim.lastHeartbeatAt).getTime();
				if (lastBeat < threshold) {
					stale.push(claim);
				}
			}
		}
		return stale;
	}

	size(): number {
		let total = 0;
		for (const byRole of this.claims.values()) {
			total += byRole.size;
		}
		return total;
	}
}

// ---------------------------------------------------------------------------
// Process-level singleton
// ---------------------------------------------------------------------------

let _tracker: ClaimTracker | undefined;

export function getClaimTracker(): ClaimTracker {
	if (!_tracker) {
		_tracker = new ClaimTracker();
	}
	return _tracker;
}

/** Reset for testing. */
export function resetClaimTracker(): void {
	_tracker = undefined;
}
