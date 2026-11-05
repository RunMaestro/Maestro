import { randomUUID } from 'crypto';
import type {
	RetirementPreparationResult,
	RetirementRendererCommand,
	RetirementRendererReply,
	RetirementRemovalResult,
} from '../../shared/worktreeRetirement';
import type { ManagedCheckout, RetirementToken, WorktreeRetirement } from './worktreeRetirement';
import {
	removeRetirementCheckout,
	verifyRetirementClean,
	verifyRetirementMerge,
} from './worktreeRetirementRemoval';

type RemovalResult = RetirementRemovalResult;

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
	private readonly receipts = new WeakMap<object, Map<string, RemovalResult>>();
	private readonly prepared = new Map<string, Prepared>();
	private readonly recoveries = new Map<
		string,
		{
			renderer: RetirementRenderer;
			documentRevision: number;
			wireId: string;
			revision?: number;
			invalidated: boolean;
			requested?: boolean;
			detach: () => void;
			operation?: Promise<RemovalResult>;
		}
	>();
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

	/** Desktop commit of an explicitly confirmed preparation. The
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
			return Promise.resolve(
				this.receipts.get(renderer)?.get(id) ?? {
					status: 'blocked',
					reason: 'unknown renderer preparation',
				}
			);
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
					if (!this.fence.ownsRendererDocument(entry.token, renderer))
						throw new Error('Original primary document lost; restart recovery required');
					await removeRetirementCheckout(current.expected);
					entry.diskRemoved = true;
				}
				if (!entry.diskRemoved) throw new Error('Removal outcome requires recovery');
				if (!settleWatchers) throw new Error('Watcher settlement unavailable');
				await settleWatchers(entry.expected);
				if (!this.fence.ownsRendererDocument(entry.token, renderer))
					throw new Error('Original primary document lost; restart recovery required');
				const reconciled = await this.reconcileRenderer(id, renderer);
				if (!reconciled.ok) throw new Error(reconciled.reason);
				await this.fence.settleRemoval(entry.token, () =>
					this.fence.ownsRendererDocument(entry.token, renderer)
				);
				if (!this.fence.ownsRendererDocument(entry.token, renderer))
					throw new Error('Original primary document lost; restart recovery required');
				if (!this.fence.complete(entry.token)) throw new Error('Removal settlement lost ownership');
				const receipts = this.receipts.get(renderer) ?? new Map<string, RemovalResult>();
				receipts.set(id, { status: 'removed' });
				if (receipts.size > 64) receipts.delete(receipts.keys().next().value!);
				this.receipts.set(renderer, receipts);
				this.release(id, entry);
				return { status: 'removed' };
			} catch (error) {
				const removing = this.fence.tokenState(entry.token) === 'removing';
				if (!removing) this.abort(id, renderer);
				if (removing && !this.fence.ownsRendererDocument(entry.token, renderer))
					return {
						status: 'pending',
						reason: 'Original primary document lost; restart recovery required',
						recovery: 'restart-required',
					};
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

	/** Completion of a RESTORED journal only. Observe absence, freeze a fresh
	 * primary document, and finish the original archive; never invoke Git removal.
	 * Failed attempts retain their matching renderer freeze for same-document retry.
	 */
	recover(id: string, renderer: RetirementRenderer): Promise<RemovalResult> {
		const previous = this.recoveries.get(id);
		if (previous?.operation)
			return previous.renderer.identity === renderer.identity
				? previous.operation
				: Promise.resolve({ status: 'blocked', reason: 'Recovery already running' });
		const claim = this.fence.claimRecoveredRemoval(id, renderer.identity);
		if (!claim.ok) return Promise.resolve({ status: 'blocked', reason: claim.reason });
		const owner = claim.expected.ownership!;
		let entry = previous;
		if (
			!entry ||
			entry.invalidated ||
			entry.renderer.identity !== renderer.identity ||
			entry.documentRevision !== claim.documentRevision
		) {
			previous?.detach();
			entry = {
				renderer,
				documentRevision: claim.documentRevision,
				wireId: randomUUID(),
				invalidated: false,
				detach: () => {},
			};
			const current = entry;
			entry.detach = renderer.onInvalidated(() => {
				current.invalidated = true;
			});
			this.recoveries.set(id, entry);
		}
		const current = entry;
		const assertCurrent = () => {
			if (!claim.isCurrent() || current.invalidated || this.recoveries.get(id) !== current)
				throw new Error('Recovery primary document changed');
		};
		const check = async () => {
			assertCurrent();
			const reply = await current.renderer.request({
				kind: 'check',
				sessionId: owner.sessionId,
				token: current.wireId,
				revision: current.revision!,
			});
			assertCurrent();
			if (!reply.ok || reply.token !== current.wireId || reply.revision !== current.revision)
				throw new Error('Recovery renderer revision changed');
		};
		const operation = async (): Promise<RemovalResult> => {
			try {
				assertCurrent();
				const outcome = await claim.inspect();
				assertCurrent();
				if (outcome.state !== 'removed')
					throw new Error(
						outcome.state === 'present'
							? 'Checkout still present; cancel before new preparation'
							: outcome.reason
					);
				if (current.revision === undefined) {
					// Store the wire identity even if the reply is lost. The renderer
					// accepts an idempotent repeat of this exact recovery preparation.
					current.requested = true;
					const reply = await current.renderer.request({
						kind: 'recover',
						request: {
							sessionId: owner.sessionId,
							parentSessionId: owner.parentSessionId,
							path: claim.expected.path,
							parentPath: owner.parentPath,
							token: current.wireId,
						},
					});
					assertCurrent();
					if (!reply.ok) throw new Error(reply.reason);
					if (
						reply.token !== current.wireId ||
						!Number.isSafeInteger(reply.revision) ||
						reply.revision < 1
					)
						throw new Error('Recovery renderer identity mismatch');
					current.revision = reply.revision;
				}
				await check();
				if (!this.settleDiscovery) throw new Error('Watcher settlement unavailable');
				await this.settleDiscovery(claim.expected);
				await check();
				const reconciled = await this.fence.reconcileRecoveredRemoval(id);
				if (!reconciled.ok) throw new Error(reconciled.reason);
				await check();
				const reply = await current.renderer.request({
					kind: 'complete',
					sessionId: owner.sessionId,
					token: current.wireId,
					revision: current.revision!,
				});
				assertCurrent();
				if (!reply.ok || reply.token !== current.wireId || reply.revision !== current.revision)
					throw new Error('Recovery renderer completion pending');
				await this.fence.settleRemoval(
					claim.token,
					() => claim.isCurrent() && !current.invalidated
				);
				assertCurrent();
				if (!this.fence.complete(claim.token))
					throw new Error('Recovery settlement lost ownership');
				this.recoveries.delete(id);
				current.detach();
				try {
					current.renderer.release(owner.sessionId, current.wireId);
				} catch {
					/* owner gone */
				}
				return { status: 'removed' };
			} catch (error) {
				return {
					status: 'pending',
					reason: error instanceof Error ? error.message : 'Recovery pending',
				};
			} finally {
				claim.release();
				// A present/uncertain disk result never contacted or froze a renderer.
				if (!current.requested && this.recoveries.get(id) === current) {
					this.recoveries.delete(id);
					current.detach();
				}
			}
		};
		current.operation = operation().finally(() => {
			delete current.operation;
		});
		return current.operation;
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
			this.fence.tokenState(entry.token) !== 'removing' ||
			!this.fence.ownsRendererDocument(entry.token, renderer)
		)
			return { ok: false as const, reason: 'owned removal required' };
		const persisted = await this.fence.reconcileRemovedRegistration(entry.token);
		if (!persisted.ok) return persisted;
		if (!this.fence.ownsRendererDocument(entry.token, renderer))
			return {
				ok: false as const,
				reason: 'Original primary document lost; restart recovery required',
			};
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
				this.prepared.get(id) !== entry ||
				!this.fence.ownsRendererDocument(entry.token, renderer)
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
