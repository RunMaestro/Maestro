/**
 * The headless program, run the way a machine with no desktop app runs it.
 *
 * The program is bundled exactly as `npm run build:maestro-lib-run` bundles it
 * and started under plain `node`. Nothing here is Electron, and the bundle
 * would not build if anything it reaches imported it. The provider is the fake
 * agent replaying real recorded turns, so the test needs no provider installed.
 *
 * POSIX only: the fake agent is started as a provider binary, through its
 * shebang. `run/` has the same coverage for every platform, one level down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseRunTurnArgs } from '../bin/run-turn';
import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
	CAPTURED_OPENCODE_SESSION_ID,
} from '../../../__tests__/main/process-manager/recordings/captured';
import type { TurnRecording } from '../../../__tests__/main/process-manager/recordings/fixtures';

const ENTRY = path.resolve(__dirname, '../bin/run-turn.ts');
const FAKE_AGENT = path.resolve(__dirname, '../../../__tests__/fixtures/fake-agent.mjs');
const posixOnly = describe.skipIf(process.platform === 'win32');

let scratch: string;
let program: string;
let sequence = 0;

beforeAll(async () => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lib-run-'));
	program = path.join(scratch, 'maestro-lib-run.js');
	await esbuild.build({
		entryPoints: [ENTRY],
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'cjs',
		outfile: program,
		external: ['node-pty'],
		logLevel: 'silent',
	});
}, 60_000);

afterAll(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

interface ProgramRun {
	status: number | null;
	lines: Array<Record<string, unknown>>;
	stderr: string;
	/** The arguments the provider was started with. */
	providerArgs: string[] | undefined;
}

function runProgram(
	args: string[],
	recording?: TurnRecording,
	{ readAfterMs = 0 }: { readAfterMs?: number } = {}
): Promise<ProgramRun> {
	const id = ++sequence;
	const argvOut = path.join(scratch, `argv-${id}.json`);
	const env: NodeJS.ProcessEnv = { ...process.env, FAKE_AGENT_ARGV_OUT: argvOut };
	if (recording) {
		const recordingFile = path.join(scratch, `recording-${id}.json`);
		fs.writeFileSync(
			recordingFile,
			JSON.stringify({
				chunks: recording.chunks,
				stderr: recording.stderrBuffer,
				close: { code: recording.exitCode, signal: recording.exitSignal ?? null },
			})
		);
		env.FAKE_AGENT_RECORDING = recordingFile;
	}

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [program, ...args], {
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		// A reader that starts late leaves the program's stdout pipe to fill.
		const read = (): void => {
			child.stdout.setEncoding('utf8').on('data', (text: string) => (stdout += text));
		};
		if (readAfterMs > 0) setTimeout(read, readAfterMs);
		else read();
		child.stderr.setEncoding('utf8').on('data', (text: string) => (stderr += text));
		child.once('error', reject);
		child.once('close', (status) => {
			resolve({
				status,
				stderr,
				lines: stdout
					.split('\n')
					.filter((text) => text.length > 0)
					.map((text) => JSON.parse(text) as Record<string, unknown>),
				providerArgs: fs.existsSync(argvOut)
					? (JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[])
					: undefined,
			});
		});
	});
}

function turnArgs(agentId: string, extra: string[] = []): string[] {
	return [
		'--agent',
		agentId,
		'--cwd',
		scratch,
		'--command',
		FAKE_AGENT,
		'--prompt',
		'What is the capital of France?',
		...extra,
	];
}

