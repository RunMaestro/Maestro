/**
 * @file consent-minter.test.ts
 * @description Tests for the consent-nonce registry — the anti-forgery core of
 * the isolated authorization minter. A mint may only proceed with a live,
 * main-issued, one-time nonce bound to the exact plugin, approving a subset of
 * the offered capabilities.
 */

import { describe, it, expect } from 'vitest';
import {
	ConsentNonceRegistry,
	ConsentMinter,
	sameConsentSender,
	type ConsentSender,
} from '../../../main/plugins/consent-minter';
import type { AuthIdentity } from '../../../main/plugins/authorization-ledger';
import type { PermissionRequest, PermissionGrant } from '../../../shared/plugins/permissions';

function reg(now: { t: number }, seq = { n: 0 }, ttlMs = 1000): ConsentNonceRegistry {
	return new ConsentNonceRegistry({
		now: () => now.t,
		newNonce: () => `nonce-${++seq.n}`,
		ttlMs,
	});
}

describe('ConsentNonceRegistry', () => {
	it('accepts a live nonce for the right plugin approving a subset of offered caps', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read', 'net:fetch', 'ui:contribute']);
		expect(r.consume(nonce, 'p', ['fs:read', 'ui:contribute'])).toBe(true);
	});

	it('accepts approving the exact offered set', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read']);
		expect(r.consume(nonce, 'p', ['fs:read'])).toBe(true);
	});

	it('is one-time: a nonce cannot be replayed', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read']);
		expect(r.consume(nonce, 'p', ['fs:read'])).toBe(true);
		expect(r.consume(nonce, 'p', ['fs:read'])).toBe(false); // replay rejected
	});

	it('rejects an unknown / forged nonce', () => {
		const now = { t: 0 };
		const r = reg(now);
		expect(r.consume('forged', 'p', ['fs:read'])).toBe(false);
	});

	it('rejects a nonce minted for a different plugin', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read']);
		expect(r.consume(nonce, 'other', ['fs:read'])).toBe(false);
	});

	it('rejects approving a capability that was never offered (no widening)', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read']);
		expect(r.consume(nonce, 'p', ['fs:read', 'fs:write'])).toBe(false);
	});

	it('rejects an expired nonce', () => {
		const now = { t: 0 };
		const r = reg(now, { n: 0 }, 1000);
		const nonce = r.issue('p', ['fs:read']);
		now.t = 1001; // past ttl
		expect(r.consume(nonce, 'p', ['fs:read'])).toBe(false);
	});

	it('a failed consume still burns the nonce (no retry on a presented nonce)', () => {
		const now = { t: 0 };
		const r = reg(now);
		const nonce = r.issue('p', ['fs:read']);
		expect(r.consume(nonce, 'p', ['fs:write'])).toBe(false); // not offered
		expect(r.consume(nonce, 'p', ['fs:read'])).toBe(false); // already burned
	});

	it('prunes expired nonces on issue', () => {
		const now = { t: 0 };
		const r = reg(now, { n: 0 }, 1000);
		r.issue('p', ['fs:read']);
		expect(r.outstanding()).toBe(1);
		now.t = 2000;
		r.issue('q', ['fs:read']); // triggers prune of the expired first ticket
		expect(r.outstanding()).toBe(1);
	});
});

const SENDER: ConsentSender = { webContentsId: 7, frameId: 1, url: 'app://consent' };
const UNTRUSTED: AuthIdentity = { contentHash: 'h', signatureStatus: 'untrusted', signerKey: null };
const TRUSTED: AuthIdentity = { contentHash: 'h', signatureStatus: 'trusted', signerKey: 'k' };

