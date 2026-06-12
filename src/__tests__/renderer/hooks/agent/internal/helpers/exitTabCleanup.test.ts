import { describe, it, expect } from 'vitest';
import {
	removeHiddenProgressLog,
	applyExitThinkingPolicy,
	cleanupExitedTabLogs,
} from '../../../../../../renderer/hooks/agent/internal/helpers/exitTabCleanup';
import type { LogEntry } from '../../../../../../renderer/types';
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
	});
});
