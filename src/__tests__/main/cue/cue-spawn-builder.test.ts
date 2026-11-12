/**
 * Tests for the Cue Spawn Builder.
 *
 * Verifies spawn spec construction: agent definition lookup, arg building,
 * config overrides, SSH wrapping, and prompt appending.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueExecutionConfig } from '../../../main/cue/cue-executor';
import type { CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';
import type { TemplateContext } from '../../../shared/templateVariables';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockGetAgentDefinition = vi.fn();
const mockGetAgentCapabilities = vi.fn(() => ({
	supportsResume: true,
	supportsReadOnlyMode: true,
	supportsJsonOutput: true,
	supportsSessionId: true,
	supportsImageInput: false,
	supportsImageInputOnResume: false,
	supportsSlashCommands: true,
	supportsSessionStorage: true,
	supportsCostTracking: true,
	supportsContextUsage: true,
	supportsThinking: false,
	supportsStdin: false,
	supportsRawStdin: false,
	supportsModelSelection: false,
	supportsModelDiscovery: false,
	supportsBatchMode: true,
	supportsYoloMode: true,
	supportsExitCodes: true,
	supportsWorkingDir: false,
}));

vi.mock('../../../main/agents', () => ({
	getAgentDefinition: (...args: unknown[]) => mockGetAgentDefinition(...args),
	getAgentCapabilities: (...args: unknown[]) => mockGetAgentCapabilities(...args),
}));

const mockBuildAgentArgs = vi.fn((_agent: unknown, _opts: unknown) => ['--print', '--verbose']);
const mockApplyOverrides = vi.fn((_agent: unknown, args: string[], _overrides: unknown) => ({
	args,
	effectiveCustomEnvVars: undefined,
	customArgsSource: 'none' as const,
	customEnvSource: 'none' as const,
	modelSource: 'default' as const,
}));

vi.mock('../../../main/utils/agent-args', () => ({
	buildAgentArgs: (...args: unknown[]) => mockBuildAgentArgs(...args),
	applyAgentConfigOverrides: (...args: unknown[]) => mockApplyOverrides(...args),
}));

const mockWrapSpawnWithSsh = vi.fn();
vi.mock('../../../main/utils/ssh-spawn-wrapper', async () => {
	const actual = await vi.importActual<typeof import('../../../main/utils/ssh-spawn-wrapper')>(
		'../../../main/utils/ssh-spawn-wrapper'
	);
	return {
		...actual,
		wrapSpawnWithSsh: (...args: unknown[]) => mockWrapSpawnWithSsh(...args),
	};
});

// Mock the Claude token-source resolver's leaf dependencies so the maestro-p
// binary reads as present and config-dir resolution is deterministic. The
// resolver itself (resolveClaudeSpawnMode / applyClaudeSpawnDecision) and
// getClaudeTokenMode run for real, so these tests exercise the actual
// command/arg/env rewrite produced inside buildSpawnSpec.
vi.mock('../../../main/agents/claude-usage-startup', () => ({
	getMaestroPBinPath: () => '/bundled/maestro-p.js',
	isMaestroPBinaryPath: (p: string | null | undefined) => !!p && p.includes('maestro-p'),
}));
vi.mock('../../../main/stores/claudeUsageStore', () => ({
	getSnapshot: () => null,
	resolveConfigDirKey: () => 'test-config-key',
}));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	// Make the resolved maestro-p script read as present; leave every other fs
	// function untouched so the rest of the import graph behaves normally.
	return { ...actual, existsSync: () => true };
});

// POSIX by default; the Windows `.cmd` shim tests flip it.
const { mockIsWindows } = vi.hoisted(() => ({ mockIsWindows: vi.fn(() => false) }));
vi.mock('../../../shared/platformDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/platformDetection')>();
	return { ...actual, isWindows: () => mockIsWindows() };
});

// Must import after mocks
import { buildSpawnSpec } from '../../../main/cue/cue-spawn-builder';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultAgentDef = {
	id: 'claude-code',
	name: 'Claude Code',
	binaryName: 'claude',
	command: 'claude',
	args: ['--print', '--verbose'],
};

function createConfig(overrides: Partial<CueExecutionConfig> = {}): CueExecutionConfig {
	return {
		runId: 'run-1',
		session: {
			id: 'session-1',
			name: 'Test',
			toolType: 'claude-code',
			cwd: '/projects/test',
			projectRoot: '/projects/test',
		} as SessionInfo,
		subscription: {
			name: 'test-sub',
			event: 'file.changed',
			enabled: true,
			prompt: 'test',
		} as CueSubscription,
		event: {
			id: 'evt-1',
			type: 'file.changed',
			timestamp: '2026-01-01T00:00:00.000Z',
			triggerName: 'test',
			payload: {},
		} as CueEvent,
		promptPath: 'test prompt',
		toolType: 'claude-code',
		projectRoot: '/projects/test',
		templateContext: {} as TemplateContext,
		timeoutMs: 30000,
		onLog: vi.fn(),
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('cue-spawn-builder', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsWindows.mockReturnValue(false);
		mockGetAgentDefinition.mockReturnValue(defaultAgentDef);
		// The spec env spreads process.env, so an ambient MAESTRO_CLAUDE_BIN
		// (leaked when these tests run inside a maestro/claude agent) would bleed
		// into specs and trip the "maestro-p disabled -> undefined" assertion.
		// Clear it so the suite asserts only what the builder itself injects.
		vi.stubEnv('MAESTRO_CLAUDE_BIN', undefined as unknown as string);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe('buildSpawnSpec', () => {
		it('returns error for unknown agent type', async () => {
			mockGetAgentDefinition.mockReturnValue(undefined);

			const result = await buildSpawnSpec(createConfig({ toolType: 'nonexistent' }), 'prompt');

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.message).toContain('Unknown agent type: nonexistent');
			}
		});

		it('builds spec with correct command and cwd for local execution', async () => {
			const result = await buildSpawnSpec(createConfig(), 'hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.command).toBe('claude');
				expect(result.spec.cwd).toBe('/projects/test');
			}
		});

		it('uses custom path when provided', async () => {
			const result = await buildSpawnSpec(createConfig({ customPath: '/custom/claude' }), 'prompt');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.command).toBe('/custom/claude');
			}
		});

		it('appends -- then prompt for default agents (no promptArgs/noPromptSeparator)', async () => {
			const result = await buildSpawnSpec(createConfig(), 'Hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				const args = result.spec.args;
				expect(args[args.length - 2]).toBe('--');
				expect(args[args.length - 1]).toBe('Hello world');
			}
		});

		it('uses promptArgs when agent provides it', async () => {
			mockGetAgentDefinition.mockReturnValue({
				...defaultAgentDef,
				promptArgs: (p: string) => ['-p', p],
			});

			const result = await buildSpawnSpec(createConfig(), 'Hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				const pIdx = result.spec.args.indexOf('-p');
				expect(pIdx).toBeGreaterThan(-1);
				expect(result.spec.args[pIdx + 1]).toBe('Hello world');
			}
		});

		it('appends prompt directly when noPromptSeparator is true', async () => {
			mockGetAgentDefinition.mockReturnValue({
				...defaultAgentDef,
				noPromptSeparator: true,
			});

			const result = await buildSpawnSpec(createConfig(), 'Hello world');

			expect(result.ok).toBe(true);
			if (result.ok) {
				const args = result.spec.args;
				expect(args[args.length - 1]).toBe('Hello world');
				expect(args[args.length - 2]).not.toBe('--');
			}
		});

		describe('Windows .cmd shim (MAESTRO-R0)', () => {
			const codexDef = {
				id: 'codex',
				name: 'Codex',
				binaryName: 'codex',
				command: 'codex',
				args: ['exec'],
			};
			const shimPath = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd';
			const multiLinePrompt = 'Review the diff.\nThen summarize "what changed".';

			function useStdinCapableCodex(stdin = true) {
				mockGetAgentDefinition.mockReturnValue(codexDef);
				mockBuildAgentArgs.mockReturnValueOnce(['exec', '--json']);
				mockGetAgentCapabilities.mockReturnValueOnce({
					...mockGetAgentCapabilities(),
					supportsPromptViaStdin: stdin,
				} as ReturnType<typeof mockGetAgentCapabilities>);
			}

			beforeEach(() => {
				mockIsWindows.mockReturnValue(true);
			});

			it('starts the shim through cmd.exe and sends the prompt on stdin', async () => {
				useStdinCapableCodex();

				const result = await buildSpawnSpec(
					createConfig({ toolType: 'codex', customPath: shimPath }),
					multiLinePrompt
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.shell).toBe(true);
					expect(result.spec.command).toBe(shimPath);
					// cmd.exe ends a command at a line break, so the prompt must not ride argv.
					expect(result.spec.args).toEqual(['exec', '--json']);
					expect(result.spec.stdinPrompt).toBe(multiLinePrompt);
				}
			});

			it('appends the stdin query args an agent declares', async () => {
				useStdinCapableCodex();
				mockGetAgentDefinition.mockReturnValue({
					...codexDef,
					stdinPromptArgs: ['--query-file', '-'],
				});

				const result = await buildSpawnSpec(
					createConfig({ toolType: 'codex', customPath: shimPath }),
					'prompt'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.args).toEqual(['exec', '--json', '--query-file', '-']);
					expect(result.spec.stdinPrompt).toBe('prompt');
				}
			});

			it('quotes a shim path containing spaces for cmd.exe', async () => {
				useStdinCapableCodex();
				const spaced = 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\codex.cmd';

				const result = await buildSpawnSpec(
					createConfig({ toolType: 'codex', customPath: spaced }),
					'prompt'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.command).toBe(`"${spaced}"`);
					expect(result.spec.shell).toBe(true);
				}
			});

			it('keeps the prompt in argv, escaped, for an agent that cannot read stdin', async () => {
				useStdinCapableCodex(false);

				const result = await buildSpawnSpec(
					createConfig({ toolType: 'codex', customPath: shimPath }),
					'fix the "auth" bug'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.shell).toBe(true);
					expect(result.spec.stdinPrompt).toBeUndefined();
					expect(result.spec.args).toEqual(['exec', '--json', '--', '"fix the ""auth"" bug"']);
				}
			});

			it('refuses a multi-line prompt for an agent that cannot read stdin', async () => {
				useStdinCapableCodex(false);

				const result = await buildSpawnSpec(
					createConfig({ toolType: 'codex', customPath: shimPath }),
					multiLinePrompt
				);

				expect(result).toEqual({
					ok: false,
					message: `Codex at ${shimPath} only starts through cmd.exe, which cannot pass the prompt intact: it contains a line break, which ends a cmd.exe command line`,
				});
			});

			it('refuses a prompt containing % for an agent that cannot read stdin', async () => {
				useStdinCapableCodex(false);

				const result = await buildSpawnSpec(
					createConfig({ toolType: 'codex', customPath: shimPath }),
					'Use %USERPROFILE% as the root'
				);

				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.message).toContain('cannot pass the prompt intact');
					expect(result.message).toContain(
						'it contains a %NAME% pair, which cmd.exe expands as a variable'
					);
				}
			});

			it('refuses a prompt containing ^ for an agent that cannot read stdin', async () => {
				useStdinCapableCodex(false);

				const result = await buildSpawnSpec(
					createConfig({ toolType: 'codex', customPath: shimPath }),
					'match ^main$'
				);

				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.message).toContain('it contains ^, which cmd.exe would pass on doubled');
				}
			});

			it('still runs a stdin-capable agent with a multi-line, % prompt: it never rides cmd.exe', async () => {
				useStdinCapableCodex();
				const prompt = 'Use %USERPROFILE% as the root.\nThen match ^main$.';

				const result = await buildSpawnSpec(
					createConfig({ toolType: 'codex', customPath: shimPath }),
					prompt
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.shell).toBe(true);
					expect(result.spec.args).toEqual(['exec', '--json']);
					expect(result.spec.stdinPrompt).toBe(prompt);
				}
			});

			it('refuses any other shell-bound argument cmd.exe would rewrite, even with the prompt on stdin', async () => {
				useStdinCapableCodex();
				mockApplyOverrides.mockReturnValueOnce({
					args: ['exec', '--json', '--config', 'home=%APPDATA%'],
					effectiveCustomEnvVars: undefined,
				} as unknown as ReturnType<typeof mockApplyOverrides>);

				const result = await buildSpawnSpec(
					createConfig({ toolType: 'codex', customPath: shimPath }),
					'prompt'
				);

				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.message).toContain('cannot pass the value of --config intact');
					expect(result.message).not.toContain('%APPDATA%');
				}
			});

			// The same cases as rc's src/__tests__/shared/maestro-lib/launch/windows-command.test.ts,
			// run through the builder because main's cmdShellArgProblem() is private to
			// it. Change both together until main has maestro-lib. The cmd.exe
			// behaviour is read from documented parser rules; only the windows-latest
			// CI leg has a real cmd.exe.
			describe('the cmd.exe argument rule', () => {
				/** The reason the builder refuses `arg`, or null when it builds. */
				async function problemFor(arg: string): Promise<string | null> {
					useStdinCapableCodex();
					mockApplyOverrides.mockReturnValueOnce({
						args: ['exec', '--json', '--', arg],
						effectiveCustomEnvVars: undefined,
					} as unknown as ReturnType<typeof mockApplyOverrides>);
					const result = await buildSpawnSpec(
						createConfig({ toolType: 'codex', customPath: shimPath }),
						'prompt'
					);
					if (result.ok) return null;
					const marker = ' intact: ';
					expect(result.message).not.toContain(arg);
					return result.message.slice(result.message.indexOf(marker) + marker.length);
				}

				it.each([
					['a trailing percent', '100%'],
					['a URL escape', '%20'],
					['a percent in prose', '50% off'],
					['an empty pair', '%%'],
					['a doubled trailing percent', '100%%'],
					['a plain argument', '--print'],
					['an argument with spaces and quotes', 'say "hi" & more'],
				])('lets %s through', async (_label, arg) => {
					expect(await problemFor(arg)).toBeNull();
				});

				it.each([
					['a plain variable', '%PATH%'],
					['a name with parentheses', '%ProgramFiles(x86)%'],
					['a substring form', '%PATH:~0,3%'],
					['a substitution form', '%X:a=b%'],
					['a name with a space', '%a b%'],
					['a drive variable', '%=C:%'],
					['a pair inside doubled percents', '%%PATH%%'],
					['a pair inside a value', '--settings=%APPDATA%\\claude.json'],
					['two lone percents in one argument', '50% off, then 20% more'],
				])('refuses %s', async (_label, arg) => {
					expect(await problemFor(arg)).toBe(
						'it contains a %NAME% pair, which cmd.exe expands as a variable'
					);
				});

				it.each(['first\nsecond', 'first\r\nsecond', 'first\rsecond'])(
					'refuses a line break (%j)',
					async (arg) => {
						expect(await problemFor(arg)).toBe(
							'it contains a line break, which ends a cmd.exe command line'
						);
					}
				);

				it('refuses a caret', async () => {
					expect(await problemFor('match ^main$')).toBe(
						'it contains ^, which cmd.exe would pass on doubled'
					);
				});

				it('runs a prompt with a lone % on the command line', async () => {
					useStdinCapableCodex(false);

					const result = await buildSpawnSpec(
						createConfig({ toolType: 'codex', customPath: shimPath }),
						'Cut it by 50% off'
					);

					expect(result.ok).toBe(true);
					if (result.ok) expect(result.spec.args).toContain('"Cut it by 50% off"');
				});
			});

			describe('never quotes a refused argument, which may be a credential', () => {
				async function refusalFor(args: string[]) {
					useStdinCapableCodex();
					mockApplyOverrides.mockReturnValueOnce({
						args,
						effectiveCustomEnvVars: undefined,
					} as unknown as ReturnType<typeof mockApplyOverrides>);
					const result = await buildSpawnSpec(
						createConfig({ toolType: 'codex', customPath: shimPath }),
						'prompt'
					);
					expect(result.ok).toBe(false);
					return result.ok ? '' : result.message;
				}

				it('names a --flag=value argument by its flag', async () => {
					const message = await refusalFor(['exec', '--json', '--api-key=ab%cd%']);

					expect(message).toContain(
						'cannot pass the value of --api-key intact: it contains a %NAME% pair, which cmd.exe expands as a variable'
					);
					expect(message).not.toContain('ab%cd');
				});

				it('names the value of a --flag value pair with a %NAME% secret by its flag', async () => {
					const message = await refusalFor(['exec', '--api-key', 'sk-%SECRET%-value']);

					expect(message).toContain(
						'cannot pass the value of --api-key intact: it contains a %NAME% pair, which cmd.exe expands as a variable'
					);
					expect(message).not.toContain('SECRET');
				});

				it('names the value of a --flag value pair by its flag', async () => {
					const message = await refusalFor(['exec', '--json', '--token', 'ab^cd']);

					expect(message).toContain(
						'cannot pass the value of --token intact: it contains ^, which cmd.exe would pass on doubled'
					);
					expect(message).not.toContain('ab^cd');
				});

				it('names any other argument by its position', async () => {
					const message = await refusalFor(['exec', '--json', '--', 'ab%cd%']);

					expect(message).toContain('cannot pass argument 4 intact');
					expect(message).not.toContain('ab%cd');
				});

				it('names the value of a single-letter flag by its flag', async () => {
					const message = await refusalFor(['exec', '-c', 'home=%APPDATA%']);

					expect(message).toContain('cannot pass the value of -c intact');
					expect(message).not.toContain('%APPDATA%');
				});

				it('never names a short flag with a value attached, which may be the secret', async () => {
					const message = await refusalFor(['exec', '-pSECRET', '%APPDATA%']);

					expect(message).toContain('cannot pass argument 3 intact');
					expect(message).not.toContain('SECRET');
				});

				it('never names a preceding value that only starts with a dash', async () => {
					const message = await refusalFor(['exec', '--token', '-secret-value', 'bad%arg%']);

					expect(message).toContain('cannot pass argument 4 intact');
					expect(message).not.toContain('secret-value');
					expect(message).not.toContain('bad%arg');
				});

				it('never names the part before = unless it is a bare flag name', async () => {
					const message = await refusalFor(['exec', '-pSECRET=ab%cd%']);

					expect(message).toContain('cannot pass argument 2 intact');
					expect(message).not.toContain('SECRET');
				});

				it('can only name a flag, never a value, after a flag that takes no value', async () => {
					// Shape alone cannot tell that --json takes no value, so the label is
					// imprecise here, but what it names is still only a flag.
					const message = await refusalFor(['exec', '--json', '-pSECRET=ab%cd%']);

					expect(message).toContain('cannot pass the value of --json intact');
					expect(message).not.toContain('SECRET');
				});
			});

			it('leaves a Windows .exe untouched: no shell, prompt in argv', async () => {
				useStdinCapableCodex();
				const exe = 'C:\\Users\\dev\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe';

				const result = await buildSpawnSpec(
					createConfig({ toolType: 'codex', customPath: exe }),
					multiLinePrompt
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.shell).toBeUndefined();
					expect(result.spec.command).toBe(exe);
					expect(result.spec.args).toEqual(['exec', '--json', '--', multiLinePrompt]);
					expect(result.spec.stdinPrompt).toBeUndefined();
				}
			});

			it('does nothing off Windows, even for a .cmd path', async () => {
				mockIsWindows.mockReturnValue(false);
				useStdinCapableCodex();

				const result = await buildSpawnSpec(
					createConfig({ toolType: 'codex', customPath: shimPath }),
					'prompt'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.shell).toBeUndefined();
					expect(result.spec.args).toEqual(['exec', '--json', '--', 'prompt']);
					expect(result.spec.stdinPrompt).toBeUndefined();
				}
			});

			it('passes a multi-line, % prompt through untouched off Windows', async () => {
				mockIsWindows.mockReturnValue(false);
				useStdinCapableCodex(false);
				const prompt = 'Use %HOME% as the root.\nThen match ^main$.';

				const result = await buildSpawnSpec(createConfig({ toolType: 'codex' }), prompt);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.command).toBe('codex');
					expect(result.spec.shell).toBeUndefined();
					expect(result.spec.args).toEqual(['exec', '--json', '--', prompt]);
					expect(result.spec.stdinPrompt).toBeUndefined();
				}
			});
		});

		it('calls buildAgentArgs with yoloMode: true', async () => {
			await buildSpawnSpec(createConfig(), 'prompt');

			expect(mockBuildAgentArgs).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'claude-code' }),
				expect.objectContaining({ yoloMode: true, permissionMode: 'full' })
			);
		});

		it('passes config overrides through applyAgentConfigOverrides', async () => {
			const config = createConfig({
				customModel: 'claude-4-opus',
				customArgs: '--max-tokens 1000',
				customEnvVars: { API_KEY: 'test' },
			});

			await buildSpawnSpec(config, 'prompt');

			expect(mockApplyOverrides).toHaveBeenCalledWith(
				expect.anything(),
				expect.any(Array),
				expect.objectContaining({
					sessionCustomModel: 'claude-4-opus',
					sessionCustomArgs: '--max-tokens 1000',
					sessionCustomEnvVars: { API_KEY: 'test' },
				})
			);
		});

		it('includes process.env in the spec env', async () => {
			// Seed a unique env var to avoid platform-fragile assertions (e.g. PATH)
			process.env.__CUE_SPAWN_TEST__ = 'test-value';
			try {
				const result = await buildSpawnSpec(createConfig(), 'prompt');

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.env.__CUE_SPAWN_TEST__).toBe('test-value');
				}
			} finally {
				delete process.env.__CUE_SPAWN_TEST__;
			}
		});

		it('expands a launchd PATH instead of inheriting it verbatim (#1573)', async () => {
			const launchdPath = '/usr/bin:/bin:/usr/sbin:/sbin';
			const originalPath = process.env.PATH;
			process.env.PATH = launchdPath;
			try {
				const result = await buildSpawnSpec(createConfig(), 'prompt');

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.env.PATH).not.toBe(launchdPath);
					expect(result.spec.env.PATH).toContain(launchdPath.split(':')[0]);
					if (process.platform !== 'win32') {
						const parts = result.spec.env.PATH.split(':');
						expect(parts).toContain('/opt/homebrew/bin');
						expect(parts).toContain('/usr/local/bin');
					}
				}
			} finally {
				process.env.PATH = originalPath;
			}
		});

		it('marks the spawn as a cue turn', async () => {
			// Nothing else distinguishes a Cue run from a prompt the user typed:
			// same binary, same args, and the prompt text is the user's own words
			// out of cue.yaml. Downstream tooling reads this var instead of guessing.
			const result = await buildSpawnSpec(createConfig(), 'prompt');

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.env.MAESTRO_QUERY_SOURCE).toBe('cue');
			}
		});

		it('keeps the cue marker even when the agent sets its own env vars', async () => {
			const result = await buildSpawnSpec(
				createConfig({ customEnvVars: { MAESTRO_QUERY_SOURCE: 'user' } }),
				'prompt'
			);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.spec.env.MAESTRO_QUERY_SOURCE).toBe('cue');
			}
		});

		describe('SSH execution', () => {
			it('calls wrapSpawnWithSsh when SSH is enabled', async () => {
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host', 'claude', '--print'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'remote-1', name: 'Server', host: 'host.example.com' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
						sshStore: mockSshStore,
					}),
					'prompt'
				);

				expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
					expect.objectContaining({
						command: 'claude',
						agentBinaryName: 'claude',
					}),
					{ enabled: true, remoteId: 'remote-1' },
					mockSshStore
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.command).toBe('ssh');
					expect(result.spec.cwd).toBe('/Users/test');
					expect(result.spec.sshRemoteUsed).toEqual({
						id: 'remote-1',
						name: 'Server',
						host: 'host.example.com',
					});
				}
			});

			it('does not append prompt to args for SSH mode (wrapper handles it)', async () => {
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host', 'claude', '--', 'Hello world'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'Hello world'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					// Only one occurrence of the prompt (from SSH wrapper)
					const promptOccurrences = result.spec.args.filter((a) =>
						a.includes('Hello world')
					).length;
					expect(promptOccurrences).toBe(1);
				}
			});

			it('passes sshStdinScript through when SSH returns it', async () => {
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshStdinScript: '#!/bin/bash\nclaude "test prompt"',
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'test prompt'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.sshStdinScript).toBe('#!/bin/bash\nclaude "test prompt"');
				}
			});

			it('passes stdinPrompt through when SSH returns prompt for stdin delivery', async () => {
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: 'large prompt content',
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'large prompt content'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.stdinPrompt).toBe('large prompt content');
				}
			});

			it('fails instead of spawning locally when the wrapper cannot resolve the remote', async () => {
				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'claude',
					args: ['--print', '--verbose'],
					cwd: '/projects/test',
					customEnvVars: undefined,
					prompt: 'Hello world',
					sshRemoteUsed: null,
				});

				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'deleted-remote' },
						sshStore: { getSshRemotes: vi.fn(() => []) },
					}),
					'Hello world'
				);

				expect(result).toEqual({
					ok: false,
					message: expect.stringContaining(
						'configured remote "deleted-remote" could not be resolved'
					),
				});
			});

			describe('with the real SSH wrapper and resolver', () => {
				let realWrap: typeof import('../../../main/utils/ssh-spawn-wrapper').wrapSpawnWithSsh;
				beforeEach(async () => {
					realWrap = (
						await vi.importActual<typeof import('../../../main/utils/ssh-spawn-wrapper')>(
							'../../../main/utils/ssh-spawn-wrapper'
						)
					).wrapSpawnWithSsh;
					mockWrapSpawnWithSsh.mockImplementation((...args: Parameters<typeof realWrap>) =>
						realWrap(...args)
					);
				});

				it('fails when the remote id is not in settings', async () => {
					const result = await buildSpawnSpec(
						createConfig({
							sshRemoteConfig: { enabled: true, remoteId: 'deleted-remote' },
							sshStore: { getSshRemotes: () => [] },
						}),
						'Hello world'
					);

					expect(result.ok).toBe(false);
					if (!result.ok) {
						expect(result.message).toContain(
							'configured remote "deleted-remote" could not be resolved'
						);
					}
				});

				it('fails when the remote exists but is disabled', async () => {
					const result = await buildSpawnSpec(
						createConfig({
							sshRemoteConfig: { enabled: true, remoteId: 'r1' },
							sshStore: {
								getSshRemotes: () => [
									{
										id: 'r1',
										name: 'Server',
										host: 'host.example.com',
										port: 22,
										username: 'dev',
										privateKeyPath: '',
										enabled: false,
									},
								],
							},
						}),
						'Hello world'
					);

					expect(result.ok).toBe(false);
					if (!result.ok) {
						expect(result.message).toContain('configured remote "r1" could not be resolved');
					}
				});
			});

			it('still appends prompt when SSH is enabled but sshStore is missing', async () => {
				// SSH enabled in config, but no sshStore → SSH wrapping skipped
				// Prompt should still be appended for local fallback
				const result = await buildSpawnSpec(
					createConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						// sshStore deliberately omitted
					}),
					'Hello world'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					const args = result.spec.args;
					expect(args[args.length - 1]).toBe('Hello world');
					expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
				}
			});
		});

		describe('Claude token-source (maestro-p) rewrite', () => {
			// A claude-code definition carrying the interactive (maestro-p) wiring
			// the resolver requires to treat the spawn as a TUI candidate.
			const claudeInteractiveAgentDef = {
				...defaultAgentDef,
				interactiveCommand: 'maestro-p',
				interactiveModeArgs: ['--dangerously-skip-permissions'],
				defaultEnvVars: {},
			};

			it('rewrites a local spawn to maestro-p for interactive token mode, keeping the prompt last', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);

				const result = await buildSpawnSpec(
					createConfig({ enableMaestroP: true, maestroPMode: 'interactive' }),
					'Hello world'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					const { command, args, env } = result.spec;
					// maestro-p runs via the Node execPath...
					expect(command).toBe(process.execPath);
					// ...with the maestro-p script first, then --max-wait derived from
					// the run's timeoutMs (30000ms -> 30s), then the interactive flags...
					expect(args[0]).toBe('/bundled/maestro-p.js');
					expect(args[1]).toBe('--max-wait');
					expect(args[2]).toBe('30');
					expect(args[3]).toBe('--dangerously-skip-permissions');
					// ...and the substituted prompt still the trailing positional.
					expect(args[args.length - 1]).toBe('Hello world');
					// maestro-p is told which real claude binary to drive.
					expect(env.MAESTRO_CLAUDE_BIN).toBeTruthy();
				}
			});

			it('leaves a plain claude batch spec unchanged when maestro-p is disabled', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);

				const result = await buildSpawnSpec(createConfig({ enableMaestroP: false }), 'Hello world');

				expect(result.ok).toBe(true);
				if (result.ok) {
					const { command, args, env } = result.spec;
					expect(command).toBe('claude');
					expect(args[0]).not.toBe('/bundled/maestro-p.js');
					expect(args[args.length - 1]).toBe('Hello world');
					expect(env.MAESTRO_CLAUDE_BIN).toBeUndefined();
				}
			});

			it('routes interactive token mode through maestro-p on the remote when SSH is enabled', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };
				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host', 'maestro-p', '--dangerously-skip-permissions', '--', 'Hello world'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				const result = await buildSpawnSpec(
					createConfig({
						enableMaestroP: true,
						maestroPMode: 'interactive',
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: mockSshStore,
					}),
					'Hello world'
				);

				// The SSH wrapper is handed the REMOTE maestro-p command (not the
				// local execPath rewrite), with --max-wait derived from the run's
				// timeoutMs (30000ms -> 30s) ahead of the interactive flags, then the
				// headless arg list (maestro-p strips those on the remote).
				expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
					expect.objectContaining({
						agentBinaryName: 'maestro-p',
						args: expect.arrayContaining(['--max-wait', '30', '--dangerously-skip-permissions']),
					}),
					{ enabled: true, remoteId: 'r1' },
					mockSshStore
				);
				const wrapArgs = mockWrapSpawnWithSsh.mock.calls[0][0].args as string[];
				expect(wrapArgs.slice(0, 3)).toEqual([
					'--max-wait',
					'30',
					'--dangerously-skip-permissions',
				]);

				expect(result.ok).toBe(true);
				if (result.ok) {
					// The local maestro-p execPath rewrite must NOT apply for SSH.
					expect(result.spec.command).toBe('ssh');
					expect(result.spec.command).not.toBe(process.execPath);
				}
			});

			// #1872: a Cue run in the agent's own project root accepts claude's
			// folder-trust prompt; any other folder must still fail loudly.
			it('opts maestro-p into workspace trust when the run is in the agent project root', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);

				const result = await buildSpawnSpec(
					createConfig({ enableMaestroP: true, maestroPMode: 'interactive' }),
					'Hello world'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.env.MAESTRO_P_ACCEPT_WORKSPACE_TRUST).toBe('1');
				}
			});

			it('does not opt into workspace trust for a folder that is not the agent own', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);

				const result = await buildSpawnSpec(
					createConfig({
						enableMaestroP: true,
						maestroPMode: 'interactive',
						projectRoot: '/somewhere/else',
					}),
					'Hello world'
				);

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.spec.env.MAESTRO_P_ACCEPT_WORKSPACE_TRUST).toBeUndefined();
				}
			});

			it('passes the workspace-trust opt-in to the remote maestro-p over SSH', async () => {
				mockGetAgentDefinition.mockReturnValue(claudeInteractiveAgentDef);
				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host', 'maestro-p'],
					cwd: '/projects/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'r1', name: 'S', host: 'h' },
				});

				await buildSpawnSpec(
					createConfig({
						enableMaestroP: true,
						maestroPMode: 'interactive',
						sshRemoteConfig: { enabled: true, remoteId: 'r1' },
						sshStore: { getSshRemotes: vi.fn(() => []) },
					}),
					'Hello world'
				);

				const wrapConfig = mockWrapSpawnWithSsh.mock.calls[0][0] as {
					customEnvVars?: Record<string, string>;
				};
				expect(wrapConfig.customEnvVars?.MAESTRO_P_ACCEPT_WORKSPACE_TRUST).toBe('1');
			});
		});
	});
});
