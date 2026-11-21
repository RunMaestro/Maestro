// Source: src/shared/maestro-lib/__tests__/built-entry.test.ts
// Source: src/shared/maestro-lib/__tests__/tui-example.test.ts
// Source: src/shared/maestro-lib/__tests__/headless-program.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeAll } from 'vitest';
import { afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAESTRO_LIB_VERSION } from '../version';
import { CAPTURED_RECORDINGS } from '../../../__tests__/main/process-manager/recordings/captured';
import { CAPTURED_CLAUDE_CODE_SESSION_ID } from '../../../__tests__/main/process-manager/recordings/captured';
import type { TurnRecording } from '../../../__tests__/main/process-manager/recordings/fixtures';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as esbuild from 'esbuild';
import { parseRunTurnArgs } from '../bin/run-turn';
import { CAPTURED_OPENCODE_SESSION_ID } from '../../../__tests__/main/process-manager/recordings/captured';
describeSourceSuite('built-entry', () => {
	const REPO_ROOT = path.resolve(__dirname, '../../../..');
	const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts/build-maestro-lib.mjs');
	const FAKE_AGENT = path.resolve(__dirname, '../../../__tests__/fixtures/fake-agent.mjs');
	const posixOnly = describe.skipIf(process.platform === 'win32');

	/** Every runtime export a consumer of the entry relies on. */
	const FUNCTION_EXPORTS = [
		'getAgentIds',
		'getAgentDefinition',
		'getVisibleAgentDefinitions',
		'getAgentCapabilities',
		'hasCapability',
		'planSessionTurn',
		'buildAgentArgs',
		'buildAgentLaunchPlan',
		'checkBinaryExists',
		'checkCustomPath',
		'turnProcessSpecFromPlan',
		'startTurn',
		'runTurn',
		'runToCompletion',
		'TurnCapture',
		'UnknownProviderError',
		'stopProcess',
		'killProcessTreeNow',
		'snapshotProcessTree',
		'resolveTurnOutcome',
		'initializeOutputParsers',
		'createOutputParser',
		'getOutputParser',
		'hasOutputParser',
		'getAllOutputParsers',
		'setMaestroLibLogger',
		'setMaestroLibErrorReporter',
		'setMaestroLibImageRefResolver',
		'setMaestroLibCapabilitySnapshotLookup',
	];

	let scratch: string;
	let libDir: string;

	/** Run a script under plain `node` in the scratch folder and parse the JSON it prints. */
	function runNode(args: string[]): unknown {
		const env = { ...process.env };
		delete env.NODE_PATH;
		delete env.NODE_OPTIONS;
		delete env.ELECTRON_RUN_AS_NODE;
		const result = spawnSync(process.execPath, args, {
			cwd: scratch,
			env,
			encoding: 'utf8',
			timeout: 30_000,
		});
		if (result.status !== 0) {
			throw new Error(`node exited ${result.status}: ${result.stderr}`);
		}
		return JSON.parse(result.stdout);
	}

	function writeRecording(name: string, recording: TurnRecording): string {
		const file = path.join(scratch, `${name}.json`);
		fs.writeFileSync(
			file,
			JSON.stringify({
				chunks: recording.chunks,
				stderr: recording.stderrBuffer,
				close: { code: recording.exitCode, signal: recording.exitSignal ?? null },
			})
		);
		return file;
	}

	beforeAll(() => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lib-built-'));
		libDir = path.join(scratch, 'maestro-lib');
		const build = spawnSync(process.execPath, [BUILD_SCRIPT, '--out-dir', libDir], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			timeout: 120_000,
		});
		if (build.status !== 0) {
			throw new Error(`build:maestro-lib failed:\n${build.stdout}\n${build.stderr}`);
		}
	}, 150_000);

	afterAll(() => {
		fs.rmSync(scratch, { recursive: true, force: true });
	});

	describe('the built maestro-lib entry', () => {
		it('loads with require in plain Node, with no Electron to be found', () => {
			const loaded = runNode([
				'-e',
				`
			const lib = require(${JSON.stringify(libDir)});
			let electron = 'found';
			try { require.resolve('electron', { paths: [${JSON.stringify(libDir)}] }); }
			catch { electron = 'absent'; }
			const types = {};
			for (const name of ${JSON.stringify(FUNCTION_EXPORTS)}) types[name] = typeof lib[name];
			console.log(JSON.stringify({
				version: lib.MAESTRO_LIB_VERSION,
				types,
				agents: lib.getAgentIds().length,
				electron,
			}));
			`,
			]) as { version: string; types: Record<string, string>; agents: number; electron: string };

			expect(loaded.electron).toBe('absent');
			expect(loaded.version).toBe(MAESTRO_LIB_VERSION);
			expect(loaded.agents).toBeGreaterThan(0);
			for (const name of FUNCTION_EXPORTS) {
				expect(loaded.types[name], name).toBe('function');
			}
		});

		it('loads with import from an ES module', () => {
			const loaded = runNode([
				'--input-type=module',
				'-e',
				`
			import { MAESTRO_LIB_VERSION, runTurn, planSessionTurn } from ${JSON.stringify(
				// ESM takes a URL, and a Windows path reads as one with a "c:" scheme.
				pathToFileURL(path.join(libDir, 'index.js')).href
			)};
			console.log(JSON.stringify({
				version: MAESTRO_LIB_VERSION,
				runTurn: typeof runTurn,
				planSessionTurn: typeof planSessionTurn,
			}));
			`,
			]);

			expect(loaded).toEqual({
				version: MAESTRO_LIB_VERSION,
				runTurn: 'function',
				planSessionTurn: 'function',
			});
		});

		it('is a versioned package with its declarations', () => {
			const libPackage = JSON.parse(fs.readFileSync(path.join(libDir, 'package.json'), 'utf8'));
			const appPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

			expect(libPackage).toMatchObject({
				name: 'maestro-lib',
				version: MAESTRO_LIB_VERSION,
				private: true,
				main: 'index.js',
				types: 'index.d.ts',
				maestroAppVersion: appPackage.version,
			});
			expect(fs.existsSync(path.join(libDir, 'index.d.ts'))).toBe(true);
			expect(fs.readFileSync(path.join(libDir, 'README.md'), 'utf8')).toBe(
				fs.readFileSync(path.join(REPO_ROOT, 'docs/maestro-lib.md'), 'utf8')
			);
			// The entry re-exports whole modules (`export * from './run/session'`), so the
			// name lives in that module's declarations and the entry's point at it.
			const types = path.join(libDir, 'types/shared/maestro-lib');
			expect(fs.readFileSync(path.join(types, 'index.d.ts'), 'utf8')).toContain("'./run/session'");
			expect(fs.readFileSync(path.join(types, 'run/session.d.ts'), 'utf8')).toContain(
				'planSessionTurn'
			);
		});
	});

	posixOnly('a consumer built only on the entry', () => {
		it('plans, streams, resumes and stops a turn', () => {
			const consumer = path.join(scratch, 'consumer.js');
			fs.writeFileSync(
				consumer,
				`
			const lib = require(process.argv[2]);
			const config = JSON.parse(process.argv[3]);

			async function turn(recording, extra, stopAfterFirstEvent) {
				const planned = await lib.planSessionTurn({
					agentId: 'claude-code',
					cwd: config.cwd,
					prompt: 'What is the capital of France?',
					command: config.fakeAgent,
					envVars: { FAKE_AGENT_RECORDING: recording, ...extra },
					resumeSessionId: config.resume,
				});
				if (!planned.ok) throw new Error(planned.error);
				const events = [];
				const running = lib.runTurn(
					planned.spec,
					{ agentId: 'claude-code', sessionId: 'consumer', stopGraceMs: lib.INTERACTIVE_STOP_GRACE_MS },
					{
						onEvent: (event) => {
							events.push(event.type);
							if (stopAfterFirstEvent && events.length === 1) running.handle.interrupt();
						},
					}
				);
				const done = await running.completed;
				return { resuming: planned.resuming, events, outcome: done.outcome, sessionId: done.sessionId, answer: done.answerText };
			}

			(async () => {
				const first = await turn(config.normal, {}, false);
				config.resume = first.sessionId;
				const resumed = await turn(config.resumed, { FAKE_AGENT_ARGV_OUT: config.argvOut }, false);
				const resumeArgs = JSON.parse(require('fs').readFileSync(config.argvOut, 'utf8'));
				config.resume = undefined;
				const stopped = await turn(config.normal, { FAKE_AGENT_HOLD: '1' }, true);
				console.log(JSON.stringify({ first, resumed, resumeArgs, stopped }));
			})().catch((error) => {
				console.error(error && error.stack ? error.stack : String(error));
				process.exit(1);
			});
			`
			);

			const result = runNode([
				consumer,
				libDir,
				JSON.stringify({
					cwd: scratch,
					fakeAgent: FAKE_AGENT,
					normal: writeRecording('normal', CAPTURED_RECORDINGS['captured-claude-code-normal']),
					resumed: writeRecording('resumed', CAPTURED_RECORDINGS['captured-claude-code-resumed']),
					argvOut: path.join(scratch, 'resume-argv.json'),
				}),
			]) as {
				first: { resuming: boolean; events: string[]; outcome: string; sessionId: string };
				resumed: { resuming: boolean; outcome: string; sessionId: string };
				resumeArgs: string[];
				stopped: { outcome: string };
			};

			expect(result.first).toMatchObject({
				resuming: false,
				outcome: 'completed',
				sessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
			});
			expect(result.first.events).toContain('text');

			expect(result.resumed).toMatchObject({
				resuming: true,
				outcome: 'completed',
				sessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
			});
			const at = result.resumeArgs.indexOf('--resume');
			expect(result.resumeArgs[at + 1]).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);

			expect(result.stopped.outcome).toBe('interrupted');
		}, 60_000);
	});
});
describeSourceSuite('tui-example', () => {
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
});
describeSourceSuite('headless-program', () => {
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
			[
				'claude-code',
				'captured-claude-code-resumed',
				['--resume', CAPTURED_CLAUDE_CODE_SESSION_ID],
			],
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
});