posixOnly('the headless program', () => {
	it('runs an OpenCode turn and ends with its outcome and session id', async () => {
		const run = await runProgram(
			turnArgs('opencode'),
			CAPTURED_RECORDINGS['captured-opencode-normal']
		);

		expect(run.status).toBe(0);
		expect(run.stderr).toBe('');
		expect(run.lines[0]).toMatchObject({ type: 'started', resuming: false });
		expect(run.lines.at(-1)).toMatchObject({
			type: 'turn',
			outcome: 'completed',
			sessionId: CAPTURED_OPENCODE_SESSION_ID,
			answer: 'The capital of France is Paris.',
			exitCode: 0,
			signal: null,
			error: null,
		});
	});

	it('streams the reply before the turn ends, in order', async () => {
		const run = await runProgram(
			turnArgs('claude-code'),
			CAPTURED_RECORDINGS['captured-claude-code-normal']
		);
		const types = run.lines.map((entry) => entry.type);

		expect(run.status).toBe(0);
		expect(types[0]).toBe('started');
		expect(types.at(-1)).toBe('turn');
		expect(types.indexOf('session')).toBeGreaterThan(0);
		expect(types.indexOf('session')).toBeLessThan(types.indexOf('result'));
		expect(types.indexOf('text')).toBeLessThan(types.indexOf('result'));
		expect(run.lines.at(-1)).toMatchObject({
			outcome: 'completed',
			sessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
		});
	});

	it.each([
		['opencode', 'captured-opencode-resumed', ['--session', CAPTURED_OPENCODE_SESSION_ID]],
		['claude-code', 'captured-claude-code-resumed', ['--resume', CAPTURED_CLAUDE_CODE_SESSION_ID]],
	])(
		'resumes a %s session by handing the provider its own resume arguments',
		async (agentId, recording, resumeArgs) => {
			const run = await runProgram(
				turnArgs(agentId, ['--resume', resumeArgs[1]]),
				CAPTURED_RECORDINGS[recording]
			);

			expect(run.status).toBe(0);
			expect(run.lines[0]).toMatchObject({ type: 'started', resuming: true });
			expect(run.lines.at(-1)).toMatchObject({ outcome: 'completed', sessionId: resumeArgs[1] });

			const args = run.providerArgs ?? [];
			const at = args.indexOf(resumeArgs[0]);
			expect(at).toBeGreaterThanOrEqual(0);
			expect(args[at + 1]).toBe(resumeArgs[1]);
			expect(args).toContain('What is the capital of France?');
		}
	);

	it('does not pass resume arguments for a new session', async () => {
		const run = await runProgram(
			turnArgs('opencode'),
			CAPTURED_RECORDINGS['captured-opencode-normal']
		);

		expect(run.providerArgs).not.toContain('--session');
	});

	it('loses nothing and does not stall when its reader is slower than the agent', async () => {
		// Far more output than a pipe holds, to a reader that is not reading yet:
		// the program's stdout fills, it pauses the agent, and picks up again
		// once the reader drains what is queued.
		const normal = CAPTURED_RECORDINGS['captured-opencode-normal'];
		const textChunk = normal.chunks.find((chunk) => chunk.includes('"type":"text"'));
		if (!textChunk) throw new Error('the recording has no text event to repeat');
		const count = 4000;
		const flood = Array.from({ length: count }, (_, index) =>
			textChunk.replace('The capital of France is Paris.', `line ${index}`)
		);
		const recording: TurnRecording = {
			...normal,
			chunks: [normal.chunks[0], ...flood, ...normal.chunks.slice(1)],
		};

		const run = await runProgram(turnArgs('opencode'), recording, { readAfterMs: 400 });

		const streamed = run.lines
			.map((entry) => entry.text)
			.filter((text): text is string => typeof text === 'string' && text.startsWith('line '));
		expect(run.status).toBe(0);
		expect(streamed).toEqual(Array.from({ length: count }, (_, index) => `line ${index}`));
		expect(run.lines.at(-1)).toMatchObject({ type: 'turn', outcome: 'completed' });
	}, 30_000);

	it('exits 2 for a provider whose output it could not read', async () => {
		const run = await runProgram(turnArgs('hermes'));

		expect(run.status).toBe(2);
		expect(run.stderr).toContain('Hermes has no output parser');
		expect(run.providerArgs).toBeUndefined();
	});

	it('exits 2 for a read-only turn the provider cannot enforce', async () => {
		const run = await runProgram(turnArgs('antigravity', ['--read-only']));

		expect(run.status).toBe(2);
		expect(run.stderr).toContain('cannot enforce a read-only turn');
		expect(run.providerArgs).toBeUndefined();
	});

	it('exits 1 and names the failure when the turn crashed', async () => {
		// Claude Code killed by a signal nobody here sent: no result, exit 143.
		const run = await runProgram(
			turnArgs('claude-code'),
			CAPTURED_RECORDINGS['captured-claude-code-stopped-sigterm']
		);

		expect(run.status).toBe(1);
		expect(run.lines.at(-1)).toMatchObject({ type: 'turn', outcome: 'crashed', exitCode: 143 });
	});

	it('exits 2 without starting anything when the provider is not installed', async () => {
		const run = await runProgram([
			'--agent',
			'opencode',
			'--cwd',
			scratch,
			'--command',
			path.join(scratch, 'no-such-binary'),
			'--prompt',
			'hi',
		]);

		expect(run.status).toBe(2);
		expect(run.lines).toEqual([]);
		expect(run.stderr).toContain('was not found');
		expect(run.providerArgs).toBeUndefined();
	});

	it('exits 2 for a provider it does not know', async () => {
		const run = await runProgram(['--agent', 'nope', '--cwd', scratch, '--prompt', 'hi']);

		expect(run.status).toBe(2);
		expect(run.stderr).toContain('Unknown agent "nope"');
	});

	it('exits 2 and prints its usage for a bad command line', async () => {
		const run = await runProgram(['--cwd', scratch, '--prompt', 'hi']);

		expect(run.status).toBe(2);
		expect(run.stderr).toContain('--agent is required');
		expect(run.stderr).toContain('Usage: maestro-lib-run');
	});
});

