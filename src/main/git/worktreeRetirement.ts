/** Main-owned admission fence for managed local worktree retirement.
 * Callers must hold an admission from before their first await until work settles.
 */
import * as fs from 'fs';
import * as path from 'path';
import { canonicalJson } from '../../shared/canonicalJson';
import { generateUUID } from '../../shared/uuid';
import type { StoredSession, StoredRetiredWorktree } from '../stores/types';
import {
	foldPathCase,
	isPathWithin,
	realpathThroughAncestor,
} from '../utils/real-path-containment';
import {
	retirementRegistrationPair,
	verifyRetirementOwnership,
	type CheckoutOwnership,
	type RetirementRegistrationSource,
} from './worktreeRetirementOwnership';
import {
	inspectRetirementOutcome,
	readRetirementIntents,
	type RetirementIntent,
} from './worktreeRetirementRecovery';

export interface ManagedCheckout {
	/** Verified checkout root; Git ownership must be verified by the caller. */
	path: string;
	head: string;
	generation: number;
	ownership?: Readonly<CheckoutOwnership>;
}

export type RetirementState = 'available' | 'preparing' | 'removing' | 'removed';
export type RetirementToken = object;
export type Admission = { ok: true; release: () => void } | { ok: false; reason: string };
export type Preparation =
	| { ok: true; token: RetirementToken; expected: Readonly<ManagedCheckout> }
	| { ok: false; reason: string };

type Entry = {
	identity: ManagedCheckout;
	state: RetirementState;
	discoveryEpoch?: number;
	token?: RetirementToken;
	owner?: object;
	ownerRevision?: number;
	intent?: RetirementIntent;
	recovered?: boolean;
	recoveryClaim?: object;
	registration?: {
		source: RetirementRegistrationSource;
		child: StoredSession;
		parent: StoredSession;
		record?: StoredRetiredWorktree;
		reconciled?: boolean;
	};
};
type Hold = { paths: string[] | null };
type RetirementClient = {
	kind: 'primary' | 'secondary' | 'web';
	renderer?: object;
	revision: number;
};
type ClientAdmission =
	| { ok: false; reason: string }
	| {
			ok: true;
			release: () => void;
			invalidate: () => void;
			loaded: (renderer: object) => void;
	  };

/** Only filesystem creation endpoints may resolve through genuinely missing entries. */
function canonical(p: string, allowMissing = false): string | null {
	if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
	try {
		return foldPathCase(
			allowMissing ? realpathThroughAncestor(p, { strict: true }) : fs.realpathSync.native(p)
		);
	} catch {
		return null;
	}
}

function overlaps(a: string, b: string): boolean {
	return isPathWithin(a, b) || isPathWithin(b, a);
}

/** Removal runs from the surviving parent and changes its Git administration. */
function ownershipPaths(checkout: ManagedCheckout, state: RetirementState = 'preparing'): string[] {
	return checkout.ownership && state !== 'removed'
		? [checkout.path, checkout.ownership.parentPath]
		: [checkout.path];
}

export class WorktreeRetirement {
	private readonly entries = new Map<string, Entry>();
	private readonly holds = new Set<Hold>();
	private readonly unsupportedExecutions = new Set<string | null>();
	private readonly clients = new Map<object, RetirementClient>();
	private registrationSource?: RetirementRegistrationSource;

	/** Synchronous startup barrier, before any process/client/writer is created.
	 * Restored tokens are new Main capabilities; old wire ids cannot own them.
	 */
	restoreRetirements(value: unknown): void {
		if (this.clients.size || this.holds.size || this.entries.size)
			throw new Error('Retirement recovery must precede admissions');
		for (const intent of readRetirementIntents(value)) {
			if (intent.phase === 'cancelled') continue;
			this.entries.set(foldPathCase(intent.checkout.path), {
				identity: intent.checkout,
				state: intent.phase === 'settled' ? 'removed' : 'removing',
				token: Object.freeze({}),
				intent,
				recovered: true,
			});
		}
	}

	/** Internal recovery control plane. No destructive authority or token is exposed. */
	pendingRecoveries() {
		return [...this.entries.values()]
			.filter((e) => e.recovered && e.state === 'removing')
			.map((e) => ({
				id: e.intent!.archive.id,
				sessionId: e.intent!.archive.session.id,
				path: e.identity.path,
			}));
	}

