/**
 * The `get_project_token_usage` wire: a host's numbers are untrusted input, read field by field,
 * and a project counts as read only when the host read it whole and every record checked out.
 */

import { describe, it, expect } from 'vitest';
import {
	MAX_PROJECT_TOKEN_USAGE_BREAKDOWNS,
	MAX_PROJECT_TOKEN_USAGE_PROJECTS,
	PROJECT_TOKEN_USAGE_MESSAGE,
	PROJECT_TOKEN_USAGE_REPLY,
	chunkProjects,
	parseProjectTokenUsageReply,
	parseProjectTokenUsageRequest,
	projectTokenUsageReplyFrame,
	projectTokenUsageRequest,
	type ProjectTokenUsage,
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

function read(breakdowns: SessionTokenBreakdown[]): ProjectTokenUsage['projects'][number] {
	return { status: 'read', breakdowns, complete: true };
}

/** A frame as it arrives: through JSON. */
function wire(usage: ProjectTokenUsage): Record<string, unknown> {
	return JSON.parse(JSON.stringify(projectTokenUsageReplyFrame(usage)));
}

/** A reply whose one record has `raw` laid over it. */
function replyWith(raw: Record<string, unknown>): unknown {
	const frame = wire({ projects: [read([breakdown()])] }) as {
		projects: Array<{ breakdowns: Array<Record<string, unknown>> }>;
	};
	frame.projects[0].breakdowns[0] = { ...frame.projects[0].breakdowns[0], ...raw };
	return frame;
}

describe('project token usage request', () => {
	it('sends each project once, and chunks a long list into requests a host accepts', () => {
		expect(projectTokenUsageRequest([...ASKED, ...ASKED])).toEqual({
			type: PROJECT_TOKEN_USAGE_MESSAGE,
			projects: ASKED,
		});
		const many = Array.from({ length: MAX_PROJECT_TOKEN_USAGE_PROJECTS + 5 }, (_, i) => ({
			provider: 'codex',
			projectPath: `/p/${i}`,
		}));
		expect(chunkProjects([...many, ...many]).map((chunk) => chunk.length)).toEqual([
			MAX_PROJECT_TOKEN_USAGE_PROJECTS,
			5,
		]);
	});

	it('refuses a request it cannot answer as asked, rather than answering a different list', () => {
		const many = Array.from({ length: MAX_PROJECT_TOKEN_USAGE_PROJECTS + 1 }, (_, i) => ({
			provider: 'codex',
			projectPath: `/p/${i}`,
		}));
		expect(parseProjectTokenUsageRequest({ projects: many })).toBeUndefined();
		expect(parseProjectTokenUsageRequest({ projects: [{ provider: 'codex' }] })).toBeUndefined();
		expect(parseProjectTokenUsageRequest({ projects: [] })).toBeUndefined();
		expect(parseProjectTokenUsageRequest({ projects: ASKED })).toEqual(ASKED);
	});
});

describe('project token usage reply', () => {
	it('round-trips a read project; per-call speed stays on the host', () => {
		const parsed = parseProjectTokenUsageReply(
			wire({ projects: [read([breakdown({ speed: [{ startMs: 1 } as never] })])] }),
			ASKED
		);
		expect(parsed).toEqual({ projects: [read([breakdown()])] });
	});

	it('keeps lifetime accounting, so the requester counts lifetime totals over partial model detail', () => {
		const grok = breakdown({
			agentType: 'grok',
			inputTokens: 300,
			byModel: [{ ...breakdown().byModel[0], inputTokens: 120 }],
			accounting: {
				source: 'provider-billing',
				scope: 'native-session',
				reporting: 'snapshot',
				cacheReadCounting: 'beside-input',
				cacheCreationCounting: 'beside-input',
				completeness: 'partial',
				cost: { status: 'exact', costUsdTicks: '12500000000', costUsd: 1.25 },
				childInclusion: 'all',
				childCompleteness: 'complete',
			},
		});
		const parsed = parseProjectTokenUsageReply(wire({ projects: [read([grok])] }), [
			{ provider: 'grok', projectPath: '/srv/app' },
		]);
		const [got] = parsed!.projects[0].breakdowns;
		expect(got.inputTokens).toBe(300);
		expect(got.accounting).toMatchObject({
			completeness: 'partial',
			cost: { status: 'exact', costUsdTicks: '12500000000' },
		});
		expect(parsed!.projects[0].complete).toBe(true);
	});

	it('carries a failed or unsupported project as not complete', () => {
		const parsed = parseProjectTokenUsageReply(
			wire({
				projects: [
					{ status: 'failed', breakdowns: [], complete: false },
					{ status: 'unsupported', breakdowns: [], complete: false },
				],
			}),
			[ASKED[0], { provider: 'opencode', projectPath: '/srv/app' }]
		);
		expect(parsed!.projects.map((p) => [p.status, p.complete])).toEqual([
			['failed', false],
			['unsupported', false],
		]);
	});

	it('marks a project cut at the reply cap as not complete', () => {
		const frame = projectTokenUsageReplyFrame({
			projects: [
				read(
					Array.from({ length: MAX_PROJECT_TOKEN_USAGE_BREAKDOWNS + 1 }, (_, i) =>
						breakdown({ sessionId: `s${i}`, byModel: [] })
					)
				),
			],
		}) as { projects: Array<{ breakdowns: unknown[]; truncated?: boolean }> };
		expect(frame.projects[0].breakdowns).toHaveLength(MAX_PROJECT_TOKEN_USAGE_BREAKDOWNS);
		expect(frame.projects[0].truncated).toBe(true);
		expect(parseProjectTokenUsageReply(frame, ASKED)!.projects[0].complete).toBe(false);
	});

	it('folds model buckets past the cap into one, keeping the session whole', () => {
		const byModel = Array.from({ length: 70 }, (_, i) => ({
			...breakdown().byModel[0],
			model: `m${i}`,
			inputTokens: 1,
		}));
		const parsed = parseProjectTokenUsageReply(
			wire({ projects: [read([breakdown({ byModel, inputTokens: 70 })])] }),
			ASKED
		);
		const models = parsed!.projects[0].breakdowns[0].byModel;
		expect(models).toHaveLength(64);
		expect(models.reduce((sum, m) => sum + m.inputTokens, 0)).toBe(70);
		expect(parsed!.projects[0].complete).toBe(true);
	});

	it.each([
		['a negative count', { inputTokens: -1 }],
		['a non-finite count', { outputTokens: Number.POSITIVE_INFINITY }],
		['a count no conversation reaches', { cacheReadTokens: 1e20 }],
		['a string count', { costUsd: '5' }],
		['another provider than the project asked about', { agentType: 'codex' }],
		['no session id', { sessionId: '' }],
		[
			'a malformed lifetime cost',
			{ lifetime: { completeness: 'complete', cost: { status: 'free' } } },
		],
		['a model bucket that does not hold together', { byModel: [{ model: 'x', inputTokens: -5 }] }],
		[
			'too many model buckets',
			{ byModel: Array.from({ length: 65 }, () => breakdown().byModel[0]) },
		],
	])('drops a record with %s and leaves its project not complete', (_label, raw) => {
		const parsed = parseProjectTokenUsageReply(replyWith(raw), ASKED);
		expect(parsed!.projects[0].breakdowns).toEqual([]);
		expect(parsed!.projects[0].complete).toBe(false);
	});

	it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype'])(
		'drops a record that names %s as its id, path, account, or model, and leaves its project not complete',
		(key) => {
			const spoilers: Array<(record: Record<string, unknown>) => void> = [
				(record) => (record.sessionId = key),
				(record) => (record.projectPath = key),
				(record) => (record.accountKey = key),
				(record) => ((record.byModel as Array<Record<string, unknown>>)[0].model = key),
				(record) => ((record.byModel as Array<Record<string, unknown>>)[0].rawModel = key),
			];
			for (const spoil of spoilers) {
				const frame = replyWith({}) as {
					projects: Array<{ breakdowns: Array<Record<string, unknown>> }>;
				};
				spoil(frame.projects[0].breakdowns[0]);
				const parsed = parseProjectTokenUsageReply(frame, ASKED);
				expect(parsed!.projects[0].breakdowns).toEqual([]);
				expect(parsed!.projects[0].complete).toBe(false);
			}
		}
	);

	it('refuses a request whose provider or project names a prototype key', () => {
		for (const key of ['__proto__', 'constructor', 'toString']) {
			expect(
				parseProjectTokenUsageRequest({ projects: [{ provider: key, projectPath: '/srv/app' }] })
			).toBeUndefined();
			expect(
				parseProjectTokenUsageRequest({ projects: [{ provider: 'codex', projectPath: key }] })
			).toBeUndefined();
		}
	});

	it('names each account by its dir, never by a path of the host, keeping same-named dirs apart', () => {
		const frame = wire({
			projects: [
				read([
					breakdown({ sessionId: 'a', accountKey: '/home/dev/.claude-work' }),
					breakdown({ sessionId: 'b', accountKey: '/opt/other/.claude-work' }),
					breakdown({ sessionId: 'c', accountKey: 'C:\\Users\\dev\\.claude-home\\' }),
					breakdown({ sessionId: 'd', accountKey: 'default' }),
				]),
			],
		});
		expect(JSON.stringify(frame)).not.toMatch(/home\/dev|opt\/other|Users/);
		const parsed = parseProjectTokenUsageReply(frame, ASKED)!;
		expect(parsed.projects[0].complete).toBe(true);
		expect(parsed.projects[0].breakdowns.map((b) => b.accountKey)).toEqual([
			'.claude-work',
			'.claude-work-2',
			'.claude-home',
			'default',
		]);
	});

	it('drops a record whose path is not the folder the request named', () => {
		const parsed = parseProjectTokenUsageReply(replyWith({ projectPath: '/srv/app/sub' }), ASKED);
		expect(parsed!.projects[0].breakdowns).toEqual([]);
		expect(parsed!.projects[0].complete).toBe(false);
	});

	it('carries how many conversations were too large to read, and reads a bad count as not complete', () => {
		const frame = wire({
			projects: [{ status: 'read', breakdowns: [breakdown()], complete: true, skippedFiles: 2 }],
		});
		const parsed = parseProjectTokenUsageReply(frame, ASKED)!;
		expect(parsed.projects[0]).toMatchObject({ complete: true, skippedFiles: 2 });
		for (const bad of [-1, 1.5, 'two', 1e9]) {
			const spoiled = JSON.parse(JSON.stringify(frame)) as {
				projects: Array<Record<string, unknown>>;
			};
			spoiled.projects[0].skipped = bad;
			const read = parseProjectTokenUsageReply(spoiled, ASKED)!;
			expect(read.projects[0].complete).toBe(false);
		}
	});

	it('keeps only known coverage and origin words', () => {
		const parsed = parseProjectTokenUsageReply(
			replyWith({ coverage: 'everything', origin: 'robot' }),
			ASKED
		);
		expect(parsed!.projects[0].breakdowns[0].coverage).toBe('unsupported');
		expect(parsed!.projects[0].breakdowns[0].origin).toBeUndefined();
	});

	it('reads a failure, a malformed reply, or one answering other projects as no answer', () => {
		expect(parseProjectTokenUsageReply({ success: false, error: 'x' }, ASKED)).toBeUndefined();
		expect(parseProjectTokenUsageReply({ success: true }, ASKED)).toBeUndefined();
		expect(parseProjectTokenUsageReply('nope', ASKED)).toBeUndefined();
		const frame = wire({ projects: [read([]), read([])] });
		expect(frame.type).toBe(PROJECT_TOKEN_USAGE_REPLY);
		expect(parseProjectTokenUsageReply(frame, ASKED)).toBeUndefined();
	});
});
