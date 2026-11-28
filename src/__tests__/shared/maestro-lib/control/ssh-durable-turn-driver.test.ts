/**
 * The durable SSH turn driver: launch, lost links, reattach, settle, Stop.
 *
 * Each ssh attempt is a real local `bash --norc --noprofile -s` started
 * through `startTurn`, which stands in for the remote shell sshd starts.
 * Killing that bash is what a lost link does: the stream dies, the agent and
 * its supervisor do not. A "host down" attempt is a bash that exits 255 at
 * once, as ssh does when it cannot connect, after saying so on stderr; a
 * reattach that reaches the host first prints a login shell's noise on
 * stderr, as a real `.bashrc` can. Neither may reach the agent's stderr once
 * the agent runs (a first launch's noise reaches it, as today's does). The agent replays a Claude
 * stream-json fixture, and the parsed events are compared with today's
 * direct launch, so D2 and D3 are judged on what the parser sees.
 *
 * POSIX only: the remote shell is bash.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	buildDurableLaunchScript,
	DURABLE_STDOUT_START,
	DURABLE_TURN_GONE_MESSAGE,
	runDurableSshTurn,
	type DurableAttempt,
	type DurableAttemptHandlers,
} from '../../../../shared/maestro-lib/control/ssh-durable-turn';
import {
	buildPreLaunchReapScript,
	newRemoteTurnDir,
	SSH_STDIN_REMOTE_SHELL,
	withRemotePidRecord,
} from '../../../../shared/maestro-lib/control/ssh-remote-signal';
import { startTurn } from '../../../../shared/maestro-lib/run/start-turn';
import { createOutputParser } from '../../../../shared/maestro-lib/parsers/parser-factory';
import type { ParsedEvent } from '../../../../shared/maestro-lib/parsers/agent-output-parser';

const posixOnly = describe.skipIf(process.platform === 'win32');

const FIXTURE = [
	{ type: 'system', subtype: 'init', session_id: 'durable-1', model: 'claude-haiku-5-5' },
	...Array.from({ length: 12 }, (_, i) => ({
		type: 'assistant',
		session_id: 'durable-1',
		message: {
			id: `m${i}`,
			role: 'assistant',
			content: [{ type: 'text', text: `part ${i}: héllo wörld ✓ ${'x'.repeat(40)}` }],
		},
	})),
	{
		type: 'result',
		subtype: 'success',
		result: 'done é',
		session_id: 'durable-1',
		usage: { input_tokens: 10, output_tokens: 20 },
	},
]
	.map((line) => JSON.stringify(line))
	.join('\n');

const cleanups: string[] = [];
afterEach(() => {
	for (const p of cleanups.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

function track<T extends string>(p: T): T {
	cleanups.push(p);
	return p;
}

function fixtureFile(): string {
	const file = track(path.join(os.tmpdir(), `durable-fixture-${randomUUID()}.jsonl`));
	fs.writeFileSync(file, FIXTURE + '\n');
	return file;
}

/** Today's stdin: pid record, an agent that reads its prompt, replays the fixture, and exits 0. */
function todaysStdin(pidFile: string, fixture: string, exitCode = 0): string {
	const agent =
		`exec /bin/bash -c 'read -r p; while IFS= read -r l; do printf "%s\\n" "$l"; sleep 0.03; done < ${fixture}; ` +
		`echo "warn é" >&2; exit ${exitCode}'`;
	return withRemotePidRecord(`${agent}\n`, pidFile) + 'the prompt\n';
}

function parse(stdout: string): ParsedEvent[] {
	const parser = createOutputParser('claude-code')!;
	return stdout
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => parser.parseJsonLine(line))
		.filter((event): event is ParsedEvent => event !== null);
}

const [SHELL, ...SHELL_ARGS] = SSH_STDIN_REMOTE_SHELL;
const SHELL_SPEC = { command: SHELL, args: SHELL_ARGS, cwd: os.tmpdir(), env: process.env };

interface Rig {
	/**
	 * How many stdout bytes each attempt delivers before its link is cut (0:
	 * never). The cut is byte-exact: the bytes past it are lost with the link.
	 */
	cutAfter: number[];
	/** Attempts (by index) that find the host down. */
	hostDown: Set<number>;
	attempts: number;
	/** Every stdout byte delivered so far, across attempts. */
	received?: number;
	/** Where in the whole stream each cut fell. */
	cutAt?: number[];
	/** What a login shell's startup files print to stdout before each attempt's script. */
	stdoutNoise?: string;
}

