/**
 * @file authorization-ledger.test.ts
 * @description Security tests for the sealed authorization ledger - the plugin
 * authorization gate. Proves the contract: nothing on disk authorizes a plugin
 * without a mint, and a file-writer cannot forge, roll back, or revive
 * authorization. Uses fakes for the seal and the credential-store anchor so the
 * anchor persists (like a real keyring) while the ledger file is independently
 * rolled back - the exact rollback attack.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	AuthorizationStore,
	createKeyringAnchor,
	shouldDisablePluginForVerifyResult,
	type SealProvider,
	type AnchorStore,
	type Anchor,
	type AuthIdentity,
} from '../../../main/plugins/authorization-ledger';
import type { SignatureStatus } from '../../../shared/plugins/signing';
import type { PermissionGrant } from '../../../shared/plugins/permissions';
import { isPermitted, parseAllowlistScope } from '../../../shared/plugins/permissions';

let tmpDir: string;
let ledgerPath: string;

/** Reversible "seal" with a marker so foreign/garbage bytes fail to unseal. */
function fakeSeal(available = true): SealProvider {
	const MARK = 'SEALED\u0000';
	return {
		available: () => available,
		seal: (plaintext) => Buffer.from(MARK + plaintext, 'utf-8'),
		unseal: (blob) => {
			const s = blob.toString('utf-8');
			if (!s.startsWith(MARK)) throw new Error('not sealed by us');
			return s.slice(MARK.length);
		},
	};
}

/** In-memory anchor backed by an external holder - simulates the OS credential
 * vault, which is NOT rolled back when the ledger file is restored. */
function fakeAnchor(holder: { value: Anchor | null }, available = true): AnchorStore {
	return {
		available: () => available,
		read: () => holder.value,
		write: (a) => {
			holder.value = { ...a };
		},
		clear: () => {
			holder.value = null;
		},
	};
}

it('createKeyringAnchor degrades unavailable native keyring to session-only', () => {
	const missing = createKeyringAnchor('com.maestro.test', 'freshness', () => null);
	expect(missing.available()).toBe(false);
	expect(missing.read()).toBeNull();
	expect(() => missing.write({ installSecret: 's', epoch: 1 })).not.toThrow();

	const throwing = createKeyringAnchor('com.maestro.test', 'freshness', () => {
		throw new Error('native module unavailable');
	});
	expect(throwing.available()).toBe(false);
	expect(() => throwing.clear()).not.toThrow();
});

it('createKeyringAnchor wraps a lazy keyring Entry module', () => {
	const passwords = new Map<string, string>();
	class FakeEntry {
		private readonly key: string;

		constructor(service: string, account: string) {
			this.key = `${service}:${account}`;
		}

		getPassword(): string | null {
			return passwords.get(this.key) ?? null;
		}

		setPassword(password: string): void {
			passwords.set(this.key, password);
		}

		deletePassword(): boolean {
			return passwords.delete(this.key);
		}
	}

	const anchor = createKeyringAnchor('com.maestro.test', 'freshness', () => ({
		Entry: FakeEntry,
	}));

	expect(anchor.available()).toBe(true);
	anchor.write({ installSecret: 'secret', epoch: 7 });
	expect(anchor.read()).toEqual({ installSecret: 'secret', epoch: 7 });
	anchor.clear();
	expect(anchor.read()).toBeNull();
});

const caps = (cap: PermissionGrant['capability'], scope?: string): PermissionGrant[] => [
	{ capability: cap, scope, grantedAt: 1 },
];

const ident = (
	contentHash: string,
	signatureStatus: SignatureStatus = 'unsigned',
	signerKey: string | null = null
): AuthIdentity => ({ contentHash, signatureStatus, signerKey });

function makeStore(seal: SealProvider, anchor: AnchorStore, seq = { n: 0 }): AuthorizationStore {
	return new AuthorizationStore({
		seal,
		anchor,
		ledgerPath,
		now: () => 1000,
		newSecret: () => `secret-${++seq.n}`,
	});
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-ledger-'));
	ledgerPath = path.join(tmpDir, 'auth-ledger.bin');
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AuthorizationStore - mint / revoke', () => {
	it('mint enables and grants exactly the approved caps; unminted plugins get nothing', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));

		expect(store.readGrants('a')).toEqual([]); // default-deny
		expect(store.isEnabled('a')).toBe(false);

		store.mint('a', caps('fs:read', '/data'), ident('hash-a'));

		expect(store.isEnabled('a')).toBe(true);
		expect(store.readGrants('a')).toEqual([
			{ capability: 'fs:read', scope: '/data', grantedAt: 1 },
		]);
		expect(store.entryIdentity('a')?.contentHash).toBe('hash-a');
		expect(store.trustState()).toBe('persistent');
	});

	it('revoke disables, drops grants, and tombstones', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('a', caps('net:fetch', 'example.com'), ident('hash-a'));
		store.revoke('a');
		expect(store.isEnabled('a')).toBe(false);
		expect(store.readGrants('a')).toEqual([]);
		expect(store.isTombstoned('a')).toBe(true);
	});
});

