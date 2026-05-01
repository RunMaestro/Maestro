import type {
	WorkGraphActor,
	WorkItemClaim,
	WorkItemClaimRenewInput,
} from '../../shared/work-graph-types';
import type { FleetRegistry } from './fleet-registry';

/**
 * Store interface required by the heartbeat supervisor.
 * The runtime adapter fulfils this against WorkGraphStorage.
 */
export interface HeartbeatWorkGraphStore {
	/** Renew an active claim's expiry deadline. */
	renewClaim(input: WorkItemClaimRenewInput): Promise<WorkItemClaim>;
	/**
	 * Release a claim (string overload – no owner check, for force-expiry).
	 * When the claim has already expired/been released this must not throw.
	 */
	releaseClaim(
		workItemId: string,
		options?: { note?: string; actor?: WorkGraphActor }
	): Promise<WorkItemClaim | undefined>;
}

export interface HeartbeatOptions {
	workGraph: HeartbeatWorkGraphStore;
	fleetRegistry: FleetRegistry;
	/** How often to tick, in milliseconds. Default: 30 000 (30 s). */
	intervalMs?: number;
	/**
	 * New expiry offset from now added each time a claim is renewed.
	 * Should be > intervalMs so that a single missed tick doesn't immediately
	 * expire the lease.  Default: intervalMs * 3.
	 */
	renewWindowMs?: number;
	/** Override Date.now() for testing. */
	now?: () => number;
}

export interface HeartbeatTickResult {
	renewed: number;
	expired: number;
	errors: Array<{ workItemId: string; claimId: string; message: string }>;
}

/**
 * ClaimHeartbeat periodically renews active claims owned by the local fleet
 * and releases claims whose leases have lapsed without renewal.
 *
 * Design:
 * - Tickable (no internal setInterval) so unit tests can drive ticks
 *   synchronously without fake timers.
 * - start() / stop() wire the real interval when running in production.
 * - Crash/disconnect recovery: on startup the fleet is compared against the
 *   Work Graph; any claim whose expiresAt has passed is released so that work
 *   re-enters the pool rather than staying orphaned.
 */
export class ClaimHeartbeat {
	private readonly intervalMs: number;
	private readonly renewWindowMs: number;
	private readonly now: () => number;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;

	constructor(private readonly options: HeartbeatOptions) {
		this.intervalMs = options.intervalMs ?? 30_000;
		this.renewWindowMs = options.renewWindowMs ?? this.intervalMs * 3;
		this.now = options.now ?? (() => Date.now());
	}

	/** Start the periodic heartbeat loop. Idempotent. */
	start(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
	}

	/** Stop the periodic heartbeat loop. Idempotent. */
	stop(): void {
		this.running = false;
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Execute one heartbeat pass.
	 *
	 * For each active claim owned by an agent in the current fleet:
	 * - If the lease has already expired: release the claim so the item
	 *   returns to the ready pool (crash-recovery path).
	 * - Otherwise: renew the claim, extending expiresAt by renewWindowMs.
	 *
	 * Claims without an expiresAt (no-expiry leases) are renewed with a fresh
	 * expiry so that a new heartbeat window is established going forward.
	 */
	async tick(): Promise<HeartbeatTickResult> {
		const result: HeartbeatTickResult = { renewed: 0, expired: 0, errors: [] };
		const now = this.now();
		const nowIso = new Date(now).toISOString();
		const newExpiryIso = new Date(now + this.renewWindowMs).toISOString();

		const claims = this.getOwnedActiveClaims();
		for (const claim of claims) {
			const hasExpired = !!claim.expiresAt && claim.expiresAt <= nowIso;
			if (hasExpired) {
				await this.expireClaim(claim, nowIso, result);
			} else {
				await this.renewClaim(claim, newExpiryIso, result);
			}
		}

		return result;
	}

	private getOwnedActiveClaims(): WorkItemClaim[] {
		const entries = this.options.fleetRegistry.getEntries();
		const ownerIds = new Set(entries.map((entry) => entry.id));
		const seen = new Set<string>();
		const claims: WorkItemClaim[] = [];

		for (const entry of entries) {
			for (const claim of entry.currentClaims) {
				if (claim.status === 'active' && ownerIds.has(claim.owner.id) && !seen.has(claim.id)) {
					seen.add(claim.id);
					claims.push(claim);
				}
			}
		}
		return claims;
	}

	private async renewClaim(
		claim: WorkItemClaim,
		newExpiryIso: string,
		result: HeartbeatTickResult
	): Promise<void> {
		try {
			await this.options.workGraph.renewClaim({
				workItemId: claim.workItemId,
				claimId: claim.id,
				owner: claim.owner,
				expiresAt: newExpiryIso,
				note: 'heartbeat renewal',
			});
			result.renewed += 1;
		} catch (error) {
			result.errors.push({
				workItemId: claim.workItemId,
				claimId: claim.id,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async expireClaim(
		claim: WorkItemClaim,
		_nowIso: string,
		result: HeartbeatTickResult
	): Promise<void> {
		try {
			await this.options.workGraph.releaseClaim(claim.workItemId, {
				note: 'heartbeat: lease expired, returning to ready pool',
				actor: {
					type: 'system',
					id: 'claim-heartbeat',
					name: 'Claim Heartbeat',
				},
			});
			result.expired += 1;
		} catch (error) {
			result.errors.push({
				workItemId: claim.workItemId,
				claimId: claim.id,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
