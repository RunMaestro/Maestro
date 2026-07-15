/**
 * Consent minter - anti-forgery core (main process).
 *
 * Authorization can only be minted through a consent prompt the MAIN process
 * itself opened. This registry issues a one-time, short-lived nonce when the
 * minter opens a prompt for a specific {pluginId, offered capabilities}; the
 * confirm must echo that exact nonce and may only approve a SUBSET of the
 * offered capabilities. A forged, replayed, expired, wrong-plugin, or
 * never-offered request is rejected.
 *
 * This is the part that's pure and exhaustively testable. The IPC layer adds the
 * other two checks the contract requires - the sender is the trusted, host-owned
 * consent surface (`event.senderFrame`), and the confirm carries a real user
 * activation - neither of which any plugin-controlled surface can satisfy.
 */

import { randomBytes } from 'crypto';
import {
	grantsFromRequests,
	isPluginCapability,
	isHighRiskActCapability,
	type PluginCapability,
	type PermissionRequest,
	type PermissionGrant,
} from '../../shared/plugins/permissions';
import { transcriptReadEgressConflict } from '../../shared/plugins/capability-policy';
import type { AuthIdentity } from './authorization-ledger';

export interface ConsentTicket {
	pluginId: string;
	/** The capabilities the prompt offered; an approval may only be a subset. */
	capabilities: readonly PluginCapability[];
	expiresAt: number;
}

export interface ConsentNonceDeps {
	now?: () => number;
	newNonce?: () => string;
	/** How long an issued nonce stays valid (default 5 minutes). */
	ttlMs?: number;
}

export class ConsentNonceRegistry {
	private readonly tickets = new Map<string, ConsentTicket>();
	private readonly now: () => number;
	private readonly newNonce: () => string;
	private readonly ttlMs: number;

	constructor(deps: ConsentNonceDeps = {}) {
		this.now = deps.now ?? (() => Date.now());
		this.newNonce = deps.newNonce ?? (() => randomBytes(32).toString('base64url'));
		this.ttlMs = deps.ttlMs ?? 5 * 60 * 1000;
	}

	/** Issue a one-time nonce for a consent prompt the main process is opening. */
	issue(pluginId: string, capabilities: readonly PluginCapability[]): string {
		const t = this.now();
		for (const [nonce, ticket] of this.tickets) {
			if (t > ticket.expiresAt) this.tickets.delete(nonce);
		}
		const nonce = this.newNonce();
		this.tickets.set(nonce, {
			pluginId,
			capabilities: [...capabilities],
			expiresAt: t + this.ttlMs,
		});
		return nonce;
	}

	/**
	 * Validate + consume a nonce for a confirm. True ONLY when the nonce is
	 * outstanding, unexpired, for this exact plugin, and `approved` ⊆ the
	 * capabilities the prompt offered. One-time: the nonce is removed whether or
	 * not it validated, so a presented nonce can never be retried or replayed.
	 */
	consume(nonce: string, pluginId: string, approved: readonly PluginCapability[]): boolean {
		const ticket = this.tickets.get(nonce);
		this.tickets.delete(nonce); // one-time, regardless of outcome
		if (!ticket) return false;
		if (this.now() > ticket.expiresAt) return false;
		if (ticket.pluginId !== pluginId) return false;
		const offered = new Set(ticket.capabilities);
		return approved.every((c) => offered.has(c));
	}

	/** Number of outstanding (issued, unconsumed) nonces - for tests / diagnostics. */
	outstanding(): number {
		return this.tickets.size;
	}
}

/** A frame-level identity for the consent surface. A bare webContents id is not
 * enough - a subframe or an in-frame navigation could share it - so we bind to the
 * specific frame (routing id) and its URL. The IPC layer builds this from
 * `event.senderFrame`; `openPrompt` returns the consent window's own token. */
export interface ConsentSender {
	webContentsId: number;
	frameId: number;
	/** The frame's current URL when available (defends against in-frame navigation). */
	url?: string;
}

/** True only when two sender tokens denote the exact same frame in the same state. */
export function sameConsentSender(a: ConsentSender, b: ConsentSender): boolean {
	return a.webContentsId === b.webContentsId && a.frameId === b.frameId && a.url === b.url;
}