describe('AuthorizationStore - setAllowlistScope (host-managed allow list, #1250)', () => {
	const dispatchGrant = (scope: string, unattended = false): PermissionGrant[] => [
		{
			capability: 'agents:dispatch',
			scope,
			grantedAt: 1,
			...(unattended ? { unattended: true } : {}),
		},
	];

	it('widens the allow list of an already-consented dispatch grant', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('relay', dispatchGrant('agent-1'), ident('hash'));

		expect(
			store.setAllowlistScope('relay', 'agents:dispatch', ['agent-1', 'agent-2', 'agent-3'])
		).toBe(true);
		const grants = store.readGrants('relay');
		expect(grants).toHaveLength(1);
		expect(parseAllowlistScope(grants[0].scope)).toEqual(['agent-1', 'agent-2', 'agent-3']);
		expect(isPermitted(grants, 'agents:dispatch', 'agent-3')).toBe(true);
	});

	it('an empty set clears the scope to deny-all (never a wildcard)', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('relay', dispatchGrant('agent-1'), ident('hash'));

		expect(store.setAllowlistScope('relay', 'agents:dispatch', [])).toBe(true);
		const grants = store.readGrants('relay');
		expect(grants[0].scope).toBeUndefined();
		expect(isPermitted(grants, 'agents:dispatch', 'agent-1')).toBe(false);
	});

	it('preserves the unattended flag and any other grants', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint(
			'relay',
			[
				{ capability: 'agents:dispatch', scope: 'agent-1', grantedAt: 1, unattended: true },
				{ capability: 'net:connect', scope: 'gateway.discord.gg', grantedAt: 1 },
			],
			ident('hash')
		);

		store.setAllowlistScope('relay', 'agents:dispatch', ['agent-1', 'agent-2']);
		const grants = store.readGrants('relay');
		const dispatch = grants.find((g) => g.capability === 'agents:dispatch');
		const net = grants.find((g) => g.capability === 'net:connect');
		expect(dispatch?.unattended).toBe(true);
		expect(parseAllowlistScope(dispatch?.scope)).toEqual(['agent-1', 'agent-2']);
		expect(net?.scope).toBe('gateway.discord.gg');
	});

	it('returns false when the plugin holds no grant for the capability', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('data', caps('fs:read', '/data'), ident('hash'));
		expect(store.setAllowlistScope('data', 'agents:dispatch', ['agent-1'])).toBe(false);
		expect(store.setAllowlistScope('missing', 'agents:dispatch', ['agent-1'])).toBe(false);
	});

	it('refuses a non-allowlist capability and leaves its scope untouched', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('data', caps('fs:read', '/data'), ident('hash'));
		expect(store.setAllowlistScope('data', 'fs:read', ['/other'])).toBe(false);
		expect(store.readGrants('data')[0].scope).toBe('/data');
	});

	it('persists the widened scope across restarts (sealed + anchored)', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('relay', dispatchGrant('agent-1'), ident('hash'));
		store.setAllowlistScope('relay', 'agents:dispatch', ['agent-1', 'agent-2']);

		const reopened = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(parseAllowlistScope(reopened.readGrants('relay')[0].scope)).toEqual([
			'agent-1',
			'agent-2',
		]);
		expect(reopened.trustState()).toBe('persistent');
	});

	it('the widened scope survives verify() with an unchanged identity', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('relay', dispatchGrant('agent-1'), ident('hash'));
		store.setAllowlistScope('relay', 'agents:dispatch', ['agent-1', 'agent-2']);

		const result = store.verify('relay', ident('hash'), ['agents:dispatch']);
		expect(result.authorized).toBe(true);
		expect(parseAllowlistScope(result.caps[0].scope)).toEqual(['agent-1', 'agent-2']);
	});

	it('refuses the whole edit if any member is invalid, leaving the scope unchanged', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(), fakeAnchor(holder));
		store.mint('relay', dispatchGrant('agent-1'), ident('hash'));

		// A comma would split the scope into two members; a '*' could smuggle
		// pattern semantics - both must be refused outright, never silently dropped.
		expect(
			store.setAllowlistScope('relay', 'agents:dispatch', ['agent-2', 'agent-1,agent-3'])
		).toBe(false);
		expect(store.setAllowlistScope('relay', 'agents:dispatch', ['agent-*'])).toBe(false);
		// The original scope is untouched.
		expect(parseAllowlistScope(store.readGrants('relay')[0].scope)).toEqual(['agent-1']);
	});
});

