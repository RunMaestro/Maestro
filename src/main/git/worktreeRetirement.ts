/** Main-owned admission fence for managed local worktree retirement.
 * Callers must hold an admission from before their first await until work settles.
 */
import * as fs from 'fs';
import * as path from 'path';
import { canonicalJson } from '../../shared/canonicalJson';
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
	token?: RetirementToken;
	owner?: object;
};
type Hold = { paths: string[] | null };
type RetirementClient = { kind: 'primary' | 'secondary' | 'web'; renderer?: object };
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

	/** Persistence owns this source and its generation; no IPC input can replace it. */
	bindRegistrationSource(source: RetirementRegistrationSource): void {
		for (const entry of this.entries.values()) {
			if (entry.state === 'preparing' && entry.token) this.abort(entry.token);
		}
		this.registrationSource = source;
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
					// No await between releasing our own reads and acquiring the fence.
					current.release();
					if (initial?.ok) initial.release();
					return this.prepareForRenderer(checkout, renderer);
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
		if ([...this.entries.values()].some((e) => e.state === 'preparing' || e.state === 'removing'))
			return { ok: false, reason: 'worktree retirement is in progress' };
		const owner = Object.freeze({});
		const client: RetirementClient = { kind };
		this.clients.set(owner, client);
		const invalidate = () => {
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
		if (prepared.ok) this.owned(prepared.token)!.owner = owner;
		return prepared;
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
		return { ok: true, token, expected: Object.freeze({ ...entry.identity }) };
	}

	/** Commit begins removal; completion must be reported separately after the runner settles. */
	commit(token: RetirementToken): boolean {
		const entry = this.owned(token);
		if (!entry || entry.state !== 'preparing') return false;
		entry.state = 'removing';
		return true;
	}

	/** A failed or uncertain removal remains fenced for explicit reconciliation. */
	complete(token: RetirementToken): boolean {
		const entry = this.owned(token);
		if (!entry || entry.state !== 'removing') return false;
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

	private owned(token: RetirementToken): Entry | undefined {
		return [...this.entries.values()].find((entry) => entry.token === token);
	}
}

export const worktreeRetirement = new WorktreeRetirement();