function setup(opts?: {
	requested?: PermissionRequest[];
	identity?: AuthIdentity | null;
	sender?: ConsentSender;
}) {
	const requested = opts?.requested ?? [{ capability: 'fs:read' }, { capability: 'net:fetch' }];
	const identity = opts && 'identity' in opts ? opts.identity! : UNTRUSTED;
	const sender = opts?.sender ?? SENDER;
	const registry = new ConsentNonceRegistry({ now: () => 0, newNonce: () => 'NONCE', ttlMs: 1000 });
	const mints: { pluginId: string; caps: PermissionGrant[]; identity: AuthIdentity }[] = [];
	const captured: { nonce?: string } = {};
	const minter = new ConsentMinter({
		registry,
		store: { mint: (pluginId, caps, id) => mints.push({ pluginId, caps, identity: id }) },
		requested: () => requested,
		identityOf: () => identity,
		openPrompt: async ({ nonce }) => {
			captured.nonce = nonce;
			return sender;
		},
		now: () => 1234,
	});
	return { minter, registry, mints, captured, sender };
}

describe('ConsentMinter', () => {
	it('mints when a confirm from the consent frame echoes the nonce and approves a subset', async () => {
		const { minter, mints, captured } = setup();
		await minter.requestConsent('p');
		const out = minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			approved: ['fs:read'],
		});
		expect(out.ok).toBe(true);
		expect(mints).toHaveLength(1);
		expect(mints[0].pluginId).toBe('p');
		expect(mints[0].caps.map((c) => c.capability)).toEqual(['fs:read']); // only the approved subset
		expect(mints[0].caps[0].grantedAt).toBe(1234); // stamped with the minter clock
		expect(mints[0].identity).toEqual(UNTRUSTED);
	});

	it('issues the nonce only inside the main-owned open path', async () => {
		const { minter, registry } = setup();
		expect(registry.outstanding()).toBe(0); // nothing issuable without opening a prompt
		await minter.requestConsent('p');
		expect(registry.outstanding()).toBe(1);
	});

	it('rejects a confirm from any frame that is not the recorded consent frame', async () => {
		const { minter, mints, captured } = setup();
		await minter.requestConsent('p');
		const out = minter.confirm(
			{ webContentsId: 99, frameId: 1, url: 'app://consent' }, // different webContents
			{ pluginId: 'p', nonce: captured.nonce!, approved: ['fs:read'] }
		);
		expect(out).toEqual({ ok: false, reason: 'untrusted-sender' });
		expect(mints).toHaveLength(0);
	});

	it('rejects a confirm naming a different plugin than the open prompt', async () => {
		const { minter, mints, captured } = setup();
		await minter.requestConsent('p');
		const out = minter.confirm(SENDER, {
			pluginId: 'other',
			nonce: captured.nonce!,
			approved: ['fs:read'],
		});
		expect(out).toEqual({ ok: false, reason: 'plugin-mismatch' });
		expect(mints).toHaveLength(0);
	});

	it('rejects a forged / wrong nonce', async () => {
		const { minter, mints } = setup();
		await minter.requestConsent('p');
		const out = minter.confirm(SENDER, { pluginId: 'p', nonce: 'WRONG', approved: ['fs:read'] });
		expect(out).toEqual({ ok: false, reason: 'bad-nonce' });
		expect(mints).toHaveLength(0);
	});

	it('rejects approving a capability the prompt never offered', async () => {
		const { minter, mints, captured } = setup({ requested: [{ capability: 'fs:read' }] });
		await minter.requestConsent('p');
		const out = minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			approved: ['fs:read', 'net:fetch'], // net:fetch was not offered
		});
		expect(out).toEqual({ ok: false, reason: 'bad-nonce' });
		expect(mints).toHaveLength(0);
	});

	it('is one-shot: a second confirm after a successful mint finds no prompt', async () => {
		const { minter, mints, captured } = setup();
		await minter.requestConsent('p');
		expect(
			minter.confirm(SENDER, { pluginId: 'p', nonce: captured.nonce!, approved: ['fs:read'] }).ok
		).toBe(true);
		const again = minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			approved: ['fs:read'],
		});
		expect(again).toEqual({ ok: false, reason: 'no-prompt' });
		expect(mints).toHaveLength(1); // not re-minted
	});

	it('rejects a confirm when no prompt is open', () => {
		const { minter } = setup();
		expect(minter.confirm(SENDER, { pluginId: 'p', nonce: 'x', approved: [] })).toEqual({
			ok: false,
			reason: 'no-prompt',
		});
	});

	it('refuses to mint a plugin whose identity is unhashable (symlink escape)', async () => {
		const { minter, mints, captured } = setup({ identity: null });
		await minter.requestConsent('p');
		const out = minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			approved: ['fs:read'],
		});
		expect(out).toEqual({ ok: false, reason: 'no-identity' });
		expect(mints).toHaveLength(0);
	});

	it('rejects transcripts:read + egress for an untrusted plugin, but mints it when trusted', async () => {
		const requested: PermissionRequest[] = [
			{ capability: 'transcripts:read' },
			{ capability: 'net:fetch' },
		];
		const untrusted = setup({ requested, identity: UNTRUSTED });
		await untrusted.minter.requestConsent('p');
		const blocked = untrusted.minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: untrusted.captured.nonce!,
			approved: ['transcripts:read', 'net:fetch'],
		});
		expect(blocked).toEqual({ ok: false, reason: 'conflict' });
		expect(untrusted.mints).toHaveLength(0);

		const trusted = setup({ requested, identity: TRUSTED });
		await trusted.minter.requestConsent('p');
		const ok = trusted.minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: trusted.captured.nonce!,
			approved: ['transcripts:read', 'net:fetch'],
		});
		expect(ok.ok).toBe(true);
		expect(trusted.mints).toHaveLength(1);
	});

	it('binds the confirm to the current prompt nonce, not a superseded one', async () => {
		const { minter, mints } = setup();
		// Re-issue the captured nonce per call so the two prompts get distinct nonces.
		const registry = new ConsentNonceRegistry({
			now: () => 0,
			newNonce: (() => {
				let n = 0;
				return () => `n-${++n}`;
			})(),
			ttlMs: 1000,
		});
		const captured: string[] = [];
		const m = new ConsentMinter({
			registry,
			store: { mint: () => mints.push({} as never) },
			requested: () => [{ capability: 'fs:read' }],
			identityOf: () => UNTRUSTED,
			openPrompt: async ({ nonce }) => {
				captured.push(nonce);
				return SENDER;
			},
		});
		await m.requestConsent('p'); // nonce n-1 (still live, never consumed)
		await m.requestConsent('p'); // supersedes; current nonce is n-2
		const stale = m.confirm(SENDER, { pluginId: 'p', nonce: captured[0], approved: ['fs:read'] });
		expect(stale).toEqual({ ok: false, reason: 'bad-nonce' });
		expect(mints).toHaveLength(0);
	});
});