const HOST_DOWN_STDIN =
	"echo 'ssh: connect to host durable port 22: Connection refused' >&2; exit 255\n";
const LOGIN_NOISE = "echo 'bash: atuin: command not found' >&2\n";

function rigAttempt(rig: Rig) {
	return (stdin: string, handlers: DurableAttemptHandlers): DurableAttempt => {
		const index = rig.attempts++;
		const down = rig.hostDown.has(index);
		const cut = rig.cutAfter[index] ?? 0;
		let seen = 0;
		let lost = false;
		// The startup noise and the stdout marker come first; cuts count only the agent's bytes.
		const noise = rig.stdoutNoise ?? '';
		let ahead = down ? 0 : Buffer.byteLength(noise) + DURABLE_STDOUT_START.length;
		const noiseScript = noise ? `printf '%s' '${noise}'\n` : '';
		let turn: ReturnType<typeof startTurn>;
		turn = startTurn(
			{
				...SHELL_SPEC,
				stdin: down ? HOST_DOWN_STDIN : noiseScript + (index > 0 ? LOGIN_NOISE : '') + stdin,
			},
			{
				onStdoutBytes: (all) => {
					if (lost) return;
					const pre = Math.min(all.length, ahead);
					ahead -= pre;
					if (pre) handlers.onStdoutBytes(all.subarray(0, pre));
					const chunk = all.subarray(pre);
					if (chunk.length === 0) return;
					const take = cut ? Math.min(chunk.length, cut - seen) : chunk.length;
					handlers.onStdoutBytes(chunk.subarray(0, take));
					seen += take;
					rig.received = (rig.received ?? 0) + take;
					if (cut && seen >= cut) {
						lost = true;
						(rig.cutAt ??= []).push(rig.received);
						turn.child.kill('SIGKILL');
					}
				},
				onStderrBytes: (chunk) => {
					if (!lost) handlers.onStderrBytes(chunk);
				},
			},
			{}
		);
		return { child: turn.child, done: turn.done };
	};
}

async function runDurable(
	stdin: string,
	dir: string,
	pidFile: string,
	rig: Rig,
	stopReason: () => 'interrupt' | 'kill' | null = () => null
) {
	let out = '';
	let err = '';
	let linksLost = 0;
	const turn = runDurableSshTurn(buildDurableLaunchScript(stdin, dir, pidFile), {
		dir,
		pidFile,
		startAttempt: rigAttempt(rig),
		onStdout: (text) => (out += text),
		onStderr: (text) => (err += text),
		onLinkLost: () => linksLost++,
		stopReason,
		delaysMs: [20, 20, 20, 20, 20, 20],
	});
	const exit = await turn.done;
	return { exit, out, err, linksLost };
}

/** Today's launch, straight through one bash. */
async function runToday(stdin: string): Promise<{ out: string; err: string; code: number | null }> {
	let out = '';
	let err = '';
	const turn = startTurn(
		{ ...SHELL_SPEC, stdin },
		{ onStdout: (t) => (out += t), onStderr: (t) => (err += t) },
		{}
	);
	const exit = await turn.done;
	return { out, err, code: exit.exitCode };
}

