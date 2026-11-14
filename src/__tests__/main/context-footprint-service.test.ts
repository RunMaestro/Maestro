import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import type { StoredSession } from '../../main/stores/types';

const state = vi.hoisted(() => ({ sessions: [] as StoredSession[] }));
vi.mock('../../main/stores/instances', () => ({ isInitialized: () => true }));
vi.mock('../../main/stores/getters', () => ({
	getLiveSessions: () => state.sessions,
	getSessionsStore: () => ({ get: () => state.sessions }),
	getSettingsStore: () => ({ get: (_key: string, fallback: unknown) => fallback }),
	getAgentConfigsStore: () => ({ get: () => ({}) }),
}));
vi.mock('../../cli/services/system-prompt', () => ({
	prepareMaestroSystemPromptCli: vi.fn(async () => 'Configured system text'),
}));
vi.mock('../../main/utils/remote-git', () => ({
	execGitReadOnly: vi.fn(async () => ({ exitCode: 0, stdout: 'acappella\n', stderr: '' })),
}));

import { auditStoredAgentContextFootprint } from '../../main/context-footprint-service';
import { prepareMaestroSystemPromptCli } from '../../cli/services/system-prompt';
import { execGitReadOnly } from '../../main/utils/remote-git';

let root: string;
let project: string;
let account: string;

beforeEach(() => {
	vi.clearAllMocks();
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-stored-footprint-'));
	project = path.join(root, 'project');
	account = path.join(root, 'account');
	fs.mkdirSync(project);
	fs.mkdirSync(account);
	fs.mkdirSync(path.join(account, 'memories'));
	fs.writeFileSync(path.join(project, 'AGENTS.md'), 'project instruction');
	fs.writeFileSync(path.join(account, 'AGENTS.md'), 'account instruction');
	fs.writeFileSync(path.join(account, 'memories', 'work.md'), 'memory evidence');
	state.sessions = [
		{
			id: 'selected',
			name: 'Selected agent',
			toolType: 'codex',
			cwd: project,
			projectRoot: project,
			customEnvVars: { CODEX_HOME: account },
			newSessionMessage: 'Saved first-message text',
			nudgeMessage: 'Saved nudge',
		},
	];
	vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue('Configured system text');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe('stored agent context audit', () => {
	it('uses the selected project, account and canonical memory store with no writes', async () => {
		const before = fs.readdirSync(root, { recursive: true });
		const instruction = path.join(account, 'AGENTS.md');
		const stat = fs.statSync(instruction);
		const audit = await auditStoredAgentContextFootprint('selected');
		expect(audit.subject.agentId).toBe('selected');
		const text = JSON.stringify(audit);
		expect(text).toContain(path.join(project, 'AGENTS.md'));
		expect(text).toContain(instruction);
		expect(text).toContain(path.join(account, 'memories'));
		expect(text).toContain('Runtime-dependent System One text is omitted');
		expect(text).toContain('delivery');
		expect(fs.readdirSync(root, { recursive: true })).toEqual(before);
		expect(fs.readFileSync(instruction, 'utf8')).toBe('account instruction');
		expect(fs.statSync(instruction).mtimeMs).toBe(stat.mtimeMs);
		expect(execGitReadOnly).toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'HEAD'], project);
		const [agent, options] = vi.mocked(prepareMaestroSystemPromptCli).mock.calls[0];
		expect(agent.id).toBe('selected');
		expect(options?.readAgents?.()).toBe(state.sessions);
		await expect(options?.readSystemOneAccess?.('selected')).resolves.toBeUndefined();
		expect(options?.gitInfo).toEqual({ isRepo: true, branch: 'acappella' });
	});

	it('keeps different stored accounts isolated', async () => {
		const otherAccount = path.join(root, 'other-account');
		fs.mkdirSync(otherAccount);
		fs.writeFileSync(path.join(otherAccount, 'AGENTS.md'), 'other account');
		state.sessions.push({
			...state.sessions[0],
			id: 'other',
			customEnvVars: { CODEX_HOME: otherAccount },
		});
		const selected = JSON.stringify(await auditStoredAgentContextFootprint('selected'));
		const other = JSON.stringify(await auditStoredAgentContextFootprint('other'));
		expect(selected).not.toContain(otherAccount);
		expect(other).toContain(path.join(otherAccount, 'AGENTS.md'));
		expect(other).not.toContain(path.join(account, 'AGENTS.md'));
	});

	it.each([
		{ sessionSshRemoteConfig: { enabled: true, remoteId: 'host' } },
		{ sshRemoteId: 'observed-host' },
		{ sessionSshRemoteConfig: { enabled: false }, sshRemoteId: 'observed-host' },
	])('refuses local inventory for either remote identity: %j', async (remote) => {
		Object.assign(state.sessions[0], remote);
		const audit = await auditStoredAgentContextFootprint('selected');
		expect(audit.inventory.components).toEqual([]);
		expect(audit.unknowns.some((note) => note.code === 'remote-agent')).toBe(true);
		expect(execGitReadOnly).not.toHaveBeenCalled();
		expect(prepareMaestroSystemPromptCli).not.toHaveBeenCalled();
	});

	it.each(['', 'sel', 'missing', { id: 'selected', projectRoot: '/elsewhere' }, null])(
		'rejects a missing, partial or caller-supplied identity: %j',
		async (input) => {
			await expect(auditStoredAgentContextFootprint(input as string)).rejects.toThrow();
			expect(execGitReadOnly).not.toHaveBeenCalled();
			expect(prepareMaestroSystemPromptCli).not.toHaveBeenCalled();
		}
	);

	it('leaves unsupported memory explicitly unavailable', async () => {
		state.sessions[0].toolType = 'gemini-cli';
		const audit = await auditStoredAgentContextFootprint('selected');
		expect(audit.unknowns.some((note) => note.code === 'memory-not-read')).toBe(true);
		expect(JSON.stringify(audit)).toContain('not supported');
	});

	it.each(['terminal', 'unknown-provider'])(
		'rejects %s before local resolution',
		async (toolType) => {
			state.sessions[0].toolType = toolType;
			await expect(auditStoredAgentContextFootprint('selected')).rejects.toThrow(
				'supported AI agent'
			);
			expect(execGitReadOnly).not.toHaveBeenCalled();
		}
	);

	it('does not use a relative cwd for Git or prompt assembly', async () => {
		state.sessions[0].cwd = 'relative';
		const audit = await auditStoredAgentContextFootprint('selected');
		expect(audit.unknowns.some((note) => note.code === 'maestro-prompt-unavailable')).toBe(true);
		expect(execGitReadOnly).not.toHaveBeenCalled();
		expect(prepareMaestroSystemPromptCli).not.toHaveBeenCalled();
	});

	it('preserves the actual cwd when it differs from the project root', async () => {
		const cwd = path.join(project, 'subdir');
		fs.mkdirSync(cwd);
		state.sessions[0].cwd = cwd;
		await auditStoredAgentContextFootprint('selected');
		expect(execGitReadOnly).toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
		expect(prepareMaestroSystemPromptCli).toHaveBeenCalledWith(
			expect.objectContaining({ cwd, projectRoot: project }),
			expect.anything()
		);
	});

	it('propagates unexpected assembly failures rather than reporting a successful empty audit', async () => {
		vi.mocked(prepareMaestroSystemPromptCli).mockRejectedValueOnce(new Error('read failed'));
		await expect(auditStoredAgentContextFootprint('selected')).rejects.toThrow('read failed');
	});
});
