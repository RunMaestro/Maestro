/**
 * `loadTurnContext`: what a turn reads from a data directory. A temp directory stands in for
 * the data dir; the binary probe and the git read are injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	loadAgentSystemPrompt,
	loadPluginSectionsSystemPrompt,
	loadStandInSystemPrompt,
	loadTurnContext,
} from '../../../../shared/maestro-lib/turns/context';
import { assembleTurn } from '../../../../shared/maestro-lib/turns/assemble';
import { historyFilePath } from '../../../../shared/maestro-lib/store/read-history';
import { journeyFilePath } from '../../../../shared/maestro-lib/store/read-journey';
import { makeAgent, makeTab } from './fixtures';

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

	it('leaves a dormant Pianola (flag off) without its role or manager env', async () => {
		write(path.join(prompts, 'pianola-system.md'), 'MANAGER');
		const pianola = await load(makeAgent({ isPianola: true }));
		if (!pianola.ok) throw new Error('expected a context');
		expect(pianola.context.prompts.pianolaSystem).toBeUndefined();
		expect(pianola.context.pianolaEnabled).toBe(false);
	});

	it('loads Pianola and the Copilot preamble only for the agents that use them', async () => {
		write(path.join(prompts, 'pianola-system.md'), 'MANAGER');
		write(path.join(prompts, 'copilot-preamble.md'), 'PREAMBLE');
		write(paths.settingsFile, { encoreFeatures: { pianola: true } });
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

	it('names the journey file and reads the recent entries against the given clock', async () => {
		const now = new Date(2026, 0, 1).getTime();
		const recent = { ts: now - 60_000, agentId: 'agent-1', kind: 'file.open', target: '/p/a.ts' };
		const stale = { ...recent, ts: now - 3 * 60 * 60 * 1000 };
		write(journeyFilePath(dir, 'agent-1'), `${JSON.stringify(stale)}\n${JSON.stringify(recent)}\n`);
		const result = await load();
		if (!result.ok) throw new Error(result.message);
		expect(result.context.journeyFilePath).toBe(journeyFilePath(dir, 'agent-1'));
		expect(result.context.journeyEntries).toEqual([recent]);

		const ssh = await load(
			makeAgent({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } }),
			{
				probeBinary: found('/never'),
			}
		);
		if (!ssh.ok) throw new Error(ssh.message);
		expect(ssh.context.journeyFilePath).toBeUndefined();
		expect(ssh.context.journeyEntries).toEqual([recent]);
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

describe('the plugin sections of the system prompt', () => {
	const SEP = '\n\n---\n\n';
	const ssh = { sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } };

	beforeEach(() => {
		write(path.join(prompts, 'concerto-system.md'), 'CONCERTO');
		write(path.join(prompts, 'computer-history-system.md'), 'HISTORY {{COMPUTER_HISTORY_DIR}}');
		write(path.join(prompts, 'maestro-run-system.md'), 'RUN {{MAESTRO_RUN_PATH}}');
	});

	const enable = (flags: Record<string, boolean>, extra: Record<string, unknown> = {}) =>
		write(paths.settingsFile, { encoreFeatures: flags, ...extra });
	const recordMaestroRun = (ready: boolean) =>
		write(path.join(dir, 'maestro-run', 'state.json'), {
			ready,
			binaryPath: '/Apps/maestro-run',
			version: '1.0.0',
			checkedAt: 1,
		});

	async function sectionsOf(agent = makeAgent(), sources = {}) {
		const result = await load(agent, sources);
		if (!result.ok) throw new Error(result.message);
		return result.context;
	}

	it('loads no section while every plugin is off', async () => {
		expect((await sectionsOf()).prompts.pluginSections).toEqual([]);
	});

	it('loads each enabled plugin section, in the shared order', async () => {
		enable({ concerto: true, computerHistory: true });
		const context = await sectionsOf();
		expect(context.prompts.pluginSections).toEqual([
			'CONCERTO',
			'HISTORY {{COMPUTER_HISTORY_DIR}}',
		]);
		expect(context.computerHistoryDir).toBe(path.join(dir, 'computer-history'));
	});

	it('drops localOnly sections and local paths for an SSH agent', async () => {
		enable({ concerto: true, computerHistory: true, maestroRun: true });
		recordMaestroRun(true);
		const context = await sectionsOf(makeAgent(ssh));
		expect(context.prompts.pluginSections).toEqual(['CONCERTO']);
		expect(context.computerHistoryDir).toBeUndefined();
		expect(context.maestroRunPath).toBeUndefined();
	});

	it('includes MaestroRun only once the app recorded it ready, or the host says so', async () => {
		enable({ maestroRun: true });
		expect((await sectionsOf()).prompts.pluginSections).toEqual([]);
		recordMaestroRun(false);
		expect((await sectionsOf()).prompts.pluginSections).toEqual([]);
		recordMaestroRun(true);
		const recorded = await sectionsOf();
		expect(recorded.prompts.pluginSections).toEqual(['RUN {{MAESTRO_RUN_PATH}}']);
		expect(recorded.maestroRunPath).toBe('/Apps/maestro-run');
		fs.rmSync(path.join(dir, 'maestro-run'), { recursive: true });
		const stated = await sectionsOf(makeAgent(), { maestroRunPath: '/host/maestro-run' });
		expect(stated.maestroRunPath).toBe('/host/maestro-run');
		expect(stated.prompts.pluginSections).toEqual(['RUN {{MAESTRO_RUN_PATH}}']);
	});

	it('skips a section whose prompt does not load', async () => {
		enable({ concerto: true, computerHistory: true });
		fs.rmSync(path.join(prompts, 'concerto-system.md'));
		expect((await sectionsOf()).prompts.pluginSections).toEqual([
			'HISTORY {{COMPUTER_HISTORY_DIR}}',
		]);
	});

	it("gives a turn with no tab the agent's own system prompt, less the tab id", async () => {
		enable({ computerHistory: true }, { conductorProfile: 'Pedram' });
		write(
			path.join(prompts, 'maestro-system-prompt.md'),
			'SYSTEM {{AGENT_NAME}} [{{TAB_ID}}] {{CONDUCTOR_PROFILE}}'
		);
		const agent = makeAgent();
		const loaded = await sectionsOf(agent);
		const turn = assembleTurn(agent, makeTab({ id: '' }), { text: 'hi' }, loaded);
		if (!turn.ok) throw new Error(turn.message);
		const sources = { paths, bundledPromptsDir: prompts, now: () => new Date(2026, 0, 1) };
		const tabless = await loadAgentSystemPrompt(agent, sources);
		expect(tabless).toBe(
			`SYSTEM Test Agent [] Pedram${SEP}HISTORY ${path.join(dir, 'computer-history')}`
		);
		expect(tabless).toBe(turn.turn.systemPrompt);
	});

	it('gives a turn with no agent behind it the plugin sections alone', async () => {
		enable({ concerto: true, computerHistory: true });
		const sources = { paths, bundledPromptsDir: prompts };
		expect(loadPluginSectionsSystemPrompt(sources, { isSsh: false })).toBe(
			`CONCERTO${SEP}HISTORY ${path.join(dir, 'computer-history')}`
		);
		expect(loadPluginSectionsSystemPrompt(sources, { isSsh: true })).toBe('CONCERTO');
		enable({});
		expect(loadPluginSectionsSystemPrompt(sources, { isSsh: false })).toBeUndefined();
	});

	it('falls back to the plugin sections when no stored agent stands behind a turn', async () => {
		enable({ concerto: true });
		const sources = { paths, bundledPromptsDir: prompts };
		expect(await loadStandInSystemPrompt(undefined, sources, { isSsh: false })).toBe('CONCERTO');
		expect(await loadStandInSystemPrompt(makeAgent(), sources, { isSsh: false })).toBe(
			`SYSTEM${SEP}CONCERTO`
		);
		fs.rmSync(path.join(prompts, 'maestro-system-prompt.md'));
		expect(await loadStandInSystemPrompt(makeAgent(), sources, { isSsh: false })).toBe('CONCERTO');
	});
});
