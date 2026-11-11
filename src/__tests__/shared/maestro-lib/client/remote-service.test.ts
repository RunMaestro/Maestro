/**
 * Tests for src/shared/maestro-lib/client/remote-service.ts: registering a Federation host with
 * the remote's service manager. The script is syntax-checked with bash and run for real against
 * stub `uname`, `systemctl`, `loginctl`, and `maestro-cli`, so its branches are exercised as a
 * remote would run them.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	LAUNCHD_LOGIN_NOTE,
	RemoteServiceError,
	buildHostServiceWrapper,
	buildLaunchdPlist,
	buildRemoteServiceScript,
	buildSystemdUnit,
	describeRemoteService,
	installRemoteService,
	parseRemoteServiceReport,
} from '../../../../shared/maestro-lib/client/remote-service';
import type { RemoteExec } from '../../../../shared/maestro-lib/client/remote-discovery';
import { isWindows } from '../../../../shared/platformDetection';
import type { SshRemoteConfig } from '../../../../shared/types';

const onPosix = !isWindows();
const remote: SshRemoteConfig = {
	id: 'r1',
	name: 'Build box',
	host: 'build.example.com',
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
};

let tmp: string;
beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-service-'));
});
afterAll(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run the script with stub tools first on PATH and a fresh HOME holding a stub launcher. */
function run(stubs: Record<string, string>, options: { launcher?: string } = {}) {
	const home = fs.mkdtempSync(path.join(tmp, 'home-'));
	const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
	const log = path.join(home, 'calls.log');
	for (const [name, body] of Object.entries(stubs)) {
		fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, {
			mode: 0o755,
		});
	}
	if (options.launcher !== undefined) {
		const launcherDir = path.join(home, '.maestro', 'bin');
		fs.mkdirSync(launcherDir, { recursive: true });
		fs.writeFileSync(path.join(launcherDir, 'maestro-cli'), `#!/bin/sh\n${options.launcher}\n`, {
			mode: 0o755,
		});
	}
	const result = spawnSync('bash', ['--norc', '--noprofile', '-c', buildRemoteServiceScript()], {
		env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: home },
		encoding: 'utf8',
	});
	const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
	return { stdout: result.stdout, status: result.status, home, calls };
}

const LINUX = { uname: '[ "$1" = -s ] && echo Linux || echo x86_64' };
const NOT_RUNNING = 'echo \'{ "running": false }\'';
const RUNNING = 'echo \'{ "running": true, "pid": 9 }\'';
/** systemctl that works; `is-active` answers from $ACTIVE. */
const systemctl = (active: boolean) =>
	`case "$2" in is-active) exit ${active ? 0 : 3};; *) exit 0;; esac`;

describe('the service files', () => {
	it('runs the host in the foreground with the PATH an SSH agent spawn gets', () => {
		const wrapper = buildHostServiceWrapper();
		expect(wrapper.startsWith('#!/bin/sh\n')).toBe(true);
		expect(wrapper).toContain('/bin/bash --norc --noprofile -c');
		expect(wrapper).toContain('$HOME/.maestro/bin');
		expect(wrapper).toContain('_nvm_dir');
		expect(wrapper).toContain('host start --foreground');
	});

	it('restarts on failure only, and gives the host time to drain on stop', () => {
		const unit = buildSystemdUnit();
		expect(unit).toContain('ExecStart=%h/.maestro/bin/maestro-host-service');
		expect(unit).toContain('Restart=on-failure');
		expect(unit).toContain('TimeoutStopSec=90');
		expect(unit).toContain('WantedBy=default.target');
		const plist = buildLaunchdPlist('/Users/me/.maestro/bin/maestro-host-service');
		expect(plist).toContain('<string>/Users/me/.maestro/bin/maestro-host-service</string>');
		expect(plist).toContain('<key>SuccessfulExit</key><false/>');
	});
});

