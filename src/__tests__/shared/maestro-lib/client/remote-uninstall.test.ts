/**
 * Tests for src/shared/maestro-lib/client/remote-uninstall.ts: stopping the Federation host on an
 * SSH remote and removing what Maestro installed there. The scripts are syntax-checked with bash
 * and run for real against a stub HOME with stub `uname`, `systemctl`, `launchctl` and a stub
 * `maestro-cli` launcher, so each branch runs the way a remote would run it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildRemoteHostStopScript,
	buildRemoteHostSurveyScript,
	describeHeldAgents,
	parseRemoteAgentList,
	parseRemoteHostSurvey,
	stopRemoteHost,
	RemoteHostStopError,
} from '../../../../shared/maestro-lib/client/remote-uninstall';
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
const TOKEN = 'tok-0f9e8d7c-secret-path-token';

let tmp: string;
beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-uninstall-'));
});
afterAll(() => {
	// A locked `default.target.wants` would stop the cleanup.
	spawnSync('chmod', ['-R', 'u+w', tmp]);
	fs.rmSync(tmp, { recursive: true, force: true });
});

interface Remote {
	home: string;
	bin: string;
	log: string;
}

interface RemoteSetup {
	os: 'Linux' | 'Darwin';
	/** Maestro's own install under ~/.maestro. */
	installed?: boolean;
	/** A headless host runs (the launcher's `host endpoint` says so until `host stop`). */
	running?: boolean;
	/** The running host is the desktop app. */
	desktop?: boolean;
	/** What `list agents --json` prints; omit for `[]`, null for a failure. */
	agents?: string | null;
	/** The service file Maestro wrote is there. */
	service?: boolean;
	/** A `maestro-cli` Maestro did not install, on PATH. */
	foreign?: boolean;
	/** The data directory exists; `desktop` puts the desktop app's marker in it. */
	data?: 'host' | 'desktop';
	/** `host stop` fails. */
	stopFails?: boolean;
	/** `host stop` stops the host, then exits non-zero (its wait for the process timed out). */
	stopExitsLate?: boolean;
	/** What `list agents --json` prints once `host stop` ran: an agent that arrived meanwhile. */
	agentsAfterStop?: string;
	/** The contents of `~/.maestro/host.env`. */
	hostEnv?: string;
	/** What `version --json` prints, in place of the headless or desktop answer. */
	version?: string;
	/** What `ps -o args= -p <pid>` prints for the host's pid. */
	ps?: string;
	/** No user bus: every `systemctl --user` call fails; `launchctl disable` fails. */
	disableFails?: boolean;
	/** The `default.target.wants` link `systemctl enable` made (Linux). */
	wantsLink?: boolean;
	/** The `default.target.wants` directory is read-only, so the link cannot be removed. */
	wantsLocked?: boolean;
	/** `host endpoint --json` fails with no answer (a discovery file other users can read). */
	endpointFails?: boolean;
	/** The contents of the data directory's `maestro-sessions.json`; omit for `{}`. */
	stored?: string;
	/** What `list agents --json` prints from its second call on: an agent that moved in meanwhile. */
	agentsLater?: string;
	/** The service file's folder is read-only, so the file cannot be removed. */
	serviceLocked?: boolean;
}

