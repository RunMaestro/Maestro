/**
 * Durable SSH turns: the envelope, the reattach and the cleanup scripts.
 *
 * The real-process block runs each script under a local bash, which stands in
 * for the remote shell sshd starts (the same `bash --norc --noprofile -s`).
 * Killing that bash is what a lost link does to the remote side: the stream
 * dies, the agent and its supervisor do not. Nothing is mocked.
 *
 * POSIX only: the remote shell is bash.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	buildDurableLaunchScript,
	buildDurableReattachScript,
	buildTurnDirSweepScript,
	DURABLE_TURN_GONE_EXIT_CODE,
	DurableStderrReader,
} from '../../../../shared/maestro-lib/control/ssh-durable-turn';
import {
	buildPreLaunchReapScript,
	buildRemoteSignalScript,
	buildRemoteTurnCleanupScript,
	newRemoteTurnDir,
	SSH_STDIN_REMOTE_SHELL,
	withRemotePidRecord,
} from '../../../../shared/maestro-lib/control/ssh-remote-signal';

const posixOnly = describe.skipIf(process.platform === 'win32');

interface ShellRun {
	out: Buffer;
	err: Buffer;
	code: number | null;
}

/** Run `script` under bash; kill it once `killAfterBytes` of stdout arrived (a lost link). */
function runShell(script: string, killAfterBytes = 0): Promise<ShellRun> {
	return new Promise((resolve) => {
		const [shell, ...args] = SSH_STDIN_REMOTE_SHELL;
		const child = spawn(shell, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		let out = Buffer.alloc(0);
		let err = Buffer.alloc(0);
		child.stdout.on('data', (chunk: Buffer) => {
			out = Buffer.concat([out, chunk]);
			if (killAfterBytes && out.length >= killAfterBytes) child.kill('SIGKILL');
		});
		child.stderr.on('data', (chunk: Buffer) => {
			err = Buffer.concat([err, chunk]);
		});
		child.on('close', (code) => resolve({ out, err, code }));
		child.stdin.end(script);
	});
}

const dirs: string[] = [];
const pidFiles: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const file of pidFiles.splice(0)) fs.rmSync(file, { force: true });
});

function newPidFile(): string {
	const file = `/tmp/maestro-agent-${randomUUID()}.pid`;
	pidFiles.push(file);
	return file;
}

function newDir(): string {
	const dir = newRemoteTurnDir();
	dirs.push(dir);
	return dir;
}

/** Today's stdin for an agent that reads its prompt from stdin, then writes 40 lines. */
function todaysStdin(pidFile: string, lines = 40, exitCode = 3): string {
	const agent =
		`exec /bin/bash -c 'read -r p; for i in $(seq 1 ${lines}); do ` +
		`printf "line %s of %s \\303\\251\\n" "$i" "$p"; sleep 0.02; done; echo warn >&2; exit ${exitCode}'`;
	return withRemotePidRecord(`${agent}\n`, pidFile) + 'hello-prompt\n';
}

function expectedLines(lines = 40): string {
	return Array.from({ length: lines }, (_, i) => `line ${i + 1} of hello-prompt é\n`).join('');
}

describe('script text', () => {
	it("puts today's stdin, unchanged, after the envelope", () => {
		const inner = todaysStdin(newPidFile());
		const script = buildDurableLaunchScript(inner, newDir());
		expect(script.endsWith(`\n}\n${inner}`)).toBe(true);
		expect(script.startsWith('{\n')).toBe(true);
	});

	it('refuses a turn dir or pid file Maestro did not name', () => {
		expect(() => buildDurableLaunchScript('', '/tmp/evil; rm -rf ~')).toThrow();
		expect(() => buildDurableReattachScript(newRemoteTurnDir(), '/etc/passwd', 0, 0)).toThrow();
		expect(() => buildDurableReattachScript(newRemoteTurnDir(), newPidFile(), -1, 0)).toThrow();
		expect(() => buildDurableReattachScript(newRemoteTurnDir(), newPidFile(), 1.5, 0)).toThrow();
		expect(() => buildRemoteTurnCleanupScript('/tmp')).toThrow();
	});

	it('writes the offsets the stream resumes from', () => {
		const script = buildDurableReattachScript(newRemoteTurnDir(), newPidFile(), 1234, 56);
		expect(script).toContain('o=1234; e=56');
	});
});

