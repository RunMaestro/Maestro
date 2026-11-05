/** Durable recovery never repeats a destructive Git command. */
import * as fs from 'fs';
import * as path from 'path';
import type { StoredRetiredWorktree, StoredSession } from '../stores/types';
import type { ManagedCheckout } from './worktreeRetirement';
import { canonicalJson } from '../../shared/canonicalJson';
import { foldPathCase, isPathWithin } from '../utils/real-path-containment';
import { execGitReadOnly } from '../utils/remote-git';

export interface RetirementIntent {
	version: 1;
	phase: 'removing' | 'settled' | 'cancelled';
	checkout: ManagedCheckout;
	archive: StoredRetiredWorktree;
	parent: StoredSession;
}

/** Store data can be malformed. Never silently drop a pending safety fence. */
export function readRetirementIntents(value: unknown): RetirementIntent[] {
	if (!Array.isArray(value)) throw new Error('Invalid retirement recovery journal');
	const intents = JSON.parse(canonicalJson(value)) as RetirementIntent[];
	const ids = new Set<string>();
	const paths = new Set<string>();
	for (const intent of intents) {
		const checkout = intent?.checkout;
		const owner = checkout?.ownership;
		const archive = intent?.archive;
		const parent = intent?.parent;
		if (
			intent?.version !== 1 ||
			!['removing', 'settled', 'cancelled'].includes(intent.phase) ||
			!owner ||
			!archive?.session ||
			!parent ||
			![
				checkout.path,
				owner.parentPath,
				owner.commonDir,
				owner.gitDir,
				archive.session.cwd,
				parent.cwd,
			].every((p) => typeof p === 'string' && path.isAbsolute(p)) ||
			!Number.isSafeInteger(checkout.generation) ||
			checkout.generation < 0 ||
			!Number.isFinite(archive.retiredAt) ||
			typeof checkout.head !== 'string' ||
			!/^[a-f\d]{40,64}$/i.test(checkout.head) ||
			typeof archive.id !== 'string' ||
			!archive.id ||
			ids.has(archive.id) ||
			(intent.phase !== 'cancelled' && paths.has(foldPathCase(checkout.path))) ||
			typeof owner.sessionId !== 'string' ||
			!owner.sessionId ||
			typeof owner.parentSessionId !== 'string' ||
			!owner.parentSessionId ||
			owner.sessionId === owner.parentSessionId ||
			typeof owner.branch !== 'string' ||
			!owner.branch ||
			archive.branch !== owner.branch ||
			archive.path !== checkout.path ||
			archive.head !== checkout.head ||
			archive.parentSessionId !== owner.parentSessionId ||
			archive.parentPath !== owner.parentPath ||
			archive.session.id !== owner.sessionId ||
			archive.session.parentSessionId !== parent.id ||
			archive.session.worktreeBranch !== owner.branch ||
			parent.id !== owner.parentSessionId ||
			parent.parentSessionId ||
			parent.sshRemoteId ||
			parent.sessionSshRemoteConfig?.enabled ||
			archive.session.sshRemoteId ||
			archive.session.sessionSshRemoteConfig?.enabled ||
			isPathWithin(foldPathCase(checkout.path), foldPathCase(owner.parentPath)) ||
			isPathWithin(foldPathCase(owner.parentPath), foldPathCase(checkout.path)) ||
			!isPathWithin(
				foldPathCase(owner.gitDir),
				foldPathCase(path.join(owner.commonDir, 'worktrees'))
			) ||
			foldPathCase(owner.gitDir) === foldPathCase(path.join(owner.commonDir, 'worktrees'))
		)
			throw new Error('Invalid retirement recovery identity');
		ids.add(archive.id);
		if (intent.phase !== 'cancelled') paths.add(foldPathCase(checkout.path));
	}
	return intents;
}

export type RetirementDiskOutcome =
	| { state: 'removed' }
	| { state: 'present' }
	| { state: 'uncertain'; reason: string };

/** Absence alone is insufficient: the surviving primary's Git administration
 * must agree. A partial removal, replaced parent, or unreadable endpoint stays
 * fenced. Even a fully present checkout requires a NEW preparation to delete.
 */
export async function inspectRetirementOutcome(
	intent: RetirementIntent
): Promise<RetirementDiskOutcome> {
	try {
		readRetirementIntents([intent]);
		const { checkout } = intent;
		const owner = checkout.ownership!;
		const samePhysical = (a: string, b: string) =>
			foldPathCase(fs.realpathSync.native(a)) === foldPathCase(b);
		if (
			!samePhysical(owner.parentPath, owner.parentPath) ||
			!samePhysical(owner.commonDir, owner.commonDir)
		)
			throw new Error('Recovery parent or Git directory changed');
		const git = async (args: string[]) => {
			const result = await execGitReadOnly(args, owner.parentPath);
			if (result.exitCode !== 0) throw new Error('Recovery Git evidence unavailable');
			return result.stdout.trim();
		};
		if (
			!samePhysical(await git(['rev-parse', '--show-toplevel']), owner.parentPath) ||
			!samePhysical(await git(['rev-parse', '--absolute-git-dir']), owner.commonDir) ||
			(await git(['rev-parse', '--verify', `refs/heads/${owner.branch}`])) !== checkout.head
		)
			throw new Error('Recovery primary or retained branch changed');
		const exists = (p: string) => {
			try {
				fs.lstatSync(p);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
				throw error;
			}
		};
		const child = exists(checkout.path);
		const admin = exists(owner.gitDir);
		const registry = await git(['worktree', 'list', '--porcelain', '-z']);
		const entries = registry
			.split('\0\0')
			.filter(Boolean)
			.map((record) => record.split('\0'));
		const matches = entries.filter((entry) =>
			entry.some(
				(field) =>
					field.startsWith('worktree ') &&
					foldPathCase(path.resolve(field.slice(9))) === foldPathCase(checkout.path)
			)
		);
		// The registry read was asynchronous; do not acknowledge an earlier
		// absence if either endpoint or surviving owner changed while it ran.
		if (
			exists(checkout.path) !== child ||
			exists(owner.gitDir) !== admin ||
			!samePhysical(owner.parentPath, owner.parentPath) ||
			!samePhysical(owner.commonDir, owner.commonDir)
		)
			throw new Error('Recovery endpoints changed during inspection');
		if (!child && !admin && matches.length === 0) return { state: 'removed' };
		if (
			child &&
			admin &&
			matches.length === 1 &&
			matches[0].includes(`HEAD ${checkout.head}`) &&
			matches[0].includes(`branch refs/heads/${owner.branch}`)
		)
			return { state: 'present' };
		throw new Error('Partial or replaced worktree removal requires inspection');
	} catch (error) {
		return {
			state: 'uncertain',
			reason: error instanceof Error ? error.message : 'Recovery unavailable',
		};
	}
}
