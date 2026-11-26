/**
 * The `get_project_token_usage` wire: a host's numbers are untrusted input, read field by field.
 */

import { describe, it, expect } from 'vitest';
import {
	MAX_PROJECT_TOKEN_USAGE_PROJECTS,
	PROJECT_TOKEN_USAGE_MESSAGE,
	PROJECT_TOKEN_USAGE_REPLY,
	parseProjectTokenUsageReply,
	parseProjectTokenUsageRequest,
	projectTokenUsageReplyFrame,
	projectTokenUsageRequest,
} from '../../shared/projectTokenUsage';
import type { SessionTokenBreakdown } from '../../shared/tokenUsage';

const ASKED = [{ provider: 'claude-code', projectPath: '/srv/app' }];

function breakdown(overrides: Partial<SessionTokenBreakdown> = {}): SessionTokenBreakdown {
	return {
		sessionId: 's1',
		agentType: 'claude-code',
		projectPath: '/srv/app',
		accountKey: 'default',
		timestampMs: 1_700_000_000_000,
		origin: 'user',
		byModel: [
			{
				model: 'claude-opus-4-8',
				inputTokens: 10,
				outputTokens: 20,
				cacheReadTokens: 30,
				cacheCreationTokens: 40,
				costUsd: 0.5,
				costEstimated: true,
			},
		],
		inputTokens: 10,
		outputTokens: 20,
		cacheReadTokens: 30,
		cacheCreationTokens: 40,
		costUsd: 0.5,
		costEstimated: true,
		coverage: 'full',
		...overrides,
	};
}

/** A reply as it arrives: the frame, through JSON, with one record replaced. */
function replyWith(raw: Record<string, unknown>): unknown {
	const frame = JSON.parse(
		JSON.stringify(
			projectTokenUsageReplyFrame({ breakdowns: [breakdown()], unsupportedProviders: [] })
		)
	);
	frame.breakdowns[0] = { ...frame.breakdowns[0], ...raw };
	return frame;
}

describe('project token usage request', () => {
	it('sends each project once', () => {
		const request = projectTokenUsageRequest([...ASKED, ...ASKED]);
		expect(request).toEqual({ type: PROJECT_TOKEN_USAGE_MESSAGE, projects: ASKED });
	});

	it('reads only projects that name a provider and a path, capped', () => {
		const many = Array.from({ length: MAX_PROJECT_TOKEN_USAGE_PROJECTS + 5 }, (_, i) => ({
			provider: 'codex',
			projectPath: `/p/${i}`,
		}));
		expect(
			parseProjectTokenUsageRequest({ projects: [{ provider: 'codex' }, 7, ...many] })
		).toHaveLength(MAX_PROJECT_TOKEN_USAGE_PROJECTS);
		expect(parseProjectTokenUsageRequest({ projects: 'all' })).toEqual([]);
	});
});

describe('project token usage reply', () => {
	it('round-trips a breakdown, leaving canonical accounting and speed on the host', () => {
		const frame = projectTokenUsageReplyFrame({
			breakdowns: [
				breakdown({
					accounting: { completeness: 'complete' } as never,
					speed: [{ startMs: 1 } as never],
				}),
			],
			unsupportedProviders: ['opencode'],
		});
		expect(frame.type).toBe(PROJECT_TOKEN_USAGE_REPLY);
		const parsed = parseProjectTokenUsageReply(JSON.parse(JSON.stringify(frame)), [
			...ASKED,
			{ provider: 'opencode', projectPath: '/srv/app' },
		]);
		expect(parsed?.breakdowns).toEqual([breakdown()]);
		expect(parsed?.unsupportedProviders).toEqual(['opencode']);
	});

	it.each([
		['a negative count', { inputTokens: -1 }],
		['a non-finite count', { outputTokens: Number.POSITIVE_INFINITY }],
		['a count no conversation reaches', { cacheReadTokens: 1e20 }],
		['a string count', { costUsd: '5' }],
		['a provider the request did not ask about', { agentType: 'codex' }],
		['no session id', { sessionId: '' }],
		['a model bucket that does not hold together', { byModel: [{ model: 'x', inputTokens: -5 }] }],
		[
			'too many model buckets',
			{ byModel: Array.from({ length: 65 }, () => breakdown().byModel[0]) },
		],
	])('drops a record with %s', (_label, raw) => {
		expect(parseProjectTokenUsageReply(replyWith(raw), ASKED)?.breakdowns).toEqual([]);
	});

	it('keeps only known coverage and origin words', () => {
		const parsed = parseProjectTokenUsageReply(
			replyWith({ coverage: 'everything', origin: 'robot' }),
			ASKED
		);
		expect(parsed?.breakdowns[0].coverage).toBe('unsupported');
		expect(parsed?.breakdowns[0].origin).toBeUndefined();
	});

	it('reads a failure or a malformed reply as no answer', () => {
		expect(parseProjectTokenUsageReply({ success: false, error: 'x' }, ASKED)).toBeUndefined();
		expect(parseProjectTokenUsageReply({ success: true }, ASKED)).toBeUndefined();
		expect(parseProjectTokenUsageReply('nope', ASKED)).toBeUndefined();
	});
});