/** A fresh HOME and stub bin directory shaped like a remote Maestro set up. */
function makeRemote(setup: RemoteSetup): Remote {
	const home = fs.mkdtempSync(path.join(tmp, 'home-'));
	const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
	const log = path.join(home, 'calls.log');
	const stub = (dir: string, name: string, body: string) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, {
			mode: 0o755,
		});
	};
	const dataDir = dataDirOf({ home, bin, log }, setup.os);
	stub(bin, 'uname', `[ "$1" = -s ] && echo ${setup.os} || echo x86_64`);
	stub(bin, 'systemctl', setup.disableFails ? 'exit 1' : 'exit 0');
	stub(
		bin,
		'launchctl',
		`case "$1" in print-disabled) exit 0;; print) exit 0;; disable) exit ${setup.disableFails ? 1 : 0};; *) exit 0;; esac`
	);
	if (setup.ps !== undefined) stub(bin, 'ps', `printf '%s\\n' '${setup.ps}'`);
	const state = path.join(home, 'host-running');
	if (setup.running) fs.writeFileSync(state, '');
	const agents = setup.agents === undefined ? '[]' : setup.agents;
	const agentsFile = path.join(home, 'agents.json');
	if (agents !== null) fs.writeFileSync(agentsFile, `${agents}\n`);
	const laterFile = path.join(home, 'agents-later.json');
	if (setup.agentsLater !== undefined) fs.writeFileSync(laterFile, `${setup.agentsLater}\n`);
	const launcher = [
		`case "$1 $2" in`,
		setup.endpointFails
			? `  "host endpoint") echo '{ "error": "cli-server.json can be read by other users" }'; exit 1;;`
			: `  "host endpoint") if [ -f "${state}" ]; then printf '{\\n  "running": true,\\n  "port": 4100,\\n  "token": "${TOKEN}",\\n  "pid": 812\\n}\\n'; else echo '{ "running": false }'; fi;;`,
		`  "version --json") ${setup.version !== undefined ? `echo '${setup.version}'` : setup.desktop ? `echo '{ "cliVersion": "1.1.2", "appRunning": true }'` : `echo '{ "cliVersion": "1.1.2", "appRunning": false, "hostKind": "headless", "hostPid": 812 }'`};;`,
		`  "list agents") ${agents === null ? 'exit 1' : `cat "${agentsFile}"; if [ -f "${laterFile}" ]; then mv "${laterFile}" "${agentsFile}"; fi`};;`,
		`  "host stop") ${setup.stopFails ? 'echo "Error: work in flight (1 turn)" >&2; exit 5' : setup.stopExitsLate ? `rm -f "${state}"; echo "Error: timed out waiting for pid 812" >&2; exit 5` : `rm -f "${state}";${setup.agentsAfterStop ? ` printf '%s\\n' '${setup.agentsAfterStop}' > "${agentsFile}"; printf '%s\\n' '{"sessions":${setup.agentsAfterStop}}' > "${path.join(dataDir, 'maestro-sessions.json')}";` : ''} echo "Host stopped (pid 812)."`};;`,
		'esac',
	].join('\n');
	const root = path.join(home, '.maestro');
	if (setup.installed) {
		stub(path.join(root, 'bin'), 'maestro-cli', launcher);
		fs.writeFileSync(path.join(root, 'bin', 'maestro-host-service'), '#!/bin/sh\n', {
			mode: 0o755,
		});
		fs.mkdirSync(path.join(root, 'cli', 'prompts'), { recursive: true });
		fs.writeFileSync(path.join(root, 'cli', 'maestro-cli.js'), '');
		fs.mkdirSync(path.join(root, 'node', 'bin'), { recursive: true });
		fs.writeFileSync(path.join(root, 'host.env'), setup.hostEnv ?? 'EXTRA=1\n');
	}
	if (setup.foreign) {
		// Foreign only: it answers for the host when Maestro's own launcher is gone.
		stub(path.join(home, 'foreign-bin'), 'maestro-cli', launcher);
	}
	if (setup.service) {
		if (setup.os === 'Linux') {
			const dir = path.join(home, '.config', 'systemd', 'user');
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'maestro-host.service'), '[Unit]\n');
			if (setup.serviceLocked) fs.chmodSync(dir, 0o555);
			if (setup.wantsLink) {
				const wants = path.join(dir, 'default.target.wants');
				fs.mkdirSync(wants, { recursive: true });
				fs.symlinkSync(
					path.join(dir, 'maestro-host.service'),
					path.join(wants, 'maestro-host.service')
				);
				if (setup.wantsLocked) fs.chmodSync(wants, 0o555);
			}
		} else {
			const dir = path.join(home, 'Library', 'LaunchAgents');
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'sh.maestro.host.plist'), '<plist/>\n');
			if (setup.serviceLocked) fs.chmodSync(dir, 0o555);
		}
	}
	if (setup.data) {
		const data = dataDir;
		fs.mkdirSync(data, { recursive: true });
		fs.writeFileSync(path.join(data, 'maestro-sessions.json'), setup.stored ?? '{}');
		if (setup.data === 'desktop')
			fs.writeFileSync(path.join(data, 'maestro-window-state.json'), '{}');
	}
	return { home, bin, log };
}

function dataDirOf(r: Remote, osName: RemoteSetup['os']): string {
	return osName === 'Linux'
		? path.join(r.home, '.config', 'maestro')
		: path.join(r.home, 'Library', 'Application Support', 'Maestro');
}

function runScript(r: Remote, script: string) {
	const result = spawnSync('bash', ['--norc', '--noprofile', '-c', script], {
		env: {
			HOME: r.home,
			PATH: `${r.bin}:${path.join(r.home, 'foreign-bin')}:/usr/bin:/bin`,
			XDG_RUNTIME_DIR: r.home,
		},
		encoding: 'utf8',
	});
	const calls = fs.existsSync(r.log) ? fs.readFileSync(r.log, 'utf8') : '';
	return { stdout: result.stdout, stderr: result.stderr, status: result.status, calls };
}

/**
 * An `exec` that runs, on the stub remote, the bare script `stopRemoteHost()` asked for: the survey
 * or the act, with the options its wrapped form carries.
 */
function execOn(r: Remote): RemoteExec & { scripts: string[] } {
	const scripts: string[] = [];
	const exec = vi.fn<RemoteExec>(async (_command, args) => {
		const wrapped = args[args.length - 1];
		const script = wrapped.includes('UNINSTALL=')
			? buildRemoteHostStopScript({
					uninstall: wrapped.includes('UNINSTALL=1'),
					purgeData: wrapped.includes('PURGE=1'),
					force: wrapped.includes('FORCE=1'),
				})
			: buildRemoteHostSurveyScript({ agents: wrapped.includes('agents-begin') });
		scripts.push(script);
		const { stdout, stderr, status } = runScript(r, script);
		return { stdout, stderr, exitCode: status ?? 1 };
	});
	return Object.assign(exec, { scripts });
}

const exists = (r: Remote, ...parts: string[]) => fs.existsSync(path.join(r.home, ...parts));

