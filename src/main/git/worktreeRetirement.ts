/** Main-owned admission fence for managed local worktree retirement.
 * Callers must hold an admission from before their first await until work settles.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
	foldPathCase,
	isPathWithin,
	realpathThroughAncestor,
} from '../utils/real-path-containment';

export interface ManagedCheckout {
	/** Verified checkout root; Git ownership must be verified by the caller. */
	path: string;
	head: string;
	generation: number;
}

export type RetirementState = 'available' | 'preparing' | 'removing' | 'removed';
export type RetirementToken = object;
export type Admission = { ok: true; release: () => void } | { ok: false; reason: string };
export type Preparation =
	| { ok: true; token: RetirementToken; expected: Readonly<ManagedCheckout> }
	| { ok: false; reason: string };

type Entry = { identity: ManagedCheckout; state: RetirementState; token?: RetirementToken };
type Hold = { paths: string[] | null };

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

export class WorktreeRetirement {
	private readonly entries = new Map<string, Entry>();
	private readonly holds = new Set<Hold>();
	private readonly unsupportedExecutions = new Set<string | null>();

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
		for (const [root, entry] of this.entries) {
			if (entry.state !== 'available' && (!roots || roots.some((p) => overlaps(p, root))))
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
					otherRoot !== root && other.state !== 'available' && overlaps(root, otherRoot)
			)
		)
			return { ok: false, reason: 'overlapping worktree is reserved' };
		if ([...this.holds].some((hold) => !hold.paths || hold.paths.some((p) => overlaps(p, root))))
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
