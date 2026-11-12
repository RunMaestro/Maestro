/**
 * @file agent-footprint.test.ts
 * @description `maestro-cli agent footprint`: the agent is resolved from the
 * stored agents, its account dir and memory store with the resolvers the
 * Memory Viewer uses, and the audit is printed as text or JSON. Files are real
 * (a temporary tree); the stores, the system prompt builder and git are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionInfo } from '../../../shared/types';

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((reference: string) => reference),
	getSessionById: vi.fn(),
}));
vi.mock('../../../cli/services/agent-account-dir', () => ({
	resolveCliAgentAccountDir: vi.fn(),
}));
vi.mock('../../../cli/services/system-prompt', () => ({
	prepareMaestroSystemPromptCli: vi.fn(),
}));
vi.mock('../../../cli/services/git-utils', () => ({
	getGitCommonDir: vi.fn(),
}));

import { agentFootprint } from '../../../cli/commands/agent-footprint';
import { resolveAgentId, getSessionById } from '../../../cli/services/storage';
import { resolveCliAgentAccountDir } from '../../../cli/services/agent-account-dir';
import { prepareMaestroSystemPromptCli } from '../../../cli/services/system-prompt';
import { getGitCommonDir } from '../../../cli/services/git-utils';
import { resolveClaudeMemoryPath } from '../../../shared/maestro-lib/translation/memory';

let root: string;
let project: string;
let account: string;

function seed(base: string, files: Record<string, string>): void {
	for (const [relative, text] of Object.entries(files)) {
		const file = path.join(base, ...relative.split('/'));
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	}
}

function agent(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: 'agent-1',
		name: 'Docs Agent',
		toolType: 'claude-code',
		cwd: project,
		projectRoot: project,
		...overrides,
	} as SessionInfo;
}

describe('agent footprint command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;
	const callerEnv = process.env.MAESTRO_CALLER_AGENT_ID;

	const printed = () => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
	const json = () => JSON.parse(String(logSpy.mock.calls[0][0]));

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-agent-footprint-'));
		project = path.join(root, 'work', 'project');
		account = path.join(root, 'accounts', 'main');
		fs.mkdirSync(project, { recursive: true });
		fs.mkdirSync(account, { recursive: true });
		delete process.env.MAESTRO_CALLER_AGENT_ID;

		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((reference: string) => reference);
		vi.mocked(getSessionById).mockReturnValue(agent());
		vi.mocked(resolveCliAgentAccountDir).mockReturnValue(account);
		vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue('P'.repeat(400));
		vi.mocked(getGitCommonDir).mockReturnValue(undefined);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
		if (callerEnv === undefined) delete process.env.MAESTRO_CALLER_AGENT_ID;
		else process.env.MAESTRO_CALLER_AGENT_ID = callerEnv;
		vi.restoreAllMocks();
	});

	describe('the report', () => {
		it('prints the measured text and the inventory of the agent it was asked about', async () => {
			seed(project, {
				'CLAUDE.md': 'c'.repeat(8_000),
				'.claude/skills/one/SKILL.md': 's'.repeat(80),
			});
			seed(account, { 'CLAUDE.md': 'u'.repeat(400) });
			vi.mocked(getSessionById).mockReturnValue(
				agent({ nudgeMessage: 'n'.repeat(40), newSessionMessage: 'm'.repeat(80) })
			);

			await agentFootprint('agent-1', {});

			const out = printed();
			expect(resolveAgentId).toHaveBeenCalledWith('agent-1');
			expect(out).toContain('CONTEXT FOOTPRINT  Docs Agent (claude-code)');
			expect(out).toContain(`Project  ${project}`);
			expect(out).toContain(`Account  ${account}`);
			expect(out).toContain('Maestro system prompt  about 100 tokens  each spawn');
			expect(out).toContain('New session message  about 20 tokens  first message of a new session');
			expect(out).toContain('Nudge message  about 10 tokens  every message');
			expect(out).toContain(
				'1. CLAUDE.md  [instruction, project]  about 2,000 tokens if loaded in full'
			);
			// The account file is counted in the rollup; it is too small to be a candidate.
			expect(out).toContain('2 instruction files: 2,100 tokens');
			expect(out).toContain('1 skill: 20 tokens');
			expect(out).toContain('Nothing here is counted as compression savings');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('does not call current settings known loaded, in the text or in the JSON', async () => {
			vi.mocked(getSessionById).mockReturnValue(
				agent({ nudgeMessage: 'n'.repeat(40), newSessionMessage: 'm'.repeat(80) })
			);

			await agentFootprint('agent-1', {});
			const out = printed();
			expect(out).toContain('MAESTRO-ADDED TEXT: sizes as configured now');
			expect(out).toContain('delivery unknown  window unknown');
			expect(out).not.toMatch(/KNOWN LOADED/i);
			expect(out).toContain('These are separate additions and are not added together');

			logSpy.mockClear();
			await agentFootprint('agent-1', { json: true });
			const result = json();
			expect(result.loaded).toBeUndefined();
			expect(result.configured.contributions).toHaveLength(3);
			for (const entry of result.configured.contributions) {
				expect(entry).toMatchObject({
					basis: 'configured-now',
					delivery: { state: 'unknown' },
					window: { state: 'unknown' },
				});
			}
		});

		it('builds the Maestro prompt without asking the desktop, and says what that leaves out', async () => {
			await agentFootprint('agent-1', {});

			expect(prepareMaestroSystemPromptCli).toHaveBeenCalledTimes(1);
			const [passedAgent, options] = vi.mocked(prepareMaestroSystemPromptCli).mock.calls[0];
			expect(passedAgent).toEqual(agent());
			await expect(options?.readSystemOneAccess?.('agent-1')).resolves.toBeUndefined();
			expect(printed()).toContain(
				'the System One section, whose presence depends on desktop state'
			);
		});

		it('prints one JSON document with the audit beside success', async () => {
			seed(project, { 'CLAUDE.md': 'c'.repeat(400) });
			await agentFootprint('agent-1', { json: true });

			expect(logSpy).toHaveBeenCalledTimes(1);
			const result = json();
			expect(result.success).toBe(true);
			expect(result.version).toBe(1);
			expect(result.subject).toMatchObject({ agentId: 'agent-1', toolType: 'claude-code' });
			expect(result.inventory.components[0]).toMatchObject({
				label: 'CLAUDE.md',
				kind: 'instruction',
				estimatedTokens: 100,
				activation: { state: 'unknown' },
			});
			expect(result.configured.contributions[0].id).toBe('maestro-system-prompt');
			expect(result.accounting.countsAsSavings).toBe(false);
		});

		it("reads a worktree agent's project root, not its working directory", async () => {
			const worktree = path.join(root, 'work', 'project-worktree');
			fs.mkdirSync(worktree, { recursive: true });
			seed(project, { 'CLAUDE.md': 'at the project root' });
			seed(worktree, { 'AGENTS.md': 'only in the working directory' });
			vi.mocked(getSessionById).mockReturnValue(agent({ cwd: worktree, projectRoot: project }));

			await agentFootprint('agent-1', { json: true });

			expect(json().inventory.components.map((c: { label: string }) => c.label)).toEqual([
				'CLAUDE.md',
			]);
		});

		it('falls back to the working directory when the agent has no project root', async () => {
			seed(project, { 'CLAUDE.md': 'here' });
			vi.mocked(getSessionById).mockReturnValue(agent({ projectRoot: '' }));
			await agentFootprint('agent-1', { json: true });
			expect(json().subject.projectRoot).toBe(project);
			expect(json().inventory.components).toHaveLength(1);
		});
	});

	describe('memory', () => {
		it("finds a worktree agent's store under its main checkout, the way the Memory Viewer does", async () => {
			const main = path.join(root, 'work', 'main-checkout');
			vi.mocked(getGitCommonDir).mockReturnValue(path.join(main, '.git'));
			const store = resolveClaudeMemoryPath(main, account);
			seed(store, { 'MEMORY.md': 'i'.repeat(400), 'topic.md': 't'.repeat(40) });
			// The store a worktree-path key would have named holds something else.
			seed(resolveClaudeMemoryPath(project, account), { 'wrong.md': 'wrong store' });

			await agentFootprint('agent-1', { json: true });

			expect(getGitCommonDir).toHaveBeenCalledWith(project);
			expect(json().inventory.components.map((c: { label: string }) => c.label)).toEqual([
				'memory/MEMORY.md',
				'memory/topic.md',
			]);
		});

		it('says why memory was not read for a provider with no store', async () => {
			vi.mocked(getSessionById).mockReturnValue(agent({ toolType: 'opencode' }));
			await agentFootprint('agent-1', {});
			expect(printed()).toContain(
				'The memory store was not read: Memory viewer is not supported for agent "opencode"'
			);
		});

		it('does not look for memory when the provider has no account dir', async () => {
			vi.mocked(resolveCliAgentAccountDir).mockReturnValue(undefined);
			await agentFootprint('agent-1', { json: true });
			expect(getGitCommonDir).not.toHaveBeenCalled();
			expect(json().unknowns.map((n: { code: string }) => n.code)).toContain('memory-not-read');
			expect(json().subject.accountDir).toBeUndefined();
		});
	});

	describe('an agent on an SSH remote', () => {
		it.each([
			{ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } },
			{ sshRemoteId: 'observed-host' },
			{ sessionSshRemoteConfig: { enabled: false }, sshRemoteId: 'observed-host' },
		])("reads none of this machine's files for either remote identity: %j", async (remote) => {
			seed(project, { 'CLAUDE.md': 'a file on THIS machine' });
			vi.mocked(getSessionById).mockReturnValue(Object.assign(agent(), remote));

			await agentFootprint('agent-1', { json: true });

			const result = json();
			expect(result.inventory.components).toEqual([]);
			expect(result.unknowns.map((n: { code: string }) => n.code)).toContain('remote-agent');
			expect(resolveCliAgentAccountDir).not.toHaveBeenCalled();
			expect(getGitCommonDir).not.toHaveBeenCalled();
			expect(prepareMaestroSystemPromptCli).not.toHaveBeenCalled();
			expect(result.configured.contributions).toEqual([]);
			expect(result.unknowns.map((n: { code: string }) => n.code)).toContain(
				'maestro-prompt-unavailable'
			);
		});
	});

	describe('the system prompt', () => {
		it('reports it as not measured when the builder has no prompt to build', async () => {
			vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue(undefined);
			await agentFootprint('agent-1', { json: true });
			expect(json().configured.contributions).toEqual([]);
			expect(json().unknowns).toContainEqual({
				code: 'maestro-prompt-unavailable',
				message: 'The Maestro system prompt was not measured.',
			});
		});

		it('reports a failure of the builder and exits, rather than printing a partial audit', async () => {
			vi.mocked(prepareMaestroSystemPromptCli).mockRejectedValue(new Error('prompt store broke'));
			await agentFootprint('agent-1', {});
			expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
				'prompt store broke'
			);
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(logSpy).not.toHaveBeenCalled();
		});
	});

	describe('which agent', () => {
		it('defaults to the agent it runs under', async () => {
			process.env.MAESTRO_CALLER_AGENT_ID = 'caller-agent';
			await agentFootprint(undefined, {});
			expect(resolveAgentId).toHaveBeenCalledWith('caller-agent');
		});

		it('prefers the agent it was given over the one it runs under', async () => {
			process.env.MAESTRO_CALLER_AGENT_ID = 'caller-agent';
			await agentFootprint('named-agent', {});
			expect(resolveAgentId).toHaveBeenCalledWith('named-agent');
		});

		it('asks for an agent when it has none, as JSON when asked', async () => {
			await agentFootprint(undefined, { json: true });
			expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
				success: false,
				error: 'Name an agent: maestro-cli agent footprint <agent-id>',
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(getSessionById).not.toHaveBeenCalled();
		});

		it('reports an agent the resolver rejects', async () => {
			vi.mocked(resolveAgentId).mockImplementation(() => {
				throw new Error("Ambiguous agent ID 'a'. Matches:\n  aaaa  One\n  aaab  Two");
			});
			await agentFootprint('a', {});
			expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain('Ambiguous');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('reports an agent that resolves to nothing', async () => {
			vi.mocked(getSessionById).mockReturnValue(undefined);
			await agentFootprint('ghost', { json: true });
			expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
				success: false,
				error: 'Agent not found: ghost',
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});
});