/** The main-owned consent prompt currently open. The recorded `sender` is the
 * frame of the consent window the main process itself created - the ONLY frame
 * whose confirm is trusted. */
export interface OpenConsentPrompt {
	pluginId: string;
	offered: readonly PluginCapability[];
	sender: ConsentSender;
	/** The exact nonce this prompt issued; a confirm must echo THIS one, not a
	 * still-live nonce from a superseded prompt for the same plugin. */
	nonce: string;
}

/** Why a confirm did not mint - surfaced for the audit log, never to a plugin. */
export type MintRejection =
	| 'no-prompt' // no consent prompt is open
	| 'untrusted-sender' // confirm came from a frame that is not the consent window
	| 'plugin-mismatch' // confirm names a different plugin than the open prompt
	| 'bad-nonce' // nonce missing/expired/replayed, or approved ⊄ offered
	| 'no-identity' // the plugin dir is unhashable (symlink) - never mintable
	| 'conflict' // transcripts:read + egress on an untrusted plugin
	| 'bundled-act-verb' // an act verb rode the plain approved[] channel (forgery/spoof)
	| 'bad-high-risk' // approvedHighRisk carried a non-act-verb capability
	| 'bad-unattended'; // unattended named a cap not separately approved as high-risk

export type MintOutcome =
	| { ok: true; grants: PermissionGrant[] }
	| { ok: false; reason: MintRejection };

export interface ConsentMinterDeps {
	registry: ConsentNonceRegistry;
	/** The sealed authorization ledger - the only thing that creates trust. */
	store: { mint: (pluginId: string, caps: PermissionGrant[], identity: AuthIdentity) => void };
	/** The plugin's manifest-requested permissions (capability + scope + reason). */
	requested: (pluginId: string) => PermissionRequest[];
	/** The plugin's CURRENT identity (content digest + signature), or null if unhashable. */
	identityOf: (pluginId: string) => AuthIdentity | null;
	/** Open the main-owned consent window for {pluginId, offered, nonce}; resolves
	 * with the consent window's own frame token - the only trusted confirmer. */
	openPrompt: (req: {
		pluginId: string;
		offered: readonly PluginCapability[];
		nonce: string;
	}) => Promise<ConsentSender>;
	now?: () => number;
}

/**
 * The isolated authorization minter. Orchestrates the only path that can create
 * trust, enforcing the three checks the contract requires:
 *
 *  1. The nonce is issued ONLY inside the main-owned open path (`requestConsent`),
 *     never via a renderer-callable endpoint - so possessing a nonce proves the
 *     main process opened the prompt.
 *  2. The confirm is accepted ONLY from the consent window's recorded frame
 *     (`sender`) - no plugin-controlled surface can be that frame.
 *  3. No renderer-supplied "user activation" flag is trusted; trust derives from
 *     the sender-frame identity + one-time nonce alone.
 *
 * Pure given its injected deps (no Electron), so the whole decision is unit-
 * testable; the IPC layer wires `openPrompt` to a real BrowserWindow/WebContentsView
 * and builds the `ConsentSender` from `event.senderFrame` on confirm.
 */
export class ConsentMinter {
	private open: OpenConsentPrompt | null = null;
	private readonly now: () => number;

	constructor(private readonly deps: ConsentMinterDeps) {
		this.now = deps.now ?? (() => Date.now());
	}

	/** The plugin a prompt is currently open for, or null. */
	pending(): string | null {
		return this.open?.pluginId ?? null;
	}

	/**
	 * Main-owned open path: issue a one-time nonce for the plugin's offered caps,
	 * open the consent window, and record its frame as the only trusted confirmer.
	 * A second request supersedes any prior open prompt (its nonce stays single-use
	 * in the registry and simply expires).
	 */
	async requestConsent(pluginId: string): Promise<void> {
		const offered = this.deps.requested(pluginId).map((r) => r.capability);
		const nonce = this.deps.registry.issue(pluginId, offered);
		const sender = await this.deps.openPrompt({ pluginId, offered, nonce });
		this.open = { pluginId, offered, sender, nonce };
	}

