import { expect, it, vi } from 'vitest';
import {
	boardOwnerLiveness,
	readBoardOwnerHostIdentity,
	type BoardOwnerEvidence,
} from '../../../main/board/board-owner-liveness';

it.each(['darwin', 'win32'] as const)(
	'%s native host adapter hashes a valid OS identity and refuses unavailable proof',
	(platform) => {
		const uuid = '12345678-abcd-1234-abcd-123456789abc';
		const read = vi.fn(() =>
			platform === 'darwin'
				? `"IOPlatformUUID" = "${uuid}"`
				: `    MachineGuid    REG_SZ    ${uuid}\r\n`
		);
		const identity = readBoardOwnerHostIdentity(platform, read);
		expect(identity).toMatch(/^[0-9a-f]{64}$/);
		expect(identity).not.toContain(uuid);
		expect(read).toHaveBeenCalledWith(
			...(platform === 'darwin'
				? ['/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']]
				: [
						expect.stringMatching(/\\System32\\reg\.exe$/i),
						['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
					])
		);
		for (const raw of ['', 'missing', '00000000-0000-0000-0000-000000000000'])
			expect(readBoardOwnerHostIdentity(platform, () => raw)).toBeUndefined();
		expect(
			readBoardOwnerHostIdentity(platform, () => {
				throw new Error('host read denied');
			})
		).toBeUndefined();
	}
);

it.each(['darwin', 'win32'] as const)(
	'%s recovery requires native host, boot and process evidence',
	(platform) => {
		const old = {
			pid: 111,
			token: 'old-token',
			bootTime: 1000,
			startedAt: new Date(2000).toISOString(),
			platform,
			hostIdentity: 'machine',
		};
		const evidence: BoardOwnerEvidence = {
			platform,
			hostIdentity: 'machine',
			current: {
				pid: 222,
				token: 'current-token',
				bootTime: 1000,
				startedAt: new Date(3000).toISOString(),
				mode: 'desktop',
			},
			ownsCurrent: () => true,
			isPidAlive: () => true,
			earlierHolder: () => false,
		};
		const verdict = (previous = old, trusted = evidence) =>
			boardOwnerLiveness(JSON.stringify(previous), trusted);
		// A different startedAt, absent namespace, and current Cue ownership do not prove death.
		expect(verdict()).toBe('unknown');
		expect(verdict(old, { ...evidence, isPidAlive: () => false })).toBe('dead');
		for (const previous of [
			{ ...old, hostIdentity: '' },
			{ ...old, hostIdentity: 'other-host' },
			{ ...old, platform: 'linux' as const },
			{ ...old, token: '' },
			{ ...old, bootTime: -100000 },
			{ ...old, bootTime: NaN },
		])
			expect(verdict(previous, { ...evidence, isPidAlive: () => false })).toBe('unknown');
		expect(
			boardOwnerLiveness(JSON.stringify({ pid: 111, token: 'legacy', bootTime: 1000 }), {
				...evidence,
				isPidAlive: () => false,
			})
		).toBe('unknown');
		expect(verdict(old, { ...evidence, ownsCurrent: () => false, isPidAlive: () => false })).toBe(
			'unknown'
		);
		expect(verdict(old, { ...evidence, hostIdentity: undefined, isPidAlive: () => false })).toBe(
			'unknown'
		);
		expect(
			verdict(old, {
				...evidence,
				current: { ...evidence.current!, bootTime: NaN },
				isPidAlive: () => false,
			})
		).toBe('unknown');
		// Only our exact native PID in the same host/boot can disprove a reused PID by token.
		expect(verdict({ ...old, pid: 222 })).toBe('dead');
		expect(verdict({ ...old, pid: 222, token: 'current-token' })).toBe('unknown');
		expect(verdict({ ...old, pid: 222, hostIdentity: 'other-host' })).toBe('unknown');
	}
);

it('keeps Linux namespace evidence mandatory and ignores host metadata as a substitute', () => {
	const old = { pid: 111, token: 'old', pidNsInode: 12, bootTime: 1000 };
	const evidence: BoardOwnerEvidence = {
		platform: 'linux',
		hostIdentity: 'machine',
		current: {
			pid: 222,
			token: 'new',
			pidNsInode: 12,
			bootTime: 1000,
			mode: 'desktop',
			startedAt: new Date(3000).toISOString(),
		},
		ownsCurrent: () => true,
		isPidAlive: () => false,
		earlierHolder: () => false,
	};
	expect(boardOwnerLiveness(JSON.stringify(old), evidence)).toBe('dead');
	for (const pidNsInode of [undefined, 13])
		expect(boardOwnerLiveness(JSON.stringify({ ...old, pidNsInode }), evidence)).toBe('unknown');
	expect(boardOwnerLiveness('invalid', evidence)).toBe('unknown');
});