posixOnly('runDurableSshTurn', () => {
	it('D2: a healthy durable turn gives the parser the same events as today', async () => {
		const fixture = fixtureFile();
		const today = await runToday(todaysStdin(track(newPid()), fixture));
		const pidFile = track(newPid());
		const durable = await runDurable(
			todaysStdin(pidFile, fixture),
			track(newRemoteTurnDir()),
			pidFile,
			{ cutAfter: [], hostDown: new Set(), attempts: 0 }
		);
		expect(parse(today.out).length).toBe(14);
		expect(parse(durable.out)).toEqual(parse(today.out));
		expect(durable.out).toBe(today.out);
		expect(durable.err).toBe(today.err);
		expect(durable.exit.outcome).toBe('ended');
		expect(durable.exit.exitCode).toBe(today.code);
		expect(durable.linksLost).toBe(0);
	}, 30_000);

	it('D3: three lost links mid-turn, cut mid-line and mid-character, change no parsed event', async () => {
		const fixture = fixtureFile();
		const today = await runToday(todaysStdin(track(newPid()), fixture));
		const pidFile = track(newPid());
		// Byte-exact cuts: one inside the 2-byte é of the first reply, one inside
		// the 3-byte ✓ of a later one, one in the middle of a plain run.
		const bytes = Buffer.from(today.out);
		const inE = bytes.indexOf(Buffer.from('é')) + 1;
		const inCheck = bytes.indexOf(Buffer.from('✓'), inE + 300) + 2;
		const rig: Rig = {
			cutAfter: [inE, inCheck - inE, 0, 377],
			hostDown: new Set([2]),
			attempts: 0,
		};
		const durable = await runDurable(
			todaysStdin(pidFile, fixture, 7),
			track(newRemoteTurnDir()),
			pidFile,
			rig
		);
		expect(rig.cutAt).toEqual([inE, inCheck, inCheck + 377]);
		const insideLine = (at: number) => bytes[at - 1] !== 0x0a && bytes[at] !== 0x0a;
		const insideChar = (at: number) => (bytes[at] & 0xc0) === 0x80;
		expect(rig.cutAt!.every(insideLine)).toBe(true);
		expect(rig.cutAt!.filter(insideChar).length).toBeGreaterThanOrEqual(2);
		expect(durable.linksLost).toBeGreaterThanOrEqual(3);
		expect(parse(durable.out)).toEqual(parse(today.out));
		expect(durable.out).toBe(today.out);
		expect(durable.out).not.toContain('�');
		expect(durable.err).toBe(today.err);
		expect(durable.exit.outcome).toBe('ended');
		expect(durable.exit.exitCode).toBe(7);
	}, 30_000);

	it("a login shell's stdout before each attempt is passed on once and never shifts the offsets", async () => {
		const fixture = fixtureFile();
		const noise = 'Welcome to the durable box\n';
		const today = await runToday(
			`printf '%s' '${noise}'\n` + todaysStdin(track(newPid()), fixture)
		);
		const pidFile = track(newPid());
		const bytes = Buffer.from(today.out.slice(noise.length));
		const inE = bytes.indexOf(Buffer.from('é')) + 1;
		const rig: Rig = { cutAfter: [inE, 300], hostDown: new Set(), attempts: 0, stdoutNoise: noise };
		const durable = await runDurable(
			todaysStdin(pidFile, fixture),
			track(newRemoteTurnDir()),
			pidFile,
			rig
		);
		expect(durable.linksLost).toBeGreaterThanOrEqual(2);
		// The first launch's noise reaches the tab as today's does; a reattach's never does.
		expect(durable.out).toBe(today.out);
		expect(parse(durable.out)).toEqual(parse(today.out));
		expect(durable.exit.outcome).toBe('ended');
	}, 30_000);

	it('D4: the turn stays unsettled while the host is down, then settles with the agent', async () => {
		const fixture = fixtureFile();
		const pidFile = track(newPid());
		const rig: Rig = { cutAfter: [120], hostDown: new Set([1, 2, 3, 4]), attempts: 0 };
		let settled = false;
		const run = runDurable(todaysStdin(pidFile, fixture), track(newRemoteTurnDir()), pidFile, rig);
		void run.then(() => (settled = true));
		// The first reattaches find the host down: nothing may treat the turn as over.
		await waitFor(() => rig.attempts >= 4);
		expect(settled).toBe(false);
		const durable = await run;
		expect(durable.exit.outcome).toBe('ended');
		expect(parse(durable.out).length).toBe(14);
	}, 30_000);

	it('D5: Stop while reconnecting settles the turn as stopped; the reap then ends the agent and its dir', async () => {
		const pidFile = track(newPid());
		const dir = track(newRemoteTurnDir());
		const inner = withRemotePidRecord(
			"exec /bin/bash -c 'for i in $(seq 1 600); do echo tick $i; sleep 0.05; done'\n",
			pidFile
		);
		const rig: Rig = { cutAfter: [40], hostDown: new Set([1, 2, 3, 4, 5, 6]), attempts: 0 };
		let stop: 'interrupt' | null = null;
		const run = runDurable(inner, dir, pidFile, rig, () => stop);
		await waitFor(() => rig.attempts >= 2);
		stop = 'interrupt';
		const durable = await run;
		expect(durable.exit.outcome).toBe('stopped');
		expect(durable.exit.interrupted).toBe(true);
		const attemptsAtStop = rig.attempts;
		await new Promise((r) => setTimeout(r, 100));
		expect(rig.attempts).toBe(attemptsAtStop);

		// The agent outlived the link; the spawner's reap (terminate + dir) ends it.
		const [pid] = fs.readFileSync(pidFile, 'utf8').split(' ');
		expect(() => process.kill(Number(pid), 0)).not.toThrow();
		await runToday(
			buildPreLaunchReapScript([
				{ sshCommand: 'ssh', sshArgs: [], pidFile, sessionId: 's', turnDir: dir },
			])
		);
		expect(() => process.kill(-Number(pid), 0)).toThrow();
		expect(fs.existsSync(dir)).toBe(false);
	}, 30_000);

	it('an app restart mid-turn: the next run resumes at the last line end, and the parser sees every event once', async () => {
		const fixture = fixtureFile();
		const today = await runToday(todaysStdin(track(newPid()), fixture));
		const pidFile = track(newPid());
		const dir = track(newRemoteTurnDir());

		// The quit: the local ssh dies mid-turn and nobody owns the turn any more.
		// (The mid-line rule itself is the spawner test's 'a quit detaches the turn'.)
		const quitRig: Rig = { cutAfter: [251], hostDown: new Set(), attempts: 0 };
		let quit = false;
		let before = '';
		const first = runDurableSshTurn(
			buildDurableLaunchScript(todaysStdin(pidFile, fixture), dir, pidFile),
			{
				dir,
				pidFile,
				startAttempt: (stdin, handlers) => {
					const attempt = rigAttempt(quitRig)(stdin, handlers);
					void attempt.done.then(() => (quit = true));
					return attempt;
				},
				onStdout: (text) => (before += text),
				onStderr: () => {},
				stopReason: () => (quit ? 'kill' : null),
				delaysMs: [20],
			}
		);
		expect((await first.done).outcome).toBe('stopped');
		const offsets = first.restartOffsets();
		// A new process starts with empty line buffers: only whole lines were parsed.
		const parsedBefore = before.slice(0, before.lastIndexOf('\n') + 1);
		expect(Buffer.byteLength(parsedBefore)).toBe(offsets.outOffset);

		// The next launch: one reattach from the recorded offsets, to the end.
		const rig: Rig = { cutAfter: [], hostDown: new Set(), attempts: 0 };
		let after = '';
		let err = '';
		const second = runDurableSshTurn('', {
			dir,
			pidFile,
			resume: offsets,
			startAttempt: rigAttempt(rig),
			onStdout: (text) => (after += text),
			onStderr: (text) => (err += text),
			stopReason: () => null,
			delaysMs: [20],
		});
		const exit = await second.done;
		expect(exit.outcome).toBe('ended');
		expect(exit.exitCode).toBe(0);
		expect(rig.attempts).toBe(1);
		expect(parsedBefore + after).toBe(today.out);
		expect([...parse(parsedBefore), ...parse(after)]).toEqual(parse(today.out));
		expect(err).toBe(today.err);
	}, 30_000);

	it('a restarted turn whose host does not answer is a lost link, not a launch that never ran', async () => {
		const pidFile = track(newPid());
		const rig: Rig = { cutAfter: [], hostDown: new Set([0, 1]), attempts: 0 };
		const turn = runDurableSshTurn('', {
			dir: track(newRemoteTurnDir()),
			pidFile,
			resume: { outOffset: 10, errOffset: 0 },
			startAttempt: rigAttempt(rig),
			onStdout: () => {},
			onStderr: () => {},
			stopReason: () => null,
			delaysMs: [20],
		});
		const exit = await turn.done;
		expect(rig.attempts).toBe(2);
		expect(exit.outcome).toBe('unreachable');
		expect(exit.exitCode).toBe(255);
	});

	it("a turn given up as unreachable hands ssh's last words to the error parsers; a recovered one never does", async () => {
		const pidFile = track(newPid());
		const rig: Rig = { cutAfter: [], hostDown: new Set([0, 1]), attempts: 0 };
		let err = '';
		const turn = runDurableSshTurn('', {
			dir: track(newRemoteTurnDir()),
			pidFile,
			resume: { outOffset: 10, errOffset: 0 },
			startAttempt: rigAttempt(rig),
			onStdout: () => {},
			onStderr: (text) => (err += text),
			stopReason: () => null,
			delaysMs: [20],
		});
		expect((await turn.done).outcome).toBe('unreachable');
		// Held while the turn could still recover; passed on once it was given up.
		expect(err).toBe('ssh: connect to host durable port 22: Connection refused\n'.repeat(2));
	});

	it('a restart replays the output received before it into a silent parser, and the tab hears the rest once', async () => {
		const fixture = fixtureFile();
		const today = await runToday(todaysStdin(track(newPid()), fixture));
		const pidFile = track(newPid());
		const dir = track(newRemoteTurnDir());
		// The first run of the app: it quits after 400 bytes.
		const quitRig: Rig = { cutAfter: [400], hostDown: new Set(), attempts: 0 };
		let quit = false;
		const first = runDurableSshTurn(
			buildDurableLaunchScript(todaysStdin(pidFile, fixture), dir, pidFile),
			{
				dir,
				pidFile,
				startAttempt: (stdin, handlers) => {
					const attempt = rigAttempt(quitRig)(stdin, handlers);
					void attempt.done.then(() => (quit = true));
					return attempt;
				},
				onStdout: () => {},
				onStderr: () => {},
				stopReason: () => (quit ? 'kill' : null),
				delaysMs: [20],
			}
		);
		await first.done;
		const offsets = first.restartOffsets();
		expect(offsets.outOffset).toBeGreaterThan(0);

		// The next run: the stream starts at byte 0; the first part is the replay.
		let replayed = '';
		let after = '';
		let lowest = Infinity;
		const rig: Rig = { cutAfter: [150], hostDown: new Set(), attempts: 0 };
		const second = runDurableSshTurn('', {
			dir,
			pidFile,
			resume: offsets,
			startAttempt: rigAttempt(rig),
			onReplayStdout: (text) => {
				replayed += text;
				lowest = Math.min(lowest, second.restartOffsets().outOffset);
			},
			onStdout: (text) => (after += text),
			onStderr: () => {},
			stopReason: () => null,
			delaysMs: [20],
		});
		const exit = await second.done;
		expect(exit.outcome).toBe('ended');
		// A lost link during the replay changes nothing either.
		expect(rig.attempts).toBe(2);
		expect(Buffer.byteLength(replayed)).toBe(offsets.outOffset);
		expect(replayed + after).toBe(today.out);
		expect([...parse(replayed), ...parse(after)]).toEqual(parse(today.out));
		// A crash mid-replay keeps the record where the tab already is.
		expect(lowest).toBe(offsets.outOffset);
	}, 30_000);

	it('a stream whose agent and supervisor die with no exit settles as failed, with the reason', async () => {
		const pidFile = track(newPid());
		const dir = track(newRemoteTurnDir());
		const inner = withRemotePidRecord("exec /bin/bash -c 'echo started; sleep 60'\n", pidFile);
		const rig: Rig = { cutAfter: [], hostDown: new Set(), attempts: 0 };
		const run = runDurable(inner, dir, pidFile, rig);
		await waitFor(() => fs.existsSync(pidFile) && fs.existsSync(`${dir}/sup`));
		const [agent] = fs.readFileSync(pidFile, 'utf8').split(' ');
		const [supervisor] = fs.readFileSync(`${dir}/sup`, 'utf8').split(' ');
		process.kill(Number(supervisor), 'SIGKILL');
		process.kill(-Number(agent), 'SIGKILL');
		const durable = await run;
		expect(durable.exit.outcome).toBe('gone');
		expect(durable.exit.exitCode).toBe(1);
		expect(durable.out).toBe('started\n');
		expect(durable.err).toBe(DURABLE_TURN_GONE_MESSAGE);
		expect(rig.attempts).toBe(1);
		expect(durable.linksLost).toBe(0);
	}, 30_000);

	it('a launch that never reaches the agent settles as today, with no reattach', async () => {
		const rig: Rig = { cutAfter: [], hostDown: new Set([0]), attempts: 0 };
		const pidFile = track(newPid());
		const durable = await runDurable('', track(newRemoteTurnDir()), pidFile, rig);
		expect(durable.exit.outcome).toBe('not-started');
		expect(durable.exit.exitCode).toBe(255);
		expect(rig.attempts).toBe(1);
		// The agent never ran: ssh's words reach the error parsers as today.
		expect(durable.err).toBe('ssh: connect to host durable port 22: Connection refused\n');
	});

	it('an agent that itself exits 255 is not mistaken for a lost link', async () => {
		const fixture = fixtureFile();
		const pidFile = track(newPid());
		const rig: Rig = { cutAfter: [], hostDown: new Set(), attempts: 0 };
		const durable = await runDurable(
			todaysStdin(pidFile, fixture, 255),
			track(newRemoteTurnDir()),
			pidFile,
			rig
		);
		expect(durable.exit.outcome).toBe('ended');
		expect(durable.exit.exitCode).toBe(255);
		expect(rig.attempts).toBe(1);
	}, 30_000);
});

function newPid(): string {
	return `/tmp/maestro-agent-${randomUUID()}.pid`;
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error('timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}