	/** Observe disk first, then reuse the original archive id and saved snapshots.
	 * This deliberately retains the fence for watcher/renderer settlement.
	 */
	async reconcileRecoveredRemoval(id: string) {
		const entry = [...this.entries.values()].find(
			(e) => e.recovered && e.intent?.archive.id === id
		);
		if (!entry?.token || entry.state !== 'removing')
			return { ok: false as const, reason: 'Pending recovery required' };
		const outcome = await inspectRetirementOutcome(entry.intent!);
		if (outcome.state !== 'removed')
			return {
				ok: false as const,
				reason:
					outcome.state === 'present'
						? 'Checkout still present; new explicit preparation required'
						: outcome.reason,
			};
		return this.reconcileRemovedRegistration(entry.token);
	}

	/** Internal capability for one recovery runner and one loaded document. A claim
	 * serializes completion against cancellation without ever releasing the fence.
	 */
	claimRecoveredRemoval(id: string, renderer: object) {
		const entry = [...this.entries.values()].find(
			(e) => e.recovered && e.intent?.archive.id === id
		);
		const client = [...this.clients.values()][0];
		const source = entry?.registration?.source;
		if (
			!entry?.intent ||
			!entry.token ||
			entry.state !== 'removing' ||
			entry.recoveryClaim ||
			!source ||
			source !== this.registrationSource ||
			this.clients.size !== 1 ||
			client?.kind !== 'primary' ||
			client.renderer !== renderer
		)
			return {
				ok: false as const,
				reason: 'Loaded primary and unclaimed pending recovery required',
			};
		const claim = Object.freeze({});
		const revision = client.revision;
		entry.recoveryClaim = claim;
		return {
			ok: true as const,
			token: entry.token,
			expected: entry.identity,
			documentRevision: revision,
			inspect: () => inspectRetirementOutcome(entry.intent!),
			isCurrent: () =>
				this.owned(entry.token!) === entry &&
				entry.state === 'removing' &&
				entry.recoveryClaim === claim &&
				this.registrationSource === source &&
				this.clients.size === 1 &&
				[...this.clients.values()][0] === client &&
				client.renderer === renderer &&
				client.revision === revision,
			release: () => {
				if (entry.recoveryClaim === claim) delete entry.recoveryClaim;
			},
		};
	}

	/** Cancel only a restored, fully present checkout. Never retry Git removal or
	 * transfer its token to a new preparation. The original fence survives failed
	 * durability, changed ownership, reloads and concurrent recovery requests.
	 */
	async cancelRecoveredRemoval(id: string, renderer: object) {
		const entry = [...this.entries.values()].find(
			(e) => e.recovered && e.intent?.archive.id === id
		);
		const token = entry?.token;
		const source = entry?.registration?.source;
		const client = [...this.clients.values()][0];
		if (
			!entry?.intent ||
			!token ||
			entry.state !== 'removing' ||
			entry.recoveryClaim ||
			entry.registration?.reconciled ||
			!source?.writeRetirementIntent ||
			source !== this.registrationSource ||
			this.clients.size !== 1 ||
			client?.kind !== 'primary' ||
			client.renderer !== renderer
		)
			return { ok: false as const, reason: 'Loaded primary and pending recovery required' };
		const revision = client.revision;
		const isCurrent = () =>
			this.owned(token) === entry &&
			entry.state === 'removing' &&
			!entry.registration?.reconciled &&
			!entry.recoveryClaim &&
			this.registrationSource === source &&
			this.clients.size === 1 &&
			[...this.clients.values()][0] === client &&
			client.renderer === renderer &&
			client.revision === revision;
		try {
			return await source.enqueue(async () => {
				if (!isCurrent()) throw new Error('Recovery cancellation owner changed');
				const generation = source.generation();
				const { child, parent } = retirementRegistrationPair(
					source.read(),
					entry.intent!.archive.session.id
				);
				if (
					canonicalJson(child) !== canonicalJson(entry.intent!.archive.session) ||
					canonicalJson(parent) !== canonicalJson(entry.intent!.parent)
				)
					throw new Error('Recovery cancellation registration changed');
				const outcome = await inspectRetirementOutcome(entry.intent!);
				if (outcome.state !== 'present')
					throw new Error('Only a fully present checkout can cancel recovery');
				// Registry presence alone cannot rule out a replaced child/gitfile.
				const current = await verifyRetirementOwnership(
					source.read(),
					entry.intent!.archive.session.id,
					generation
				);
				if (
					!isCurrent() ||
					source.generation() !== generation ||
					canonicalJson(current) !== canonicalJson({ ...entry.identity, generation })
				)
					throw new Error('Recovery cancellation ownership changed');
				await source.writeRetirementIntent!({ ...entry.intent!, phase: 'cancelled' });
				if (!isCurrent() || source.generation() !== generation)
					throw new Error('Recovery cancellation changed during persistence');
				// No await between durable acknowledgement and releasing this token.
				this.entries.delete(foldPathCase(entry.identity.path));
				return { ok: true as const };
			});
		} catch (error) {
			return {
				ok: false as const,
				reason: error instanceof Error ? error.message : 'Recovery cancellation pending',
			};
		}
	}

