import { randomUUID } from 'crypto';
import type {
	RetirementPreparationResult,
	RetirementRendererCommand,
	RetirementRendererReply,
} from '../../shared/worktreeRetirement';
import type { ManagedCheckout, RetirementToken, WorktreeRetirement } from './worktreeRetirement';
import {
	removeRetirementCheckout,
	verifyRetirementClean,
	verifyRetirementMerge,
} from './worktreeRetirementRemoval';

type RemovalResult = { status: 'removed' } | { status: 'blocked' | 'pending'; reason: string };

/** Adapter owns the actual IPC sender and its primary-window lifetime. */
export interface RetirementRenderer {
	identity: object;
	request(command: RetirementRendererCommand): Promise<RetirementRendererReply>;
	release(sessionId: string, token: string): void;
	onInvalidated(callback: () => void): () => void;
}
type Prepared = {
	sessionId: string;
	renderer: RetirementRenderer;
	token: RetirementToken;
	expected: Readonly<ManagedCheckout>;
	revision?: number;
	timer?: ReturnType<typeof setTimeout>;
	detach?: () => void;
	removal?: Promise<RemovalResult>;
	diskRemoved?: boolean;
};

/** Opaque wire ids never substitute for Main-owned reservation objects.
 * A lease can abort preparation only; removing remains fenced until settlement.
 */
export class WorktreeRetirementHost {
	private readonly prepared = new Map<string, Prepared>();
	constructor(
		private readonly fence: WorktreeRetirement,
		private readonly leaseMs = 30000,
		private readonly settleDiscovery?: (checkout: Readonly<ManagedCheckout>) => Promise<void>
	) {}

	async prepare(
		sessionId: string,
		renderer: RetirementRenderer
	): Promise<RetirementPreparationResult> {
		if (typeof sessionId !== 'string' || !sessionId)
			return { ok: false, reason: 'session id required' };
		const result = await this.fence.prepareRegisteredForRenderer(sessionId, renderer.identity);
		if (!result.ok) return result;
		const ownership = result.expected.ownership;
		if (!ownership) {
			this.fence.abort(result.token);
			return { ok: false, reason: 'trusted ownership required' };
		}
		const id = randomUUID();
		const entry: Prepared = { sessionId, renderer, token: result.token, expected: result.expected };
		this.prepared.set(id, entry);
		try {
			entry.timer = setTimeout(() => this.abort(id, renderer.identity), this.leaseMs);
			entry.detach = renderer.onInvalidated(() => this.abort(id, renderer.identity));

			const reply = await renderer.request({
				kind: 'prepare',
				request: {
					sessionId,
					parentSessionId: ownership.parentSessionId,
					path: result.expected.path,
					parentPath: ownership.parentPath,
					token: id,
				},
			});
			if (!reply.ok) {
				this.abort(id, renderer.identity);
				return reply;
			}
			if (reply.token !== id || !Number.isSafeInteger(reply.revision) || reply.revision < 1)
				throw new Error('renderer preparation identity mismatch');
			entry.revision = reply.revision;
			const persisted = await this.fence.persistPreparedRegistration(entry.token, reply.snapshots);
			if (!persisted.ok) throw new Error(persisted.reason);
			entry.expected = persisted.expected;
			const verified = await this.validate(id, renderer.identity);
			if (!verified.ok) throw new Error(verified.reason);
			return { ok: true, token: id, revision: reply.revision };
		} catch (error) {
			this.abort(id, renderer.identity);
			return { ok: false, reason: error instanceof Error ? error.message : 'renderer unavailable' };
		}
	}

	/** Used by the internal removal transaction, never exposed as an IPC token getter.
	 * Validate after awaits; owner loss or expiration must win over a late reply.
	 */
	async validate(id: string, renderer: object) {
		const entry = this.prepared.get(id);
		if (!entry || entry.renderer.identity !== renderer || entry.revision === undefined)
			return { ok: false as const, reason: 'unknown renderer preparation' };
		const reply = await entry.renderer.request({
			kind: 'check',
			sessionId: entry.sessionId,
			token: id,
			revision: entry.revision,
		});
		if (!reply.ok || reply.token !== id || reply.revision !== entry.revision)
			return { ok: false as const, reason: 'renderer revision changed' };
		const verified = await this.fence.revalidateRegistered(entry.token);
		if (!verified.ok) return verified;
		if (this.prepared.get(id) !== entry)
			return { ok: false as const, reason: 'preparation expired or owner lost' };
		return { ok: true as const, token: entry.token, expected: entry.expected };
	}

