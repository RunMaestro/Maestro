/**
 * Tests for src/cli/services/host-linger.ts: whether systemd-logind lets a Linux host outlive the
 * SSH session that started it, with loginctl and the platform stood in for. The injected-deps
 * tests pass every dependency; the default-wiring tests mock the platform helper, the exec helper
 * and `os.userInfo()`, so no loginctl ever runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isLinuxMock, execFileNoThrowMock, userInfoMock } = vi.hoisted(() => ({
	isLinuxMock: vi.fn(() => true),
	execFileNoThrowMock: vi.fn(),
	userInfoMock: vi.fn(() => ({ username: 'bob' })),
}));

vi.mock('../../../shared/platformDetection', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/platformDetection')>()),
	isLinux: isLinuxMock,
}));
vi.mock('../../../shared/maestro-lib/launch/exec-file', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/maestro-lib/launch/exec-file')>()),
	execFileNoThrow: execFileNoThrowMock,
}));
vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	return { ...actual, default: { ...actual, userInfo: userInfoMock }, userInfo: userInfoMock };
});

import {
	checkUserLinger,
	formatLingerWarning,
	parseLingerProperty,
	type LingerCheckDeps,
} from '../../../cli/services/host-linger';

function linuxWith(stdout: string, exitCode: number | string = 0) {
	const exec = vi.fn<LingerCheckDeps['exec']>().mockResolvedValue({ stdout, stderr: '', exitCode });
	return { isLinux: () => true, username: () => 'alice', exec };
}

describe('checkUserLinger', () => {
	it('asks loginctl about the host user, and reports the fix when lingering is off', async () => {
		const deps = linuxWith('Linger=no\n');
		expect(await checkUserLinger(deps)).toEqual({
			linger: false,
			lingerFix: 'loginctl enable-linger alice',
		});
		expect(deps.exec).toHaveBeenCalledWith('loginctl', ['show-user', 'alice', '-p', 'Linger']);
	});

	it('reports nothing when lingering is on', async () => {
		expect(await checkUserLinger(linuxWith('Linger=yes\n'))).toBeUndefined();
	});

	it('never runs loginctl off Linux', async () => {
		const deps = { ...linuxWith('Linger=no\n'), isLinux: () => false };
		expect(await checkUserLinger(deps)).toBeUndefined();
		expect(deps.exec).not.toHaveBeenCalled();
	});

	it('reports nothing when loginctl is missing, fails, or says something else', async () => {
		expect(await checkUserLinger(linuxWith('', 'ENOENT'))).toBeUndefined();
		expect(await checkUserLinger(linuxWith('Linger=no\n', 1))).toBeUndefined();
		expect(await checkUserLinger(linuxWith('Failed to connect to bus\n'))).toBeUndefined();
		const throwing = {
			...linuxWith(''),
			exec: vi.fn<LingerCheckDeps['exec']>().mockRejectedValue(new Error('boom')),
		};
		expect(await checkUserLinger(throwing)).toBeUndefined();
	});

	it('reports nothing when the user is unknown', async () => {
		const deps = { ...linuxWith('Linger=no\n'), username: () => undefined };
		expect(await checkUserLinger(deps)).toBeUndefined();
		expect(deps.exec).not.toHaveBeenCalled();
	});
});

describe('checkUserLinger default wiring', () => {
	beforeEach(() => {
		isLinuxMock.mockReset().mockReturnValue(true);
		userInfoMock.mockReset().mockReturnValue({ username: 'bob' });
		execFileNoThrowMock
			.mockReset()
			.mockResolvedValue({ stdout: 'Linger=no\n', stderr: '', exitCode: 0 });
	});

	it('asks loginctl through execFileNoThrow with a timeout, for the OS user', async () => {
		expect(await checkUserLinger()).toEqual({
			linger: false,
			lingerFix: 'loginctl enable-linger bob',
		});
		expect(execFileNoThrowMock).toHaveBeenCalledWith(
			'loginctl',
			['show-user', 'bob', '-p', 'Linger'],
			undefined,
			{ timeout: 5_000 }
		);
	});

	it('asks the platform helper first, and runs nothing off Linux', async () => {
		isLinuxMock.mockReturnValue(false);
		expect(await checkUserLinger()).toBeUndefined();
		expect(isLinuxMock).toHaveBeenCalled();
		expect(execFileNoThrowMock).not.toHaveBeenCalled();
	});

	it('falls back to $USER when os.userInfo() throws', async () => {
		userInfoMock.mockImplementation(() => {
			throw new Error('no passwd entry');
		});
		vi.stubEnv('USER', 'carol');
		try {
			expect(await checkUserLinger()).toEqual({
				linger: false,
				lingerFix: 'loginctl enable-linger carol',
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe('parseLingerProperty', () => {
	it('reads the Linger line only', () => {
		expect(parseLingerProperty('Linger=no')).toBe(false);
		expect(parseLingerProperty('Name=alice\nLinger=yes\n')).toBe(true);
		expect(parseLingerProperty('Linger=maybe')).toBeUndefined();
		expect(parseLingerProperty('')).toBeUndefined();
	});
});

describe('formatLingerWarning', () => {
	it('names the fix, and the remote it must run on when shown on the laptop', () => {
		expect(formatLingerWarning('loginctl enable-linger alice')).toContain(
			'lingering is off for this user'
		);
		const remote = formatLingerWarning('loginctl enable-linger alice', 'Build box');
		expect(remote).toContain('the SSH user on Build box');
		expect(remote).toContain('Turn it on on Build box with: loginctl enable-linger alice');
	});
});
