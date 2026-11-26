/**
 * A headless host answering `get_project_token_usage`, and the desktop host answering the same
 * message: the two host kinds send the same frame for the same transcripts.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	createHostTokenUsageAnswer,
	headlessAccountSources,
	type ProjectTokenUsageReader,
} from '../../../cli/services/host-token-usage';
import {
	PROJECT_TOKEN_USAGE_FAILED,
	PROJECT_TOKEN_USAGE_REPLY,
	projectTokenUsageRequest,
} from '../../../shared/projectTokenUsage';
import type { SessionTokenBreakdown } from '../../../shared/tokenUsage';
import { formatChain, staticGraph, staticSpecifiers } from '../../helpers/staticImportGraph';

const SRC = path.join(__dirname, '../../..');

const BREAKDOWN: SessionTokenBreakdown = {
	sessionId: 's1',
	agentType: 'claude-code',
	projectPath: '/srv/app',
	accountKey: 'default',
	timestampMs: 5,
	byModel: [],
	inputTokens: 3,
	outputTokens: 4,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
	costUsd: 0,
	costEstimated: false,
	coverage: 'full',
};

describe('headless host token usage answer', () => {
	it('answers its own message with numbers only', async () => {
		const read: ProjectTokenUsageReader = vi.fn(async () => ({
			projects: [{ status: 'read' as const, breakdowns: [BREAKDOWN], complete: true }],
		}));
		const answer = createHostTokenUsageAnswer(read);
		const frame = await answer(
			projectTokenUsageRequest([{ provider: 'claude-code', projectPath: '/srv/app' }])
		);
		expect(frame).toMatchObject({
			type: PROJECT_TOKEN_USAGE_REPLY,
			success: true,
			projects: [{ status: 'read', breakdowns: [{ sessionId: 's1', inputTokens: 3 }] }],
		});
		expect(read).toHaveBeenCalledWith([{ provider: 'claude-code', projectPath: '/srv/app' }]);
	});

	it('leaves every other message to the next answerer', async () => {
		const answer = createHostTokenUsageAnswer(vi.fn());
		expect(await answer({ type: 'cue_list' })).toBeUndefined();
	});

	it('refuses a request with no project, and reports a read failure without throwing or naming a host path', async () => {
		const log = vi.fn();
		const answer = createHostTokenUsageAnswer(
			vi
				.fn()
				.mockRejectedValue(new Error("EACCES: open '/home/dev/.claude-work/projects/x.jsonl'")),
			{ log }
		);
		expect(await answer({ type: 'get_project_token_usage', projects: [] })).toMatchObject({
			success: false,
		});
		expect(
			await answer(projectTokenUsageRequest([{ provider: 'codex', projectPath: '/x' }]))
		).toEqual({
			type: PROJECT_TOKEN_USAGE_REPLY,
			success: false,
			error: PROJECT_TOKEN_USAGE_FAILED,
		});
		// The detail stays in the host's own log.
		expect(log).toHaveBeenCalledWith(expect.stringContaining('/home/dev/.claude-work'));
	});

	it('finds the accounts the host stores: its agents, provider env, and Settings env', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-host-accounts-'));
		try {
			fs.writeFileSync(
				path.join(dir, 'maestro-agent-configs.json'),
				JSON.stringify({ configs: { codex: { customEnvVars: { CODEX_HOME: '/data/codex-b' } } } })
			);
			const agents = [
				{ id: 'a1', toolType: 'claude-code', customEnvVars: { CLAUDE_CONFIG_DIR: '/data/work' } },
			];
			const sources = await headlessAccountSources(
				{
					agents: { list: async () => ({ ok: true, value: agents }) },
					settings: {
						get: async () => ({
							ok: true,
							value: { shellEnvVars: { CLAUDE_CONFIG_DIR: '/data/shell', N: 3 } },
						}),
					},
				} as never,
				dir
			);
			expect(sources.sessions).toEqual(agents);
			expect(sources.globalShellEnvVars).toEqual({ CLAUDE_CONFIG_DIR: '/data/shell' });
			expect(sources.agentLevelEnvVars('codex')).toEqual({ CODEX_HOME: '/data/codex-b' });
			expect(sources.agentLevelEnvVars('claude-code')).toEqual({});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('fails the read, rather than answer short, when an account source cannot be read', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-host-accounts-'));
		try {
			const runtime = (agentsOk: boolean, settingsOk: boolean) =>
				({
					agents: { list: async () => (agentsOk ? { ok: true, value: [] } : { ok: false }) },
					settings: {
						get: async () => (settingsOk ? { ok: true, value: {} } : { ok: false }),
					},
				}) as never;
			// An absent configs file is no failure.
			await expect(headlessAccountSources(runtime(true, true), dir)).resolves.toBeDefined();
			await expect(headlessAccountSources(runtime(false, true), dir)).rejects.toThrow();
			await expect(headlessAccountSources(runtime(true, false), dir)).rejects.toThrow();
			fs.writeFileSync(path.join(dir, 'maestro-agent-configs.json'), '{ not json');
			await expect(headlessAccountSources(runtime(true, true), dir)).rejects.toThrow();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('loads storages that plain Node can run: no static path to better-sqlite3', () => {
		// The modules the headless reader imports on the first ask.
		for (const entry of [
			'main/stats/token-usage/project-breakdowns.ts',
			'main/storage/claude-session-storage.ts',
			'main/storage/codex-session-storage.ts',
			'main/agents/provider-account-dirs.ts',
			'main/agents/provider-account-dirs-core.ts',
		]) {
			const graph = staticGraph(path.join(SRC, entry), () => null);
			const offenders = [...graph.entries()]
				.filter(([file]) =>
					staticSpecifiers(fs.readFileSync(file, 'utf-8')).includes('better-sqlite3')
				)
				.map(([, chain]) => formatChain(chain, SRC));
			expect(offenders, entry).toEqual([]);
		}
	});
});