const RS = '\x1e';
const US = '\x1f';

describe('DurableStderrReader', () => {
	it("passes ssh's own lines and the agent's framed stderr in order, and counts only the agent's", () => {
		const reader = new DurableStderrReader();
		expect(reader.push(Buffer.from('Warning: added host\n' + RS))).toBe('Warning: added host\n');
		expect(reader.launched).toBe(false);
		expect(reader.push(Buffer.from(`S\n${RS}D4\nab`))).toBe('');
		expect(reader.launched).toBe(true);
		expect(reader.attached).toBe(true);
		expect(reader.push(Buffer.from(`cd${US}`))).toBe('abcd');
		expect(reader.errOffset).toBe(4);
		expect(reader.push(Buffer.from(`${RS}E3\nShared connection closed.\n`))).toBe(
			'Shared connection closed.\n'
		);
		expect(reader.endCode).toBe(3);
	});

	it('drops a frame a drop cut, even when ssh wrote into it, and decodes a split character whole', () => {
		const reader = new DurableStderrReader();
		const e = Buffer.from('é');
		reader.push(Buffer.from(`${RS}S\n`));
		expect(
			reader.push(Buffer.concat([Buffer.from(`${RS}D1\n`), e.subarray(0, 1), Buffer.from(US)]))
		).toBe('');
		expect(reader.errOffset).toBe(1);
		// The next frame is cut; ssh's disconnect message lands where its bytes were due.
		reader.push(Buffer.from(`${RS}D9\nxyclient_loop: send disconnect: Broken pipe\n`));
		expect(reader.errOffset).toBe(1);
		reader.endAttempt();
		expect(reader.attached).toBe(false);
		// The reattach resends from offset 1: the rest of the character, then the cut frame.
		reader.push(Buffer.from(`${RS}S\n`));
		expect(
			reader.push(Buffer.concat([Buffer.from(`${RS}D1\n`), e.subarray(1), Buffer.from(US)]))
		).toBe('é');
		expect(reader.errOffset).toBe(2);
	});

	it("hands back ssh's partial last line at the end of an attempt", () => {
		const reader = new DurableStderrReader();
		expect(reader.push(Buffer.from('ssh: connect to host x port 22: Connection refused'))).toBe('');
		expect(reader.endAttempt()).toBe('ssh: connect to host x port 22: Connection refused');
		expect(reader.launched).toBe(false);
	});

	it('reports a gone turn', () => {
		const reader = new DurableStderrReader();
		reader.push(Buffer.from(`${RS}G\n`));
		expect(reader.gone).toBe(true);
		expect(reader.endCode).toBeNull();
	});
});

/** The agent's stderr as this machine reads it from one or more attempts. */
function readStderr(...attempts: Buffer[]): { text: string; reader: DurableStderrReader } {
	const reader = new DurableStderrReader();
	let text = '';
	for (const err of attempts) {
		text += reader.push(err);
		text += reader.endAttempt();
	}
	return { text, reader };
}

