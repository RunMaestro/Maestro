/**
 * The runtime's background turns: how a group chat turn and a consult are started, reported, and
 * stopped, over the real run layer. A missing binary and an unknown provider are the real thing
 * (nothing is faked for them); the rest replay a recorded stream through the fake agent.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stop's remote half is observed here, never sent: a real one runs ssh.
const remoteSignals = vi.hoisted(() => [] as Array<{ pidFile: string; mode: string }>);
vi.mock('../../control/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../control/ssh-remote-signal')>()),
	signalRemoteAgent: (target: { pidFile: string }, mode: string) => {
		remoteSignals.push({ pidFile: target.pidFile, mode });
		return true;
	},
}));

import {
	createFakeGroupChatProvider,
	promptOf,
	type FakeScript,
} from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import {
	claudeTranscriptPath,
	clearRememberedClaudeSessionCosts,
} from '../../../claudeCostTracker';
import { embedSystemPromptInPrompt } from '../../../embeddedSystemPrompt';
import * as systemDelivery from '../../turns/args';
import * as remoteControl from '../../control/ssh-remote-signal';
import { getAgentCapabilities } from '../../providers/capabilities';
import { getAgentDefinition, type AgentConfig } from '../../providers/definitions';
import { resolveMaestroPaths } from '../../paths/resolve';
import * as groupChatPreparation from '../../groupchat/spawn';
import type { GroupChatSpawn } from '../../groupchat/types';
import {
	consultOwner,
	createBackgroundTurns,
	groupChatOwner,
	type GroupChatRunnerHandlers,
} from '../background-turns';
import { createProcessRegistry, type ProcessRegistry } from '../processes';

const CHAT_ID = '11111111-2222-4333-8444-555555555555';
const MODERATOR = `group-chat-${CHAT_ID}-moderator-1700000000000`;
const PARTICIPANT = `group-chat-${CHAT_ID}-participant-Alpha-1700000000000`;

const claude = (path = '/fake/bin/claude'): AgentConfig =>
	({
		...getAgentDefinition('claude-code')!,
		available: true,
		path,
		capabilities: getAgentCapabilities('claude-code'),
	}) as AgentConfig;

// Candidate file delivery is opted in only by this fixture, never by the provider registry.
const grok: AgentConfig = {
	...getAgentDefinition('grok')!,
	available: true,
	path: path.resolve('synthetic-grok'),
	capabilities: getAgentCapabilities('grok'),
	promptFile: { format: 'acp-json', exclusivePromptFlags: ['-p', '--prompt-file'] },
	promptFileArgs: (file) => ['--prompt-file', file],
};

const spawnOf = (overrides: Partial<GroupChatSpawn> = {}): GroupChatSpawn => ({
	processId: PARTICIPANT,
	providerId: 'claude-code',
	agent: claude(),
	args: ['--print', '--verbose', '--output-format', 'stream-json'],
	cwd: os.tmpdir(),
	prompt: 'hello',
	...overrides,
});

describe('background turns', () => {
	let dir: string;
	let registry: ProcessRegistry;
	let beginTurn: ReturnType<typeof vi.fn<(processId: string) => void>>;
	let reported: string[];
	let handlers: GroupChatRunnerHandlers;

	const paths = () => resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } });

	function turns(script?: FakeScript) {
		const provider = script ? createFakeGroupChatProvider(dir, script) : undefined;
		const background = createBackgroundTurns({
			paths: paths(),
			registry,
			host: {},
			beginTurn,
			...(provider ? { deps: { runTurn: provider.runTurn } } : {}),
		});
		return { background, provider };
	}

	beforeEach(() => {
		remoteSignals.length = 0;
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-background-turns-'));
		registry = createProcessRegistry({ waitMs: 2_000 });
		beginTurn = vi.fn<(processId: string) => void>();
		reported = [];
		handlers = {
			chatIdOf: () => CHAT_ID,
			onActivity: () => undefined,
			onOutput: () => undefined,
			onSessionId: async (_id, sessionId) => void reported.push(`session:${sessionId}`),
			onUsage: (_id, usage) => void reported.push(`usage:${usage.contextWindow}`),
			onEnd: async (_id, completed) =>
				void reported.push(`end:${completed.answerText}:${completed.exit.exitCode}`),
		};
	});
	afterEach(async () => {
		await registry.stopAll();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('a group chat turn', () => {
		it('reports the session id, then usage, then the end, in that order', async () => {
			const { background } = turns(() => ({ text: 'Done.', sessionId: 'sess-1' }));
			const runner = background.groupChatRunner(handlers);

			const started = await runner.start(spawnOf());

			expect(started).toMatchObject({ success: true });
			expect(started.pid).toBeGreaterThan(0);
			await vi.waitFor(() => expect(reported).toHaveLength(3));
			// Usage carries the agent's configured window when the provider reported none.
			expect(reported).toEqual(['session:sess-1', 'usage:200000', 'end:Done.:0']);
			expect(beginTurn).toHaveBeenCalledExactlyOnceWith(PARTICIPANT);
		});

		it('owns the process under the chat, so no agent reads busy for it and shutdown reaches it', async () => {
			const { background } = turns(() => ({ text: 'working', hold: true }));
			const runner = background.groupChatRunner(handlers);
			await runner.start(spawnOf());

			expect(background.activeCount()).toBe(1);
			expect(registry.size()).toBe(1);
			expect(registry.isBusy(groupChatOwner(CHAT_ID), PARTICIPANT)).toBe(true);
			expect(registry.isBusy('any-agent')).toBe(false);

			await registry.stopAll();
			expect(background.activeCount()).toBe(0);
			// A stopped turn is still reported: the engine decides what a stop means.
			await vi.waitFor(() => expect(reported.some((entry) => entry.startsWith('end:'))).toBe(true));
		});

		it('stops a turn by its full id, and ignores one it does not know', async () => {
			const { background } = turns(() => ({ text: 'working', hold: true }));
			const runner = background.groupChatRunner(handlers);
			await runner.start(spawnOf({ processId: MODERATOR }));

			runner.stop('group-chat-unknown');
			expect(background.activeCount()).toBe(1);
			runner.stop(MODERATOR);

			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			expect(registry.size()).toBe(0);
		});

		// Windows starts agents through a shell (`getWindowsSpawnConfig`), which exists and gets a pid:
		// there a missing binary is the shell's non-zero exit, reported as an ordinary end.
		it.skipIf(process.platform === 'win32')(
			'answers a refusal, with no end to follow, when the binary does not exist',
			async () => {
				const { background } = turns();
				const runner = background.groupChatRunner(handlers);

				const started = await runner.start(
					spawnOf({ agent: claude('/nonexistent/dir/claude'), command: '/nonexistent/dir/claude' })
				);

				expect(started.success).toBe(false);
				expect(started.error).toMatch(/ENOENT|spawn/i);
				expect(background.activeCount()).toBe(0);
				await new Promise((resolve) => setTimeout(resolve, 50));
				expect(reported).toEqual([]);
			}
		);

		it('answers a refusal for a provider with no output parser', async () => {
			const { background } = turns();
			const runner = background.groupChatRunner(handlers);

			const started = await runner.start(spawnOf({ providerId: 'no-such-provider' }));

			expect(started).toMatchObject({
				success: false,
				error: expect.stringMatching(/no-such-provider/),
			});
		});

		it('lets a launch that cannot be prepared throw, so the engine words it for the room', async () => {
			const { background } = turns();
			const runner = background.groupChatRunner(handlers);

			await expect(
				runner.start(spawnOf({ sshRemoteConfig: { enabled: true, remoteId: 'gone' } }))
			).rejects.toThrow(/SSH/);
			expect(beginTurn).not.toHaveBeenCalled();
		});

		it('keeps one turn’s failure to report from taking the runner down', async () => {
			const { background } = turns(() => ({ text: 'x' }));
			const runner = background.groupChatRunner({
				...handlers,
				onEnd: async () => {
					throw new Error('the engine fell over');
				},
			});
			await runner.start(spawnOf());
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			expect(registry.size()).toBe(0);
		});
	});

	describe('the system prompt a turn carries', () => {
		it('rides the native flag for an agent that has one', async () => {
			const { background, provider } = turns(() => ({ text: 'ok' }));
			await background.groupChatRunner(handlers).start(spawnOf({ appendSystemPrompt: 'BE BRIEF' }));

			const args = provider!.calls[0].spec.args;
			if (process.platform === 'win32') {
				// A Windows host cannot hold a large prompt on its command line: it goes to a temp file.
				expect(args).toContain('--append-system-prompt-file');
				expect(args).not.toContain('BE BRIEF');
			} else {
				expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('BE BRIEF');
			}
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
		});

		it('is embedded in the prompt for an agent without the flag, and not again on a resume', async () => {
			const codex: AgentConfig = {
				...getAgentDefinition('codex')!,
				available: true,
				path: '/fake/bin/codex',
				capabilities: getAgentCapabilities('codex'),
			} as AgentConfig;
			const codexSpawn = (overrides: Partial<GroupChatSpawn>) =>
				spawnOf({
					providerId: 'codex',
					agent: codex,
					args: ['exec', '--json'],
					appendSystemPrompt: 'BE BRIEF',
					...overrides,
				});
			const { background, provider } = turns(() => ({ text: 'ok' }));
			const runner = background.groupChatRunner(handlers);

			await runner.start(codexSpawn({}));
			await runner.start(codexSpawn({ processId: MODERATOR, isResume: true }));

			const [first, resumed] = provider!.calls.map((call) => promptOf(call.spec));
			expect(first).toContain(embedSystemPromptInPrompt('BE BRIEF', 'hello'));
			expect(resumed).not.toContain('BE BRIEF');
			expect(resumed).toContain('hello');
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
		});
	});

	describe('candidate Grok file delivery', () => {
		afterEach(() => vi.restoreAllMocks());

		it.each(['group', 'consult'] as const)(
			'captures %s capabilities and nested file ownership before system delivery yields',
			async (kind) => {
				const selectedCapabilities = { ...getAgentCapabilities('grok') };
				const selectedPromptFile = {
					...grok.promptFile!,
					exclusivePromptFlags: [...grok.promptFile!.exclusivePromptFlags],
				};
				const callerPromptFlags = [...selectedPromptFile.exclusivePromptFlags];
				const agent: AgentConfig = {
					...grok,
					capabilities: { ...selectedCapabilities },
					promptFile: {
						...selectedPromptFile,
						exclusivePromptFlags: callerPromptFlags,
					},
				};
				let finish!: (result: systemDelivery.SystemPromptDeliveryResult) => void;
				const delivery = vi.spyOn(systemDelivery, 'deliverSystemPrompt').mockReturnValueOnce(
					new Promise((resolve) => {
						finish = resolve;
					})
				);
				const prepare = vi.spyOn(groupChatPreparation, 'prepareGroupChatSpawn');
				const { background, provider } = turns(() => ({ text: '' }));
				const spawn = spawnOf({ providerId: 'grok', agent, prompt: 'private captured input' });
				const started =
					kind === 'group'
						? background.groupChatRunner(handlers).start(spawn)
						: background.consultRunner().start(spawn, {
								onActivity: vi.fn(),
								onSessionId: vi.fn(),
								onEnd: vi.fn(),
							});
				expect(delivery).toHaveBeenCalledOnce();
				expect(prepare).not.toHaveBeenCalled();
				agent.capabilities.supportsAppendSystemPrompt =
					!selectedCapabilities.supportsAppendSystemPrompt;
				agent.capabilities.supportsReadOnlyMode = !selectedCapabilities.supportsReadOnlyMode;
				callerPromptFlags.push('--print');
				finish({ args: spawn.args, prompt: spawn.prompt });

				expect(await started).toMatchObject({ success: true });
				expect(prepare).toHaveBeenCalledOnce();
				const captured = prepare.mock.calls[0][0].agent;
				expect(captured.capabilities).toEqual(selectedCapabilities);
				expect(captured.capabilities).not.toBe(agent.capabilities);
				expect(captured.promptFile).toEqual(selectedPromptFile);
				expect(captured.promptFile!.exclusivePromptFlags).not.toBe(
					agent.promptFile!.exclusivePromptFlags
				);
				expect(getAgentCapabilities('grok')).toEqual(selectedCapabilities);
				expect(grok.promptFile).toEqual(selectedPromptFile);
				const spec = provider!.calls[0].spec;
				expect(spec.promptArtifact).toMatchObject({ owner: 'local', mode: 0o600, cleanup: 'turn' });
				expect(JSON.parse(spec.promptArtifact!.content)).toEqual({
					type: 'acp',
					content: [{ type: 'text', text: spawn.prompt }],
				});
				expect(spec.args.join(' ')).not.toContain(spawn.prompt);
				expect(spec.stdin).toBeUndefined();
				await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			}
		);

		it.each([
			['empty', '', undefined, false],
			['composed', 'private 雪\n'.repeat(5_000), 'SYSTEM', false],
			['resumed', 'next turn', 'SYSTEM', true],
		] as const)(
			'hands %s content to the local file owner without argv or stdin fallback',
			async (_label, prompt, system, resume) => {
				const { background, provider } = turns(() => ({ text: '' }));
				const spawn = spawnOf({
					providerId: 'grok',
					agent: grok,
					prompt,
					appendSystemPrompt: system,
					args: ['--model', 'selected-model', ...(resume ? ['--resume', 'session-1'] : [])],
					customEnvVars: { GROK_HOME: path.join(dir, 'selected-account') },
				});
				const started = background.groupChatRunner(handlers).start(spawn);
				spawn.args[1] = 'changed-model';
				spawn.customEnvVars!.GROK_HOME = path.join(dir, 'changed-account');
				expect(await started).toMatchObject({ success: true });
				const spec = provider!.calls[0].spec;
				const text = system && !resume ? embedSystemPromptInPrompt(system, prompt) : prompt;
				expect(JSON.parse(spec.promptArtifact!.content)).toEqual({
					type: 'acp',
					content: [{ type: 'text', text }],
				});
				expect(spec.promptArtifact).toMatchObject({
					owner: 'local',
					mode: 0o600,
					flag: 'wx',
					cleanup: 'turn',
				});
				expect(spec.args.join(' ')).toContain('selected-model');
				expect(spec.args.join(' ')).toContain(spec.promptArtifact!.path);
				expect(spec.env.GROK_HOME).toBe(path.join(dir, 'selected-account'));
				expect(spec.stdin).toBeUndefined();
				if (prompt) expect(spec.args.join(' ')).not.toContain(prompt);
				await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			}
		);

		it.each([
			{ args: ['-p', 'conflicting-private-input'] },
			{ isResume: true, args: [] },
			{ sshRemoteConfig: { enabled: true, remoteId: 'missing-private-host' } },
		])(
			'refuses invalid private preparation without a retry or diagnostic disclosure: %j',
			async (override) => {
				const { background, provider } = turns(() => ({ text: 'never' }));
				await expect(
					background.groupChatRunner(handlers).start(
						spawnOf({
							providerId: 'grok',
							agent: grok,
							prompt: 'private prompt',
							...override,
						})
					)
				).rejects.toEqual(new Error('Prompt-file background preparation unavailable.'));
				expect(provider!.calls).toEqual([]);
				expect(beginTurn).not.toHaveBeenCalled();
				expect(reported).toEqual([]);
			}
		);

		it.each(['group', 'consult'] as const)(
			'cleans abandoned system preparation when a %s is stopped',
			async (kind) => {
				const file = path.join(dir, 'private-system.txt');
				fs.writeFileSync(file, 'private system');
				let finish!: (result: systemDelivery.SystemPromptDeliveryResult) => void;
				vi.spyOn(systemDelivery, 'deliverSystemPrompt').mockReturnValueOnce(
					new Promise((resolve) => {
						finish = resolve;
					})
				);
				const { background, provider } = turns(() => ({ text: 'never' }));
				const group = background.groupChatRunner(handlers);
				const consult = background.consultRunner();
				const spawn = spawnOf({ providerId: 'grok', agent: grok });
				const started =
					kind === 'group'
						? group.start(spawn)
						: consult.start(spawn, {
								onActivity: vi.fn(),
								onSessionId: vi.fn(),
								onEnd: vi.fn(),
							});
				(kind === 'group' ? group : consult).stop(spawn.processId);
				finish({ args: spawn.args, prompt: spawn.prompt, tempFile: file });
				expect(await started).toEqual({
					success: false,
					error: 'Background turn cancelled before spawn.',
				});
				await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false), { timeout: 2_000 });
				expect(provider!.calls).toEqual([]);
				expect(beginTurn).not.toHaveBeenCalled();
			}
		);
	});

	describe('a resumed Claude session', () => {
		it('records the turn’s own cost, not the session’s running total', async () => {
			const configDir = path.join(dir, 'claude-config');
			const transcript = claudeTranscriptPath(configDir, os.tmpdir(), 'sess-r');
			fs.mkdirSync(path.dirname(transcript), { recursive: true });
			fs.writeFileSync(
				transcript,
				`${JSON.stringify({ type: 'cost-state', totalCostUSD: 0.004, modelUsage: {} })}\n`
			);
			const { background } = turns(() => ({ text: 'Done.', sessionId: 'sess-r' }));
			// The fake provider is built first: it forgets every total remembered so far.
			clearRememberedClaudeSessionCosts();
			const costs: number[] = [];
			await background
				.groupChatRunner({
					...handlers,
					onUsage: (_id, usage) => void costs.push(usage.totalCostUsd),
				})
				.start(
					spawnOf({
						args: ['--print', '--output-format', 'stream-json', '--resume', 'sess-r'],
						customEnvVars: { CLAUDE_CONFIG_DIR: configDir },
					})
				);

			// The stream reports the session's total, 0.01; this turn spent the rest.
			await vi.waitFor(() => expect(costs).toHaveLength(1));
			expect(costs[0]).toBeCloseTo(0.006, 6);
		});
	});

	describe('a turn on an SSH remote', () => {
		beforeEach(() => {
			const settings = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } }).settingsFile;
			fs.mkdirSync(path.dirname(settings), { recursive: true });
			fs.writeFileSync(
				settings,
				JSON.stringify({
					sshRemotes: [
						{
							id: 'r1',
							name: 'Build box',
							host: 'build.example.com',
							port: 22,
							username: 'dev',
							privateKeyPath: '',
							enabled: true,
						},
					],
				})
			);
		});

		it('pins Grok private content and account to the selected SSH host through preparation and Stop', async () => {
			const signal = vi.spyOn(remoteControl, 'signalRemoteAgent');
			const { background, provider } = turns(() => ({ text: '', hold: true }));
			const runner = background.groupChatRunner(handlers);
			const spawn = spawnOf({
				providerId: 'grok',
				agent: grok,
				args: ['--model', 'selected-model'],
				prompt: 'private remote 雪',
				customEnvVars: { GROK_HOME: '/remote/account' },
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});
			const started = runner.start(spawn);
			const settings = paths().settingsFile;
			const changed = JSON.parse(fs.readFileSync(settings, 'utf8'));
			changed.sshRemotes[0].host = 'changed.example.com';
			fs.writeFileSync(settings, JSON.stringify(changed));
			spawn.sshRemoteConfig!.remoteId = 'other';
			expect(await started).toMatchObject({ success: true });
			const spec = provider!.calls[0].spec;
			expect(spec.promptArtifact).toBeUndefined();
			expect(spec.args.join(' ')).toContain('build.example.com');
			expect(spec.args.join(' ')).not.toContain('changed.example.com');
			expect(spec.args.join(' ')).not.toContain('private remote');
			expect(spec.stdin).toContain('/remote/account');
			expect(spec.stdin).toContain('selected-model');
			expect(spec.stdin).toContain(
				Buffer.from(
					JSON.stringify({ type: 'acp', content: [{ type: 'text', text: 'private remote 雪' }] })
				).toString('base64')
			);
			const pidFile = /\/tmp\/maestro-prompt-owner-[0-9a-f-]+\.pid/.exec(spec.stdin!)?.[0];
			expect(pidFile).toBeDefined();
			runner.stop(PARTICIPANT);
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			expect(signal).toHaveBeenCalledWith(
				expect.objectContaining({
					pidFile,
					sshArgs: spec.args,
					promptArtifactPath: expect.stringMatching(/^\/tmp\/maestro-prompt-.*\.json$/),
				}),
				'terminate'
			);
			signal.mockRestore();
		});

		it('records the agent’s pid in its script, and Stop reaches it on its host', async () => {
			const { background, provider } = turns(() => ({ text: 'working', hold: true }));
			const runner = background.groupChatRunner(handlers);
			// A large prompt rides a stdin script, the launch that records the agent's pid.
			await runner.start(
				spawnOf({ sshRemoteConfig: { enabled: true, remoteId: 'r1' }, prompt: 'x'.repeat(5000) })
			);

			const script = provider!.calls[0].spec.stdin ?? '';
			const pidFile = /\/tmp\/maestro-agent-[0-9a-f-]+\.pid/.exec(script)?.[0];
			expect(pidFile).toBeDefined();

			runner.stop(PARTICIPANT);
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			expect(remoteSignals).toEqual([{ pidFile, mode: 'terminate' }]);
		});
	});

	describe('a consult', () => {
		const consultSpawn = (id = 'cross-agent-r1') => spawnOf({ processId: id });

		it('hands the observer the session id and the end, with the text read lazily', async () => {
			const { background } = turns(() => ({ text: 'The answer.', sessionId: 'sess-9' }));
			const seen: string[] = [];
			const ended = new Promise<{ exitCode: number | null; text: string }>((resolve) => {
				background.consultRunner().start(consultSpawn(), {
					onActivity: () => undefined,
					onSessionId: (id) => void seen.push(id),
					onEnd: ({ exitCode, readText }) => resolve({ exitCode, text: readText() }),
				});
			});

			expect(await ended).toEqual({ exitCode: 0, text: 'The answer.' });
			expect(seen).toEqual(['sess-9']);
		});

		it('registers under a consult owner, apart from any chat', async () => {
			const { background } = turns(() => ({ text: 'working', hold: true }));
			await background.consultRunner().start(consultSpawn(), {
				onActivity: () => undefined,
				onSessionId: () => undefined,
				onEnd: () => undefined,
			});
			expect(registry.isBusy(consultOwner('cross-agent-r1'), 'cross-agent-r1')).toBe(true);
		});

		it('stops with the partial answer, and reports nothing after it', async () => {
			const provider = createFakeGroupChatProvider(dir, () => ({
				text: 'Half an answer.',
				hold: true,
			}));
			const runTurn = vi.spyOn(provider, 'runTurn');
			const background = createBackgroundTurns({
				paths: paths(),
				registry,
				host: {},
				beginTurn,
				deps: { runTurn },
			});
			const runner = background.consultRunner();
			const events: string[] = [];
			await runner.start(consultSpawn(), {
				onActivity: () => void events.push('activity'),
				onSessionId: () => void events.push('session'),
				onEnd: () => void events.push('end'),
			});
			// Wait until the answer has streamed in.
			await vi.waitFor(() =>
				expect(runTurn.mock.results[0]?.value.answerSoFar()).toBe('Half an answer.')
			);
			expect(runner.stop('cross-agent-other')).toBe('');

			const partial = runner.stop('cross-agent-r1');
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));

			expect(partial).toBe('Half an answer.');
			expect(events).not.toContain('end');
			expect(events).not.toContain('session');
		});

		it('is idempotent, and safe for a process that does not exist yet', () => {
			const { background } = turns();
			const runner = background.consultRunner();
			expect(runner.stop('cross-agent-never')).toBe('');
			expect(runner.stop('cross-agent-never')).toBe('');
		});
	});

	describe('resolving a provider', () => {
		it('answers the definition with where it is, or that it is not installed here', async () => {
			const background = createBackgroundTurns({
				paths: paths(),
				registry,
				host: {},
				beginTurn,
				deps: {
					probeBinary: async (binaryName) =>
						binaryName === 'claude' ? { exists: true, path: '/probed/claude' } : { exists: false },
				},
			});

			expect(await background.resolveAgent('claude-code')).toMatchObject({
				id: 'claude-code',
				available: true,
				path: '/probed/claude',
			});
			expect(await background.resolveAgent('codex')).toMatchObject({
				id: 'codex',
				available: false,
			});
			expect(await background.resolveAgent('no-such-provider')).toBeNull();
		});
	});
});
