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
	DURABLE_STDOUT_START,
	DURABLE_TURN_GONE_EXIT_CODE,
	DurableStderrReader,
	incompleteUtf8TailLength,
	MAX_STDERR_FRAME_BYTES,
} from '../../../../shared/maestro-lib/control/ssh-durable-turn';
import {
	buildDurableInterruptScript,
	buildPreLaunchReapScript,
	buildRemoteSignalScript,
	buildRemoteTurnCleanupScript,
	newRemoteTurnDir,
	PRE_LAUNCH_REAP_REFUSED_EXIT_CODE,
	PRE_LAUNCH_REAP_REFUSED_MESSAGE,
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

/** The agent's stdout of a run: every attempt's start marker taken out. */
function agentOut(out: Buffer): Buffer {
	const parts: Buffer[] = [];
	let rest = out;
	for (
		let at = rest.indexOf(DURABLE_STDOUT_START);
		at >= 0;
		at = rest.indexOf(DURABLE_STDOUT_START)
	) {
		parts.push(rest.subarray(0, at));
		rest = rest.subarray(at + DURABLE_STDOUT_START.length);
	}
	parts.push(rest);
	return Buffer.concat(parts);
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
		const pidFile = newPidFile();
		const inner = todaysStdin(pidFile);
		const script = buildDurableLaunchScript(inner, newDir(), pidFile);
		expect(script.endsWith(`\n}\n${inner}`)).toBe(true);
		expect(script.startsWith('{\n')).toBe(true);
	});

	it('refuses a turn dir or pid file Maestro did not name', () => {
		expect(() => buildDurableLaunchScript('', '/tmp/evil; rm -rf ~', newPidFile())).toThrow();
		expect(() => buildDurableLaunchScript('', newRemoteTurnDir(), '/etc/passwd')).toThrow();
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
	it('finds the start frame behind ssh text that has no line end', () => {
		const reader = new DurableStderrReader();
		expect(reader.push(Buffer.from(`Warning: no newline${RS}S\n${RS}D2\nok${US}`))).toBe(
			'Warning: no newline\nok'
		);
		expect(reader.launched).toBe(true);
		// A frame header inside a data payload is the agent's data, not a frame.
		expect(reader.push(Buffer.from(`${RS}D3\na${RS}b${US}`))).toBe(`a${RS}b`);
		expect(reader.errOffset).toBe(5);
	});

	it("passes ssh's own lines until the agent runs, then keeps them apart from the agent's stderr", () => {
		const reader = new DurableStderrReader();
		expect(reader.push(Buffer.from('Warning: added host\n' + RS))).toBe('Warning: added host\n');
		expect(reader.launched).toBe(false);
		expect(reader.push(Buffer.from(`S\n${RS}D4\nab`))).toBe('');
		expect(reader.launched).toBe(true);
		expect(reader.attached).toBe(true);
		expect(reader.push(Buffer.from(`cd${US}`))).toBe('abcd');
		expect(reader.errOffset).toBe(4);
		// ssh's own words once the agent runs are diagnostics, never agent stderr:
		// a link that drops and recovers must not read as an agent error.
		expect(reader.push(Buffer.from(`client_loop: send disconnect: Broken pipe\n`))).toBe('');
		expect(reader.push(Buffer.from(`${RS}E3\nShared connection closed.\n`))).toBe('');
		expect(reader.endAttempt()).toBe('');
		expect(reader.sshDiagnostics).toBe(
			'client_loop: send disconnect: Broken pipe\nShared connection closed.\n'
		);
		expect(reader.endCode).toBe(3);
	});

	it('resumes a restart before a character the last frame cut, and the reconnect from the byte', () => {
		const reader = new DurableStderrReader();
		const e = Buffer.from('é');
		reader.push(Buffer.from(`${RS}S\n`));
		expect(
			reader.push(Buffer.concat([Buffer.from(`${RS}D2\nx`), e.subarray(0, 1), Buffer.from(US)]))
		).toBe('x');
		// A reconnect keeps this reader and its pending byte; a restart starts a new one.
		expect(reader.errOffset).toBe(2);
		expect(reader.restartErrOffset).toBe(1);
		const restarted = new DurableStderrReader(reader.restartErrOffset);
		restarted.push(Buffer.from(`${RS}S\n`));
		expect(restarted.push(Buffer.concat([Buffer.from(`${RS}D2\n`), e, Buffer.from(US)]))).toBe('é');
		expect(restarted.errOffset).toBe(3);
		expect(restarted.restartErrOffset).toBe(3);
	});

	it('finds the start of an incomplete UTF-8 character', () => {
		const four = Buffer.from('😀');
		expect(incompleteUtf8TailLength(Buffer.from('abc'))).toBe(0);
		expect(incompleteUtf8TailLength(four)).toBe(0);
		for (let n = 1; n < 4; n++) expect(incompleteUtf8TailLength(four.subarray(0, n))).toBe(n);
		expect(incompleteUtf8TailLength(Buffer.from('é').subarray(0, 1))).toBe(1);
		expect(incompleteUtf8TailLength(Buffer.from([0x80, 0x80]))).toBe(0);
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
		expect(reader.push(Buffer.from(`${RS}D9\nxyclient_loop: send disconnect: Broken pipe\n`))).toBe(
			''
		);
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
		const durable = await runShell(
			buildDurableLaunchScript(todaysStdin(pidFile, 10), dir, pidFile)
		);
		expect(durable.out.subarray(0, DURABLE_STDOUT_START.length)).toEqual(DURABLE_STDOUT_START);
		expect(agentOut(durable.out).toString()).toBe(plain.out.toString());
		expect(agentOut(durable.out).toString()).toBe(expectedLines(10));
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
		const first = await runShell(buildDurableLaunchScript(todaysStdin(pidFile), dir, pidFile), 200);
		expect(first.code).toBeNull();
		let got = agentOut(first.out);
		const reader = new DurableStderrReader();
		let err = reader.push(first.err) + reader.endAttempt();
		let code: number | null = null;
		for (let hop = 0; code === null; hop++) {
			expect(hop).toBeLessThan(10);
			const next = await runShell(
				buildDurableReattachScript(dir, pidFile, got.length, reader.errOffset),
				hop < 3 ? 200 : 0
			);
			got = Buffer.concat([got, agentOut(next.out)]);
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
		const run = await runShell(
			buildDurableLaunchScript(todaysStdin(pidFile, 1, 255), newDir(), pidFile)
		);
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
		const first = await runShell(
			buildDurableLaunchScript(inner, dir, pidFile),
			DURABLE_STDOUT_START.length + 20
		);
		const [pid] = fs.readFileSync(pidFile, 'utf8').split(' ');
		await runShell(buildRemoteSignalScript(pidFile, 'terminate'));
		const rest = await runShell(
			buildDurableReattachScript(dir, pidFile, agentOut(first.out).length, 0)
		);
		expect(rest.code).toBe(143);
		// The agent led its own group, so the tool it started went with it.
		expect(() => process.kill(-Number(pid), 0)).toThrow();
	}, 30_000);

	it('the cleanup leaves nothing, and a reattach then reports the turn gone', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		await runShell(buildDurableLaunchScript(todaysStdin(pidFile, 2), dir, pidFile));
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
		const launch = runShell(buildDurableLaunchScript(inner, dir, pidFile));
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
		const durable = await runShell(buildDurableLaunchScript(stdin, dir, pidFile));
		expect(agentOut(durable.out).toString()).toContain('in-gone\nfd3-closed\n');
		expect(agentOut(durable.out).toString()).toBe(plain.out.toString());
		expect(fs.existsSync(`${dir}/in`)).toBe(false);
		for (const name of ['out', 'err']) {
			expect(fs.statSync(`${dir}/${name}`).mode & 0o777).toBe(0o600);
		}
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
	}, 20_000);

	const waitFor = async (check: () => boolean): Promise<void> => {
		for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
		expect(check()).toBe(true);
	};

	it('a stream on a live link ends as gone when the agent and its supervisor die without an exit', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		const inner = withRemotePidRecord(
			"exec /bin/bash -c 'echo started; echo oops >&2; sleep 60'\n",
			pidFile
		);
		const launch = runShell(buildDurableLaunchScript(inner, dir, pidFile));
		await waitFor(() => fs.existsSync(pidFile) && fs.existsSync(`${dir}/sup`));
		const [agent] = fs.readFileSync(pidFile, 'utf8').split(' ');
		const [supervisor] = fs.readFileSync(`${dir}/sup`, 'utf8').split(' ');
		// Out of memory, or a reboot: both go at once and nobody writes `exit`.
		process.kill(Number(supervisor), 'SIGKILL');
		process.kill(-Number(agent), 'SIGKILL');
		const run = await launch;
		expect(run.code).toBe(DURABLE_TURN_GONE_EXIT_CODE);
		expect(fs.existsSync(`${dir}/exit`)).toBe(false);
		// What they wrote before they died still arrived, once.
		expect(agentOut(run.out).toString()).toBe('started\n');
		const { text, reader } = readStderr(run.err);
		expect(text).toBe('oops\n');
		expect(reader.gone).toBe(true);
	}, 20_000);

	it('a stderr backlog is sent in bounded frames and arrives whole', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		const size = MAX_STDERR_FRAME_BYTES * 3 + 123;
		const inner = withRemotePidRecord(
			`exec /bin/bash -c 'head -c ${size} /dev/zero | tr "\\0" "x" >&2; exit 0'\n`,
			pidFile
		);
		const run = await runShell(buildDurableLaunchScript(inner, dir, pidFile));
		expect(run.code).toBe(0);
		const headers = [...run.err.toString('latin1').matchAll(/\x1eD(\d+)\n/g)].map((m) =>
			Number(m[1])
		);
		expect(headers.length).toBeGreaterThanOrEqual(4);
		expect(Math.max(...headers)).toBeLessThanOrEqual(MAX_STDERR_FRAME_BYTES);
		const { text, reader } = readStderr(run.err);
		expect(text).toBe('x'.repeat(size));
		expect(reader.errOffset).toBe(size);
		expect(reader.endCode).toBe(0);
	}, 20_000);

	it('a reap finds the agent through the dir copy after the day-old sweep took its pid record', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		const inner = withRemotePidRecord("exec /bin/bash -c 'sleep 30'\n", pidFile);
		const launch = runShell(buildDurableLaunchScript(inner, dir, pidFile));
		await waitFor(() => fs.existsSync(pidFile) && fs.existsSync(`${dir}/agent`));
		const [pid] = fs.readFileSync(pidFile, 'utf8').split(' ');
		expect(fs.readFileSync(`${dir}/agent`, 'utf8')).toBe(fs.readFileSync(pidFile, 'utf8'));
		fs.rmSync(pidFile);
		await runShell(
			buildPreLaunchReapScript([
				{ sshCommand: 'ssh', sshArgs: [], pidFile, sessionId: 's', turnDir: dir },
			])
		);
		expect(() => process.kill(-Number(pid), 0)).toThrow();
		expect([143, DURABLE_TURN_GONE_EXIT_CODE]).toContain((await launch).code);
		expect(fs.existsSync(dir)).toBe(false);
	}, 20_000);

	it('a launch whose earlier turn names no agent yet keeps that dir and never starts its own agent', async () => {
		const dir = newDir();
		fs.mkdirSync(dir, { mode: 0o700 });
		fs.writeFileSync(`${dir}/out`, 'partial');
		const launch =
			buildPreLaunchReapScript([
				{ sshCommand: 'ssh', sshArgs: [], pidFile: newPidFile(), sessionId: 's', turnDir: dir },
			]) + 'echo launched\n';
		const run = await runShell(launch);
		// No exit file and no record naming the agent (a Stop that beat the
		// supervisor's record): nothing proves it stopped, so the reap retries
		// and the new agent waits.
		expect(run.code).toBe(PRE_LAUNCH_REAP_REFUSED_EXIT_CODE);
		expect(run.out.toString()).toBe('');
		expect(run.err.toString()).toBe(`${PRE_LAUNCH_REAP_REFUSED_MESSAGE}\n`);
		expect(fs.existsSync(dir)).toBe(true);
	}, 20_000);

	it('a terminate that cannot see its agent go keeps the record and the dir, and a retry finishes the job', async () => {
		const dir = newDir();
		const pidFile = newPidFile();
		fs.mkdirSync(dir, { mode: 0o700 });
		// A zombie no parent reaps answers `kill -0` and keeps its start time
		// through SIGKILL: an agent the terminate cannot see go.
		const zombieFile = path.join(os.tmpdir(), `durable-zombie-${randomUUID()}`);
		pidFiles.push(zombieFile);
		const parent = spawn(
			'/bin/bash',
			['-c', `sh -c 'echo $$ > ${zombieFile}; exit 0' & exec sleep 30`],
			{ stdio: 'ignore', detached: true }
		);
		try {
			for (let i = 0; i < 100 && !fs.existsSync(zombieFile); i++)
				await new Promise((r) => setTimeout(r, 50));
			await new Promise((r) => setTimeout(r, 200));
			const zombie = fs.readFileSync(zombieFile, 'utf8').trim();
			const started = execFileSync('ps', ['-o', 'lstart=', '-p', zombie]).toString().trim();
			fs.writeFileSync(`${dir}/agent`, `${zombie} ${started}\n`);
			const target = { sshCommand: 'ssh', sshArgs: [], pidFile, sessionId: 's', turnDir: dir };
			const first = await runShell(buildPreLaunchReapScript([target]) + 'echo launched\n');
			expect(first.code).toBe(PRE_LAUNCH_REAP_REFUSED_EXIT_CODE);
			expect(first.out.toString()).toBe('');
			expect(fs.readFileSync(`${dir}/agent`, 'utf8')).toContain(zombie);
			expect(fs.existsSync(dir)).toBe(true);
			// Its parent goes, the zombie is reaped: the retry proves it gone.
			process.kill(parent.pid!, 'SIGKILL');
			await new Promise((r) => setTimeout(r, 300));
			const retry = await runShell(buildPreLaunchReapScript([target]) + 'echo launched\n');
			expect(retry.out.toString()).toBe('launched\n');
			expect(fs.existsSync(dir)).toBe(false);
		} finally {
			try {
				process.kill(parent.pid!, 'SIGKILL');
			} catch {
				// Already gone.
			}
		}
	}, 20_000);

	it('a Stop reaches the agent through the dir copy once the day-old sweep took its pid record', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		const inner = withRemotePidRecord(
			'exec /bin/bash -c \'trap "echo interrupted; exit 5" INT; while :; do sleep 0.1; done\'\n',
			pidFile
		);
		const launch = runShell(buildDurableLaunchScript(inner, dir, pidFile));
		await waitFor(() => fs.existsSync(pidFile) && fs.existsSync(`${dir}/agent`));
		await new Promise((r) => setTimeout(r, 200));
		fs.rmSync(pidFile);
		await runShell(buildDurableInterruptScript(dir, pidFile));
		const run = await launch;
		expect(run.code).toBe(5);
		expect(agentOut(run.out).toString()).toBe('interrupted\n');
		// The interrupt removes nothing: a later terminate still needs the record.
		expect(fs.existsSync(`${dir}/agent`)).toBe(true);
	}, 20_000);

	it('a reattach keeps a turn whose supervisor died while the agent, found by its dir copy, still runs', async () => {
		const pidFile = newPidFile();
		const dir = newDir();
		const inner = withRemotePidRecord("exec /bin/bash -c 'sleep 30'\n", pidFile);
		const launch = runShell(
			buildDurableLaunchScript(inner, dir, pidFile),
			DURABLE_STDOUT_START.length
		);
		await waitFor(
			() => fs.existsSync(pidFile) && fs.existsSync(`${dir}/sup`) && fs.existsSync(`${dir}/agent`)
		);
		await launch;
		const [agent] = fs.readFileSync(`${dir}/agent`, 'utf8').split(' ');
		const [supervisor] = fs.readFileSync(`${dir}/sup`, 'utf8').split(' ');
		try {
			process.kill(Number(supervisor), 'SIGKILL');
			fs.rmSync(pidFile);
			const reattach = await runShell(
				buildDurableReattachScript(dir, pidFile, 0, 0),
				DURABLE_STDOUT_START.length
			);
			const { reader } = readStderr(reattach.err);
			expect(reader.gone).toBe(false);
			expect(reader.launched).toBe(true);
			expect(reattach.err.toString('latin1')).toContain('\x1eS\n');
		} finally {
			try {
				process.kill(-Number(agent), 'SIGKILL');
			} catch {
				// Already gone.
			}
		}
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
		expect(buildDurableLaunchScript('', newRemoteTurnDir(), newPidFile())).toContain(
			buildTurnDirSweepScript()
		);
	});
});
