import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	getAgentCustomPath: vi.fn(),
	readAgentConfig: vi.fn(),
	readSshRemotes: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: mocks.spawn,
		default: {
			...actual,
			spawn: mocks.spawn,
		},
	};
});

vi.mock('../../cli/services/storage', () => ({
	getAgentCustomPath: mocks.getAgentCustomPath,
	readAgentConfig: mocks.readAgentConfig,
	readSshRemotes: mocks.readSshRemotes,
}));

type MockChild = EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
	stdin: { end: ReturnType<typeof vi.fn> };
};

const createdDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-agent-spawner-'));
	createdDirs.push(dir);
	return dir;
}

function createMockChild(): MockChild {
	return Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		stdin: { end: vi.fn() },
	});
}

async function loadSpawner() {
	vi.resetModules();
	return import('../../cli/services/agent-spawner');
}

async function flushSpawnRegistration() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function emitJsonLines(child: MockChild, events: unknown[]) {
	child.stdout.emit(
		'data',
		Buffer.from(
			events
				.map((event) => (typeof event === 'string' ? event : JSON.stringify(event)))
				.join('\n') + '\n'
		)
	);
}

describe('agent spawner integration', () => {
	beforeEach(() => {
		mocks.spawn.mockReset();
		mocks.getAgentCustomPath.mockReset();
		mocks.readAgentConfig.mockReset();
		mocks.readSshRemotes.mockReset();
		mocks.getAgentCustomPath.mockReturnValue(undefined);
		mocks.readAgentConfig.mockReturnValue({});
		mocks.readSshRemotes.mockReturnValue([]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.doUnmock('../../main/agents/capabilities');
		vi.doUnmock('../../main/agents/definitions');
		vi.doUnmock('../../shared/platformDetection');
		for (const dir of createdDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reads and writes markdown tasks against the real filesystem', async () => {
		const { readDocAndCountTasks, readDocAndGetTasks, uncheckAllTasks, writeDoc } =
			await loadSpawner();
		const folder = makeTempDir();
		const content = [
			'# Playbook',
			'',
			'- [ ] First task',
			'  - [ ] Nested task',
			'- [x] Done task',
			'- [ ] Third task',
		].join('\n');

		fs.writeFileSync(path.join(folder, 'plan.md'), content, 'utf8');
		fs.writeFileSync(path.join(folder, 'done.md'), '- [x] Already done\nPlain text', 'utf8');

		expect(readDocAndCountTasks(folder, 'plan')).toEqual({ content, taskCount: 3 });
		expect(readDocAndGetTasks(folder, 'plan')).toEqual({
			content,
			tasks: ['First task', 'Nested task', 'Third task'],
		});
		expect(readDocAndCountTasks(folder, 'done')).toEqual({
			content: '- [x] Already done\nPlain text',
			taskCount: 0,
		});
		expect(readDocAndGetTasks(folder, 'done')).toEqual({
			content: '- [x] Already done\nPlain text',
			tasks: [],
		});
		expect(readDocAndCountTasks(folder, 'missing')).toEqual({ content: '', taskCount: 0 });
		expect(readDocAndGetTasks(folder, 'missing')).toEqual({ content: '', tasks: [] });
		expect(uncheckAllTasks('- [x] done\n  - [X] nested\n- [ ] open')).toBe(
			'- [ ] done\n  - [ ] nested\n- [ ] open'
		);

		writeDoc(folder, 'written.md', 'saved');

		expect(fs.readFileSync(path.join(folder, 'written.md'), 'utf8')).toBe('saved');
	});

	it('detects custom executables, caches resolved paths, and falls back to PATH detection', async () => {
		const {
			detectAgent,
			detectClaude,
			detectCodex,
			getAgentCommand,
			getClaudeCommand,
			getCodexCommand,
		} = await loadSpawner();
		const folder = makeTempDir();
		const customCodex = path.join(folder, 'codex-custom');
		fs.writeFileSync(customCodex, '#!/bin/sh\n', 'utf8');
		fs.chmodSync(customCodex, 0o755);
		mocks.getAgentCustomPath.mockImplementation((toolType: string) =>
			toolType === 'codex' ? customCodex : undefined
		);

		await expect(detectAgent('codex')).resolves.toEqual({
			available: true,
			path: customCodex,
			source: 'settings',
		});
		await expect(detectAgent('codex')).resolves.toEqual({
			available: true,
			path: customCodex,
			source: 'settings',
		});
		await expect(detectCodex()).resolves.toEqual({
			available: true,
			path: customCodex,
			source: 'settings',
		});
		expect(getAgentCommand('codex')).toBe(customCodex);
		expect(getCodexCommand()).toBe(customCodex);

		const pathLookup = createMockChild();
		mocks.spawn.mockReturnValueOnce(pathLookup);
		const claudeDetection = detectAgent('claude-code');
		pathLookup.stdout.emit('data', Buffer.from('/usr/local/bin/claude\n'));
		pathLookup.emit('close', 0);

		await expect(claudeDetection).resolves.toEqual({
			available: true,
			path: '/usr/local/bin/claude',
			source: 'path',
		});
		await expect(detectClaude()).resolves.toEqual({
			available: true,
			path: '/usr/local/bin/claude',
			source: 'settings',
		});
		expect(mocks.spawn).toHaveBeenCalledWith(
			expect.stringMatching(/^(which|where)$/),
			['claude'],
			expect.objectContaining({ env: expect.objectContaining({ PATH: expect.any(String) }) })
		);
		expect(getClaudeCommand()).toBe('/usr/local/bin/claude');
	});

	it('warns on invalid custom paths and reports unavailable agents when PATH lookup fails', async () => {
		const { detectAgent } = await loadSpawner();
		const warning = vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);

		mocks.spawn.mockImplementation(() => {
			const pathLookup = createMockChild();
			queueMicrotask(() => pathLookup.emit('close', 1));
			return pathLookup;
		});

		const folder = makeTempDir();
		const directoryPath = path.join(folder, 'not-a-file');
		fs.mkdirSync(directoryPath);
		mocks.getAgentCustomPath.mockReturnValue(directoryPath);

		await expect(detectAgent('codex')).resolves.toEqual({ available: false });
		expect(warning).toHaveBeenCalledWith(expect.stringContaining('falling back to PATH detection'));

		const nonExecutablePath = path.join(folder, 'codex-not-executable');
		fs.writeFileSync(nonExecutablePath, '#!/bin/sh\n', 'utf8');
		fs.chmodSync(nonExecutablePath, 0o644);
		mocks.getAgentCustomPath.mockReturnValue(nonExecutablePath);

		await expect(detectAgent('codex')).resolves.toEqual({ available: false });

		mocks.getAgentCustomPath.mockReturnValue('/missing/codex');

		await expect(detectAgent('codex')).resolves.toEqual({ available: false });
		expect(warning).toHaveBeenCalledWith(expect.stringContaining('falling back to PATH detection'));
	});

	it('exposes wrapper helpers and treats PATH lookup errors as unavailable', async () => {
		const {
			detectAgent,
			detectDroid,
			detectOpenCode,
			getAgentCommand,
			getDroidCommand,
			getOpenCodeCommand,
		} = await loadSpawner();
		const warning = vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
		mocks.getAgentCustomPath.mockImplementation((toolType: string) =>
			toolType === 'unknown-agent' ? '/missing/unknown-agent' : undefined
		);
		mocks.spawn.mockImplementation(() => {
			const pathLookup = createMockChild();
			queueMicrotask(() => pathLookup.emit('error', new Error('which failed')));
			return pathLookup;
		});

		await expect(detectOpenCode()).resolves.toEqual({ available: false });
		await expect(detectDroid()).resolves.toEqual({ available: false });
		await expect(detectAgent('unknown-agent' as never)).resolves.toEqual({ available: false });
		expect(warning).toHaveBeenCalledWith(expect.stringContaining('Custom unknown-agent path'));
		expect(getOpenCodeCommand()).toBe('opencode');
		expect(getDroidCommand()).toBe('droid');
		expect(getAgentCommand('unknown-agent' as never)).toBe('unknown-agent');
	});

	it('accepts custom executable files on Windows without Unix execute bits', async () => {
		vi.doMock('../../shared/platformDetection', async (importOriginal) => {
			const actual = await importOriginal<typeof import('../../shared/platformDetection')>();
			return {
				...actual,
				isWindows: () => true,
				getWhichCommand: () => 'where',
			};
		});
		const { detectAgent } = await loadSpawner();
		const folder = makeTempDir();
		const customCodex = path.join(folder, 'codex.cmd');
		fs.writeFileSync(customCodex, '@echo off\n', 'utf8');
		fs.chmodSync(customCodex, 0o644);
		mocks.getAgentCustomPath.mockReturnValue(customCodex);

		await expect(detectAgent('codex')).resolves.toEqual({
			available: true,
			path: customCodex,
			source: 'settings',
		});
	});

	it('spawns Claude in stream-json mode with session, usage, and failure handling', async () => {
		const { spawnAgent } = await loadSpawner();
		const child = createMockChild();
		mocks.spawn.mockReturnValueOnce(child);

		const resultPromise = spawnAgent('claude-code', '/repo', 'Claude prompt', 'session-1');
		await flushSpawnRegistration();

		expect(mocks.spawn).toHaveBeenCalledWith(
			'claude',
			expect.arrayContaining(['--print', '--resume', 'session-1', '--', 'Claude prompt']),
			expect.objectContaining({
				cwd: '/repo',
				stdio: ['pipe', 'pipe', 'pipe'],
				env: expect.objectContaining({ PATH: expect.any(String) }),
			})
		);
		expect(child.stdin.end).toHaveBeenCalled();

		child.stdout.emit('data', Buffer.from('\nnot json\n'));
		emitJsonLines(child, [
			{ session_id: 'claude-session' },
			{
				usage: {
					input_tokens: 12,
					output_tokens: 5,
					cache_read_input_tokens: 2,
					cache_creation_input_tokens: 1,
				},
				total_cost_usd: 0.03,
			},
			{ type: 'result', result: 'Claude result' },
			{ type: 'result', result: 'ignored duplicate' },
		]);
		child.emit('close', 0);

		await expect(resultPromise).resolves.toMatchObject({
			success: true,
			response: 'Claude result',
			agentSessionId: 'claude-session',
			usageStats: {
				inputTokens: 12,
				outputTokens: 5,
				cacheReadInputTokens: 2,
				cacheCreationInputTokens: 1,
				totalCostUsd: 0.03,
			},
		});

		const failedChild = createMockChild();
		mocks.spawn.mockReturnValueOnce(failedChild);
		const failedPromise = spawnAgent('claude-code', '/repo', 'Claude prompt');
		await flushSpawnRegistration();
		failedChild.stderr.emit('data', Buffer.from('permission denied'));
		failedChild.emit('close', 1);

		await expect(failedPromise).resolves.toEqual({
			success: false,
			error: 'permission denied',
			agentSessionId: undefined,
			usageStats: undefined,
		});

		const noResultChild = createMockChild();
		mocks.spawn.mockReturnValueOnce(noResultChild);
		const noResultPromise = spawnAgent('claude-code', '/repo', 'Claude prompt');
		await flushSpawnRegistration();
		noResultChild.emit('close', 0);

		await expect(noResultPromise).resolves.toEqual({
			success: false,
			error: 'Process exited with code 0',
			agentSessionId: undefined,
			usageStats: undefined,
		});

		const spawnErrorChild = createMockChild();
		mocks.spawn.mockReturnValueOnce(spawnErrorChild);
		const spawnErrorPromise = spawnAgent('claude-code', '/repo', 'Claude prompt');
		await flushSpawnRegistration();
		spawnErrorChild.emit('error', new Error('spawn ENOENT'));

		await expect(spawnErrorPromise).resolves.toEqual({
			success: false,
			error: 'Failed to spawn Claude: spawn ENOENT',
		});
	});

	it('spawns JSON-line agents with real parsers, env defaults, and error precedence', async () => {
		const { spawnAgent } = await loadSpawner();
		const codexChild = createMockChild();
		mocks.spawn.mockReturnValueOnce(codexChild);

		const codexPromise = spawnAgent('codex', '/repo', 'Codex prompt', 'thread-1');
		await flushSpawnRegistration();

		expect(mocks.spawn).toHaveBeenCalledWith(
			'codex',
			[
				'-C',
				'/repo',
				'exec',
				'--dangerously-bypass-approvals-and-sandbox',
				'--skip-git-repo-check',
				'--json',
				'resume',
				'thread-1',
				'--',
				'Codex prompt',
			],
			expect.objectContaining({ cwd: '/repo', stdio: ['pipe', 'pipe', 'pipe'] })
		);

		codexChild.stdout.emit('data', Buffer.from('\n'));
		emitJsonLines(codexChild, [
			{ type: 'thread.started', thread_id: 'thread-xyz' },
			{ type: 'item.completed', item: { type: 'agent_message', text: 'First' } },
			'not json',
			'null',
			{ type: 'item.completed', item: { type: 'agent_message', text: 'Second' } },
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cached_input_tokens: 2,
					reasoning_output_tokens: 3,
				},
			},
		]);
		codexChild.emit('close', 0);

		await expect(codexPromise).resolves.toMatchObject({
			success: true,
			response: 'First\nSecond',
			agentSessionId: 'thread-xyz',
			usageStats: {
				inputTokens: 10,
				outputTokens: 8,
				cacheReadInputTokens: 2,
				reasoningTokens: 3,
			},
		});

		const openCodeChild = createMockChild();
		mocks.spawn.mockReturnValueOnce(openCodeChild);
		const openCodePromise = spawnAgent('opencode', '/repo', 'Open prompt');
		await flushSpawnRegistration();
		expect(mocks.spawn.mock.calls[1][2].env.OPENCODE_CONFIG_CONTENT).toContain('"question":false');
		emitJsonLines(openCodeChild, [
			{ type: 'step_start', sessionID: 'open-session' },
			{ type: 'error', sessionID: 'open-session', error: { data: { message: 'API down' } } },
			{ type: 'error', sessionID: 'open-session', error: { data: { message: 'Ignored' } } },
		]);
		openCodeChild.stderr.emit('data', Buffer.from('stderr fallback'));
		openCodeChild.emit('close', 0);

		await expect(openCodePromise).resolves.toEqual({
			success: false,
			error: 'API down',
			agentSessionId: 'open-session',
			usageStats: undefined,
		});

		const factoryChild = createMockChild();
		mocks.spawn.mockReturnValueOnce(factoryChild);
		const factoryPromise = spawnAgent(
			'factory-droid',
			'/repo',
			'Factory prompt',
			'factory-session'
		);
		await flushSpawnRegistration();
		expect(mocks.spawn.mock.calls[2][1]).toEqual([
			'exec',
			'--skip-permissions-unsafe',
			'-o',
			'stream-json',
			'-s',
			'factory-session',
			'Factory prompt',
		]);
		emitJsonLines(factoryChild, [
			{ type: 'system', subtype: 'init', session_id: 'factory-session' },
			{
				type: 'completion',
				session_id: 'factory-session',
				finalText: 'Factory done',
				usage: {
					input_tokens: 7,
					output_tokens: 8,
					cache_read_input_tokens: 1,
					cache_creation_input_tokens: 2,
					thinking_tokens: 4,
				},
			},
		]);
		factoryChild.emit('close', 0);

		await expect(factoryPromise).resolves.toMatchObject({
			success: true,
			response: 'Factory done',
			agentSessionId: 'factory-session',
			usageStats: {
				inputTokens: 7,
				outputTokens: 8,
				cacheReadInputTokens: 1,
				cacheCreationInputTokens: 2,
				reasoningTokens: 4,
			},
		});

		const noReasoningChild = createMockChild();
		mocks.spawn.mockReturnValueOnce(noReasoningChild);
		const noReasoningPromise = spawnAgent('codex', '/repo', 'No reasoning prompt');
		await flushSpawnRegistration();
		emitJsonLines(noReasoningChild, [
			{ type: 'item.completed', item: { type: 'agent_message', text: 'No reasoning' } },
			{
				type: 'turn.completed',
				usage: {
					input_tokens: 4,
					output_tokens: 2,
				},
			},
		]);
		noReasoningChild.emit('close', 0);

		await expect(noReasoningPromise).resolves.toEqual({
			success: true,
			response: 'No reasoning',
			agentSessionId: undefined,
			usageStats: {
				inputTokens: 4,
				outputTokens: 2,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0,
				contextWindow: 1000000,
			},
		});
	});

	it('returns process and capability errors without hanging spawned children', async () => {
		const { spawnAgent } = await loadSpawner();

		await expect(spawnAgent('terminal' as never, '/repo', 'prompt')).resolves.toEqual({
			success: false,
			error: 'Unsupported agent type for batch mode: terminal',
		});

		const child = createMockChild();
		mocks.spawn.mockReturnValueOnce(child);
		const spawnFailure = spawnAgent('factory-droid', '/repo', 'prompt');
		await flushSpawnRegistration();
		child.emit('error', new Error('spawn ENOENT'));

		await expect(spawnFailure).resolves.toEqual({
			success: false,
			error: 'Failed to spawn Factory Droid: spawn ENOENT',
		});

		const stderrChild = createMockChild();
		mocks.spawn.mockReturnValueOnce(stderrChild);
		const stderrFailure = spawnAgent('opencode', '/repo', 'prompt');
		await flushSpawnRegistration();
		stderrChild.stderr.emit('data', Buffer.from('permission denied'));
		stderrChild.emit('close', 1);

		await expect(stderrFailure).resolves.toEqual({
			success: false,
			error: 'permission denied',
			agentSessionId: undefined,
			usageStats: undefined,
		});

		const fallbackChild = createMockChild();
		mocks.spawn.mockReturnValueOnce(fallbackChild);
		const fallbackFailure = spawnAgent('opencode', '/repo', 'prompt');
		await flushSpawnRegistration();
		fallbackChild.emit('close', 2);

		await expect(fallbackFailure).resolves.toEqual({
			success: false,
			error: 'Process exited with code 2',
			agentSessionId: undefined,
			usageStats: undefined,
		});
	});

	it('returns failure for JSON-line capable agents when no parser exists', async () => {
		vi.doMock('../../main/agents/capabilities', () => ({
			hasCapability: () => true,
		}));
		vi.doMock('../../main/agents/definitions', () => ({
			getAgentDefinition: () => ({
				name: 'Gemini CLI',
				binaryName: 'gemini',
				batchModePrefix: ['run'],
			}),
		}));
		const { spawnAgent } = await loadSpawner();
		await expect(spawnAgent('gemini-cli' as never, '/repo', 'prompt')).resolves.toEqual({
			success: false,
			error: 'No parser available for agent type: gemini-cli',
		});
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});