	/** Persistence owns this source and its generation; no IPC input can replace it. */
	bindRegistrationSource(source: RetirementRegistrationSource): void {
		for (const entry of this.entries.values()) {
			if (entry.state === 'preparing' && entry.token) this.abort(entry.token);
		}
		this.registrationSource = source;
		for (const entry of this.entries.values()) {
			if (entry.recovered && entry.intent && !entry.registration) {
				entry.registration = {
					source,
					child: entry.intent.archive.session,
					parent: entry.intent.parent,
					record: entry.intent.archive,
				};
			}
		}
	}

	/** Resolve only an id against Main's current store. Hold admission BEFORE the
	 * lane's first microtask, then verify Git and reserve without an async gap.
	 * This is not yet permission to remove: renderer freeze and PR merge proof
	 * are still required by the eventual cleanup transaction.
	 */
	async prepareRegisteredForRenderer(sessionId: string, renderer: object): Promise<Preparation> {
		const source = this.registrationSource;
		if (!source) return { ok: false, reason: 'registration source unavailable' };
		let initial: Admission | undefined;
		try {
			const { child, parent } = retirementRegistrationPair(source.read(), sessionId);
			initial = this.admit([child.cwd, parent.cwd]);
			if (!initial.ok) return initial;
			return await source.enqueue(async () => {
				const sessions = source.read();
				const { child: currentChild, parent: currentParent } = retirementRegistrationPair(
					sessions,
					sessionId
				);
				const current = this.admit([currentChild.cwd, currentParent.cwd]);
				if (!current.ok) return current;
				try {
					const generation = source.generation();
					const checkout = await verifyRetirementOwnership(sessions, sessionId, generation);
					if (this.registrationSource !== source || source.generation() !== generation)
						return { ok: false, reason: 'registration changed during verification' };
					if (!this.register(checkout))
						return { ok: false, reason: 'checkout ownership is already reserved' };
					const registration = {
						source,
						child: JSON.parse(canonicalJson(currentChild)) as StoredSession,
						parent: JSON.parse(canonicalJson(currentParent)) as StoredSession,
					};
					// No await between releasing our own reads and acquiring the fence.
					current.release();
					if (initial?.ok) initial.release();
					const prepared = this.prepareForRenderer(checkout, renderer);
					if (prepared.ok) {
						this.owned(prepared.token)!.registration = registration;
					}
					return prepared;
				} finally {
					current.release();
				}
			});
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : 'ownership unavailable',
			};
		} finally {
			if (initial?.ok) initial.release();
		}
	}

	/** Save the frozen primary's latest idle chats before it can acknowledge preparation.
	 * Ordinary persistence stays fenced; this capability cannot move registrations.
	 */
	async persistPreparedRegistration(token: RetirementToken, snapshots: unknown) {
		const entry = this.owned(token);
		const registration = entry?.registration;
		const source = registration?.source;
		if (
			!entry ||
			entry.state !== 'preparing' ||
			!registration ||
			!source?.persistPrepared ||
			source !== this.registrationSource
		)
			return { ok: false as const, reason: 'trusted preparing registration required' };
		const isCurrent = () =>
			this.owned(token) === entry &&
			entry.state === 'preparing' &&
			this.registrationSource === source;
		try {
			// Clone at entry; no caller may mutate a queued payload after validation.
			const updates = JSON.parse(canonicalJson(snapshots)) as StoredSession[];
			if (!Array.isArray(updates) || updates.length !== 2)
				throw new Error('Frozen child and parent snapshots required');
			for (const saved of [registration.child, registration.parent]) {
				const matches = updates.filter((s) => s && s.id === saved.id);
				if (matches.length !== 1) throw new Error('Frozen snapshot identity mismatch');
				for (const key of [
					'id',
					'cwd',
					'projectRoot',
					'fullPath',
					'parentSessionId',
					'worktreeBranch',
					'sshRemoteId',
					'sessionSshRemoteConfig',
					'toolType',
				])
					if (canonicalJson(matches[0][key] ?? null) !== canonicalJson(saved[key] ?? null))
						throw new Error('Frozen snapshot cannot change checkout identity');
			}
			return await source.enqueue(async () => {
				if (!isCurrent() || source.generation() !== entry.identity.generation)
					return { ok: false as const, reason: 'preparation changed before persistence' };
				await source.persistPrepared!(updates, isCurrent);
				if (!isCurrent())
					return { ok: false as const, reason: 'preparation lost during persistence' };
				const pair = retirementRegistrationPair(source.read(), registration.child.id);
				registration.child = JSON.parse(canonicalJson(pair.child)) as StoredSession;
				registration.parent = JSON.parse(canonicalJson(pair.parent)) as StoredSession;
				entry.identity.generation = source.generation();
				return { ok: true as const, expected: Object.freeze({ ...entry.identity }) };
			});
		} catch (error) {
			return {
				ok: false as const,
				reason: error instanceof Error ? error.message : 'snapshot persistence failed',
			};
		}
	}

	/** Recheck under the still-held fence immediately before the eventual commit.
	 * A failed check leaves preparation owned by its caller, who must abort it.
	 */
	async revalidateRegistered(
		token: RetirementToken
	): Promise<{ ok: true } | { ok: false; reason: string }> {
		const entry = this.owned(token);
		const source = this.registrationSource;
		if (!entry || entry.state !== 'preparing' || !entry.identity.ownership || !source)
			return { ok: false, reason: 'trusted prepared ownership required' };
		try {
			return await source.enqueue(async () => {
				if (source.generation() !== entry.identity.generation)
					return { ok: false, reason: 'registration generation changed' };
				const verified = await verifyRetirementOwnership(
					source.read(),
					entry.identity.ownership!.sessionId,
					entry.identity.generation
				);
				if (
					this.registrationSource !== source ||
					this.owned(token) !== entry ||
					entry.state !== 'preparing' ||
					source.generation() !== entry.identity.generation ||
					canonicalJson(verified) !== canonicalJson(entry.identity)
				)
					return { ok: false, reason: 'prepared checkout ownership changed' };
				return { ok: true };
			});
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : 'ownership unavailable',
			};
		}
	}

	/** Admit before constructing a window or exposing a socket to any callback.
	 * A client's lifetime ends on closed, never on an error or close request.
	 */
	admitClient(kind: RetirementClient['kind']): ClientAdmission {
		// A fresh primary may display recovery after restart. Target writes remain
		// fenced; secondary windows and web clients still cannot enter.
		const recoveryPrimary =
			kind === 'primary' &&
			this.clients.size === 0 &&
			[...this.entries.values()].every(
				(e) => e.state === 'removed' || (e.recovered && e.state === 'removing')
			);
		if (
			!recoveryPrimary &&
			[...this.entries.values()].some((e) => e.state === 'preparing' || e.state === 'removing')
		)
			return { ok: false, reason: 'worktree retirement is in progress' };
		const owner = Object.freeze({});
		const client: RetirementClient = { kind, revision: 0 };
		this.clients.set(owner, client);
		const invalidate = () => {
			client.revision++;
			delete client.renderer;
			for (const entry of this.entries.values()) {
				if (entry.owner === owner && entry.state === 'preparing' && entry.token)
					this.abort(entry.token);
			}
		};
		return {
			ok: true,
			invalidate,
			loaded: (renderer) => {
				if (!this.clients.has(owner) || kind !== 'primary') return;
				if (client.renderer !== renderer) invalidate();
				client.renderer = renderer;
			},
			release: () => {
				invalidate();
				this.clients.delete(owner);
			},
		};
	}

	/** Main passes the actual IPC sender, never a renderer-supplied window id.
	 * Loading alone is not a freeze acknowledgement; the caller must still obtain
	 * the token/revision-bound authoritative renderer preparation before commit.
	 */
	prepareForRenderer(checkout: ManagedCheckout, renderer: object): Preparation {
		const [[owner, client] = []] = this.clients;
		if (this.clients.size !== 1 || client?.kind !== 'primary' || client.renderer !== renderer)
			return {
				ok: false,
				reason: 'one loaded primary renderer required; additional clients unsupported',
			};
		const prepared = this.reserve(checkout);
		if (prepared.ok) {
			const entry = this.owned(prepared.token)!;
			entry.owner = owner;
			entry.ownerRevision = client.revision;
		}
		return prepared;
	}

	/** Removal retains the ORIGINAL primary document; a reload cannot adopt its
	 * live runner. Restart recovery uses the durable journal after it has settled.
	 */
	ownsRendererDocument(token: RetirementToken, renderer: object): boolean {
		const entry = this.owned(token);
		const client = entry?.owner && this.clients.get(entry.owner);
		return !!(
			entry &&
			client &&
			this.clients.size === 1 &&
			client.kind === 'primary' &&
			client.renderer === renderer &&
			client.revision === entry.ownerRevision
		);
	}

	/**
	 * Native transports have no concrete child/PTY completion guarantee here.
	 * A synthetic exit or removal from a session map cannot prove quiescence.
	 * Keep that checkout outside the supported CLI-only path for this Main lifetime,
	 * including after re-registration or fallback to CLI. Never clear on kill().
	 */
	excludeUnsupportedExecution(checkoutPath: string): void {
		this.unsupportedExecutions.add(canonical(checkoutPath));
	}

	/** Populate only from trusted, verified managed registrations, never renderer input. */
	register(checkout: ManagedCheckout): boolean {
		const root = canonical(checkout.path);
		if (
			!root ||
			!checkout.head ||
			!Number.isSafeInteger(checkout.generation) ||
			checkout.generation < 0
		)
			return false;
		const existing = this.entries.get(root);
		if (existing && existing.state !== 'available') return false;
		this.entries.set(root, { identity: { ...checkout, path: root }, state: 'available' });
		return true;
	}

	/** Discovery is read-only, but its late result can recreate a retired owner.
	 * Capture before awaits and recheck before probing/emitting/returning. Keep an
	 * epoch across abort so work begun before a transient reservation stays stale.
	 * Watcher roots may be ancestors of the checkout; existing parent watching
	 * remains useful, while individual candidate/group events include ancestors.
	 */
	captureDiscovery(
		checkoutPath: string,
		options: {
			includeAncestors?: boolean;
			watcherSessionId?: string;
			allowRemovedDescendants?: boolean;
		} = {}
	): () => boolean {
		const root = canonical(checkoutPath, true);
		const relevant = () =>
			[...this.entries.values()].filter(
				(entry) =>
					!(
						options.allowRemovedDescendants &&
						root &&
						entry.state === 'removed' &&
						root !== entry.identity.path &&
						isPathWithin(entry.identity.path, root)
					) &&
					((options.watcherSessionId !== undefined &&
						entry.identity.ownership?.sessionId === options.watcherSessionId) ||
						!root ||
						(options.includeAncestors !== false
							? overlaps(root, entry.identity.path)
							: isPathWithin(root, entry.identity.path)))
			);
		const initial = relevant().map((entry) => ({ entry, epoch: entry.discoveryEpoch }));
		const allowed = initial.every(({ entry }) => entry.state === 'available');
		return () => {
			if (!allowed || canonical(checkoutPath, true) !== root) return false;
			const current = relevant();
			return (
				current.length === initial.length &&
				current.every(
					(entry, index) =>
						entry === initial[index].entry &&
						entry.discoveryEpoch === initial[index].epoch &&
						entry.state === 'available'
				)
			);
		};
	}

	/** Unknown paths acquire a global hold; while reserved they fail closed. */
	admit(paths: readonly string[] | null, options: { allowMissing?: boolean } = {}): Admission {
		const resolved = paths?.length ? paths.map((p) => canonical(p, options.allowMissing)) : null;
		const roots = resolved && resolved.every((p): p is string => p !== null) ? resolved : null;
		for (const entry of this.entries.values()) {
			if (
				entry.state !== 'available' &&
				(!roots ||
					roots.some((p) =>
						ownershipPaths(entry.identity, entry.state).some((root) => overlaps(p, root))
					))
			)
				return { ok: false, reason: `worktree is ${entry.state}` };
		}
		const hold: Hold = { paths: roots };
		this.holds.add(hold);
		return {
			ok: true,
			release: () => {
				this.holds.delete(hold);
			},
		};
	}

	/** Hold local filesystem endpoints before any async work, through settlement.
	 * An empty list means the operation has no local endpoints (remote-only I/O).
	 */
	async runFilesystemMutation<T>(
		paths: readonly string[],
		operation: () => Promise<T>
	): Promise<T> {
		if (paths.length === 0) return operation();
		const endpoints = paths.flatMap((p) => {
			try {
				// Renaming/deleting a symlink changes its directory entry as well as
				// potentially accessing its target. Preserve both ownership scopes.
				return fs.lstatSync(p).isSymbolicLink() ? [p, path.dirname(p)] : [p];
			} catch {
				// Missing entries are resolved through a verified ancestor below;
				// inaccessible paths and unresolved symlinks still fail closed.
				return [p];
			}
		});
		const admission = this.admit(endpoints, { allowMissing: true });
		if (!admission.ok) throw new Error(`Worktree retirement: ${admission.reason}`);
		try {
			return await operation();
		} finally {
			admission.release();
		}
	}

	prepare(checkout: ManagedCheckout): Preparation {
		if (this.clients.size > 0) return { ok: false, reason: 'primary renderer ownership required' };
		return this.reserve(checkout);
	}

	private reserve(checkout: ManagedCheckout): Preparation {
		const root = canonical(checkout.path);
		const entry = root && this.entries.get(root);
		if (!root || !entry) return { ok: false, reason: 'unknown managed checkout' };
		if (entry.state !== 'available') return { ok: false, reason: `worktree is ${entry.state}` };
		if (entry.identity.head !== checkout.head || entry.identity.generation !== checkout.generation)
			return { ok: false, reason: 'checkout identity changed' };
		if (
			[...this.unsupportedExecutions].some(
				(unsupported) => !unsupported || overlaps(root, unsupported)
			)
		)
			return { ok: false, reason: 'unsupported native execution: CLI-only retirement unavailable' };
		if (
			[...this.entries].some(
				([otherRoot, other]) =>
					otherRoot !== root &&
					other.state !== 'available' &&
					ownershipPaths(entry.identity).some((scope) =>
						ownershipPaths(other.identity, other.state).some((otherScope) =>
							overlaps(scope, otherScope)
						)
					)
			)
		)
			return { ok: false, reason: 'overlapping worktree is reserved' };
		if (
			[...this.holds].some(
				(hold) =>
					!hold.paths ||
					hold.paths.some((p) => ownershipPaths(entry.identity).some((scope) => overlaps(p, scope)))
			)
		)
			return { ok: false, reason: 'worktree has admitted work' };
		const token = Object.freeze({});
		entry.token = token;
		entry.state = 'preparing';
		entry.discoveryEpoch = (entry.discoveryEpoch ?? 0) + 1;
		return { ok: true, token, expected: Object.freeze({ ...entry.identity }) };
	}

	/** Commit begins removal; completion must be reported separately after the runner settles. */
	commit(token: RetirementToken): boolean {
		const entry = this.owned(token);
		if (!entry || entry.state !== 'preparing') return false;
		entry.state = 'removing';
		return true;
	}

	/** Transition BEFORE the first await so owner loss cannot unlock a journal
	 * write that might reach disk. Git must not run until this durable ACK.
	 */
	async beginRemoval(token: RetirementToken): Promise<void> {
		const entry = this.owned(token);
		const registration = entry?.registration;
		if (
			!entry ||
			!registration ||
			!entry.identity.ownership ||
			registration.source !== this.registrationSource ||
			!registration.source.writeRetirementIntent ||
			!this.commit(token)
		)
			throw new Error('Durable retirement ownership required');
		const owner = entry.identity.ownership;
		registration.record ??= {
			id: generateUUID(),
			retiredAt: Date.now(),
			path: entry.identity.path,
			head: entry.identity.head,
			parentSessionId: owner.parentSessionId,
			parentPath: owner.parentPath,
			branch: owner.branch,
			session: registration.child,
		};
		entry.intent = {
			version: 1,
			phase: 'removing',
			checkout: entry.identity,
			archive: registration.record,
			parent: registration.parent,
		};
		const source = registration.source;
		await source.enqueue(async () => {
			if (
				this.registrationSource !== source ||
				this.owned(token) !== entry ||
				entry.state !== 'removing' ||
				source.generation() !== entry.identity.generation
			)
				throw new Error('Retirement ownership changed before intent persistence');
			await source.writeRetirementIntent!(entry.intent!);
			if (
				this.registrationSource !== source ||
				this.owned(token) !== entry ||
				entry.state !== 'removing'
			)
				throw new Error('Retirement ownership changed during intent persistence');
		});
	}

	/** Only after disk, watchers, archive and renderer have settled. Persist the
	 * completed tombstone before releasing the surviving parent's fence.
	 */
	async settleRemoval(token: RetirementToken, isCurrent = () => true): Promise<void> {
		const entry = this.owned(token);
		const source = entry?.registration?.source;
		if (
			!entry?.intent ||
			entry.state !== 'removing' ||
			!entry.registration?.reconciled ||
			!source?.writeRetirementIntent ||
			source !== this.registrationSource
		)
			throw new Error('Owned reconciled retirement required');
		await source.enqueue(async () => {
			if (!isCurrent() || this.owned(token) !== entry || source !== this.registrationSource)
				throw new Error('Retirement settlement source changed');
			await source.writeRetirementIntent!({ ...entry.intent!, phase: 'settled' });
			if (!isCurrent() || this.owned(token) !== entry || source !== this.registrationSource)
				throw new Error('Retirement settlement source changed during persistence');
			entry.intent = { ...entry.intent!, phase: 'settled' };
		});
	}

	/** Called only after checked Git removal settles. Never releases the fence:
	 * durable persistence and renderer/watcher reconciliation must finish first.
	 * An uncertain write/callback can be retried with the SAME token and archive id.
	 */
	async reconcileRemovedRegistration(
		token: RetirementToken
	): Promise<{ ok: true } | { ok: false; reason: string }> {
		const entry = this.owned(token);
		const registration = entry?.registration;
		if (
			!entry ||
			entry.state !== 'removing' ||
			!registration ||
			registration.source !== this.registrationSource ||
			!registration.source.reconcileRetired
		)
			return { ok: false, reason: 'trusted removing registration required' };
		const source = registration.source;
		const ownership = entry.identity.ownership!;
		registration.record ??= {
			id: generateUUID(),
			retiredAt: Date.now(),
			path: entry.identity.path,
			head: entry.identity.head,
			parentSessionId: ownership.parentSessionId,
			parentPath: ownership.parentPath,
			branch: ownership.branch,
			session: registration.child,
		};
		try {
			return await source.enqueue(async () => {
				if (
					this.owned(token) !== entry ||
					entry.state !== 'removing' ||
					this.registrationSource !== source
				)
					return { ok: false, reason: 'removal registration source changed' };
				if (!registration.reconciled) {
					await source.reconcileRetired!(registration.record!, registration.parent);
					if (
						this.registrationSource !== source ||
						this.owned(token) !== entry ||
						entry.state !== 'removing'
					)
						return { ok: false, reason: 'removal registration source changed during persistence' };
					registration.reconciled = true;
				}
				return { ok: true };
			});
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : 'persistence pending' };
		}
	}

	/** A failed or uncertain removal remains fenced for explicit reconciliation. */
	complete(token: RetirementToken): boolean {
		const entry = this.owned(token);
		if (!entry || entry.state !== 'removing' || (entry.intent && entry.intent.phase !== 'settled'))
			return false;
		entry.state = 'removed';
		return true;
	}

	abort(token: RetirementToken): boolean {
		const entry = this.owned(token);
		if (!entry || entry.state !== 'preparing') return false;
		entry.state = 'available';
		delete entry.token;
		delete entry.owner;
		return true;
	}

	state(checkoutPath: string): RetirementState | undefined {
		const root = canonical(checkoutPath) ?? foldPathCase(path.resolve(checkoutPath));
		return this.entries.get(root)?.state;
	}

	/** Token lifetime is independent of a later reservation on the same path. */
	tokenState(token: RetirementToken): RetirementState | undefined {
		return this.owned(token)?.state;
	}

	private owned(token: RetirementToken): Entry | undefined {
		return [...this.entries.values()].find((entry) => entry.token === token);
	}
}

export const worktreeRetirement = new WorktreeRetirement();
