/**
 * ICE configuration: what a connection can reach, and what it is called.
 *
 * The two things worth pinning down are honesty properties rather than
 * behaviours. A TURN server switched on with no URL must be off, because the
 * alternative is an ICE configuration that throws where nobody sees it; and a
 * candidate pair with a relay on either end must be called relayed, because
 * saying "direct" would describe a path the audio is not taking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logLines: string[] = [];
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: (message: string) => logLines.push(message),
		warn: (message: string) => logLines.push(message),
		error: (message: string) => logLines.push(message),
		debug: (message: string) => logLines.push(message),
	},
}));

import {
	__setCredentialEntryFactory,
	clearTurnCredential,
	getTurnCredential,
	setTurnCredential,
} from '../../../main/acappella/providers/credentials';
import type { KeyringEntry } from '../../../main/utils/keyring';
import {
	CANDIDATE_TYPE_LABELS,
	DEFAULT_ICE_SETTINGS,
	DEFAULT_STUN_URLS,
	TUNNEL_MEDIA_NOTE,
	__resetLegacyTurnWarningForTests,
	buildIceServers,
	classifyCandidatePair,
	classifyCandidateType,
	clearLegacyTurnCredential,
	describeIceReach,
	iceTransportPolicy,
	isOverlayAddress,
	migrateLegacyTurnCredential,
	readAndMigrateIceSettings,
	readIceSettings,
	updateStoredIceSettings,
	type IceSettingsStoreLike,
} from '../../../main/acappella/transport/ice-config';

function makeMemoryStore(initial: Record<string, unknown> = {}): IceSettingsStoreLike & {
	data: Record<string, unknown>;
} {
	const data = structuredClone(initial);
	return {
		data,
		get: (key: string, defaultValue?: unknown) => (key in data ? data[key] : defaultValue),
		set: (key: string, value: unknown) => {
			data[key] = structuredClone(value);
		},
	};
}

function fakeKeyringEntry(): KeyringEntry & { value: string | null } {
	return {
		value: null,
		getPassword() {
			return this.value;
		},
		setPassword(password: string) {
			this.value = password;
		},
		deletePassword() {
			const had = this.value !== null;
			this.value = null;
			return had;
		},
	};
}

describe('readIceSettings', () => {
	it('fills in the defaults for an empty store', () => {
		expect(readIceSettings(undefined)).toEqual(DEFAULT_ICE_SETTINGS);
		expect(readIceSettings({})).toEqual(DEFAULT_ICE_SETTINGS);
	});

	it('keeps an explicitly empty STUN list, because that is a real choice', () => {
		// LAN and overlay only, with nothing reflecting an address off anyone.
		expect(readIceSettings({ stunUrls: [] }).stunUrls).toEqual([]);
	});

	it('treats a TURN server with no URL as off, whatever the flag says', () => {
		const settings = readIceSettings({ turn: { enabled: true, url: '   ' } });
		expect(settings.turn.enabled).toBe(false);
	});

	it('does not throw on junk from a settings pane', () => {
		const settings = readIceSettings({ stunUrls: 'nope', turn: 7, hostCandidates: 'yes' });
		expect(settings.stunUrls).toEqual([...DEFAULT_STUN_URLS]);
		expect(settings.turn.enabled).toBe(false);
		expect(settings.hostCandidates).toBe(true);
	});
});

describe('buildIceServers', () => {
	it('puts TURN last so ICE tries the free paths first', () => {
		const servers = buildIceServers({
			...DEFAULT_ICE_SETTINGS,
			turn: { enabled: true, url: 'turns:relay.example.com:5349', username: 'u', credential: 'c' },
		});
		expect(servers).toHaveLength(2);
		expect(servers[1]).toMatchObject({ urls: 'turns:relay.example.com:5349', username: 'u' });
	});

	it('produces nothing at all for a LAN-only configuration', () => {
		expect(buildIceServers({ ...DEFAULT_ICE_SETTINGS, stunUrls: [] })).toEqual([]);
	});

	it('forces a relay only when asked', () => {
		expect(iceTransportPolicy(DEFAULT_ICE_SETTINGS)).toBe('all');
		expect(iceTransportPolicy({ ...DEFAULT_ICE_SETTINGS, forceRelay: true })).toBe('relay');
	});
});

describe('describeIceReach', () => {
	it('says cellular will not work without TURN', () => {
		expect(describeIceReach(DEFAULT_ICE_SETTINGS)).toMatch(/cellular will not connect/i);
	});

	it('says a LAN-only configuration reaches nothing outside it', () => {
		expect(describeIceReach({ ...DEFAULT_ICE_SETTINGS, stunUrls: [] })).toMatch(
			/this network and overlay networks only/i
		);
	});

	it('names cellular as covered once a relay is configured', () => {
		const reach = describeIceReach({
			...DEFAULT_ICE_SETTINGS,
			turn: { enabled: true, url: 'turn:r', username: 'u', credential: 'c' },
		});
		expect(reach).toMatch(/cellular/i);
	});

	it('says so when relay-only is on with no relay configured', () => {
		expect(describeIceReach({ ...DEFAULT_ICE_SETTINGS, forceRelay: true })).toMatch(
			/no device can connect/i
		);
	});
});

describe('candidate classification', () => {
	it('collapses the ICE vocabulary onto three words a person can act on', () => {
		expect(classifyCandidateType('host')).toBe('lan');
		expect(classifyCandidateType('srflx')).toBe('stun');
		expect(classifyCandidateType('prflx')).toBe('stun');
		expect(classifyCandidateType('relay')).toBe('relay');
		expect(classifyCandidateType(undefined)).toBe('unknown');
	});

	it('takes the worse end of a pair', () => {
		expect(classifyCandidatePair('host', 'host')).toBe('lan');
		expect(classifyCandidatePair('host', 'srflx')).toBe('stun');
		expect(classifyCandidatePair('host', 'relay')).toBe('relay');
		expect(classifyCandidatePair('relay', 'host')).toBe('relay');
	});

	it('reports unknown until both ends are known', () => {
		expect(classifyCandidatePair('host', undefined)).toBe('unknown');
	});

	it('has a label for every type', () => {
		for (const type of ['lan', 'stun', 'relay', 'unknown'] as const) {
			expect(CANDIDATE_TYPE_LABELS[type]).toEqual(expect.any(String));
		}
	});
});

describe('overlay addresses', () => {
	it('recognises the CGNAT block Tailscale allocates out of', () => {
		expect(isOverlayAddress('100.64.0.1')).toBe(true);
		expect(isOverlayAddress('100.127.255.254')).toBe(true);
	});

	it('does not mistake an ordinary address for an overlay', () => {
		expect(isOverlayAddress('192.168.1.10')).toBe(false);
		expect(isOverlayAddress('100.128.0.1')).toBe(false);
		expect(isOverlayAddress('not an address')).toBe(false);
	});
});

describe('the tunnel note', () => {
	it('says plainly that the quick tunnel cannot carry the media', () => {
		// The user who does not know this blames the wrong thing every single time.
		expect(TUNNEL_MEDIA_NOTE).toMatch(/cloudflare/i);
		expect(TUNNEL_MEDIA_NOTE).toMatch(/cannot carry/i);
		expect(TUNNEL_MEDIA_NOTE).toMatch(/turn relay/i);
	});
});

describe('TURN credential migration and fallback', () => {
	let entries: Record<string, ReturnType<typeof fakeKeyringEntry>>;

	beforeEach(() => {
		logLines.length = 0;
		__resetLegacyTurnWarningForTests();
		entries = {};
		__setCredentialEntryFactory((account) => {
			entries[account] ??= fakeKeyringEntry();
			return entries[account];
		});
	});

	afterEach(() => {
		__setCredentialEntryFactory(null);
	});

	it('migrates a legacy plaintext credential into the keychain and removes it from settings', () => {
		const store = makeMemoryStore({
			acappella: {
				ice: {
					turn: {
						enabled: true,
						url: 'turns:relay.example.com:5349',
						username: 'user1',
						credential: 'legacy-secret',
					},
				},
			},
		});

		const { settings, view } = readAndMigrateIceSettings(store);

		expect(getTurnCredential()).toBe('legacy-secret');
		expect(settings.turn.credential).toBe('legacy-secret');
		expect(buildIceServers(settings)[1]).toMatchObject({ credential: 'legacy-secret' });
		expect(view.turn).toMatchObject({
			credentialConfigured: true,
			keyringAvailable: true,
			legacyPlaintextFallback: false,
		});
		expect(JSON.stringify(view)).not.toContain('legacy-secret');
		expect(JSON.stringify(store.data)).not.toContain('legacy-secret');
	});

	it('keeps legacy plaintext when no keyring is available and preserves it across panel ICE edits', () => {
		__setCredentialEntryFactory(() => null);
		const store = makeMemoryStore({
			acappella: {
				ice: {
					turn: {
						enabled: true,
						url: 'turns:old.example.com:5349',
						username: 'user1',
						credential: 'legacy-secret',
					},
				},
			},
		});

		expect(migrateLegacyTurnCredential(store)).toBe(true);
		expect(setTurnCredential('new-secret').ok).toBe(false);

		updateStoredIceSettings(store, {
			turn: { enabled: true, url: 'turns:new.example.com:5349', username: 'user1' },
		});

		const { settings, view } = readAndMigrateIceSettings(store);
		expect(settings.turn.url).toBe('turns:new.example.com:5349');
		expect(settings.turn.credential).toBe('legacy-secret');
		expect(buildIceServers(settings)[1]).toMatchObject({
			urls: 'turns:new.example.com:5349',
			credential: 'legacy-secret',
		});
		expect(view.turn.legacyPlaintextFallback).toBe(true);
		expect(view.turn.keyringAvailable).toBe(false);
		expect(logLines.join('\n')).not.toContain('legacy-secret');
	});

	it('clears both the keychain entry and any legacy plaintext in settings', () => {
		setTurnCredential('keychain-secret');
		const store = makeMemoryStore({
			acappella: {
				ice: {
					turn: {
						enabled: true,
						url: 'turns:relay.example.com:5349',
						username: 'user1',
						credential: 'legacy-secret',
					},
				},
			},
		});

		expect(clearTurnCredential()).toEqual({ ok: true });
		expect(clearLegacyTurnCredential(store)).toBe(true);
		expect(getTurnCredential()).toBeNull();
		expect(JSON.stringify(store.data)).not.toContain('legacy-secret');
	});

	it('does not overwrite an existing keychain credential when a stale plaintext value reappears', () => {
		setTurnCredential('new');
		const store = makeMemoryStore({
			acappella: {
				ice: {
					turn: {
						enabled: true,
						url: 'turns:relay.example.com:5349',
						username: 'user1',
						credential: 'old',
					},
				},
			},
		});

		const { settings } = readAndMigrateIceSettings(store);

		expect(getTurnCredential()).toBe('new');
		expect(settings.turn.credential).toBe('new');
		expect(JSON.stringify(store.data)).not.toContain('old');
	});

	it('logs the no-keyring fallback warning only once across repeated reads', () => {
		__setCredentialEntryFactory(() => null);
		const store = makeMemoryStore({
			acappella: {
				ice: {
					turn: {
						enabled: true,
						url: 'turns:relay.example.com:5349',
						username: 'user1',
						credential: 'legacy-secret',
					},
				},
			},
		});

		const first = readAndMigrateIceSettings(store);
		const second = readAndMigrateIceSettings(store);

		expect(first.view.turn.legacyPlaintextFallback).toBe(true);
		expect(second.view.turn.legacyPlaintextFallback).toBe(true);
		expect(logLines).toHaveLength(1);
	});
});