describe('buildRemoteServiceScript', () => {
	it.skipIf(!onPosix)('is valid bash', () => {
		const check = spawnSync('bash', ['-n'], { input: buildRemoteServiceScript() });
		expect(check.stderr.toString()).toBe('');
		expect(check.status).toBe(0);
	});

	it.skipIf(!onPosix)('skips a remote with no launcher, and Windows', () => {
		expect(parseRemoteServiceReport(run(LINUX).stdout)).toMatchObject({
			kind: 'none',
			reason: 'no-launcher',
		});
		const windows = run({ uname: 'echo MINGW64_NT-10.0' }, { launcher: NOT_RUNNING });
		expect(parseRemoteServiceReport(windows.stdout)).toMatchObject({
			kind: 'none',
			reason: 'unsupported-os',
		});
	});

	it.skipIf(!onPosix)('skips Linux without a systemd user session, with the way round it', () => {
		const result = run({ ...LINUX, systemctl: 'exit 1' }, { launcher: NOT_RUNNING });
		const report = parseRemoteServiceReport(result.stdout);
		expect(report).toMatchObject({ kind: 'none', reason: 'no-systemd-user' });
		if (report?.kind === 'none') expect(report.fix).toContain('maestro-host-service');
		// The wrapper is written either way, so a person can run it from their own init.
		expect(fs.existsSync(path.join(result.home, '.maestro', 'bin', 'maestro-host-service'))).toBe(
			true
		);
	});

	it.skipIf(!onPosix)(
		'enables and starts the unit, and names the sudo fix when lingering stays off',
		() => {
			const result = run(
				{
					...LINUX,
					systemctl: systemctl(false),
					loginctl: '[ "$1" = show-user ] && echo no; [ "$1" = enable-linger ] && exit 1; exit 0',
					id: '[ "$1" = -un ] && echo pedram || echo 1000',
				},
				{ launcher: NOT_RUNNING }
			);
			expect(parseRemoteServiceReport(result.stdout)).toEqual({
				kind: 'systemd',
				state: 'started',
				linger: false,
				lingerFix: 'sudo loginctl enable-linger pedram',
			});
			const unit = path.join(result.home, '.config', 'systemd', 'user', 'maestro-host.service');
			expect(fs.readFileSync(unit, 'utf8')).toBe(buildSystemdUnit());
			expect(result.calls).toContain('systemctl --user enable maestro-host');
			expect(result.calls).toContain('systemctl --user start maestro-host');
		}
	);

	it.skipIf(!onPosix)(
		'turns lingering on when the user may, and never starts a second host',
		() => {
			const deferred = run(
				{
					...LINUX,
					systemctl: systemctl(false),
					loginctl: '[ "$1" = show-user ] && echo no; exit 0',
					id: '[ "$1" = -un ] && echo pedram || echo 1000',
				},
				{ launcher: RUNNING }
			);
			expect(parseRemoteServiceReport(deferred.stdout)).toEqual({
				kind: 'systemd',
				state: 'deferred',
				linger: true,
			});
			expect(deferred.calls).not.toContain('systemctl --user start');

			const active = run(
				{
					...LINUX,
					systemctl: systemctl(true),
					loginctl: '[ "$1" = show-user ] && echo yes; exit 0',
					id: '[ "$1" = -un ] && echo pedram || echo 1000',
				},
				{ launcher: RUNNING }
			);
			expect(parseRemoteServiceReport(active.stdout)).toMatchObject({
				kind: 'systemd',
				state: 'active',
			});
		}
	);
});

describe('parseRemoteServiceReport and describeRemoteService', () => {
	it('answers null when the script never ran', () => {
		expect(parseRemoteServiceReport('Welcome to the box')).toBeNull();
	});

	it('drops a linger fix that is not one plain command', () => {
		const report = parseRemoteServiceReport(
			'MAESTRO_SERVICE=kind=systemd\nMAESTRO_SERVICE=linger=off\nMAESTRO_SERVICE=lingerFix=rm -rf /\nMAESTRO_SERVICE=state=started'
		);
		expect(report).toEqual({ kind: 'systemd', state: 'started', linger: false });
	});

	it('says what a launchd agent needs, and what to do without a service', () => {
		const launchd = parseRemoteServiceReport(
			'MAESTRO_SERVICE=kind=launchd\nMAESTRO_SERVICE=state=deferred'
		);
		expect(launchd).toEqual({ kind: 'launchd', state: 'deferred', note: LAUNCHD_LOGIN_NOTE });
		expect(describeRemoteService(launchd!)).toContain('takes over from the running host');
		const none = parseRemoteServiceReport(
			'MAESTRO_SERVICE=kind=none\nMAESTRO_SERVICE=reason=desktop-app'
		);
		expect(describeRemoteService(none!)).toContain('Maestro.app is installed on this Mac');
	});
});

describe('installRemoteService', () => {
	it('runs the script over one ssh call and parses its report', async () => {
		const exec = vi.fn<RemoteExec>().mockResolvedValue({
			stdout:
				'MAESTRO_SERVICE=kind=systemd\nMAESTRO_SERVICE=linger=on\nMAESTRO_SERVICE=state=active',
			stderr: '',
			exitCode: 0,
		});
		expect(await installRemoteService(remote, { exec, sshPath: 'ssh' })).toEqual({
			kind: 'systemd',
			state: 'active',
			linger: true,
		});
		expect(exec).toHaveBeenCalledTimes(1);
		expect(exec.mock.calls[0][1]).toContain('pedram@build.example.com');
	});

	it('rejects when ssh failed or timed out', async () => {
		const failed = vi.fn<RemoteExec>().mockResolvedValue({
			stdout: '',
			stderr: 'ssh: connect to host build.example.com port 22: Connection refused',
			exitCode: 255,
		});
		await expect(installRemoteService(remote, { exec: failed, sshPath: 'ssh' })).rejects.toThrow(
			RemoteServiceError
		);
		const late = vi
			.fn<RemoteExec>()
			.mockResolvedValue({ stdout: '', stderr: '', exitCode: 'ETIMEDOUT' });
		await expect(installRemoteService(remote, { exec: late, sshPath: 'ssh' })).rejects.toThrow(
			/did not answer/
		);
	});
});
