import { configureBoardFeatures } from '../../../main/board/board-feature';
import { beforeEach, expect, it, vi } from 'vitest';
import {
	boardOwnerLiveness,
	createBoardOwnerHostIdentityReader,
	readBoardOwnerHostIdentity,
	type BoardOwnerEvidence,
} from '../../../main/board/board-owner-liveness';

beforeEach(() => configureBoardFeatures({ get: () => ({ board: true, maestroCue: true }) }));

it.each(['darwin', 'win32'] as const)(
	'%s native host adapter awaits bounded OS evidence and hashes only successful output',
	async (platform) => {
		const uuid = '12345678-abcd-1234-abcd-123456789abc';
		const stdout =
			platform === 'darwin'
				? `"IOPlatformUUID" = "${uuid}"`
				: `    MachineGuid    REG_SZ    ${uuid}\r\n`;
		let complete!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
		const read = vi.fn(
			() =>
				new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
					complete = resolve;
				})
		);
		const pending = readBoardOwnerHostIdentity(platform, read);
		expect(pending).toBeInstanceOf(Promise);
		complete({ stdout, stderr: '', exitCode: 0 });
		const identity = await pending;
		expect(identity).toMatch(/^[0-9a-f]{64}$/);
		expect(identity).not.toContain(uuid);
		expect(
			await readBoardOwnerHostIdentity(platform, async () => ({
				stdout: stdout.replace(uuid, uuid.toUpperCase()),
				stderr: '',
				exitCode: 0,
			}))
		).toBe(identity);
		expect(read).toHaveBeenCalledWith(
			...(platform === 'darwin'
				? ['/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']]
				: [
						expect.stringMatching(/^[a-z]:\\.*\\System32\\reg\.exe$/i),
						['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
					]),
			undefined,
			{ timeout: 2000 }
		);
		for (const raw of ['', 'missing', '00000000-0000-0000-0000-000000000000'])
			expect(
				await readBoardOwnerHostIdentity(platform, async () => ({
					stdout: raw,
					stderr: '',
					exitCode: 0,
				}))
			).toBeUndefined();
		for (const exitCode of [1, 'ETIMEDOUT'] as const)
			expect(
				await readBoardOwnerHostIdentity(platform, async () => ({
					stdout,
					stderr: 'failed',
					exitCode,
				}))
			).toBeUndefined();
		expect(
			await readBoardOwnerHostIdentity(platform, async () => {
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

it.each([
	{ board: false, maestroCue: false },
	{ board: false, maestroCue: true },
	{ board: true, maestroCue: false },
])('does not start native identity commands when either gate is off: %j', async (flags) => {
	configureBoardFeatures({ get: () => flags });
	const read = vi.fn();
	for (const platform of ['darwin', 'win32'] as const)
		expect(await readBoardOwnerHostIdentity(platform, read)).toBeUndefined();
	expect(read).not.toHaveBeenCalled();
});

it.each(['darwin', 'win32'] as const)(
	'%s desktop identity reader retries failed proof, deduplicates pending reads and caches success',
	async (platform) => {
		const stdout =
			platform === 'darwin'
				? '"IOPlatformUUID" = "12345678-abcd-1234-abcd-123456789abc"'
				: 'MachineGuid REG_SZ 12345678-abcd-1234-abcd-123456789abc';
		let complete!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
		const command = vi
			.fn()
			.mockResolvedValueOnce({ stdout: '', stderr: 'EACCES', exitCode: 1 })
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						complete = resolve;
					})
			);
		const read = createBoardOwnerHostIdentityReader(() =>
			readBoardOwnerHostIdentity(platform, command)
		);
		expect(await read()).toBeUndefined();
		const retry = read();
		const concurrent = read();
		expect(command).toHaveBeenCalledTimes(2);
		complete({ stdout, stderr: '', exitCode: 0 });
		const identity = await retry;
		expect(identity).toMatch(/^[0-9a-f]{64}$/);
		expect(await concurrent).toBe(identity);
		expect(await read()).toBe(identity);
		expect(command).toHaveBeenCalledTimes(2);
		expect(command.mock.calls.every((call) => call[3].timeout === 2000)).toBe(true);
	}
);

it.each([
	{ board: false, maestroCue: false },
	{ board: false, maestroCue: true },
	{ board: true, maestroCue: false },
])(
	'desktop identity reader refuses off-state reads and retries after a mid-read toggle: %j',
	async (off) => {
		let flags = off;
		configureBoardFeatures({ get: () => flags });
		let complete!: (identity: string) => void;
		const proof = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						complete = resolve;
					})
			)
			.mockResolvedValue('healthy-proof');
		const read = createBoardOwnerHostIdentityReader(proof);
		const reason = off.board ? 'CueDisabled' : 'BoardDisabled';
		await expect(read()).rejects.toThrow(reason);
		expect(proof).not.toHaveBeenCalled();
		flags = { board: true, maestroCue: true };
		const pending = read();
		flags = off;
		complete('discard-off-state-proof');
		await expect(pending).rejects.toThrow(reason);
		await expect(read()).rejects.toThrow(reason);
		expect(proof).toHaveBeenCalledOnce();
		flags = { board: true, maestroCue: true };
		expect(await read()).toBe('healthy-proof');
		expect(proof).toHaveBeenCalledTimes(2);
		flags = off;
		await expect(read()).rejects.toThrow(reason);
		flags = { board: true, maestroCue: true };
		expect(await read()).toBe('healthy-proof');
		expect(proof).toHaveBeenCalledTimes(2);
	}
);

it('desktop identity reader does not permanently cache a rejected probe', async () => {
	const proof = vi
		.fn()
		.mockRejectedValueOnce(new Error('probe unavailable'))
		.mockResolvedValue('healthy-proof');
	const read = createBoardOwnerHostIdentityReader(proof);
	await expect(read()).rejects.toThrow('probe unavailable');
	expect(await read()).toBe('healthy-proof');
	expect(proof).toHaveBeenCalledTimes(2);
});
