/**
 * The peer flags `update-agent` and `update-group-settings` share, read into
 * the same wire shapes the desktop's Peers tab saves:
 *
 *   --peer <agent>:<r|w|rw|none>   upsert one explicit row (repeatable)
 *   --peer-note <agent>:<text>     set a row's note (repeatable, empty clears)
 *   --remove-peer <agent>          delete the row outright (repeatable)
 *   --group-peers <r|w|rw|off>     the "peers in my group" grant
 *   --worktree-peers <r|w|rw|off>  the "worktree family" grant
 *
 * An agent is named by id, a unique id prefix, or its display name
 * (`resolveAgentId`). The meaning of the words lives in `shared/peerAgents.ts`,
 * which the app reads too, so a flag and a click cannot mean different things.
 */

import {
	parsePeerAccessWord,
	parsePeerGrantWord,
	type PeerAgentEdits,
} from '../../shared/peerAgents';
import type { PeerAccess } from '../../shared/types';
import { resolveAgentId } from './storage';

/** The commander options the peer flags populate. */
export interface PeerFlagOptions {
	peer?: string[];
	peerNote?: string[];
	removePeer?: string[];
	groupPeers?: string;
	worktreePeers?: string;
}

/** What the flags ask for. A key is present only when its flag was passed. */
export interface PeerFlagPatch {
	peerAgentEdits?: PeerAgentEdits;
	/** `null` is `off`. */
	groupPeerAccess?: PeerAccess | null;
	worktreePeerAccess?: PeerAccess | null;
}

/** Whether any peer flag was passed. */
export function hasPeerFlags(options: PeerFlagOptions): boolean {
	return (
		(options.peer?.length ?? 0) > 0 ||
		(options.peerNote?.length ?? 0) > 0 ||
		(options.removePeer?.length ?? 0) > 0 ||
		options.groupPeers !== undefined ||
		options.worktreePeers !== undefined
	);
}

/** Collects a repeatable flag, the way `commander` wants it. */
export function collectRepeatable(value: string, previous: string[] | undefined): string[] {
	return [...(previous ?? []), value];
}

function readGrant(flag: string, raw: string): PeerAccess | null {
	const grant = parsePeerGrantWord(raw);
	if (grant === undefined) {
		throw new Error(`${flag} expects r, w, rw, or off, got "${raw}"`);
	}
	return grant;
}

/**
 * Read the peer flags. Throws an Error that names the flag and the value when
 * one is malformed, names an agent that does not resolve, or names the same
 * agent twice in one flag.
 *
 * `selfId` is the agent being edited: an agent is never its own peer, so a row
 * for it would be inert and is refused instead.
 */
export function readPeerFlags(options: PeerFlagOptions, selfId?: string): PeerFlagPatch {
	const patch: PeerFlagPatch = {};
	const resolve = (flag: string, ref: string): string => {
		const id = resolveAgentId(ref);
		if (selfId !== undefined && id === selfId) {
			throw new Error(`${flag}: an agent cannot be its own peer ("${ref}").`);
		}
		return id;
	};
	const edits: PeerAgentEdits = {};

	const rows = options.peer ?? [];
	if (rows.length > 0) {
		const seen = new Set<string>();
		edits.upsert = rows.map((entry) => {
			// The access word never holds a colon and a name might, so split at the last.
			const cut = entry.lastIndexOf(':');
			const access = cut > 0 ? parsePeerAccessWord(entry.slice(cut + 1)) : undefined;
			if (!access) {
				throw new Error(`--peer expects <agent>:<r|w|rw|none>, got "${entry}"`);
			}
			const sessionId = resolve('--peer', entry.slice(0, cut).trim());
			if (seen.has(sessionId)) throw new Error(`--peer: "${sessionId}" is named more than once.`);
			seen.add(sessionId);
			return { sessionId, ...access };
		});
	}

	const notes = options.peerNote ?? [];
	if (notes.length > 0) {
		const seen = new Set<string>();
		edits.notes = notes.map((entry) => {
			// The text may hold colons and a name rarely does, so split at the first.
			const cut = entry.indexOf(':');
			if (cut <= 0) throw new Error(`--peer-note expects <agent>:<text>, got "${entry}"`);
			const sessionId = resolve('--peer-note', entry.slice(0, cut).trim());
			if (seen.has(sessionId)) {
				throw new Error(`--peer-note: "${sessionId}" is named more than once.`);
			}
			seen.add(sessionId);
			return { sessionId, description: entry.slice(cut + 1) };
		});
	}

	const removals = options.removePeer ?? [];
	if (removals.length > 0) {
		edits.remove = removals.map((ref) => resolve('--remove-peer', ref.trim()));
	}

	if (edits.upsert || edits.notes || edits.remove) patch.peerAgentEdits = edits;
	if (options.groupPeers !== undefined) {
		patch.groupPeerAccess = readGrant('--group-peers', options.groupPeers);
	}
	if (options.worktreePeers !== undefined) {
		patch.worktreePeerAccess = readGrant('--worktree-peers', options.worktreePeers);
	}
	return patch;
}
