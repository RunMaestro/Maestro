/**
 * The terminal example (`examples/maestro-lib-tui/tui.mjs`), driven as a user
 * drives it, on the built library alone.
 *
 * The library is built into a scratch folder with no node_modules above it, and
 * the example is copied beside it in the layout it has in the repo, so its one
 * import of the library resolves to that build and nothing else can be found.
 * Prompts go in on stdin; Ctrl+C is the SIGINT a terminal sends. The provider
 * is the fake agent replaying a recorded Claude Code turn. POSIX only, as in
 * `built-entry.test.ts`: the fake agent is started through its shebang.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
} from '../../../__tests__/main/process-manager/recordings/captured';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts/build-maestro-lib.mjs');
const TUI_SOURCE = path.join(REPO_ROOT, 'examples/maestro-lib-tui/tui.mjs');
const FAKE_AGENT = path.resolve(__dirname, '../../../__tests__/fixtures/fake-agent.mjs');
const posixOnly = describe.skipIf(process.platform === 'win32');

let scratch: string;
let tuiPath: string;
let recording: string;

/** A running TUI and everything it has printed so far. */
interface Tui {
	child: ChildProcessWithoutNullStreams;
	output: () => string;
	/** Resolves with the first match of `pattern` in the output from `from` on. */
	waitFor: (pattern: RegExp, from?: number) => Promise<RegExpMatchArray>;
	exited: Promise<number | null>;
}

function startTui(env: Record<string, string> = {}): Tui {
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		FAKE_AGENT_RECORDING: recording,
		NO_COLOR: '1',
		...env,
	};
	delete childEnv.NODE_PATH;
	delete childEnv.NODE_OPTIONS;
	delete childEnv.ELECTRON_RUN_AS_NODE;
	const child = spawn(
		process.execPath,
		[tuiPath, '--agent', 'claude-code', '--cwd', scratch, '--command', FAKE_AGENT],
		{ cwd: scratch, env: childEnv, stdio: 'pipe' }
	);
	let output = '';
	const waiters: Array<() => void> = [];
	const onData = (chunk: Buffer): void => {
		output += chunk.toString('utf8');
		for (const waiter of [...waiters]) waiter();
	};
	child.stdout.on('data', onData);
	child.stderr.on('data', onData);
	const exited = new Promise<number | null>((resolve) =>
		child.on('close', (code) => resolve(code))
	);
	return {
		child,
		output: () => output,
		waitFor: (pattern, from = 0) =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`Timed out waiting for ${pattern} in:\n${output}`)),
					15_000
				);
				const check = (): void => {
					const match = output.slice(from).match(pattern);
					if (!match) return;
					clearTimeout(timer);
					waiters.splice(waiters.indexOf(check), 1);
					resolve(match);
				};
				waiters.push(check);
				check();
			}),
		exited,
	};
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

beforeAll(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lib-tui-'));
	const build = spawnSync(
		process.execPath,
		[BUILD_SCRIPT, '--out-dir', path.join(scratch, 'dist/maestro-lib')],
		{ cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 }
	);
	if (build.status !== 0) {
		throw new Error(`build:maestro-lib failed:\n${build.stdout}\n${build.stderr}`);
	}
	tuiPath = path.join(scratch, 'examples/maestro-lib-tui/tui.mjs');
	fs.mkdirSync(path.dirname(tuiPath), { recursive: true });
	fs.copyFileSync(TUI_SOURCE, tuiPath);

	const captured = CAPTURED_RECORDINGS['captured-claude-code-normal'];
	recording = path.join(scratch, 'normal.json');
	fs.writeFileSync(
		recording,
		JSON.stringify({
			chunks: captured.chunks,
			stderr: captured.stderrBuffer,
			close: { code: captured.exitCode, signal: captured.exitSignal ?? null },
		})
	);
}, 150_000);

afterAll(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

posixOnly('the maestro-lib terminal example', () => {
	it('streams a turn, then resumes it with the session id it returned', async () => {
		const argvOut = path.join(scratch, 'resume-argv.json');
		const tui = startTui({ FAKE_AGENT_ARGV_OUT: argvOut });
		await tui.waitFor(/Provider: claude-code/);

		tui.child.stdin.write('What is the capital of France?\n');
		await tui.waitFor(/\[session .+\]/);
		expect(tui.output()).toContain('[started, pid');
		expect(tui.output()).toContain('[completed]');
		expect(tui.output()).toContain('The capital of France is Paris.');
		expect(tui.output()).toContain(`[session ${CAPTURED_CLAUDE_CODE_SESSION_ID}]`);

		const second = tui.output().length;
		tui.child.stdin.write('And Germany?\n');
		await tui.waitFor(/\[session .+\]/, second);
		expect(tui.output().slice(second)).toContain('[resuming, pid');
		const args = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
		expect(args[args.indexOf('--resume') + 1]).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
		expect(args.at(-1)).toBe('And Germany?');

		tui.child.stdin.write('/quit\n');
		expect(await tui.exited).toBe(0);
	}, 60_000);

	it('stops a running turn on Ctrl+C, and leaves no agent behind on /quit', async () => {
		const tui = startTui({ FAKE_AGENT_HOLD: '1' });
		await tui.waitFor(/Provider: claude-code/);

		tui.child.stdin.write('What is the capital of France?\n');
		const [, stoppedPid] = await tui.waitFor(/\[started, pid (\d+)\]/);
		await tui.waitFor(/Paris/);
		tui.child.kill('SIGINT');
		await tui.waitFor(/\[interrupted\]/);
		expect(isRunning(Number(stoppedPid))).toBe(false);

		// The next turn resumes, and /quit mid-turn ends it before the TUI exits.
		const next = tui.output().length;
		tui.child.stdin.write('Still there?\n');
		const [, quitPid] = await tui.waitFor(/\[resuming, pid (\d+)\]/, next);
		await tui.waitFor(/Paris/, next);
		tui.child.stdin.write('/quit\n');
		expect(await tui.exited).toBe(0);
		expect(isRunning(Number(quitPid))).toBe(false);
	}, 60_000);

	it('exits on a second Ctrl+C during a turn, with the agent gone', async () => {
		const tui = startTui({ FAKE_AGENT_HOLD: '1' });
		await tui.waitFor(/Provider: claude-code/);

		tui.child.stdin.write('What is the capital of France?\n');
		const [, pid] = await tui.waitFor(/\[started, pid (\d+)\]/);
		await tui.waitFor(/Paris/);
		tui.child.kill('SIGINT');
		await tui.waitFor(/stopping/);
		tui.child.kill('SIGINT');
		expect(await tui.exited).toBe(0);
		expect(isRunning(Number(pid))).toBe(false);
	}, 60_000);
});