describe('AuthorizationStore - persistence', () => {
	it('persists across instances when sealed + anchored', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('storage:write'), ident('hash-a'));

		const reopened = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(reopened.isEnabled('a')).toBe(true);
		expect(reopened.readGrants('a')).toHaveLength(1);
		expect(reopened.trustState()).toBe('persistent');
	});
});

describe('AuthorizationStore - anti-rollback (the contract)', () => {
	it('rejects a restored OLD sealed ledger (epoch regression) → re-consent, grant NOT honored', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('fs:write', '/d'), ident('hash-a'));

		// Snapshot the epoch-1 sealed file (the attacker's saved copy).
		const old = fs.readFileSync(ledgerPath);

		// User later narrows: revoke 'a' (epoch advances; anchor advances with it).
		makeStore(fakeSeal(), fakeAnchor(holder)).revoke('a');

		// Attacker rolls the FILE back to the broad-grant version. The anchor (in the
		// credential vault) is NOT rolled back.
		fs.writeFileSync(ledgerPath, old);

		const after = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(after.isEnabled('a')).toBe(false); // rollback rejected
		expect(after.readGrants('a')).toEqual([]);
		expect(after.priorStateDropped()).toBe(true);
		expect(after.trustState()).toBe('re-consent');
	});

	it('uninstall + restore old folder/ledger cannot silently re-enable', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('ui:command'), ident('hash-a'));
		const old = fs.readFileSync(ledgerPath);

		makeStore(fakeSeal(), fakeAnchor(holder)).uninstall('a');
		fs.writeFileSync(ledgerPath, old); // restore pre-uninstall ledger

		const after = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(after.isEnabled('a')).toBe(false);
	});

	it('rejects a tampered/foreign sealed file → re-consent', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('fs:read', '/d'), ident('hash-a'));
		fs.writeFileSync(ledgerPath, Buffer.from('garbage-not-sealed', 'utf-8'));

		const after = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(after.isEnabled('a')).toBe(false);
		expect(after.priorStateDropped()).toBe(true);
	});

	it('missing anchor with an existing sealed ledger drops grants and requires re-consent', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('agents:dispatch'), ident('hash-a'));
		holder.value = null; // keyring entry missing/corrupt while the sealed ledger file still exists

		const after = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(after.isEnabled('a')).toBe(false);
		expect(after.readGrants('a')).toEqual([]);
		expect(after.priorStateDropped()).toBe(true);
		expect(after.trustState()).toBe('re-consent');
		expect(after.isSessionOnly()).toBe(false);
	});

	it('re-consent after a drop persists again (storage mode stays persistent)', () => {
		const holder = { value: null as Anchor | null };
		makeStore(fakeSeal(), fakeAnchor(holder)).mint('a', caps('fs:read', '/d'), ident('hash-a'));
		const old = fs.readFileSync(ledgerPath);
		makeStore(fakeSeal(), fakeAnchor(holder)).revoke('a');
		fs.writeFileSync(ledgerPath, old); // rollback

		const dropped = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(dropped.trustState()).toBe('re-consent');
		expect(dropped.isSessionOnly()).toBe(false); // still persistent storage
		dropped.mint('a', caps('fs:read', '/d'), ident('hash-a2')); // user re-approves

		const reopened = makeStore(fakeSeal(), fakeAnchor(holder));
		expect(reopened.isEnabled('a')).toBe(true);
		expect(reopened.trustState()).toBe('persistent');
	});
});

describe('AuthorizationStore - session-only fail-safe', () => {
	it('no seal → in-memory grants this session, nothing persisted', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(false), fakeAnchor(holder));
		expect(store.isSessionOnly()).toBe(true);

		store.mint('a', caps('fs:read', '/d'), ident('hash-a'));
		expect(store.readGrants('a')).toHaveLength(1); // usable this run
		expect(fs.existsSync(ledgerPath)).toBe(false); // never written

		const reopened = makeStore(fakeSeal(false), fakeAnchor(holder));
		expect(reopened.isEnabled('a')).toBe(false); // not persisted
	});

	it('no anchor (no credential store) → session-only', () => {
		const holder = { value: null as Anchor | null };
		const store = makeStore(fakeSeal(true), fakeAnchor(holder, false));
		expect(store.isSessionOnly()).toBe(true);
	});
});

