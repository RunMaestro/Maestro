/**
 * A headless host answering `get_project_token_usage`, and the desktop host answering the same
 * message: the two host kinds send the same frame for the same transcripts.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
	createHostTokenUsageAnswer,
	type ProjectTokenUsageReader,
} from '../../../cli/services/host-token-usage';
import {
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
			breakdowns: [BREAKDOWN],
			unsupportedProviders: ['opencode'],
		}));
		const answer = createHostTokenUsageAnswer(read);
		const frame = await answer(
			projectTokenUsageRequest([{ provider: 'claude-code', projectPath: '/srv/app' }])
		);
		expect(frame).toMatchObject({
			type: PROJECT_TOKEN_USAGE_REPLY,
			success: true,
			unsupportedProviders: ['opencode'],
		});
		expect(read).toHaveBeenCalledWith([{ provider: 'claude-code', projectPath: '/srv/app' }]);
	});

	it('leaves every other message to the next answerer', async () => {
		const answer = createHostTokenUsageAnswer(vi.fn());
		expect(await answer({ type: 'cue_list' })).toBeUndefined();
	});

	it('refuses a request with no project, and reports a read failure without throwing', async () => {
		const answer = createHostTokenUsageAnswer(vi.fn().mockRejectedValue(new Error('disk gone')));
		expect(await answer({ type: 'get_project_token_usage', projects: [] })).toMatchObject({
			success: false,
		});
		expect(
			await answer(projectTokenUsageRequest([{ provider: 'codex', projectPath: '/x' }]))
		).toEqual({
			type: PROJECT_TOKEN_USAGE_REPLY,
			success: false,
			error: 'Failed to read token usage: disk gone',
		});
	});

	it('loads storages that plain Node can run: no static path to better-sqlite3', () => {
		// The modules the headless reader imports on the first ask.
		for (const entry of [
			'main/stats/token-usage/project-breakdowns.ts',
			'main/storage/claude-session-storage.ts',
			'main/storage/codex-session-storage.ts',
			'main/agents/provider-account-dirs.ts',
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