describe('the scripts', () => {
	it.skipIf(!onPosix)('are valid bash', () => {
		for (const script of [
			buildRemoteHostSurveyScript(),
			buildRemoteHostSurveyScript({ agents: true }),
			buildRemoteHostStopScript(),
			buildRemoteHostStopScript({ uninstall: true, purgeData: true }),
		]) {
			const check = spawnSync('bash', ['-n'], { input: script });
			expect(check.stderr.toString()).toBe('');
			expect(check.status).toBe(0);
		}
	});

	it('stops the host before removing anything, and drains it with host stop --wait', () => {
		const script = buildRemoteHostStopScript({ uninstall: true });
		expect(script).toContain('host stop --wait 120');
		expect(script.indexOf('systemctl --user disable maestro-host')).toBeLessThan(
			script.indexOf('host stop --wait')
		);
		expect(script.indexOf('host stop --wait')).toBeLessThan(script.indexOf('rm -rf "$p"'));
		// host.env is the person's own file.
		expect(script).not.toMatch(/rm[^\n]*host\.env/);
	});
});

describe('surveying a Linux remote (systemd)', () => {
	it.skipIf(!onPosix)(
		'reads the service, the headless host, the agents and a foreign CLI, never printing the token',
		() => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				foreign: true,
				data: 'host',
				agents: '[\n  { "id": "a1", "name": "Backend" }\n]',
			});
			const { stdout } = runScript(r, buildRemoteHostSurveyScript({ agents: true }));
			expect(stdout).not.toContain(TOKEN);
			expect(parseRemoteHostSurvey(stdout)).toEqual({
				os: 'linux',
				installed: true,
				hasFiles: true,
				foreign: [path.join(r.home, 'foreign-bin', 'maestro-cli')],
				host: 'headless',
				pid: 812,
				service: {
					kind: 'systemd',
					file: path.join(r.home, '.config', 'systemd', 'user', 'maestro-host.service'),
					enabled: true,
					active: true,
				},
				dataDir: dataDirOf(r, 'Linux'),
				dataDirUsedByDesktop: false,
				storedAgents: 'none',
				agents: [{ id: 'a1', name: 'Backend' }],
			});
		}
	);

	it.skipIf(!onPosix)('says the agents are unknown when they cannot be listed', () => {
		const r = makeRemote({ os: 'Linux', installed: true, data: 'host', agents: null });
		const survey = parseRemoteHostSurvey(
			runScript(r, buildRemoteHostSurveyScript({ agents: true })).stdout
		);
		expect(survey?.agents).toBe('unknown');
	});
});

