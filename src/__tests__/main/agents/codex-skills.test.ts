import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	startTurn,
	type TurnHandlers,
	type TurnExit,
} from '../../../shared/maestro-lib/run/start-turn';
import { discoverCodexSkills } from '../../../main/agents/codex-skills';
import { buildSshCommand } from '../../../main/utils/ssh-command-builder';
import type { SshRemoteConfig } from '../../../shared/types';
import * as path from 'path';

vi.mock('../../../shared/maestro-lib/run/start-turn', () => ({ startTurn: vi.fn() }));
vi.mock('../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: vi.fn(
		async (_remote: unknown, options: { command: string; args: string[]; cwd?: string }) => ({
			command: 'ssh',
			args: ['dev@box', `cd ${options.cwd} && ${options.command} ${options.args.join(' ')}`],
		})
	),
}));

describe('Codex skill discovery protocol', () => {
	const cwd = path.resolve('project');
	let handlers: TurnHandlers;
	let finish: (exit: TurnExit) => void;
	let skills: Array<Record<string, unknown>>;
	let reply: boolean;
	const write = vi.fn();
	const terminate = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		reply = true;
		skills = [];
		vi.mocked(startTurn).mockImplementation((_spec, callbacks) => {
			handlers = callbacks;
			const done = new Promise<TurnExit>((resolve) => {
				finish = resolve;
			});
			terminate.mockImplementation(() => finish({} as TurnExit));
			write.mockImplementation((line: string) => {
				const message = JSON.parse(line);
				if (reply && message.id)
					queueMicrotask(() =>
						handlers.onLine?.(
							JSON.stringify({
								id: message.id,
								result: message.method === 'initialize' ? {} : { data: [{ cwd, skills }] },
							})
						)
					);
				return true;
			});
			return {
				child: { stdin: { writable: true, write } },
				terminate,
				done,
			} as unknown as ReturnType<typeof startTurn>;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('offers enabled plugin and system skills through native invocations with their resource paths', async () => {
		const skillPath = path.join(cwd, 'plugin', 'code-review', 'SKILL.md');
		skills = [
			{ name: 'plugin:code-review', description: 'Review code', enabled: true, path: skillPath },
			{
				name: 'skill-creator',
				description: 'Create skills',
				enabled: true,
				path: path.join(cwd, '.system', 'SKILL.md'),
				interface: { shortDescription: 'Create a skill' },
			},
			{ name: 'disabled', enabled: false, path: skillPath },
		];
		const commands = await discoverCodexSkills('codex', cwd, { CODEX_HOME: cwd });
		expect(commands).toEqual([
			{
				name: 'plugin:code-review',
				description: 'Review code',
				prompt: `$plugin:code-review\n\nUse the skill at ${JSON.stringify(skillPath)}.`,
			},
			expect.objectContaining({
				name: 'skill-creator',
				description: 'Create a skill',
				prompt: expect.stringContaining('$skill-creator'),
			}),
		]);
		expect(write.mock.calls.map(([line]) => JSON.parse(line).method)).toEqual([
			'initialize',
			'initialized',
			'skills/list',
		]);
		expect(JSON.parse(write.mock.calls[2][0]).params).toEqual({ cwds: [cwd], forceReload: true });
		expect(startTurn).toHaveBeenCalledWith(
			expect.objectContaining({ cwd, env: { CODEX_HOME: cwd }, args: ['app-server'] }),
			expect.anything(),
			expect.objectContaining({ keepStdinOpen: true })
		);
		expect(terminate).toHaveBeenCalledOnce();
	});

	it('runs Codex on the SSH remote, in the folder there, when the agent runs on one', async () => {
		const remoteCwd = '/srv/project';
		skills = [{ name: 'remote-skill', enabled: true, path: '/srv/project/.codex/skills/x' }];
		// The answer names the folder the request asked about: the remote one.
		vi.mocked(startTurn).mockImplementationOnce((_spec, callbacks) => {
			handlers = callbacks;
			const done = new Promise<TurnExit>((resolve) => {
				finish = resolve;
			});
			terminate.mockImplementation(() => finish({} as TurnExit));
			write.mockImplementation((line: string) => {
				const message = JSON.parse(line);
				if (message.id)
					queueMicrotask(() =>
						handlers.onLine?.(
							JSON.stringify({
								id: message.id,
								result:
									message.method === 'initialize' ? {} : { data: [{ cwd: remoteCwd, skills }] },
							})
						)
					);
				return true;
			});
			return {
				child: { stdin: { writable: true, write } },
				terminate,
				done,
			} as unknown as ReturnType<typeof startTurn>;
		});
		const remote = {
			config: { id: 'r1', remoteEnv: { A: '1' } } as unknown as SshRemoteConfig,
			env: { CODEX_HOME: '/srv/codex' },
		};

		const commands = await discoverCodexSkills('codex', remoteCwd, { PATH: '/usr/bin' }, remote);

		expect(commands.map((c) => c.name)).toEqual(['remote-skill']);
		expect(buildSshCommand).toHaveBeenCalledWith(remote.config, {
			command: 'codex',
			args: ['app-server'],
			cwd: remoteCwd,
			env: { A: '1', CODEX_HOME: '/srv/codex' },
			useStdin: true,
		});
		// This machine starts ssh, never codex in a folder that is not here.
		const spec = vi.mocked(startTurn).mock.calls.at(-1)![0];
		expect(spec.command).toBe('ssh');
		expect(spec.cwd).not.toBe(remoteCwd);
		expect(JSON.parse(write.mock.calls[2][0]).params).toEqual({
			cwds: [remoteCwd],
			forceReload: true,
		});
	});

	it('preserves an authoritative empty skill list', async () => {
		expect(await discoverCodexSkills('codex', cwd, {})).toEqual([]);
		expect(terminate).toHaveBeenCalledOnce();
	});

	it('bounds a stalled handshake and terminates its process', async () => {
		vi.useFakeTimers();
		reply = false;
		const result = discoverCodexSkills('codex', cwd, {});
		const assertion = expect(result).rejects.toThrow('no response after 5000ms');
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;
		expect(terminate).toHaveBeenCalledOnce();
	});

	it('rejects immediately when the CLI exits before answering', async () => {
		reply = false;
		const result = discoverCodexSkills('codex', cwd, {});
		finish({} as TurnExit);
		await expect(result).rejects.toThrow('Codex skill discovery exited');
		expect(terminate).toHaveBeenCalledOnce();
	});
});
