/**
 * ICE configuration: what a connection can reach, and what it is called.
 *
 * The two things worth pinning down are honesty properties rather than
 * behaviours. A TURN server switched on with no URL must be off, because the
 * alternative is an ICE configuration that throws where nobody sees it; and a
 * candidate pair with a relay on either end must be called relayed, because
 * saying "direct" would describe a path the audio is not taking.
 */

import { describe, expect, it } from 'vitest';

import {
	CANDIDATE_TYPE_LABELS,
	DEFAULT_ICE_SETTINGS,
	DEFAULT_STUN_URLS,
	TUNNEL_MEDIA_NOTE,
	buildIceServers,
	classifyCandidatePair,
	classifyCandidateType,
	describeIceReach,
	iceTransportPolicy,
	isOverlayAddress,
	readIceSettings,
} from '../../../main/acappella/transport/ice-config';

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