describe('stopRemoteHost on Linux (systemd)', () => {
	it.skipIf(!onPosix)(
		'stops the host and disables the unit, and leaves the install and data in place',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				data: 'host',
			});
			const exec = execOn(r);
			const result = await stopRemoteHost(remote, { exec, sshPath: 'ssh' });
			expect(result).toMatchObject({
				outcome: 'done',
				hostStopped: true,
				serviceDisabled: true,
				removed: [],
			});
			const calls = fs.readFileSync(r.log, 'utf8');
			expect(calls).toContain('systemctl --user disable maestro-host');
			expect(calls).toContain('maestro-cli host stop --wait 120');
			expect(calls).toContain('systemctl --user stop maestro-host');
			expect(exists(r, '.maestro', 'cli', 'maestro-cli.js')).toBe(true);
			expect(exists(r, '.config', 'systemd', 'user', 'maestro-host.service')).toBe(true);
			expect(fs.existsSync(dataDirOf(r, 'Linux'))).toBe(true);
			expect(exec).toHaveBeenCalledTimes(2);
		}
	);

	it.skipIf(!onPosix)(
		'refuses while the host holds agents, names them, and changes nothing',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				data: 'host',
				agents: '[{ "id": "a1", "name": "Backend" }, { "id": "a2", "name": "Docs" }]',
			});
			const exec = execOn(r);
			const result = await stopRemoteHost(remote, { exec, sshPath: 'ssh' });
			expect(result).toMatchObject({
				outcome: 'agents-held',
				agents: [
					{ id: 'a1', name: 'Backend' },
					{ id: 'a2', name: 'Docs' },
				],
			});
			if (result.outcome === 'agents-held') {
				expect(describeHeldAgents(result.agents)).toBe('2 agents: "Backend", "Docs"');
			}
			// One read-only call, and nothing on the remote changed.
			expect(exec).toHaveBeenCalledTimes(1);
			const calls = fs.readFileSync(r.log, 'utf8');
			expect(calls).not.toContain('host stop');
			expect(calls).not.toContain('disable');

			const forced = await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh', force: true });
			expect(forced).toMatchObject({ outcome: 'done', hostStopped: true });
		}
	);

	it.skipIf(!onPosix)(
		"uninstall removes the unit and Maestro's install, and keeps host.env, a foreign CLI and the data",
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				foreign: true,
				data: 'host',
			});
			const result = await stopRemoteHost(remote, {
				exec: execOn(r),
				sshPath: 'ssh',
				uninstall: true,
			});
			expect(result.outcome).toBe('done');
			expect(exists(r, '.config', 'systemd', 'user', 'maestro-host.service')).toBe(false);
			expect(exists(r, '.maestro', 'cli')).toBe(false);
			expect(exists(r, '.maestro', 'node')).toBe(false);
			expect(exists(r, '.maestro', 'bin', 'maestro-cli')).toBe(false);
			expect(exists(r, '.maestro', 'bin', 'maestro-host-service')).toBe(false);
			expect(exists(r, '.maestro', 'host.env')).toBe(true);
			expect(exists(r, 'foreign-bin', 'maestro-cli')).toBe(true);
			expect(fs.existsSync(path.join(dataDirOf(r, 'Linux'), 'maestro-sessions.json'))).toBe(true);
			if (result.outcome === 'done') {
				expect(result.kept).toEqual(
					expect.arrayContaining([
						path.join(r.home, '.maestro', 'host.env'),
						path.join(r.home, 'foreign-bin', 'maestro-cli'),
						dataDirOf(r, 'Linux'),
					])
				);
				expect(result.removed).toContain(path.join(r.home, '.maestro', 'cli'));
			}
			expect(fs.readFileSync(r.log, 'utf8')).toContain('systemctl --user daemon-reload');
		}
	);

	it.skipIf(!onPosix)('removes the data directory only with purgeData and no agents', async () => {
		const r = makeRemote({ os: 'Linux', installed: true, data: 'host' });
		await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh', uninstall: true });
		expect(fs.existsSync(dataDirOf(r, 'Linux'))).toBe(true);

		const purged = makeRemote({ os: 'Linux', installed: true, data: 'host' });
		const result = await stopRemoteHost(remote, {
			exec: execOn(purged),
			sshPath: 'ssh',
			uninstall: true,
			purgeData: true,
		});
		expect(result.outcome).toBe('done');
		expect(fs.existsSync(dataDirOf(purged, 'Linux'))).toBe(false);
	});

	it.skipIf(!onPosix)(
		'refuses purgeData while the host holds an agent, even with force',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				data: 'host',
				agents: '[{ "id": "a1", "name": "Backend" }]',
			});
			const exec = execOn(r);
			const result = await stopRemoteHost(remote, {
				exec,
				sshPath: 'ssh',
				uninstall: true,
				purgeData: true,
				force: true,
			});
			expect(result).toMatchObject({ outcome: 'purge-refused', reason: 'agents-held' });
			expect(exec).toHaveBeenCalledTimes(1);
			expect(exists(r, '.maestro', 'cli')).toBe(true);
			expect(fs.existsSync(dataDirOf(r, 'Linux'))).toBe(true);
		}
	);

	it.skipIf(!onPosix)(
		'refuses purgeData when the desktop app uses that data directory',
		async () => {
			const r = makeRemote({ os: 'Linux', installed: true, data: 'desktop' });
			const result = await stopRemoteHost(remote, {
				exec: execOn(r),
				sshPath: 'ssh',
				uninstall: true,
				purgeData: true,
			});
			expect(result).toMatchObject({ outcome: 'purge-refused', reason: 'desktop-data' });
			expect(fs.existsSync(path.join(dataDirOf(r, 'Linux'), 'maestro-window-state.json'))).toBe(
				true
			);
		}
	);

	it.skipIf(!onPosix)(
		'reports a host that would not stop, with its reason, and keeps the install',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				stopFails: true,
			});
			const failed = stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh', uninstall: true });
			await expect(failed).rejects.toBeInstanceOf(RemoteHostStopError);
			await expect(
				stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh', uninstall: true })
			).rejects.toThrow(/did not stop: Error: work in flight \(1 turn\)/);
			expect(exists(r, '.maestro', 'cli')).toBe(true);
		}
	);

	it.skipIf(!onPosix)('says there is nothing to do on a remote Maestro never set up', async () => {
		const r = makeRemote({ os: 'Linux' });
		expect(await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh' })).toMatchObject({
			outcome: 'nothing',
		});
	});
});

describe('stopRemoteHost on macOS (launchd)', () => {
	it.skipIf(!onPosix)('disables and boots out the agent on stop, and keeps the plist', async () => {
		const r = makeRemote({
			os: 'Darwin',
			installed: true,
			running: true,
			service: true,
			data: 'host',
		});
		const result = await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh' });
		expect(result).toMatchObject({ outcome: 'done', hostStopped: true, serviceDisabled: true });
		const calls = fs.readFileSync(r.log, 'utf8');
		expect(calls).toMatch(/launchctl disable (gui|user)\/\d+\/sh\.maestro\.host/);
		expect(calls).toMatch(/launchctl bootout (gui|user)\/\d+\/sh\.maestro\.host/);
		expect(exists(r, 'Library', 'LaunchAgents', 'sh.maestro.host.plist')).toBe(true);
	});

	it.skipIf(!onPosix)(
		'uninstall removes the plist and clears the disabled label for a later install',
		async () => {
			const r = makeRemote({ os: 'Darwin', installed: true, service: true, data: 'host' });
			const result = await stopRemoteHost(remote, {
				exec: execOn(r),
				sshPath: 'ssh',
				uninstall: true,
			});
			expect(result.outcome).toBe('done');
			expect(exists(r, 'Library', 'LaunchAgents', 'sh.maestro.host.plist')).toBe(false);
			expect(fs.readFileSync(r.log, 'utf8')).toMatch(
				/launchctl enable (gui|user)\/\d+\/sh\.maestro\.host/
			);
			expect(exists(r, '.maestro', 'cli')).toBe(false);
			expect(fs.existsSync(dataDirOf(r, 'Darwin'))).toBe(true);
		}
	);

	it.skipIf(!onPosix)('changes nothing where the desktop app is the host', async () => {
		const r = makeRemote({
			os: 'Darwin',
			installed: true,
			running: true,
			desktop: true,
			service: true,
			data: 'desktop',
		});
		const exec = execOn(r);
		const result = await stopRemoteHost(remote, {
			exec,
			sshPath: 'ssh',
			uninstall: true,
			force: true,
		});
		expect(result.outcome).toBe('desktop-host');
		expect(exec).toHaveBeenCalledTimes(1);
		const calls = fs.readFileSync(r.log, 'utf8');
		expect(calls).not.toContain('host stop');
		expect(calls).not.toContain('launchctl disable');
		expect(exists(r, '.maestro', 'cli')).toBe(true);
		expect(exists(r, 'Library', 'LaunchAgents', 'sh.maestro.host.plist')).toBe(true);
	});

	it.skipIf(!onPosix)(
		'the act script itself refuses a desktop host, should the survey be stale',
		() => {
			const r = makeRemote({
				os: 'Darwin',
				installed: true,
				running: true,
				desktop: true,
				service: true,
			});
			const { stdout, calls } = runScript(r, buildRemoteHostStopScript({ uninstall: true }));
			expect(stdout).toContain('MAESTRO_HOST=refused=desktop');
			expect(calls).not.toContain('launchctl disable');
			expect(exists(r, '.maestro', 'cli')).toBe(true);
		}
	);
});