describe('ConsentMinter — Phase-4 act-verb channels', () => {
	const ACT_REQUESTED: PermissionRequest[] = [
		{ capability: 'fs:read' },
		{ capability: 'agents:dispatch', scope: 'agent-a' },
		{ capability: 'process:spawn', scope: 'echo-tool' },
	];

	it('REJECTS an act verb riding the plain approved[] channel (bundled-act-verb)', async () => {
		const { minter, mints, captured } = setup({ requested: ACT_REQUESTED, identity: TRUSTED });
		await minter.requestConsent('p');
		const out = minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			// A forged confirm smuggling the act verb into the bundled click: the
			// real consent page can never produce this shape.
			approved: ['fs:read', 'agents:dispatch'],
		});
		expect(out).toEqual({ ok: false, reason: 'bundled-act-verb' });
		expect(mints).toHaveLength(0);
	});

	it('mints an act verb ONLY via approvedHighRisk, keeping its allowlist scope, without unattended', async () => {
		const { minter, mints, captured } = setup({ requested: ACT_REQUESTED, identity: TRUSTED });
		await minter.requestConsent('p');
		const out = minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			approved: ['fs:read'],
			approvedHighRisk: ['agents:dispatch'],
		});
		expect(out.ok).toBe(true);
		expect(mints).toHaveLength(1);
		const caps = mints[0].caps;
		expect(caps.map((c) => c.capability).sort()).toEqual(['agents:dispatch', 'fs:read']);
		const dispatchGrant = caps.find((c) => c.capability === 'agents:dispatch')!;
		expect(dispatchGrant.scope).toBe('agent-a'); // allowlist scope preserved
		// Interactive approval alone NEVER mints the unattended flag.
		expect(caps.every((c) => c.unattended !== true)).toBe(true);
	});

	it('mints the unattended flag ONLY from the explicit unattended acceptance, per capability', async () => {
		const { minter, mints, captured } = setup({ requested: ACT_REQUESTED, identity: TRUSTED });
		await minter.requestConsent('p');
		const out = minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			approved: [],
			approvedHighRisk: ['agents:dispatch', 'process:spawn'],
			unattended: ['agents:dispatch'], // only dispatch gets the 3am consent
		});
		expect(out.ok).toBe(true);
		const caps = mints[0].caps;
		expect(caps.find((c) => c.capability === 'agents:dispatch')?.unattended).toBe(true);
		expect(caps.find((c) => c.capability === 'process:spawn')?.unattended).toBeUndefined();
	});

	it('rejects unattended naming a capability not separately approved as high-risk', async () => {
		const { minter, mints, captured } = setup({ requested: ACT_REQUESTED, identity: TRUSTED });
		await minter.requestConsent('p');
		const out = minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			approved: ['fs:read'],
			approvedHighRisk: ['process:spawn'],
			unattended: ['agents:dispatch'], // never interactively approved
		});
		expect(out).toEqual({ ok: false, reason: 'bad-unattended' });
		expect(mints).toHaveLength(0);
	});

	it('rejects a non-act verb smuggled onto the approvedHighRisk channel', async () => {
		const { minter, mints, captured } = setup({ requested: ACT_REQUESTED, identity: TRUSTED });
		await minter.requestConsent('p');
		const out = minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			approved: [],
			approvedHighRisk: ['fs:read'], // not an act verb
		});
		expect(out).toEqual({ ok: false, reason: 'bad-high-risk' });
		expect(mints).toHaveLength(0);
	});

	it('still enforces approved ⊆ offered across BOTH channels (no widening via high-risk)', async () => {
		const { minter, mints, captured } = setup({
			requested: [{ capability: 'fs:read' }], // no act verb offered
			identity: TRUSTED,
		});
		await minter.requestConsent('p');
		const out = minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			approved: ['fs:read'],
			approvedHighRisk: ['agents:dispatch'], // never offered
		});
		expect(out).toEqual({ ok: false, reason: 'bad-nonce' });
		expect(mints).toHaveLength(0);
	});

	it('a rejected bundled-act-verb confirm is one-shot (prompt burned, no retry)', async () => {
		const { minter, mints, captured } = setup({ requested: ACT_REQUESTED, identity: TRUSTED });
		await minter.requestConsent('p');
		minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			approved: ['agents:dispatch'],
		});
		const retry = minter.confirm(SENDER, {
			pluginId: 'p',
			nonce: captured.nonce!,
			approved: [],
			approvedHighRisk: ['agents:dispatch'],
		});
		expect(retry).toEqual({ ok: false, reason: 'no-prompt' });
		expect(mints).toHaveLength(0);
	});
});

describe('sameConsentSender', () => {
	it('matches the same frame in the same state', () => {
		expect(sameConsentSender(SENDER, { webContentsId: 7, frameId: 1, url: 'app://consent' })).toBe(
			true
		);
	});
	it('distinguishes a different subframe in the same webContents', () => {
		expect(sameConsentSender(SENDER, { webContentsId: 7, frameId: 2, url: 'app://consent' })).toBe(
			false
		);
	});
	it('distinguishes an in-frame navigation (different url)', () => {
		expect(sameConsentSender(SENDER, { webContentsId: 7, frameId: 1, url: 'app://evil' })).toBe(
			false
		);
	});
});
