/**
 * The durable SSH turn driver: launch, lost links, reattach, settle, Stop.
 *
 * Each ssh attempt is a real local `bash --norc --noprofile -s` started
 * through `startTurn`, which stands in for the remote shell sshd starts.
 * Killing that bash is what a lost link does: the stream dies, the agent and
 * its supervisor do not. A "host down" attempt is a bash that exits 255 at
 * once, as ssh does when it cannot connect. The agent replays a Claude
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
	/** How many stdout bytes each attempt may read before its link is cut (0: never). */
	cutAfter: number[];
	/** Attempts (by index) that find the host down. */
	hostDown: Set<number>;
	attempts: number;
}

function rigAttempt(rig: Rig) {
	return (stdin: string, handlers: DurableAttemptHandlers): DurableAttempt => {
		const index = rig.attempts++;
		const down = rig.hostDown.has(index);
		const cut = rig.cutAfter[index] ?? 0;
		let seen = 0;
		let turn: ReturnType<typeof startTurn>;
		turn = startTurn(
			{ ...SHELL_SPEC, stdin: down ? 'exit 255\n' : stdin },
			{
				onStdoutBytes: (chunk) => {
					handlers.onStdoutBytes(chunk);
					seen += chunk.length;
					if (cut && seen >= cut) turn.child.kill('SIGKILL');
				},
				onStderrBytes: (chunk) => handlers.onStderrBytes(chunk),
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
	const turn = runDurableSshTurn(buildDurableLaunchScript(stdin, dir), {
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
		const durable = await runDurable(
			todaysStdin(pidFile, fixture, 7),
			track(newRemoteTurnDir()),
			pidFile,
			// Odd byte counts land inside a line, and often inside a multibyte character.
			{ cutAfter: [151, 233, 0, 377], hostDown: new Set([2]), attempts: 0 }
		);
		expect(durable.linksLost).toBeGreaterThanOrEqual(3);
		expect(parse(durable.out)).toEqual(parse(today.out));
		expect(durable.out).toBe(today.out);
		expect(durable.out).not.toContain('�');
		expect(durable.err).toBe(today.err);
		expect(durable.exit.outcome).toBe('ended');
		expect(durable.exit.exitCode).toBe(7);
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

	it('a launch that never reaches the agent settles as today, with no reattach', async () => {
		const rig: Rig = { cutAfter: [], hostDown: new Set([0]), attempts: 0 };
		const pidFile = track(newPid());
		const durable = await runDurable('', track(newRemoteTurnDir()), pidFile, rig);
		expect(durable.exit.outcome).toBe('not-started');
		expect(durable.exit.exitCode).toBe(255);
		expect(rig.attempts).toBe(1);
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