describe('parseRemoteAgentList', () => {
	it('reads an array, JSON lines, and an empty answer, and refuses anything else', () => {
		expect(parseRemoteAgentList('[{"id":"a1","name":"A"}]')).toEqual([{ id: 'a1', name: 'A' }]);
		expect(parseRemoteAgentList('{"id":"a1","name":"A"}\n{"id":"a2"}')).toEqual([
			{ id: 'a1', name: 'A' },
			{ id: 'a2', name: 'a2' },
		]);
		expect(parseRemoteAgentList('')).toEqual([]);
		expect(parseRemoteAgentList('Error: no data')).toBeNull();
		expect(parseRemoteAgentList('[{"name":"no id"}]')).toBeNull();
	});

	it('drops control characters from what the remote sent, so a name cannot drive the terminal', () => {
		expect(
			parseRemoteAgentList('[{"id":"a1\\u0007","name":"Back\\u001b[2Jend\\r\\n\\u009b"}]')
		).toEqual([{ id: 'a1', name: 'Back[2Jend' }]);
		expect(parseRemoteAgentList('[{"id":"a1","name":"\\u001b\\u0007"}]')).toEqual([
			{ id: 'a1', name: 'a1' },
		]);
	});
});

describe('ssh failures', () => {
	it('rejects with the redacted ssh error when the remote did not run the script', async () => {
		const exec = vi.fn<RemoteExec>().mockResolvedValue({
			stdout: '',
			stderr: 'ssh: connect to host build.example.com port 22: Connection refused',
			exitCode: 255,
		});
		await expect(stopRemoteHost(remote, { exec, sshPath: 'ssh' })).rejects.toMatchObject({
			code: 'ssh-failed',
		});
		const late = vi
			.fn<RemoteExec>()
			.mockResolvedValue({ stdout: '', stderr: '', exitCode: 'ETIMEDOUT' });
		await expect(stopRemoteHost(remote, { exec: late, sshPath: 'ssh' })).rejects.toMatchObject({
			code: 'timeout',
		});
	});
});

describe('purgeData safety', () => {
	it.skipIf(!onPosix)(
		'never removes the home folder, however MAESTRO_USER_DATA spells it',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				hostEnv: 'export MAESTRO_USER_DATA="$HOME/"\n',
			});
			// Make home look like Maestro data, so only the path check stands in the way.
			fs.writeFileSync(path.join(r.home, 'maestro-sessions.json'), '{}');
			const result = await stopRemoteHost(remote, {
				exec: execOn(r),
				sshPath: 'ssh',
				uninstall: true,
				purgeData: true,
			});
			expect(result).toMatchObject({ outcome: 'done', purged: false });
			if (result.outcome === 'done') expect(result.warnings.join(' ')).toContain('home folder');
			expect(fs.existsSync(path.join(r.home, 'maestro-sessions.json'))).toBe(true);
			expect(fs.existsSync(r.log)).toBe(true);
		}
	);

	it.skipIf(!onPosix)('treats a data directory no CLI can read as holding agents', async () => {
		// An earlier `uninstall --force` took the CLI and left the agents' data.
		const r = makeRemote({ os: 'Linux', data: 'host' });
		const survey = parseRemoteHostSurvey(
			runScript(r, buildRemoteHostSurveyScript({ agents: true })).stdout
		);
		expect(survey?.agents).toBe('unknown');
		const result = await stopRemoteHost(remote, {
			exec: execOn(r),
			sshPath: 'ssh',
			uninstall: true,
			purgeData: true,
			force: true,
		});
		expect(result).toMatchObject({ outcome: 'purge-refused', reason: 'agents-held' });
		expect(fs.existsSync(dataDirOf(r, 'Linux'))).toBe(true);
	});

	it.skipIf(!onPosix)(
		'checks the store again right before the rm, and keeps the data when an agent arrived',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				data: 'host',
				agentsAfterStop: '[{ "id": "late", "name": "Imported" }]',
			});
			const result = await stopRemoteHost(remote, {
				exec: execOn(r),
				sshPath: 'ssh',
				uninstall: true,
				purgeData: true,
			});
			expect(result).toMatchObject({ outcome: 'done', hostStopped: true, purged: false });
			if (result.outcome === 'done')
				expect(result.warnings.join(' ')).toContain('its store still holds an agent');
			expect(fs.existsSync(path.join(dataDirOf(r, 'Linux'), 'maestro-sessions.json'))).toBe(true);
		}
	);
});