describe('AuthorizationStore - persist failure (locked keyring) fails safe', () => {
	it('an anchor write that throws degrades to session-only, not a crash', () => {
		const holder = { value: null as Anchor | null };
		const throwingAnchor: AnchorStore = {
			available: () => true,
			read: () => holder.value,
			write: () => {
				throw new Error('keyring locked');
			},
			clear: () => {},
		};
		const store = makeStore(fakeSeal(), throwingAnchor);
		// First-run persist() hits the throwing write and must NOT throw.
		expect(() => store.mint('a', caps('fs:read', '/d'), ident('hash-a'))).not.toThrow();
		expect(store.isSessionOnly()).toBe(true); // degraded safely
		expect(store.readGrants('a')).toHaveLength(1); // usable this session
		expect(fs.existsSync(ledgerPath)).toBe(false);
	});

	it('a seal/file write failing after the anchor write stays session-only for all later mints', () => {
		const holder = { value: null as Anchor | null };
		let failSeal = true;
		const flakySeal: SealProvider = {
			available: () => true,
			seal: () => {
				if (failSeal) throw new Error('disk/seal failure after anchor write');
				return Buffer.from('unused');
			},
			unseal: () => {
				throw new Error('unused');
			},
		};
		const store = makeStore(flakySeal, fakeAnchor(holder));
		// First-run persist(): anchor.write succeeds, then seal()/file write throws → caught.
		expect(() => store.mint('a', caps('fs:read', '/d'), ident('hash-a'))).not.toThrow();
		expect(store.isSessionOnly()).toBe(true);
		expect(fs.existsSync(ledgerPath)).toBe(false);

		// Even though the seal would now succeed, later mints MUST stay session-only
		// and never write a skipped epoch (persist early-returns once degraded).
		failSeal = false;
		store.mint('b', caps('ui:command'), ident('hash-b'));
		expect(store.isSessionOnly()).toBe(true);
		expect(fs.existsSync(ledgerPath)).toBe(false);
		expect(store.readGrants('b')).toHaveLength(1); // usable in-memory
	});
});

describe('AuthorizationStore - verify (refresh-time gate)', () => {
	const newStore = () => makeStore(fakeSeal(), fakeAnchor({ value: null as Anchor | null }));

	it('authorizes when identity matches and caps are still requested', () => {
		const store = newStore();
		store.mint('a', caps('fs:read', '/d'), ident('h1', 'trusted', 'key1'));
		const r = store.verify('a', ident('h1', 'trusted', 'key1'), ['fs:read']);
		expect(r.authorized).toBe(true);
		expect(r.reason).toBe('ok');
		expect(r.caps).toHaveLength(1);
	});

	it('rejects on content-hash change', () => {
		const store = newStore();
		store.mint('a', caps('fs:read', '/d'), ident('h1'));
		expect(store.verify('a', ident('h2'), ['fs:read'])).toMatchObject({
			authorized: false,
			reason: 'identity-changed',
		});
	});

	it('rejects on signer/trust change even when files are unchanged', () => {
		const store = newStore();
		store.mint('a', caps('fs:read', '/d'), ident('h1', 'untrusted', 'keyX'));
		expect(store.verify('a', ident('h1', 'trusted', 'keyY'), ['fs:read'])).toMatchObject({
			authorized: false,
			reason: 'identity-changed',
		});
	});

	it('not-authorized when never minted', () => {
		expect(newStore().verify('a', ident('h1'), ['fs:read'])).toMatchObject({
			authorized: false,
			reason: 'not-authorized',
		});
	});

	it('refresh-time gate disables any non-authorized result, including not-authorized', () => {
		expect(
			shouldDisablePluginForVerifyResult({
				authorized: false,
				reason: 'not-authorized',
				caps: [],
			})
		).toBe(true);
	});

	it('removed when tombstoned (post-uninstall)', () => {
		const store = newStore();
		store.mint('a', caps('fs:read', '/d'), ident('h1'));
		store.uninstall('a');
		expect(store.verify('a', ident('h1'), ['fs:read'])).toMatchObject({
			authorized: false,
			reason: 'removed',
		});
	});

	it('rejects when a granted cap is no longer requested by the manifest', () => {
		const store = newStore();
		store.mint('a', caps('fs:write', '/d'), ident('h1'));
		expect(store.verify('a', ident('h1'), ['fs:read'])).toMatchObject({
			authorized: false,
			reason: 'identity-changed',
		});
	});
});