	/** Internal only until durable restart recovery and policy are wired. The
	 * caller must settle feature-owned watchers before releasing this reservation.
	 * Concurrent calls share one runner. Once Git starts, abort/expiry/owner loss
	 * cannot unlock it; retries settle persistence/renderer without removing twice.
	 */
	remove(
		id: string,
		renderer: object,
		settleWatchers = this.settleDiscovery
	): Promise<RemovalResult> {
		const entry = this.prepared.get(id);
		if (!entry || entry.renderer.identity !== renderer)
			return Promise.resolve({ status: 'blocked', reason: 'unknown renderer preparation' });
		if (entry.removal) return entry.removal;
		const operation = async (): Promise<RemovalResult> => {
			try {
				if (this.fence.tokenState(entry.token) === 'preparing') {
					const initial = await this.validate(id, renderer);
					if (!initial.ok) throw new Error(initial.reason);
					await verifyRetirementMerge(initial.expected);
					// GitHub reads can outlive a registration, lease, or primary owner.
					if (!this.settleDiscovery || !settleWatchers)
						throw new Error('Watcher settlement unavailable');
					// Drain pending Git discovery while still preparing. Revalidate
					// afterwards so timeout/navigation wins before the durable intent.
					await this.settleDiscovery(entry.expected);
					const current = await this.validate(id, renderer);
					if (!current.ok) throw new Error(current.reason);
					await verifyRetirementClean(current.expected);
					await this.fence.beginRemoval(entry.token);
					await removeRetirementCheckout(current.expected);
					entry.diskRemoved = true;
				}
				if (!entry.diskRemoved) throw new Error('Removal outcome requires recovery');
				if (!settleWatchers) throw new Error('Watcher settlement unavailable');
				await settleWatchers(entry.expected);
				const reconciled = await this.reconcileRenderer(id, renderer);
				if (!reconciled.ok) throw new Error(reconciled.reason);
				await this.fence.settleRemoval(entry.token);
				if (!this.fence.complete(entry.token)) throw new Error('Removal settlement lost ownership');
				this.release(id, entry);
				return { status: 'removed' };
			} catch (error) {
				const removing = this.fence.tokenState(entry.token) === 'removing';
				if (!removing) this.abort(id, renderer);
				return {
					status: removing ? 'pending' : 'blocked',
					reason: error instanceof Error ? error.message : 'Removal unavailable',
				};
			}
		};
		entry.removal = operation().finally(() => {
			delete entry.removal;
		});
		return entry.removal;
	}

	/** Called internally only after checked removal and durable reconciliation.
	 * A failed/lost renderer reply keeps removing owned for same-token retry.
	 */
	async reconcileRenderer(id: string, renderer: object) {
		const entry = this.prepared.get(id);
		if (
			!entry ||
			entry.renderer.identity !== renderer ||
			entry.revision === undefined ||
			this.fence.tokenState(entry.token) !== 'removing'
		)
			return { ok: false as const, reason: 'owned removal required' };
		const persisted = await this.fence.reconcileRemovedRegistration(entry.token);
		if (!persisted.ok) return persisted;
		try {
			const reply = await entry.renderer.request({
				kind: 'complete',
				sessionId: entry.sessionId,
				token: id,
				revision: entry.revision,
			});
			if (
				!reply.ok ||
				reply.token !== id ||
				reply.revision !== entry.revision ||
				this.prepared.get(id) !== entry
			)
				return { ok: false as const, reason: 'renderer completion pending' };
			// The transaction still owns watcher settlement and final fence completion.
			return { ok: true as const };
		} catch {
			return { ok: false as const, reason: 'renderer completion unavailable' };
		}
	}

	abort(id: string, renderer: object): boolean {
		const entry = this.prepared.get(id);
		if (!entry || entry.renderer.identity !== renderer) return false;
		// Owner invalidation may already have aborted Main's fence. Never thaw
		// an active removal, even when its renderer disappears or lease expires.
		if (!this.fence.abort(entry.token) && this.fence.tokenState(entry.token) !== undefined)
			return false;
		this.release(id, entry);
		return true;
	}

	private release(id: string, entry: Prepared): void {
		this.prepared.delete(id);
		clearTimeout(entry.timer);
		entry.detach?.();
		try {
			entry.renderer.release(entry.sessionId, id);
		} catch {
			/* renderer already gone */
		}
	}
}
