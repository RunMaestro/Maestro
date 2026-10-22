import { describe, expect, it } from 'vitest';
import {
	ROLLUP_HOURS,
	SEGMENT_MINUTES,
	SEGMENT_MS,
	digestRelativePath,
	parseDigestRelativePath,
	parseSegmentRelativePath,
	rollupBlockStartMs,
	rollupDigestRelativePath,
	segmentRelativePath,
	segmentStartMs,
} from '../../../shared/computer-history/paths';

const at = (iso: string) => Date.parse(iso);

describe('15-minute segments', () => {
	it('windows start at :00, :15, :30, :45 UTC', () => {
		expect(SEGMENT_MINUTES).toBe(15);
		expect(SEGMENT_MS).toBe(900_000);
		expect(segmentStartMs(at('2026-10-03T14:14:59.999Z'))).toBe(at('2026-10-03T14:00:00Z'));
		expect(segmentStartMs(at('2026-10-03T14:15:00.000Z'))).toBe(at('2026-10-03T14:15:00Z'));
		expect(segmentStartMs(at('2026-10-03T14:59:59.000Z'))).toBe(at('2026-10-03T14:45:00Z'));
		expect(segmentRelativePath(segmentStartMs(at('2026-10-03T14:31:00Z')))).toBe(
			'segments/2026-10-03/1430Z.jsonl'
		);
		expect(digestRelativePath(at('2026-10-03T14:30:00Z'))).toBe('digests/2026-10-03/1430Z.md');
	});

	it('still parses any HHMM, so an old 10-minute file never breaks reading', () => {
		expect(parseSegmentRelativePath('segments/2026-10-03/1410Z.jsonl')).toBe(
			at('2026-10-03T14:10:00Z')
		);
		expect(parseSegmentRelativePath('segments/2026-10-03/1415Z.jsonl')).toBe(
			at('2026-10-03T14:15:00Z')
		);
	});
});

describe('6-hour roll-ups', () => {
	it('blocks are UTC-aligned at 00, 06, 12, 18', () => {
		expect(ROLLUP_HOURS).toBe(6);
		expect(rollupBlockStartMs(at('2026-10-03T05:59:59Z'))).toBe(at('2026-10-03T00:00:00Z'));
		expect(rollupBlockStartMs(at('2026-10-03T06:00:00Z'))).toBe(at('2026-10-03T06:00:00Z'));
		expect(rollupBlockStartMs(at('2026-10-03T23:10:00Z'))).toBe(at('2026-10-03T18:00:00Z'));
	});

	it('roll-up path and parse', () => {
		const block = at('2026-10-03T12:00:00Z');
		expect(rollupDigestRelativePath(block)).toBe('digests/2026-10-03/6h-1200Z.md');
		expect(parseDigestRelativePath('digests/2026-10-03/6h-1200Z.md')).toEqual({
			kind: '6h',
			startMs: block,
		});
		expect(parseDigestRelativePath('digests/2026-10-03/1215Z.md')).toEqual({
			kind: '15m',
			startMs: at('2026-10-03T12:15:00Z'),
		});
		expect(parseDigestRelativePath('digests/2026-10-03/notes.md')).toBeNull();
		expect(parseDigestRelativePath('segments/2026-10-03/1215Z.jsonl')).toBeNull();
	});
});
