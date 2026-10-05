/**
 * `loadTurnContext`: what a turn reads from a data directory. A temp directory stands in for
 * the data dir; the binary probe and the git read are injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadTurnContext } from '../../../../shared/maestro-lib/turns/context';
import { historyFilePath } from '../../../../shared/maestro-lib/store/read-history';
import { makeAgent } from './fixtures';

let dir: string;
let prompts: string;
let paths: {
	userDataDir: string;
	settingsFile: string;
	agentConfigsFile: string;
	historyDir: string;
};

const found = (p: string) => async () => ({ exists: true, path: p });
const missing = async () => ({ exists: false });

function write(file: string, content: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-turn-context-'));
	prompts = path.join(dir, 'prompts');
	paths = {
		userDataDir: dir,
		settingsFile: path.join(dir, 'maestro-settings.json'),
		agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
		historyDir: path.join(dir, 'history'),
	};
	write(path.join(prompts, 'maestro-system-prompt.md'), 'SYSTEM');
	write(path.join(prompts, 'image-only-default.md'), 'IMAGE');
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function load(agent = makeAgent(), sources: Partial<Parameters<typeof loadTurnContext>[1]> = {}) {
	return loadTurnContext(agent, {
		paths,
		bundledPromptsDir: prompts,
		probeBinary: found('/bin/claude'),
		now: () => new Date(2026, 0, 1),
		...sources,
	});
}

describe('loadTurnContext', () => {
	it('refuses a provider this build does not know', async () => {
		const result = await load(makeAgent({ toolType: 'no-such-provider' }));
		expect(result).toMatchObject({ ok: false, reason: 'unknown-provider' });
	});

	it('refuses a binary that is not on this machine, before anything is written', async () => {
		const result = await load(makeAgent(), { probeBinary: missing });
		expect(result).toMatchObject({ ok: false, reason: 'not-installed' });
		expect((result as { message: string }).message).toContain('claude');
	});

	it('builds the provider from its definition, capabilities and detected path', async () => {
		const result = await load();
		if (!result.ok) throw new Error(result.message);
		expect(result.context.provider).toMatchObject({
			id: 'claude-code',
			available: true,
			path: '/bin/claude',
		});
		expect(result.context.provider.capabilities.supportsBatchMode).toBe(true);
		expect(result.context.command).toBe('/bin/claude');
	});

	it('reads the prompts, the conductor profile and the global environment', async () => {
		write(paths.settingsFile, {
			conductorProfile: 'Pedram',
			shellEnvVars: { A: '1', B: 2 },
		});
		const result = await load();
		if (!result.ok) throw new Error(result.message);
		expect(result.context.prompts).toMatchObject({
			maestroSystem: 'SYSTEM',
			imageOnlyDefault: 'IMAGE',
		});
		expect(result.context.conductorProfile).toBe('Pedram');
		expect(result.context.globalEnvVars).toEqual({ A: '1' });
	});

	it('reads this provider config and no other', async () => {
		write(paths.agentConfigsFile, {
			configs: { 'claude-code': { model: 'haiku' }, codex: { model: 'other' } },
		});
		const result = await load();
		if (!result.ok) throw new Error(result.message);
		expect(result.context.providerConfig).toEqual({ model: 'haiku' });
	});

	it('reads the Maestro commands from settings, dropping malformed ones', async () => {
		write(paths.settingsFile, {
			customAICommands: [
				{ id: '1', command: '/review', description: 'Review', prompt: 'Review $ARGUMENTS' },
				{ command: '/broken' },
				'nonsense',
			],
		});
		const result = await load();
		if (!result.ok) throw new Error(result.message);
		expect(result.commands).toEqual([
			{ command: '/review', description: 'Review', prompt: 'Review $ARGUMENTS' },
		]);
	});

	it('goes on with defaults when a store file is corrupt', async () => {
		write(paths.settingsFile, '{ not json');
		write(paths.agentConfigsFile, '{ not json');
		const result = await load();
		expect(result.ok).toBe(true);
	});

	it('goes without a system prompt when the bundled directory cannot be found', async () => {
		const result = await load(makeAgent(), {
			bundledPromptsDir: undefined,
			moduleDirectory: path.join(dir, 'nowhere', 'a', 'b'),
		});
		if (!result.ok) throw new Error(result.message);
		expect(result.context.prompts.maestroSystem).toBeUndefined();
	});

	it('loads Pianola and the Copilot preamble only for the agents that use them', async () => {
		write(path.join(prompts, 'pianola-system.md'), 'MANAGER');
		write(path.join(prompts, 'copilot-preamble.md'), 'PREAMBLE');
		const plain = await load();
		const pianola = await load(makeAgent({ isPianola: true }));
		const copilot = await load(makeAgent({ toolType: 'copilot-cli' }));
		if (!plain.ok || !pianola.ok || !copilot.ok) throw new Error('expected contexts');
		expect(plain.context.prompts.pianolaSystem).toBeUndefined();
		expect(plain.context.prompts.copilotPreamble).toBeUndefined();
		expect(pianola.context.prompts.pianolaSystem).toBe('MANAGER');
		expect(copilot.context.prompts.copilotPreamble).toBe('PREAMBLE');
	});

	it('reads the git branch only for a git repo', async () => {
		const readGitBranch = vi.fn(async () => 'feature/x');
		const repo = await load(makeAgent({ isGitRepo: true }), { readGitBranch });
		const notRepo = await load(makeAgent({ isGitRepo: false }), { readGitBranch });
		if (!repo.ok || !notRepo.ok) throw new Error('expected contexts');
		expect(repo.context.gitBranch).toBe('feature/x');
		expect(notRepo.context.gitBranch).toBeUndefined();
		expect(readGitBranch).toHaveBeenCalledTimes(1);
		expect(readGitBranch).toHaveBeenCalledWith('/work/project');
	});

	it('treats a git read that throws as no branch', async () => {
		const result = await load(makeAgent({ isGitRepo: true }), {
			readGitBranch: async () => {
				throw new Error('git is not installed');
			},
		});
		if (!result.ok) throw new Error(result.message);
		expect(result.context.gitBranch).toBeUndefined();
	});

	it('names the history file only when it exists', async () => {
		const without = await load();
		write(historyFilePath(paths.historyDir, 'agent-1'), '');
		const withFile = await load();
		if (!without.ok || !withFile.ok) throw new Error('expected contexts');
		expect(without.context.historyFilePath).toBeUndefined();
		expect(withFile.context.historyFilePath).toBe(historyFilePath(paths.historyDir, 'agent-1'));
	});

	it('states the data dir, the CLI script and the clock it was given', async () => {
		const result = await load(makeAgent(), { maestroCliPath: '/opt/maestro-cli.js' });
		if (!result.ok) throw new Error(result.message);
		expect(result.context.userDataDir).toBe(dir);
		expect(result.context.maestroCliPath).toBe('/opt/maestro-cli.js');
		expect(result.context.now).toEqual(new Date(2026, 0, 1));
	});

	describe('the binary', () => {
		it('uses the agent custom path when it is valid', async () => {
			const probeBinary = vi.fn(async (_name: string, customPath?: string) =>
				customPath ? { exists: true, path: customPath } : { exists: true, path: '/usr/bin/claude' }
			);
			const result = await load(makeAgent({ customPath: '/mine/claude' }), { probeBinary });
			if (!result.ok) throw new Error(result.message);
			expect(result.context.command).toBe('/mine/claude');
		});

		it('falls back to the provider custom path, then the probed one, when the agent path is invalid', async () => {
			write(paths.agentConfigsFile, {
				configs: { 'claude-code': { customPath: '/provider/claude' } },
			});
			const probeBinary = async (_name: string, customPath?: string) => {
				if (customPath === '/bad/claude') return { exists: false };
				if (customPath === '/provider/claude') return { exists: true, path: customPath };
				return { exists: true, path: '/usr/bin/claude' };
			};
			const viaProvider = await load(makeAgent({ customPath: '/bad/claude' }), { probeBinary });
			if (!viaProvider.ok) throw new Error(viaProvider.message);
			expect(viaProvider.context.command).toBe('/provider/claude');

			write(paths.agentConfigsFile, { configs: {} });
			const viaPath = await load(makeAgent({ customPath: '/bad/claude' }), { probeBinary });
			if (!viaPath.ok) throw new Error(viaPath.message);
			expect(viaPath.context.command).toBe('/usr/bin/claude');
		});

		it('does not probe, and reads no local git or history, for an SSH agent', async () => {
			write(historyFilePath(paths.historyDir, 'agent-1'), '');
			const probeBinary = vi.fn(found('/never'));
			const readGitBranch = vi.fn(async () => 'main');
			const result = await load(
				makeAgent({
					isGitRepo: true,
					customPath: '/remote/claude',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
				}),
				{ probeBinary, readGitBranch }
			);
			if (!result.ok) throw new Error(result.message);
			expect(probeBinary).not.toHaveBeenCalled();
			expect(readGitBranch).not.toHaveBeenCalled();
			expect(result.context.command).toBe('/remote/claude');
			expect(result.context.gitBranch).toBeUndefined();
			expect(result.context.historyFilePath).toBeUndefined();
		});
	});
});
