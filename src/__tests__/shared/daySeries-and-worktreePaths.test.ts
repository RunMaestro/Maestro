import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { fillDaySeries } from '../../shared/daySeries';
import { localDaysBetween } from '../../shared/daySeries';
import { isPathAtOrUnderRoot } from '../../shared/worktreePaths';
import { normalizeWorktreePath } from '../../shared/worktreePaths';
import { clampFontScale } from '../../shared/scaleRange';
import { clampScale } from '../../shared/scaleRange';
import { FONT_SCALE_RANGE } from '../../shared/scaleRange';
import { stepScale } from '../../shared/scaleRange';
import { tokenUsageQueryForRange } from '../../shared/tokenUsage';
import { sessionOriginStoreFor } from '../../shared/sessionOriginStore';
import { resolvePeerRoster } from '../../shared/peerAgents';
import { prepareQueueRouting } from '../../main/pianola/pianola-queue-routing';
import { assertQueueRouting } from '../../main/pianola/pianola-queue-routing';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { PianolaQueueItem } from '../../shared/pianola/pianola-dispatch';
import { mergeAutoRunStats } from '../../shared/autoRunStatsMerge';
import { SESSION_IMAGE_REF_PREFIX } from '../../shared/sessionImageRefs';
import { isSessionImageRef } from '../../shared/sessionImageRefs';
import { sessionImageRefBasename } from '../../shared/sessionImageRefs';
import { sessionImageHttpPath } from '../../shared/sessionImageRefs';
__maestroMicrobenchDescribe('daySeries', () => {
	describe('localDaysBetween', () => {
		it('lists every day inclusive, across a month boundary', () => {
			expect(localDaysBetween('2026-10-30', '2026-11-02')).toEqual([
				'2026-10-30',
				'2026-10-31',
				'2026-11-01',
				'2026-11-02',
			]);
		});

		it('is empty for an inverted window', () => {
			expect(localDaysBetween('2026-11-02', '2026-11-01')).toEqual([]);
		});
	});

	describe('fillDaySeries', () => {
		it('fills idle days with the empty row and drops rows outside the window', () => {
			const rows = [
				{ date: '2026-10-29', count: 9 },
				{ date: '2026-10-31', count: 2 },
			];
			expect(
				fillDaySeries(rows, '2026-10-30', '2026-11-01', (date) => ({ date, count: 0 }))
			).toEqual([
				{ date: '2026-10-30', count: 0 },
				{ date: '2026-10-31', count: 2 },
				{ date: '2026-11-01', count: 0 },
			]);
		});
	});
});
__maestroMicrobenchDescribe('worktreePaths', () => {
	describe('isPathAtOrUnderRoot', () => {
		it('matches the root itself and paths under it', () => {
			expect(isPathAtOrUnderRoot('/a/b', '/a/b')).toBe(true);
			expect(isPathAtOrUnderRoot('/a/b/c', '/a/b')).toBe(true);
		});

		it('does not match a similarly named sibling', () => {
			expect(isPathAtOrUnderRoot('/a/bc', '/a/b')).toBe(false);
		});

		it('treats / as the parent of everything', () => {
			expect(isPathAtOrUnderRoot('/a', '/')).toBe(true);
		});

		it('treats a normalized Windows drive root as the parent of the drive', () => {
			const root = normalizeWorktreePath('C:\\');
			expect(root).toBe('C:/');
			expect(isPathAtOrUnderRoot(normalizeWorktreePath('C:\\vault\\notes'), root)).toBe(true);
			expect(isPathAtOrUnderRoot(normalizeWorktreePath('D:\\vault'), root)).toBe(false);
		});
	});
});
__maestroMicrobenchDescribe('scaleRange', () => {
	describe('scaleRange', () => {
		it('clamps into the range and rounds away float drift', () => {
			expect(clampScale(1.0000000000000002, FONT_SCALE_RANGE)).toBe(1);
			expect(clampScale(5, FONT_SCALE_RANGE)).toBe(2);
			expect(clampScale(0.1, FONT_SCALE_RANGE)).toBe(0.7);
			expect(clampScale(NaN, FONT_SCALE_RANGE)).toBe(1);
		});

		it('steps one increment, stopping at the ends', () => {
			expect(stepScale(1, 1, FONT_SCALE_RANGE)).toBe(1.1);
			expect(stepScale(1.1, 1, FONT_SCALE_RANGE)).toBe(1.2);
			expect(stepScale(2, 1, FONT_SCALE_RANGE)).toBe(2);
			expect(stepScale(0.7, -1, FONT_SCALE_RANGE)).toBe(0.7);
		});

		it('clampFontScale uses the text zoom range', () => {
			expect(clampFontScale(1.234)).toBe(1.23);
			expect(clampFontScale(3)).toBe(2);
		});
	});
});
__maestroMicrobenchDescribe('tokenUsage', () => {
	describe('tokenUsageQueryForRange', () => {
		const now = new Date(2026, 9, 31, 1, 53).getTime();

		it('starts "Today" at local midnight, not 24 hours back (#1960)', () => {
			// Granularity is left to the accessor, which picks it from the window's span
			// (one rule for the consumption timeline and the speed charts).
			expect(tokenUsageQueryForRange('day', now)).toEqual({
				sinceMs: new Date(2026, 9, 31).getTime(),
			});
		});

		it('starts the longer ranges at local midnight N-1 days back', () => {
			expect(tokenUsageQueryForRange('week', now).sinceMs).toBe(new Date(2026, 9, 25).getTime());
			expect(tokenUsageQueryForRange('all', now)).toEqual({});
		});
	});
});
__maestroMicrobenchDescribe('sessionOriginStore', () => {
	describe('sessionOriginStoreFor', () => {
		it('routes Claude Code, Codex, and a missing provider to the legacy Claude store', () => {
			expect(sessionOriginStoreFor('claude-code')).toBe('claude');
			expect(sessionOriginStoreFor('codex')).toBe('claude');
			expect(sessionOriginStoreFor(undefined)).toBe('claude');
			expect(sessionOriginStoreFor(null)).toBe('claude');
			expect(sessionOriginStoreFor('')).toBe('claude');
		});

		it('routes every other provider to the generic store', () => {
			for (const toolType of ['opencode', 'factory-droid', 'copilot-cli', 'pi', 'grok']) {
				expect(sessionOriginStoreFor(toolType)).toBe('generic');
			}
		});
	});
});
__maestroMicrobenchDescribe('peerAgents', () => {
	const agents: AgentRecord[] = [
		{
			id: 'source',
			name: 'Source',
			createdAt: 1,
			toolType: 'codex',
			groupId: 'team',
			groupPeerAccess: { read: true, write: false },
			parentSessionId: 'parent',
			worktreePeerAccess: { read: false, write: true },
		},
		{
			id: 'a',
			name: 'PeerA',
			createdAt: 1,
			toolType: 'codex',
			groupId: 'team',
			parentSessionId: 'parent',
		},
		{ id: 'b', name: 'PeerB', createdAt: 1, toolType: 'codex', groupId: 'nested-team' },
	];
	const item: PianolaQueueItem = {
		id: 'item',
		timestamp: 1,
		type: 'message',
		text: 'Check @PeerA',
		tabId: 'tab',
		pendingAdmissionId: 'dispatch',
		crossAgentMention: true,
	};

	describe('ported native peer roster and managed routing', () => {
		it('unions group and worktree access, with explicit rows replacing both bits', () => {
			expect(resolvePeerRoster(agents[0], agents)).toMatchObject([
				{ sessionId: 'a', read: true, write: true, source: 'group' },
			]);
			expect(
				resolvePeerRoster(
					{ ...agents[0], peerAgents: [{ sessionId: 'a', read: false, write: false }] },
					agents
				)
			).toEqual([]);
			expect(
				resolvePeerRoster(
					{ ...agents[0], peerAgents: [{ sessionId: 'a', read: true, write: false }] },
					agents
				)
			).toMatchObject([{ sessionId: 'a', read: true, write: false, source: 'explicit' }]);
		});

		it('does not infer grants from same names, nested groups, missing agents or self rows', () => {
			expect(
				resolvePeerRoster(
					{
						id: 'source',
						peerAgents: [
							{ sessionId: 'source', read: true, write: true },
							{ sessionId: 'missing', read: true, write: true },
						],
					},
					agents
				)
			).toEqual([]);
			expect(resolvePeerRoster(agents[0], agents).some((p) => p.sessionId === 'b')).toBe(false);
		});

		it('pins consult and handoff to separate read/write rights and stable step IDs', () => {
			const native = { agents, groups: [] };
			const consult = prepareQueueRouting(item, 'source', native)!;
			expect(consult.steps.map((s) => s.kind)).toEqual(['consult', 'local']);
			expect(() => assertQueueRouting(consult, item, 'source', native)).not.toThrow();
			const readOnly = {
				agents: [{ ...agents[0], worktreePeerAccess: undefined }, ...agents.slice(1)],
				groups: [],
			};
			expect(() =>
				prepareQueueRouting({ ...item, mentionRouting: 'handoff' }, 'source', readOnly)
			).toThrow('PeerDenied');
			const handoff = prepareQueueRouting(
				{ ...item, mentionRouting: 'handoff' },
				'source',
				native
			)!;
			expect(handoff.steps.map((s) => s.kind)).toEqual(['handoff', 'local']);
		});

		it('blocks renamed, deleted, replaced, ambiguously named and newly retargeted recipients', () => {
			const pinned = prepareQueueRouting(item, 'source', { agents, groups: [] })!;
			for (const roster of [
				agents.filter((a) => a.id !== 'a'),
				[agents[0], { ...agents[1], name: 'Renamed' }],
				[agents[0], { ...agents[1], createdAt: 2 }],
				[agents[0], { ...agents[1], id: 'replacement' }],
			]) {
				expect(() =>
					assertQueueRouting(pinned, item, 'source', { agents: roster, groups: [] })
				).toThrow();
			}
			expect(() =>
				prepareQueueRouting(item, 'source', {
					agents: [...agents, { ...agents[1], id: 'duplicate' }],
					groups: [],
				})
			).toThrow('Ambiguous');
		});
	});
});
__maestroMicrobenchDescribe('autoRunStatsMerge', () => {
	const stored = {
		cumulativeTimeMs: 4_869_514_889,
		cueTimeMs: 1_655_880_000,
		longestRunMs: 82_370_665,
		longestRunTimestamp: 1_783_641_600_000,
		totalRuns: 326,
		currentBadgeLevel: 6,
		lastBadgeUnlockLevel: 6,
		lastAcknowledgedBadgeLevel: 6,
		badgeHistory: [
			{ level: 2, unlockedAt: 1_764_668_373_382 },
			{ level: 3, unlockedAt: 1_765_038_054_070 },
		],
	};

	describe('mergeAutoRunStats', () => {
		// The incident: a Cue credit applied to an unhydrated renderer's zeroed copy.
		it('never lowers a stored total, run count, record, or badge', () => {
			const merged = mergeAutoRunStats(stored, {
				cumulativeTimeMs: 37_920_000,
				cueTimeMs: 37_920_000,
				longestRunMs: 0,
				longestRunTimestamp: 0,
				totalRuns: 0,
				currentBadgeLevel: 3,
				lastBadgeUnlockLevel: 3,
				lastAcknowledgedBadgeLevel: 2,
				badgeHistory: [
					{ level: 1, unlockedAt: 1_792_856_751_137 },
					{ level: 2, unlockedAt: 1_792_858_348_125 },
					{ level: 3, unlockedAt: 1_792_867_736_082 },
				],
			});

			expect(merged).toMatchObject({
				cumulativeTimeMs: stored.cumulativeTimeMs,
				cueTimeMs: stored.cueTimeMs,
				longestRunMs: stored.longestRunMs,
				longestRunTimestamp: stored.longestRunTimestamp,
				totalRuns: 326,
				currentBadgeLevel: 6,
				lastBadgeUnlockLevel: 6,
				lastAcknowledgedBadgeLevel: 6,
			});
			// Union by level, the earliest unlock of each one kept.
			expect(merged.badgeHistory).toEqual([
				{ level: 1, unlockedAt: 1_792_856_751_137 },
				{ level: 2, unlockedAt: 1_764_668_373_382 },
				{ level: 3, unlockedAt: 1_765_038_054_070 },
			]);
		});

		it('takes every counter that grew, and the longest run with its own date', () => {
			const merged = mergeAutoRunStats(stored, {
				...stored,
				cumulativeTimeMs: stored.cumulativeTimeMs + 60_000,
				cueTimeMs: stored.cueTimeMs + 60_000,
				longestRunMs: 90_000_000,
				longestRunTimestamp: 1_792_000_000_000,
				totalRuns: 327,
				currentBadgeLevel: 7,
			});

			expect(merged).toMatchObject({
				cumulativeTimeMs: stored.cumulativeTimeMs + 60_000,
				cueTimeMs: stored.cueTimeMs + 60_000,
				longestRunMs: 90_000_000,
				longestRunTimestamp: 1_792_000_000_000,
				totalRuns: 327,
				currentBadgeLevel: 7,
			});
		});

		it('keeps the Cue share inside the total', () => {
			const merged = mergeAutoRunStats(
				{ cumulativeTimeMs: 1000, cueTimeMs: 0 },
				{ cumulativeTimeMs: 500, cueTimeMs: 5000 }
			);
			expect(merged.cumulativeTimeMs).toBe(1000);
			expect(merged.cueTimeMs).toBe(1000);
		});

		it('accepts the first write on a fresh install and survives junk', () => {
			const first = mergeAutoRunStats(undefined, { cumulativeTimeMs: 60_000, totalRuns: 1 });
			expect(first).toMatchObject({ cumulativeTimeMs: 60_000, totalRuns: 1, badgeHistory: [] });

			const junk = mergeAutoRunStats(
				{ cumulativeTimeMs: 'x', totalRuns: Number.NaN, badgeHistory: 'nope' },
				{ cumulativeTimeMs: -5, badgeHistory: [null, { level: 0, unlockedAt: 1 }] }
			);
			expect(junk).toMatchObject({ cumulativeTimeMs: 0, totalRuns: 0, badgeHistory: [] });
		});
	});
});
__maestroMicrobenchDescribe('sessionImageRefs', () => {
	const SHA = 'a'.repeat(64);

	describe('sessionImageRefs', () => {
		it('recognizes a store reference and nothing else', () => {
			expect(isSessionImageRef(`${SESSION_IMAGE_REF_PREFIX}${SHA}.png`)).toBe(true);
			expect(isSessionImageRef('data:image/png;base64,AAAA')).toBe(false);
			expect(isSessionImageRef('https://example.com/a.png')).toBe(false);
			expect(isSessionImageRef(undefined)).toBe(false);
			expect(isSessionImageRef(42)).toBe(false);
		});

		it('returns the basename of a well-formed reference', () => {
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.png`)).toBe(`${SHA}.png`);
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.jpeg`)).toBe(`${SHA}.jpeg`);
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.svg`)).toBe(`${SHA}.svg`);
		});

		it('rejects anything the store would never have written', () => {
			// Traversal
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}../../etc/passwd`)).toBeNull();
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.png/../x.png`)).toBeNull();
			// Wrong hash shape
			expect(
				sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${'A'.repeat(64)}.png`)
			).toBeNull();
			expect(
				sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${'a'.repeat(63)}.png`)
			).toBeNull();
			// Unknown extension
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.exe`)).toBeNull();
			expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}`)).toBeNull();
			// Not a reference at all
			expect(sessionImageRefBasename('data:image/png;base64,AAAA')).toBeNull();
			expect(sessionImageRefBasename(null)).toBeNull();
		});

		it('builds the token-scoped HTTP path under apiBase', () => {
			expect(sessionImageHttpPath('/tok/api', `${SHA}.png`)).toBe(`/tok/api/images/${SHA}.png`);
			// A trailing slash on apiBase does not double up.
			expect(sessionImageHttpPath('/tok/api/', `${SHA}.png`)).toBe(`/tok/api/images/${SHA}.png`);
		});
	});
});
