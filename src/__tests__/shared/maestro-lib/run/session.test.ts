/**
 * `planSessionTurn`: from "run this agent on this prompt" to a process spec,
 * using nothing but the library.
 *
 * The provider's binary is the fake agent, handed in as `command`, so planning
 * is tested against real provider definitions without any provider installed.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import * as hostOs from 'node:os';
import path from 'node:path';
import * as definitions from '../../../../shared/maestro-lib/providers/definitions';

vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()) }));
vi.mock('../../../../shared/maestro-lib/providers/definitions', async (original) => ({
	...(await original<typeof import('../../../../shared/maestro-lib/providers/definitions')>()),
}));

// Pinned so the same shape is asserted on every runner, with one Windows case:
// a session turn is planned as the CLI plans one, prompt on the command line.
const mocks = vi.hoisted(() => ({
	isWindows: vi.fn(() => false),
	// Arguments a test appends to what the provider builds, standing in for a
	// custom flag such as `--api-key=...`.
	extraArgs: [] as string[],
}));
vi.mock('../../../../shared/platformDetection', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../shared/platformDetection')>()),
	isWindows: () => mocks.isWindows(),
}));
vi.mock('../../../../shared/maestro-lib/launch/agent-args', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../shared/maestro-lib/launch/agent-args')>();
	return {
		...actual,
		buildAgentArgs: (...args: Parameters<typeof actual.buildAgentArgs>) => [
			...actual.buildAgentArgs(...args),
			...mocks.extraArgs,
		],
	};
});

import {
	planSessionTurn,
	type SessionTurnRequest,
} from '../../../../shared/maestro-lib/run/session';
import { QUERY_SOURCE_ENV_VAR } from '../../../../shared/querySource';
// The desktop spawners' own import path: the shim must escape with that code.
import { escapeCmdArg } from '../../../../main/process-manager/utils/shellEscape';
import { createScratchDir, FAKE_AGENT_PATH } from './fakeAgent';
import { isolateAgentEnv } from '../../../helpers/agentEnvIsolation';
import { TRANSLATION_KNOWLEDGE_ENV_VAR } from '../../../../shared/maestro-lib/translation/knowledge-binding';

const CWD = path.resolve(__dirname);
const SESSION_ID = 'ses_f16769d8cffe7rc1MP406tiARM';

function request(overrides: Partial<SessionTurnRequest> = {}): SessionTurnRequest {
	return {
		agentId: 'opencode',
		cwd: CWD,
		prompt: 'fix the bug',
		command: FAKE_AGENT_PATH,
		...overrides,
	};
}

async function plan(overrides: Partial<SessionTurnRequest> = {}) {
	const planned = await planSessionTurn(request(overrides));
	if (!planned.ok) throw new Error(`expected a plan, got: ${planned.error}`);
	return planned;
}

/** Whether `needle` appears in `haystack` as a contiguous run. */
function containsRun(haystack: string[], needle: string[]): boolean {
	return haystack.some((_, start) =>
		needle.every((value, offset) => haystack[start + offset] === value)
	);
}

