import { describe, it, expect } from 'vitest';
import {
	removeHiddenProgressLog,
	applyExitThinkingPolicy,
	cleanupExitedTabLogs,
} from '../../../../../../renderer/hooks/agent/internal/helpers/exitTabCleanup';
import type { LogEntry } from '../../../../../../renderer/types';
import { turnFateAfter } from '../../../../../../shared/maestro-lib/agents/rules';
import { buildHiddenProgressLogId } from '../../../../../../renderer/utils/hiddenProgress';

function log(partial: Partial<LogEntry> & { id: string }): LogEntry {
	return {
		timestamp: 1700000000000,
		source: 'stdout',
		text: '',
		...partial,
	} as LogEntry;
}

describe('exitTabCleanup helpers', () => {
	describe('removeHiddenProgressLog', () => {
		it('removes the hidden-progress log for the given tab', () => {
			const hiddenId = buildHiddenProgressLogId('tab-1');
			const logs = [log({ id: hiddenId, source: 'system' }), log({ id: 'a', source: 'ai' })];
			const out = removeHiddenProgressLog(logs, 'tab-1');
			expect(out).toEqual([logs[1]]);
		});

		it('returns the same array reference when no hidden-progress log present (no allocation)', () => {
			const logs = [log({ id: 'a' }), log({ id: 'b' })];
			const out = removeHiddenProgressLog(logs, 'tab-1');
			expect(out).toBe(logs);
		});
	});

	describe('applyExitThinkingPolicy', () => {
		it("'sticky' returns logs unchanged (referential identity)", () => {
			const logs = [log({ id: 'a', source: 'thinking' }), log({ id: 'b', source: 'tool' })];
			const out = applyExitThinkingPolicy(logs, { showThinking: 'sticky' });
			expect(out).toBe(logs);
		});

		it("'on' drops thinking and tool entries", () => {
			const logs = [
				log({ id: 'a', source: 'thinking' }),
				log({ id: 'b', source: 'tool' }),
				log({ id: 'c', source: 'ai' }),
			];
			const out = applyExitThinkingPolicy(logs, { showThinking: 'on' });
			expect(out.map((l) => l.id)).toEqual(['c']);
		});

		it("'off' (the default) drops thinking and tool entries", () => {
			const logs = [log({ id: 'a', source: 'thinking' }), log({ id: 'b', source: 'ai' })];
			const out = applyExitThinkingPolicy(logs, {});
			expect(out.map((l) => l.id)).toEqual(['b']);
		});

		it('returns same array reference when nothing to drop', () => {
			const logs = [log({ id: 'a', source: 'ai' }), log({ id: 'b', source: 'user' })];
			const out = applyExitThinkingPolicy(logs, { showThinking: 'on' });
			expect(out).toBe(logs);
		});
	});

	describe('cleanupExitedTabLogs', () => {
		it('chains hidden-progress removal with thinking-policy drop', () => {
			const hiddenId = buildHiddenProgressLogId('tab-1');
			const logs = [
				log({ id: hiddenId, source: 'system' }),
				log({ id: 'a', source: 'thinking' }),
				log({ id: 'b', source: 'ai' }),
			];
			const out = cleanupExitedTabLogs(logs, 'tab-1', { showThinking: 'on' });
			expect(out.map((l) => l.id)).toEqual(['b']);
		});

		it("'sticky' keeps thinking/tool logs but still strips hidden-progress placeholder", () => {
			const hiddenId = buildHiddenProgressLogId('tab-1');
			const logs = [log({ id: hiddenId, source: 'system' }), log({ id: 'a', source: 'thinking' })];
			const out = cleanupExitedTabLogs(logs, 'tab-1', { showThinking: 'sticky' });
			expect(out.map((l) => l.id)).toEqual(['a']);
		});

		// Parity R36: a desktop host stamps the end of the turn whose process exited, so a client
		// asking whether a message ran tells an ended turn from one the host lost mid-stream.
		it("stamps the turn's end on the last entry kept, once", () => {
			const logs = [
				log({ id: 'u', source: 'user' }),
				log({ id: 'b', source: 'stdout' }),
				log({ id: 'c', source: 'thinking' }),
			];
			const out = cleanupExitedTabLogs(logs, 'tab-1', { showThinking: 'on' });
			expect(out.map((l) => [l.id, l.turnEnded === true])).toEqual([
				['u', false],
				['b', true],
			]);
			// A second exit with nothing new keeps the turn answered.
			const again = cleanupExitedTabLogs(out, 'tab-1', { showThinking: 'on' });
			expect(turnFateAfter(again, 0, 'desktop')).toBe('answered');
		});

		// CodeRabbit on #2167: a sticky turn that ended on a tool card keeps its stamp on an entry a
		// later exit in 'on' mode (which drops every thinking and tool card) does not remove.
		it('keeps an earlier turn stamped when a later exit drops its thinking and tool cards', () => {
			const sticky = cleanupExitedTabLogs(
				[log({ id: 'u1', source: 'user' }), log({ id: 't1', source: 'tool' })],
				'tab-1',
				{ showThinking: 'sticky' }
			);
			const later = cleanupExitedTabLogs(
				[...sticky, log({ id: 'u2', source: 'user' }), log({ id: 'a2', source: 'stdout' })],
				'tab-1',
				{ showThinking: 'on' }
			);
			expect(later.map((l) => [l.id, l.turnEnded === true])).toEqual([
				['u1', true],
				['u2', false],
				['a2', true],
			]);
		});

		// Parity R63 (a): the first turn ended on the queued steer (its last entry); the steer's own
		// follow-up then exits with nothing that stays. Its end goes on the steer as that follow-up's
		// message, never on the first message again, so the steer reads answered, not unended.
		it("stamps a queued steer's empty follow-up on the steer, after the earlier turn ended on it", () => {
			const steer = log({
				id: 's',
				source: 'user',
				steered: true,
				steerState: 'queued',
			});
			const first = cleanupExitedTabLogs(
				[log({ id: 'u', source: 'user' }), log({ id: 'a', source: 'stdout' }), steer],
				'tab-1',
				{ showThinking: 'on' }
			);
			expect(first.map((l) => [l.id, l.turnEnded === true])).toEqual([
				['u', false],
				['a', false],
				['s', true],
			]);
			expect(turnFateAfter(first, 2, 'desktop')).toBe('unended');
			const followUp = cleanupExitedTabLogs(
				[...first, log({ id: 'k', source: 'thinking' })],
				'tab-1',
				{ showThinking: 'on' }
			);
			expect(followUp[0].turnEnded).toBeUndefined();
			expect(followUp[2]).toMatchObject({ turnEnded: true, steerTurnEnded: true });
			expect(turnFateAfter(followUp, 0, 'desktop')).toBe('answered');
			expect(turnFateAfter(followUp, 2, 'desktop')).toBe('answered');
		});
	});
});