posixOnly('against a real shell', () => {
	it('a healthy turn streams exactly what the agent wrote, with its exit code', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		const plain = await runShell(todaysStdin(pidFile, 10));
		const durable = await runShell(buildDurableLaunchScript(todaysStdin(pidFile, 10), dir));
		expect(durable.out.toString()).toBe(plain.out.toString());
		expect(durable.out.toString()).toBe(expectedLines(10));
		expect(durable.code).toBe(plain.code);
		expect(durable.code).toBe(3);
		const { text, reader } = readStderr(durable.err);
		expect(text).toBe('warn\n');
		expect(text).toBe(plain.err.toString());
		expect(reader.endCode).toBe(3);
	}, 20_000);

	it('three lost links lose and repeat no byte', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		const first = await runShell(buildDurableLaunchScript(todaysStdin(pidFile), dir), 200);
		expect(first.code).toBeNull();
		let got = first.out;
		const reader = new DurableStderrReader();
		let err = reader.push(first.err) + reader.endAttempt();
		let code: number | null = null;
		for (let hop = 0; code === null; hop++) {
			expect(hop).toBeLessThan(10);
			const next = await runShell(
				buildDurableReattachScript(dir, pidFile, got.length, reader.errOffset),
				hop < 3 ? 200 : 0
			);
			got = Buffer.concat([got, next.out]);
			err += reader.push(next.err) + reader.endAttempt();
			code = next.code;
		}
		expect(got.toString()).toBe(expectedLines());
		expect(code).toBe(3);
		expect(reader.endCode).toBe(3);
		expect(err).toBe('warn\n');
	}, 30_000);

	it('an agent that exits 255 itself sends its end frame, so it is not a lost link', async () => {
		const pidFile = newPidFile();
		const run = await runShell(buildDurableLaunchScript(todaysStdin(pidFile, 1, 255), newDir()));
		expect(run.code).toBe(255);
		expect(readStderr(run.err).reader.endCode).toBe(255);
	}, 20_000);

	it("Stop through today's signal script ends the agent group while the link is down", async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		const inner = withRemotePidRecord(
			"exec /bin/bash -c 'sleep 30 & for i in $(seq 1 400); do echo tick $i; sleep 0.05; done'\n",
			pidFile
		);
		const first = await runShell(buildDurableLaunchScript(inner, dir), 20);
		const [pid] = fs.readFileSync(pidFile, 'utf8').split(' ');
		await runShell(buildRemoteSignalScript(pidFile, 'terminate'));
		const rest = await runShell(buildDurableReattachScript(dir, pidFile, first.out.length, 0));
		expect(rest.code).toBe(143);
		// The agent led its own group, so the tool it started went with it.
		expect(() => process.kill(-Number(pid), 0)).toThrow();
	}, 30_000);

	it('the cleanup leaves nothing, and a reattach then reports the turn gone', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		await runShell(buildDurableLaunchScript(todaysStdin(pidFile, 2), dir));
		expect(fs.existsSync(dir)).toBe(true);
		await runShell(buildRemoteTurnCleanupScript(dir));
		expect(fs.existsSync(dir)).toBe(false);
		const gone = await runShell(buildDurableReattachScript(dir, pidFile, 0, 0));
		expect(gone.code).toBe(DURABLE_TURN_GONE_EXIT_CODE);
		expect(readStderr(gone.err).reader.gone).toBe(true);
	}, 20_000);

	it('a reap carrying the turn dir stops the agent, then removes the dir', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		const inner = withRemotePidRecord("exec /bin/bash -c 'sleep 30'\n", pidFile);
		const launch = runShell(buildDurableLaunchScript(inner, dir));
		for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++)
			await new Promise((r) => setTimeout(r, 50));
		const [pid] = fs.readFileSync(pidFile, 'utf8').split(' ');
		await runShell(
			buildPreLaunchReapScript([
				{ sshCommand: 'ssh', sshArgs: [], pidFile, sessionId: 's', turnDir: dir },
			])
		);
		expect(() => process.kill(-Number(pid), 0)).toThrow();
		// The stream it fed ends too: with the agent's code, or as gone once the dir is removed.
		expect([143, DURABLE_TURN_GONE_EXIT_CODE]).toContain((await launch).code);
		expect(fs.existsSync(dir)).toBe(false);
	}, 20_000);

	it('a dir whose agent and supervisor are dead with no exit file is gone', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		fs.mkdirSync(dir, { mode: 0o700 });
		fs.writeFileSync(`${dir}/out`, 'partial');
		fs.writeFileSync(`${dir}/err`, '');
		fs.writeFileSync(`${dir}/sup`, '999999 Thu Jan  1 00:00:00 1970\n');
		const gone = await runShell(buildDurableReattachScript(dir, pidFile, 0, 0));
		expect(gone.code).toBe(DURABLE_TURN_GONE_EXIT_CODE);
		expect(gone.out.length).toBe(0);
	});

	it('the launch script and its secrets leave the disk before the agent runs; the files are private', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		// The agent reports whether `in` is still there, whether it holds the
		// envelope's fd 3, and its umask (which must be the user's, as today).
		const agent =
			`exec /bin/bash -c 'read -r p; [ -e ${dir}/in ] && echo in-present || echo in-gone; ` +
			`{ : <&3; } 2>/dev/null && echo fd3-open || echo fd3-closed; umask'`;
		const stdin = withRemotePidRecord(`${agent}\n`, pidFile) + 'API_KEY=secret\n';
		const plain = await runShell(stdin);
		const durable = await runShell(buildDurableLaunchScript(stdin, dir));
		expect(durable.out.toString()).toContain('in-gone\nfd3-closed\n');
		expect(durable.out.toString()).toBe(plain.out.toString());
		expect(fs.existsSync(`${dir}/in`)).toBe(false);
		for (const name of ['out', 'err']) {
			expect(fs.statSync(`${dir}/${name}`).mode & 0o777).toBe(0o600);
		}
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
	}, 20_000);
});