describe('a run cut off part way', () => {
	it.skipIf(!onPosix)('is never reported as done', async () => {
		const r = makeRemote({ os: 'Linux', installed: true, running: true, service: true });
		const real = execOn(r);
		const cut = vi.fn<RemoteExec>(async (command, args, options) => {
			const result = await real(command, args, options);
			// The act's output stops before its last line, as a dropped connection leaves it.
			return args[args.length - 1].includes('UNINSTALL=')
				? { ...result, stdout: result.stdout.replace(/MAESTRO_HOST=done\n?/, ''), exitCode: 255 }
				: result;
		});
		await expect(stopRemoteHost(remote, { exec: cut, sshPath: 'ssh' })).rejects.toMatchObject({
			code: 'incomplete',
		});
	});

	it.skipIf(!onPosix)('never trusts a survey that did not finish', async () => {
		const r = makeRemote({ os: 'Linux', installed: true, data: 'host' });
		const { stdout } = runScript(r, buildRemoteHostSurveyScript({ agents: true }));
		const cut = stdout.slice(0, stdout.indexOf('MAESTRO_HOST=data='));
		expect(parseRemoteHostSurvey(cut)).toBeNull();
	});
});

describe('a running host is asked for its agents', () => {
	it.skipIf(!onPosix)(
		'refuses without force when the host serves a data directory the guess missed',
		async () => {
			// No `data`: the directory the survey guesses is not there, but the host runs and holds one.
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				agents: '[{ "id": "a1", "name": "Backend" }]',
			});
			const exec = execOn(r);
			const result = await stopRemoteHost(remote, { exec, sshPath: 'ssh' });
			expect(result).toMatchObject({
				outcome: 'agents-held',
				agents: [{ id: 'a1', name: 'Backend' }],
			});
			expect(exec).toHaveBeenCalledTimes(1);
			expect(fs.readFileSync(r.log, 'utf8')).not.toContain('host stop');
		}
	);

	it.skipIf(!onPosix)(
		'reads agents=unknown when the running host cannot list them, and refuses without force',
		async () => {
			const r = makeRemote({ os: 'Linux', installed: true, running: true, agents: null });
			const exec = execOn(r);
			expect(await stopRemoteHost(remote, { exec, sshPath: 'ssh' })).toMatchObject({
				outcome: 'agents-held',
				agents: 'unknown',
			});
			expect(fs.readFileSync(r.log, 'utf8')).not.toContain('host stop');
			expect(
				await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh', force: true })
			).toMatchObject({ outcome: 'done', hostStopped: true });
		}
	);
});

describe('a boot service that could not be disabled', () => {
	it.skipIf(!onPosix)(
		'systemd with no user bus: removes the default.target.wants link and counts it disabled',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				wantsLink: true,
				disableFails: true,
			});
			const survey = parseRemoteHostSurvey(runScript(r, buildRemoteHostSurveyScript()).stdout);
			// `is-enabled` cannot answer with no bus; the link still says the unit starts at boot.
			expect(survey?.service).toMatchObject({ kind: 'systemd', enabled: true });
			const result = await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh' });
			expect(result).toMatchObject({
				outcome: 'done',
				serviceDisabled: true,
				serviceLeftAtBoot: false,
			});
			expect(
				fs.existsSync(
					path.join(
						r.home,
						'.config',
						'systemd',
						'user',
						'default.target.wants',
						'maestro-host.service'
					)
				)
			).toBe(false);
		}
	);

	it.skipIf(!onPosix || process.getuid?.() === 0)(
		'systemd: a link that cannot be removed fails the stop and says the host comes back at boot',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				wantsLink: true,
				wantsLocked: true,
				disableFails: true,
			});
			const { stdout } = runScript(r, buildRemoteHostStopScript());
			expect(stdout).toContain('MAESTRO_HOST=warn=service-disable-failed');
			expect(stdout).toContain('MAESTRO_HOST=boot=on');
			const result = await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh' });
			expect(result).toMatchObject({
				outcome: 'done',
				serviceDisabled: false,
				serviceLeftAtBoot: true,
			});
			if (result.outcome === 'done') {
				expect(result.warnings.join(' ')).toMatch(/comes back at the next boot/);
			}
		}
	);

	it.skipIf(!onPosix)(
		'launchd: a failed disable leaves the host at login on stop; uninstall removes the plist',
		async () => {
			const r = makeRemote({
				os: 'Darwin',
				installed: true,
				running: true,
				service: true,
				disableFails: true,
			});
			const stopped = await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh' });
			expect(stopped).toMatchObject({ outcome: 'done', serviceLeftAtBoot: true });
			if (stopped.outcome === 'done') {
				expect(stopped.warnings.join(' ')).toMatch(/comes back at the next login/);
			}

			const removed = await stopRemoteHost(remote, {
				exec: execOn(r),
				sshPath: 'ssh',
				uninstall: true,
			});
			expect(removed).toMatchObject({ outcome: 'done', serviceLeftAtBoot: false });
			expect(exists(r, 'Library', 'LaunchAgents', 'sh.maestro.host.plist')).toBe(false);
		}
	);
});