	/**
	 * Confirm a consent prompt. Mints ONLY when the sender is the recorded consent
	 * frame, the nonce validates (right plugin, approved ⊆ offered), the identity
	 * resolves, and the grant does not violate the transcripts+egress rule for an
	 * untrusted plugin. One-shot: the open prompt is cleared regardless of outcome.
	 *
	 * Phase 4 (plugin-phase4-high-risk-verbs.md §1+§8): the act verbs travel a
	 * DISTINCT `approvedHighRisk` channel. An act verb arriving in the plain
	 * `approved` array is REJECTED outright - the real consent page can never
	 * produce that shape, so it is a forgery, not a UI mistake. The revocable
	 * `unattended` flag is minted ONLY from the explicit `unattended` list (the
	 * nested no-user-present checkbox), which must itself be a subset of the
	 * separately-approved act verbs.
	 */
	confirm(
		sender: ConsentSender,
		req: {
			pluginId: string;
			nonce: string;
			approved: readonly PluginCapability[];
			/** Act verbs the user separately checked in the high-risk section. */
			approvedHighRisk?: readonly PluginCapability[];
			/** Act verbs whose nested unattended consent the user also checked. */
			unattended?: readonly PluginCapability[];
		}
	): MintOutcome {
		const open = this.open;
		this.open = null; // one-shot: a prompt can be confirmed at most once
		if (!open) return { ok: false, reason: 'no-prompt' };
		if (!sameConsentSender(sender, open.sender)) return { ok: false, reason: 'untrusted-sender' };
		if (req.pluginId !== open.pluginId) return { ok: false, reason: 'plugin-mismatch' };
		// Bind the confirm to THIS prompt's nonce so a still-live nonce from a
		// superseded prompt for the same plugin cannot validate here.
		if (req.nonce !== open.nonce) return { ok: false, reason: 'bad-nonce' };
		const approved = req.approved.filter(isPluginCapability);
		// A high-risk act verb must NEVER ride the bundled approval click. The
		// whole confirm is rejected (not just the verb dropped): the trusted
		// consent surface cannot emit this shape, so it is evidence of forgery.
		if (approved.some(isHighRiskActCapability)) {
			return { ok: false, reason: 'bundled-act-verb' };
		}
		const approvedHighRisk = (req.approvedHighRisk ?? []).filter(isPluginCapability);
		// The high-risk channel carries ONLY act verbs - a plain capability here
		// would dodge the (future) per-channel wording/audit trail.
		if (!approvedHighRisk.every(isHighRiskActCapability)) {
			return { ok: false, reason: 'bad-high-risk' };
		}
		const highRiskSet = new Set(approvedHighRisk);
		const unattended = (req.unattended ?? []).filter(isPluginCapability);
		// Unattended consent exists only ON TOP of an interactive high-risk
		// approval: it can never name a capability the user did not separately
		// approve in the high-risk section (and never a non-act verb).
		if (!unattended.every((c) => highRiskSet.has(c))) {
			return { ok: false, reason: 'bad-unattended' };
		}
		const allApproved = [...approved, ...approvedHighRisk];
		if (!this.deps.registry.consume(req.nonce, req.pluginId, allApproved)) {
			return { ok: false, reason: 'bad-nonce' };
		}
		const identity = this.deps.identityOf(req.pluginId);
		if (!identity) return { ok: false, reason: 'no-identity' };
		const approvedSet = new Set(allApproved);
		const toGrant = this.deps.requested(req.pluginId).filter((r) => approvedSet.has(r.capability));
		const unattendedSet = new Set(unattended);
		// The separate, revocable unattended flag is minted ONLY from the
		// explicit unattended acceptance - never inferred from the grant itself.
		const grants = grantsFromRequests(toGrant, this.now()).map((g) =>
			unattendedSet.has(g.capability) ? { ...g, unattended: true } : g
		);
		const conflict = transcriptReadEgressConflict(grants, {
			trusted: identity.signatureStatus === 'trusted',
		});
		if (conflict) return { ok: false, reason: 'conflict' };
		this.deps.store.mint(req.pluginId, grants, identity);
		return { ok: true, grants };
	}
}