describe('the headless bundle', () => {
	it('contains no reference to the desktop framework', () => {
		const bundle = fs.readFileSync(program, 'utf8');

		expect(bundle).not.toMatch(/require\(["']electron["']\)/);
		expect(bundle).not.toMatch(/from ["']electron["']/);
	});
});

describe('parseRunTurnArgs', () => {
	it('reads every option', () => {
		expect(
			parseRunTurnArgs([
				'--agent',
				'codex',
				'--cwd',
				'/project',
				'--prompt',
				'fix it',
				'--resume',
				'thread-1',
				'--model',
				'gpt-5',
				'--command',
				'/opt/codex',
				'--read-only',
			])
		).toEqual({
			ok: true,
			request: {
				agentId: 'codex',
				cwd: '/project',
				prompt: 'fix it',
				resumeSessionId: 'thread-1',
				model: 'gpt-5',
				command: '/opt/codex',
				readOnly: true,
			},
		});
	});

	it('accepts an empty prompt, which is not the same as a missing one', () => {
		const parsed = parseRunTurnArgs(['--agent', 'codex', '--cwd', '/p', '--prompt', '']);

		expect(parsed).toMatchObject({ ok: true, request: { prompt: '' } });
	});

	it('takes a prompt that looks like an option as the prompt', () => {
		const parsed = parseRunTurnArgs(['--agent', 'codex', '--cwd', '/p', '--prompt', '--help']);

		expect(parsed).toMatchObject({ ok: true, request: { prompt: '--help' } });
	});

	it.each([
		[['--cwd', '/p', '--prompt', 'x'], '--agent is required'],
		[['--agent', 'codex', '--prompt', 'x'], '--cwd is required'],
		[['--agent', 'codex', '--cwd', '/p'], '--prompt is required'],
		[['--agent', 'codex', '--cwd'], '--cwd needs a value'],
		[['--agent', 'codex', '--verbose'], 'Unknown option: --verbose'],
	])('rejects %j', (argv, error) => {
		expect(parseRunTurnArgs(argv)).toEqual({ ok: false, error });
	});
});