describe('a running host whose CLI does not say what it is', () => {
	const noKind = '{ "cliVersion": "1.1.1" }';

	it.skipIf(!onPosix)('is a headless host when its process is maestro-cli', async () => {
		const r = makeRemote({
			os: 'Linux',
			installed: true,
			running: true,
			service: true,
			version: noKind,
			ps: '/usr/bin/node /home/u/.maestro/cli/maestro-cli.js host start --foreground',
		});
		const survey = parseRemoteHostSurvey(runScript(r, buildRemoteHostSurveyScript()).stdout);
		expect(survey?.host).toBe('headless');
		expect(await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh' })).toMatchObject({
			outcome: 'done',
			hostStopped: true,
		});
	});

	it.skipIf(!onPosix)('is the desktop app when its process is the app', () => {
		const r = makeRemote({
			os: 'Linux',
			installed: true,
			running: true,
			version: noKind,
			ps: '/opt/Maestro/maestro --no-sandbox',
		});
		const survey = parseRemoteHostSurvey(runScript(r, buildRemoteHostSurveyScript()).stdout);
		expect(survey?.host).toBe('desktop');
	});

	it.skipIf(!onPosix)(
		'is unknown otherwise: never taken for the desktop app, stopped only with force',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				version: noKind,
				ps: 'something-else',
			});
			const exec = execOn(r);
			expect(await stopRemoteHost(remote, { exec, sshPath: 'ssh' })).toMatchObject({
				outcome: 'host-unknown',
			});
			expect(fs.readFileSync(r.log, 'utf8')).not.toContain('host stop');
			expect(
				await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh', force: true })
			).toMatchObject({ outcome: 'done', hostStopped: true });
		}
	);
});

describe('a host whose state cannot be read is never taken for stopped', () => {
	it.skipIf(!onPosix)(
		'reads a failed host endpoint as unknown, and refuses without force',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				endpointFails: true,
			});
			const survey = parseRemoteHostSurvey(
				runScript(r, buildRemoteHostSurveyScript({ agents: true })).stdout
			);
			expect(survey).toMatchObject({ host: 'unknown', hostUnreadable: true });
			const exec = execOn(r);
			const result = await stopRemoteHost(remote, { exec, sshPath: 'ssh', uninstall: true });
			expect(result).toMatchObject({ outcome: 'host-unknown' });
			expect(exec).toHaveBeenCalledTimes(1);
			expect(fs.readFileSync(r.log, 'utf8')).not.toContain('host stop');
			expect(exists(r, '.maestro', 'bin', 'maestro-cli')).toBe(true);
		}
	);

	it.skipIf(!onPosix)(
		'with force, stops it, and fails while the host does not answer that it stopped',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				endpointFails: true,
			});
			const error = await stopRemoteHost(remote, {
				exec: execOn(r),
				sshPath: 'ssh',
				uninstall: true,
				force: true,
			}).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(RemoteHostStopError);
			expect(error).toMatchObject({
				code: 'still-running',
				progress: { hostStopped: true, serviceDisabled: true },
			});
			expect(fs.readFileSync(r.log, 'utf8')).toContain('host stop --wait');
			// Nothing was removed under a host that may still run.
			expect(exists(r, '.maestro', 'bin', 'maestro-cli')).toBe(true);
			expect(exists(r, '.config', 'systemd', 'user', 'maestro-host.service')).toBe(true);
		}
	);
});

describe('an agent list cut off part way', () => {
	it('is unknown, never "none"', () => {
		const out = [
			'MAESTRO_HOST=os=linux',
			'MAESTRO_HOST=host=headless',
			'MAESTRO_HOST=service=none',
			'MAESTRO_HOST=surveyed=1',
			'MAESTRO_HOST=agents-begin',
		].join('\n');
		expect(parseRemoteHostSurvey(out)?.agents).toBe('unknown');
		expect(parseRemoteHostSurvey(`${out}\n[]\nMAESTRO_HOST=agents-end\n`)?.agents).toEqual([]);
	});
});

describe('the agents are read again right before the stop', () => {
	it.skipIf(!onPosix)(
		'refuses without force when one moved onto the host since the survey',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				agentsLater: '[{ "id": "late", "name": "Imported" }]',
			});
			const result = await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh' });
			expect(result).toMatchObject({
				outcome: 'agents-held',
				agents: [{ id: 'late', name: 'Imported' }],
			});
			const calls = fs.readFileSync(r.log, 'utf8');
			expect(calls).not.toContain('host stop');
			expect(calls).not.toContain('systemctl --user disable');
		}
	);
});

describe('purge reads the store, not the agent list', () => {
	it.skipIf(!onPosix)(
		'keeps a data directory whose store holds an agent the list hides',
		async () => {
			// A stored Pianola agent while Pianola is off: `list agents` shows none.
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				data: 'host',
				stored: '{"sessions":[{"id":"pianola-1","name":"Pianola"}]}',
			});
			const result = await stopRemoteHost(remote, {
				exec: execOn(r),
				sshPath: 'ssh',
				uninstall: true,
				purgeData: true,
				force: true,
			});
			expect(result).toMatchObject({ outcome: 'purge-refused', reason: 'stored-agents' });
			expect(fs.existsSync(path.join(dataDirOf(r, 'Linux'), 'maestro-sessions.json'))).toBe(true);
			expect(exists(r, '.maestro', 'bin', 'maestro-cli')).toBe(true);
		}
	);

	it.skipIf(!onPosix)('never removes ~/.maestro or a directory holding host.env', async () => {
		const r = makeRemote({
			os: 'Linux',
			installed: true,
			hostEnv: 'export MAESTRO_USER_DATA="$HOME/.maestro"\n',
		});
		// An empty Maestro store in ~/.maestro, so only the host.env rule stands in the way.
		fs.writeFileSync(path.join(r.home, '.maestro', 'maestro-sessions.json'), '{}');
		const result = await stopRemoteHost(remote, {
			exec: execOn(r),
			sshPath: 'ssh',
			uninstall: true,
			purgeData: true,
		});
		expect(result).toMatchObject({ outcome: 'done', purged: false });
		expect(exists(r, '.maestro', 'host.env')).toBe(true);
	});
});