posixOnly('the sweep of finished turn dirs', () => {
	const scratch: string[] = [];
	afterEach(() => {
		for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});
	const mkScratch = (): string => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-sweep-')));
		scratch.push(dir);
		return dir;
	};
	const old = new Date('2020-01-01T00:00:00Z');
	const turnDir = (root: string, name: string, exitAge: Date | null): string => {
		const dir = path.join(root, name);
		fs.mkdirSync(dir);
		if (exitAge) {
			fs.writeFileSync(path.join(dir, 'exit'), '0\n');
			fs.utimesSync(path.join(dir, 'exit'), exitAge, exitAge);
		}
		return dir;
	};

	it('removes only old turn dirs named as Maestro names them, never a hostile name or a link', () => {
		const root = mkScratch(); // stands in for /tmp
		const home = mkScratch(); // the remote user's home: the sweep's cwd
		fs.mkdirSync(path.join(home, 'Documents'));
		fs.writeFileSync(path.join(home, 'Documents', 'keep'), 'mine');
		const outside = mkScratch();
		fs.writeFileSync(path.join(outside, 'exit'), '0\n');
		fs.utimesSync(path.join(outside, 'exit'), old, old);

		const stale = turnDir(root, `maestro-turn-${randomUUID()}`, old);
		const fresh = turnDir(root, `maestro-turn-${randomUUID()}`, new Date());
		const running = turnDir(root, `maestro-turn-${randomUUID()}`, null);
		// Another local user's traps: a newline that a `read` loop would split
		// into `Documents`, a name that is not a UUID, and a link to elsewhere.
		const hostile = turnDir(root, 'maestro-turn-a\nDocuments', old);
		const notUuid = turnDir(root, 'maestro-turn-x', old);
		const link = path.join(root, `maestro-turn-${randomUUID()}`);
		fs.symlinkSync(outside, link);

		execFileSync('/bin/bash', ['-c', buildTurnDirSweepScript(root)], { cwd: home });

		expect(fs.existsSync(stale)).toBe(false);
		for (const kept of [fresh, running, hostile, notUuid, link])
			expect(fs.existsSync(kept)).toBe(true);
		expect(fs.readFileSync(path.join(home, 'Documents', 'keep'), 'utf8')).toBe('mine');
		expect(fs.existsSync(path.join(outside, 'exit'))).toBe(true);
	});

	it('refuses a sweep root that is not a plain absolute path', () => {
		expect(() => buildTurnDirSweepScript('tmp')).toThrow();
		expect(() => buildTurnDirSweepScript("/tmp'; rm -rf ~; '")).toThrow();
		expect(buildDurableLaunchScript('', newRemoteTurnDir())).toContain(buildTurnDirSweepScript());
	});
});
