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
	/** What `list agents --json` prints once `host stop` ran: an agent that arrived meanwhile. */
	agentsAfterStop?: string;
	/** The contents of `~/.maestro/host.env`. */
	hostEnv?: string;
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
	stub(bin, 'uname', `[ "$1" = -s ] && echo ${setup.os} || echo x86_64`);
	stub(bin, 'systemctl', 'case "$2" in is-enabled|is-active) exit 0;; *) exit 0;; esac');
	stub(bin, 'launchctl', `case "$1" in print-disabled) exit 0;; print) exit 0;; *) exit 0;; esac`);
	const state = path.join(home, 'host-running');
	if (setup.running) fs.writeFileSync(state, '');
	const agents = setup.agents === undefined ? '[]' : setup.agents;
	const agentsFile = path.join(home, 'agents.json');
	if (agents !== null) fs.writeFileSync(agentsFile, `${agents}\n`);
	const launcher = [
		`case "$1 $2" in`,
		`  "host endpoint") if [ -f "${state}" ]; then printf '{\\n  "running": true,\\n  "port": 4100,\\n  "token": "${TOKEN}",\\n  "pid": 812\\n}\\n'; else echo '{ "running": false }'; fi;;`,
		`  "version --json") ${setup.desktop ? `echo '{ "cliVersion": "1.1.2", "appRunning": true }'` : `echo '{ "cliVersion": "1.1.2", "appRunning": false, "hostKind": "headless", "hostPid": 812 }'`};;`,
		`  "list agents") ${agents === null ? 'exit 1' : `cat "${agentsFile}"`};;`,
		`  "host stop") ${setup.stopFails ? 'echo "Error: work in flight (1 turn)" >&2; exit 5' : `rm -f "${state}";${setup.agentsAfterStop ? ` printf '%s\\n' '${setup.agentsAfterStop}' > "${agentsFile}";` : ''} echo "Host stopped (pid 812)."`};;`,
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
		} else {
			const dir = path.join(home, 'Library', 'LaunchAgents');
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'sh.maestro.host.plist'), '<plist/>\n');
		}
	}
	if (setup.data) {
		const data = dataDirOf({ home, bin, log }, setup.os);
		fs.mkdirSync(data, { recursive: true });
		fs.writeFileSync(path.join(data, 'maestro-sessions.json'), '{}');
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
		'checks the agents again after the host stops, and keeps the data when one arrived',
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
				expect(result.warnings.join(' ')).toContain('an agent appeared');
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