describe('a service file that cannot be removed', () => {
	it.skipIf(!onPosix)(
		'systemd: fails the uninstall and keeps what the stop already did',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				serviceLocked: true,
			});
			const error = await stopRemoteHost(remote, {
				exec: execOn(r),
				sshPath: 'ssh',
				uninstall: true,
			}).catch((caught: unknown) => caught);
			expect(error).toMatchObject({
				code: 'remove',
				progress: { hostStopped: true, serviceDisabled: true },
			});
			expect(exists(r, '.config', 'systemd', 'user', 'maestro-host.service')).toBe(true);
		}
	);

	it.skipIf(!onPosix)('launchd: fails, and never enables the label again', async () => {
		const r = makeRemote({
			os: 'Darwin',
			installed: true,
			running: true,
			service: true,
			serviceLocked: true,
		});
		await expect(
			stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh', uninstall: true })
		).rejects.toMatchObject({ code: 'remove' });
		expect(exists(r, 'Library', 'LaunchAgents', 'sh.maestro.host.plist')).toBe(true);
		expect(fs.readFileSync(r.log, 'utf8')).not.toContain('launchctl enable');
	});
});

describe('a partial install left behind', () => {
	it.skipIf(!onPosix)('is found and removed by a retry', async () => {
		const r = makeRemote({ os: 'Linux' });
		// An earlier uninstall removed the launcher, cli and node, and stopped at the npm cache.
		fs.mkdirSync(path.join(r.home, '.maestro', 'npm-cache'), { recursive: true });
		const survey = parseRemoteHostSurvey(runScript(r, buildRemoteHostSurveyScript()).stdout);
		expect(survey?.hasFiles).toBe(true);
		const result = await stopRemoteHost(remote, {
			exec: execOn(r),
			sshPath: 'ssh',
			uninstall: true,
		});
		expect(result).toMatchObject({ outcome: 'done' });
		expect(exists(r, '.maestro', 'npm-cache')).toBe(false);
	});
});

describe('Greptile review of #2193', () => {
	it.skipIf(!onPosix)('reads a cut-off or malformed store as unknown, never empty', async () => {
		const r = makeRemote({ os: 'Linux', installed: true, data: 'host', stored: '{"sessions": [' });
		const survey = parseRemoteHostSurvey(
			runScript(r, buildRemoteHostSurveyScript({ agents: true })).stdout
		);
		expect(survey?.storedAgents).toBe('unknown');
		const result = await stopRemoteHost(remote, {
			exec: execOn(r),
			sshPath: 'ssh',
			uninstall: true,
			purgeData: true,
		});
		expect(result).toMatchObject({ outcome: 'purge-refused', reason: 'stored-agents' });
		expect(fs.existsSync(path.join(dataDirOf(r, 'Linux'), 'maestro-sessions.json'))).toBe(true);
	});

	it.skipIf(!onPosix)('reads an exactly empty store as none', () => {
		const r = makeRemote({
			os: 'Linux',
			installed: true,
			data: 'host',
			stored: '{\n\t"sessions": []\n}\n',
		});
		const survey = parseRemoteHostSurvey(
			runScript(r, buildRemoteHostSurveyScript({ agents: true })).stdout
		);
		expect(survey?.storedAgents).toBe('none');
	});

	it.skipIf(!onPosix)(
		'counts a host stop that exited non-zero but left the host stopped as a stop',
		async () => {
			const r = makeRemote({
				os: 'Linux',
				installed: true,
				running: true,
				service: true,
				stopExitsLate: true,
			});
			expect(await stopRemoteHost(remote, { exec: execOn(r), sshPath: 'ssh' })).toMatchObject({
				outcome: 'done',
				hostStopped: true,
			});
		}
	);

	it.skipIf(!onPosix)('keeps what the act did when it timed out part way', async () => {
		const r = makeRemote({ os: 'Linux', installed: true, running: true, service: true });
		const real = execOn(r);
		const hung = vi.fn<RemoteExec>(async (command, args, options) => {
			const result = await real(command, args, options);
			if (!args[args.length - 1].includes('UNINSTALL=')) return result;
			// The act stopped the host and disabled its service, then hung before it finished.
			const cut = result.stdout.slice(0, result.stdout.indexOf('MAESTRO_HOST=done'));
			return { ...result, stdout: cut, exitCode: 'ETIMEDOUT' };
		});
		await expect(stopRemoteHost(remote, { exec: hung, sshPath: 'ssh' })).rejects.toMatchObject({
			code: 'timeout',
			progress: { hostStopped: true, serviceDisabled: true },
		});
	});
});
