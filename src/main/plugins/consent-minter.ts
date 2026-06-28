/**
 * Consent minter — anti-forgery core (main process).
 *
 * Authorization can only be minted through a consent prompt the MAIN process
 * itself opened. This registry issues a one-time, short-lived nonce when the
 * minter opens a prompt for a specific {pluginId, offered capabilities}; the
 * confirm must echo that exact nonce and may only approve a SUBSET of the
 * offered capabilities. A forged, replayed, expired, wrong-plugin, or
 * never-offered request is rejected.
 *
 * This is the part that's pure and exhaustively testable. The IPC layer adds the
 * other two checks the contract requires — the sender is the trusted, host-owned
 * consent surface (`event.senderFrame`), and the confirm carries a real user
 * activation — neither of which any plugin-controlled surface can satisfy.
 */

import { randomBytes } from 'crypto';
import type { PluginCapability } from '../../shared/plugins/permissions';

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

	/** Number of outstanding (issued, unconsumed) nonces — for tests / diagnostics. */
	outstanding(): number {
		return this.tickets.size;
	}
}