describe('planSessionTurn', () => {
	beforeEach(() => {
		mocks.isWindows.mockReturnValue(false);
	});

	it('plans a new OpenCode turn in batch mode, with the prompt on the command line', async () => {
		const { spec, resuming } = await plan();

		expect(resuming).toBe(false);
		expect(spec.command).toBe(FAKE_AGENT_PATH);
		expect(spec.cwd).toBe(CWD);
		expect(spec.args[0]).toBe('run');
		expect(containsRun(spec.args, ['--format', 'json'])).toBe(true);
		expect(spec.args).toContain('fix the bug');
		expect(spec.args).not.toContain('--session');
		expect(spec.stdin).toBeUndefined();
	});

	it.each([
		['opencode', ['--session', SESSION_ID]],
		['claude-code', ['--resume', SESSION_ID]],
	])('continues a %s session with that provider resume arguments', async (agentId, resumeArgs) => {
		const { spec, resuming } = await plan({ agentId, resumeSessionId: SESSION_ID });

		expect(resuming).toBe(true);
		expect(containsRun(spec.args, resumeArgs)).toBe(true);
		expect(spec.env.MAESTRO_SESSION_RESUMED).toBe('1');
	});

	it('does not mark a new session as resumed', async () => {
		const { spec } = await plan();

		expect(spec.env.MAESTRO_SESSION_RESUMED).toBeUndefined();
	});

	it('plans a Claude Code turn with stream-json output and full access', async () => {
		const { spec } = await plan({ agentId: 'claude-code' });

		expect(spec.args).toContain('--print');
		expect(containsRun(spec.args, ['--output-format', 'stream-json'])).toBe(true);
		expect(spec.args).toContain('--dangerously-skip-permissions');
		expect(spec.args.slice(-2)).toEqual(['--', 'fix the bug']);
	});

	it('plans a read-only turn with the provider plan-mode arguments and no bypass', async () => {
		const { spec } = await plan({ agentId: 'claude-code', readOnly: true });

		expect(containsRun(spec.args, ['--permission-mode', 'plan'])).toBe(true);
		expect(spec.args).not.toContain('--dangerously-skip-permissions');
	});

	it('selects the model through the provider own flag', async () => {
		const { spec } = await plan({ model: 'opencode/big-pickle' });

		expect(containsRun(spec.args, ['--model', 'opencode/big-pickle'])).toBe(true);
	});

	it('keeps the prompt on the command line on a Windows host, as the CLI does', async () => {
		mocks.isWindows.mockReturnValue(true);

		const { spec } = await plan({ agentId: 'claude-code' });

		expect(spec.stdin).toBeUndefined();
		expect(spec.args.slice(-2)).toEqual(['--', 'fix the bug']);
	});

	it('stays in batch mode for an empty prompt', async () => {
		// No terminal is attached, so dropping the batch arguments would start
		// the provider's interactive mode and fail on "stdin is not a terminal".
		const { spec } = await plan({ prompt: '' });

		expect(spec.args[0]).toBe('run');
		expect(containsRun(spec.args, ['--format', 'json'])).toBe(true);
	});

	it('builds the environment from the provider defaults and the request', async () => {
		const { spec } = await plan({
			envVars: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
			querySource: 'cue',
		});

		expect(spec.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
		expect(spec.env[QUERY_SOURCE_ENV_VAR]).toBe('cue');
		expect(spec.env.PATH).toBeTruthy();
	});

	it('refuses a provider it does not know', async () => {
		expect(await planSessionTurn(request({ agentId: 'no-such-provider' }))).toEqual({
			ok: false,
			reason: 'unknown-agent',
			error: 'Unknown agent "no-such-provider"',
		});
	});

	it('refuses a provider that cannot run a single turn', async () => {
		const planned = await planSessionTurn(request({ agentId: 'terminal' }));

		expect(planned).toMatchObject({ ok: false, reason: 'no-batch-mode' });
	});

	it('refuses to resume a provider that cannot', async () => {
		const planned = await planSessionTurn(
			request({ agentId: 'hermes', resumeSessionId: SESSION_ID })
		);

		expect(planned).toMatchObject({ ok: false, reason: 'no-resume' });
	});

	it('refuses a provider whose output has no parser, since the runner could not read it', async () => {
		expect(await planSessionTurn(request({ agentId: 'hermes' }))).toEqual({
			ok: false,
			reason: 'no-parser',
			error: 'Hermes has no output parser, so its answer could not be read',
		});
	});

	it('refuses a read-only turn for a provider that cannot enforce one', async () => {
		// Antigravity's CLI has no flag that stops it writing in the workspace.
		const planned = await planSessionTurn(request({ agentId: 'antigravity', readOnly: true }));

		expect(planned).toMatchObject({ ok: false, reason: 'no-read-only' });
	});

	it('still plans a full-access turn for a provider that cannot enforce read-only', async () => {
		expect((await planSessionTurn(request({ agentId: 'antigravity' }))).ok).toBe(true);
	});

	it('reports a binary that is not where the request said', async () => {
		const missing = path.join(CWD, 'no-such-binary');

		expect(await planSessionTurn(request({ command: missing }))).toEqual({
			ok: false,
			reason: 'not-installed',
			error: `OpenCode was not found at ${missing}`,
		});
	});
});

describe('planSessionTurn with explicit prompt-file delivery', () => {
	isolateAgentEnv([TRANSLATION_KNOWLEDGE_ENV_VAR]);
	let scratch: ReturnType<typeof createScratchDir>;
	let fileProvider: definitions.AgentDefinition;

	beforeEach(() => {
		mocks.isWindows.mockReturnValue(false);
		scratch = createScratchDir('maestro-session-prompt');
		vi.spyOn(hostOs, 'tmpdir').mockReturnValue(scratch.dir);
		const original = definitions.getAgentDefinition;
		// Exercise the inactive route without enabling it in the provider registry.
		fileProvider = {
			...original('grok')!,
			promptFile: {
				format: 'acp-json',
				exclusivePromptFlags: ['-p', '--single', '--prompt-file'],
			},
			promptFileArgs: (file) => ['--prompt-file', file],
		};
		vi.spyOn(definitions, 'getAgentDefinition').mockImplementation((id) =>
			id === 'grok' ? fileProvider : original(id)
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		mocks.isWindows.mockReturnValue(false);
		scratch.cleanup();
	});

	it.each([
		['empty', ''],
		['multiline Unicode', '  first\r\n第二行 😀\n"quotes"\\backslash\tend  '],
		['large', 'large prompt 😀\n'.repeat(8192)],
	])(
		'carries exact %s text and all artifact metadata to a fresh spec per attempt',
		async (_, prompt) => {
			const input = {
				agentId: 'grok',
				cwd: scratch.dir,
				prompt,
				model: 'grok-4.5',
				resumeSessionId: SESSION_ID,
				envVars: { GROK_HOME: path.join(scratch.dir, 'account') },
				querySource: 'cue' as const,
			};
			const first = await plan(input);
			const second = await plan(input);
			const content = JSON.stringify({ type: 'acp', content: [{ type: 'text', text: prompt }] });

			for (const { spec, resuming } of [first, second]) {
				expect(spec.promptArtifact).toEqual({
					path: expect.any(String),
					owner: 'local',
					content,
					encoding: 'utf8',
					mode: 0o600,
					flag: 'wx',
					cleanup: 'turn',
				});
				const artifact = spec.promptArtifact!;
				expect(path.dirname(artifact.path)).toBe(scratch.dir);
				expect(Buffer.from(artifact.content, 'utf8')).toEqual(Buffer.from(content, 'utf8'));
				expect(spec.args.slice(-2)).toEqual(['--prompt-file', artifact.path]);
				expect(spec.args.filter((arg) => arg === '--prompt-file')).toHaveLength(1);
				expect(spec.args).not.toContain(prompt);
				expect(spec.args).not.toContain('-p');
				expect(spec.stdin).toBeUndefined();
				expect(spec.command).toBe(FAKE_AGENT_PATH);
				expect(spec.cwd).toBe(scratch.dir);
				expect(containsRun(spec.args, ['--output-format', 'streaming-json'])).toBe(true);
				expect(containsRun(spec.args, ['--resume', SESSION_ID])).toBe(true);
				expect(containsRun(spec.args, ['-m', 'grok-4.5'])).toBe(true);
				expect(spec.env.GROK_HOME).toBe(input.envVars.GROK_HOME);
				expect(spec.env[QUERY_SOURCE_ENV_VAR]).toBe('cue');
				expect(spec.env.MAESTRO_SESSION_RESUMED).toBe('1');
				expect(resuming).toBe(true);
			}
			expect(first.spec.promptArtifact!.path).not.toBe(second.spec.promptArtifact!.path);
			// Planning allocates names; startTurn owns every write and cleanup.
			expect(fs.readdirSync(scratch.dir)).toEqual([]);
		}
	);

	it('preserves the file artifact through Windows shim escaping without using raw stdin', async () => {
		const shim = path.join(scratch.dir, 'agent shim.cmd');
		fs.writeFileSync(shim, '@echo off\r\n', { mode: 0o755 });
		mocks.isWindows.mockReturnValue(true);
		const prompt = 'first\nsecond & 50% ^ "quoted" 😀';
		const { spec } = await plan({ agentId: 'grok', command: shim, prompt });

		expect(spec.shell).toBe(true);
		expect(spec.command).toBe(`"${shim}"`);
		expect(JSON.parse(spec.promptArtifact!.content)).toEqual({
			type: 'acp',
			content: [{ type: 'text', text: prompt }],
		});
		expect(spec.args.slice(-2)).toEqual(
			['--prompt-file', spec.promptArtifact!.path].map(escapeCmdArg)
		);
		expect(spec.args.join(' ')).not.toContain('second');
		expect(spec.stdin).toBeUndefined();
		expect(fs.readdirSync(scratch.dir)).toEqual(['agent shim.cmd']);
	});

	it('returns a launch refusal when the file builder is missing without retrying raw delivery', async () => {
		fileProvider.promptFileArgs = undefined;
		const result = await planSessionTurn(request({ agentId: 'grok', prompt: 'private prompt' }));

		expect(result).toEqual({
			ok: false,
			reason: 'launch',
			error:
				'Prompt-file delivery requires a fresh owned .json destination on the executing host and a provider file-argument builder.',
		});
		expect(fs.readdirSync(scratch.dir)).toEqual([]);
	});

	it.each(['omp', 'claude-code', 'codex'])(
		'keeps %s legacy text delivery without creating an artifact',
		async (agentId) => {
			const prompt = 'ordinary provider prompt';
			const { spec } = await plan({ agentId, prompt });

			expect(spec.args.filter((arg) => arg === prompt)).toHaveLength(1);
			expect(spec.args.at(-1)).toBe(prompt);
			expect(spec.promptArtifact).toBeUndefined();
			expect(spec.stdin).toBeUndefined();
			expect(fs.readdirSync(scratch.dir)).toEqual([]);
		}
	);
});

describe('planSessionTurn on Windows with an npm .cmd shim', () => {
	// Everything cmd.exe would otherwise eat or rewrite.
	const HOSTILE_PROMPT = 'say "hi" & echo 50% | more ^ done\nsecond line\r\nthird';

	let dir: string;
	let shim: string;
	let exe: string;

	beforeAll(() => {
		// A directory with a space, like C:\Users\First Last\AppData\Roaming\npm.
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro lib shim '));
		shim = path.join(dir, 'agent.cmd');
		exe = path.join(dir, 'agent.exe');
		fs.writeFileSync(shim, '@echo off\r\n', { mode: 0o755 });
		fs.writeFileSync(exe, '', { mode: 0o755 });
	});

	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	beforeEach(() => {
		mocks.isWindows.mockReturnValue(true);
		mocks.extraArgs = [];
	});

	it('runs the shim through cmd.exe, quoted, with every argument escaped and the prompt on stdin', async () => {
		const { spec } = await plan({ agentId: 'claude-code', command: shim, prompt: HOSTILE_PROMPT });

		mocks.isWindows.mockReturnValue(false);
		const { spec: posix } = await plan({
			agentId: 'claude-code',
			command: shim,
			prompt: HOSTILE_PROMPT,
		});
		// The same arguments, less the prompt the POSIX plan put on the command line.
		expect(posix.args.slice(-2)).toEqual(['--', HOSTILE_PROMPT]);
		const unescaped = posix.args.slice(0, -2);

		expect(spec.shell).toBe(true);
		expect(spec.command).toBe(`"${shim}"`);
		expect(spec.args).toEqual(unescaped.map(escapeCmdArg));
		expect(spec.stdin).toBe(HOSTILE_PROMPT);
		expect(spec.args.join(' ')).not.toContain('second line');
	});

	it('escapes an argument the shim gets on its command line', async () => {
		// Antigravity reads no prompt from stdin, so its prompt stays in argv.
		const { spec } = await plan({ agentId: 'antigravity', command: shim, prompt: 'fix the bug' });

		expect(spec.shell).toBe(true);
		expect(spec.stdin).toBeUndefined();
		expect(spec.args).toContain('"fix the bug"');
		expect(spec.args).not.toContain('fix the bug');
	});

	it.each([
		['a line break', 'first\nsecond', 'line break'],
		['a %NAME% pair', 'use %TEMP% for scratch', '%NAME%'],
		['a caret', 'x ^ y', '^'],
	])(
		'refuses a command-line prompt with %s rather than pass it altered',
		async (_label, prompt, named) => {
			const planned = await planSessionTurn(
				request({ agentId: 'antigravity', command: shim, prompt })
			);

			expect(planned.ok).toBe(false);
			if (planned.ok) return;
			expect(planned.reason).toBe('windows-shell');
			expect(planned.error).toContain('the prompt');
			expect(planned.error).toContain(named);
		}
	);

	it('passes a command-line prompt with a lone %, which cmd.exe leaves alone', async () => {
		const prompt = 'cut 50% off';
		const { spec } = await plan({ agentId: 'antigravity', command: shim, prompt });

		expect(spec.args).toContain(escapeCmdArg(prompt));
	});

	it.each([
		['a --flag=value argument', ['--api-key=sk-%SECRET%-value']],
		['a --flag value pair', ['--api-key', 'sk-%SECRET%-value']],
	])('names %s by its flag and never quotes the secret', async (_label, args) => {
		mocks.extraArgs = args;

		const planned = await planSessionTurn(
			request({ agentId: 'claude-code', command: shim, prompt: 'fix the bug' })
		);

		expect(planned.ok).toBe(false);
		if (planned.ok) return;
		expect(planned.reason).toBe('windows-shell');
		expect(planned.error).toBe(
			`Claude Code at ${shim} only starts through cmd.exe, which cannot pass the value of --api-key intact: it contains a %NAME% pair, which cmd.exe expands as a variable`
		);
		expect(planned.error).not.toContain('SECRET');
	});

	it('names an argument that follows no flag by its position, without quoting it', async () => {
		mocks.extraArgs = ['--', 'ab^cd'];

		const planned = await planSessionTurn(
			request({ agentId: 'claude-code', command: shim, prompt: 'fix the bug' })
		);

		expect(planned.ok).toBe(false);
		if (planned.ok) return;
		expect(planned.error).toMatch(/cannot pass argument \d+ intact: it contains \^/);
		expect(planned.error).not.toContain('ab^cd');
	});

	it('starts an .exe with a path directly, unescaped', async () => {
		const { spec } = await plan({ agentId: 'claude-code', command: exe });

		expect(spec.shell).toBeUndefined();
		expect(spec.command).toBe(exe);
		expect(spec.args.slice(-2)).toEqual(['--', 'fix the bug']);
		expect(spec.stdin).toBeUndefined();
	});

	it('leaves the shim alone on a host that is not Windows', async () => {
		mocks.isWindows.mockReturnValue(false);

		const { spec } = await plan({ agentId: 'claude-code', command: shim, prompt: HOSTILE_PROMPT });

		expect(spec.shell).toBeUndefined();
		expect(spec.command).toBe(shim);
		expect(spec.args.slice(-2)).toEqual(['--', HOSTILE_PROMPT]);
		expect(spec.stdin).toBeUndefined();
	});
});
