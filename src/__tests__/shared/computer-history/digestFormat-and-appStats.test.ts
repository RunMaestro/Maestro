import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { DIGEST_ACCURACY_RULES } from '../../../shared/computer-history/digestFormat';
import { DIGEST_SECTIONS } from '../../../shared/computer-history/digestFormat';
import { MAX_DIGEST_BULLETS } from '../../../shared/computer-history/digestFormat';
import { MAX_ROLLUP_BULLETS } from '../../../shared/computer-history/digestFormat';
import { digestFormatInstructions } from '../../../shared/computer-history/digestFormat';
import { formatDigestSources } from '../../../shared/computer-history/digestFormat';
import { APP_TIME_IDLE_CAP_MS } from '../../../shared/computer-history/appStats';
import { addEventToAppStats } from '../../../shared/computer-history/appStats';
import { appStatsIndexFields } from '../../../shared/computer-history/appStats';
import { createAppStats } from '../../../shared/computer-history/appStats';
import { splitDigestBody } from '../../../shared/computer-history/digestBody';
import { ROLLUP_HOURS } from '../../../shared/computer-history/paths';
import { SEGMENT_MINUTES } from '../../../shared/computer-history/paths';
import { SEGMENT_MS } from '../../../shared/computer-history/paths';
import { digestRelativePath } from '../../../shared/computer-history/paths';
import { parseDigestRelativePath } from '../../../shared/computer-history/paths';
import { parseSegmentRelativePath } from '../../../shared/computer-history/paths';
import { rollupBlockStartMs } from '../../../shared/computer-history/paths';
import { rollupDigestRelativePath } from '../../../shared/computer-history/paths';
import { segmentRelativePath } from '../../../shared/computer-history/paths';
import { segmentStartMs } from '../../../shared/computer-history/paths';
__maestroMicrobenchDescribe('digestFormat', () => {
	// Built from code points so no formatter can turn the escapes into the characters.
	const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

	describe('digestFormatInstructions', () => {
		it('asks for a title, a one-sentence lede, and the three sections in order', () => {
			for (const kind of ['15m', '6h'] as const) {
				const text = digestFormatInstructions(kind);
				const threads = text.indexOf(`### ${DIGEST_SECTIONS.threads}`);
				const open = text.indexOf(`### ${DIGEST_SECTIONS.open}`);
				const context = text.indexOf(`### ${DIGEST_SECTIONS.context}`);
				expect(text).toMatch(/\*\*<a title/);
				expect(threads).toBeGreaterThan(0);
				expect(open).toBeGreaterThan(threads);
				expect(context).toBeGreaterThan(open);
				expect(text).toContain('- None seen.');
				expect(text).not.toMatch(DASHES);
			}
		});

		it('caps bullets per kind and asks a roll-up for end-of-block state', () => {
			expect(digestFormatInstructions('15m')).toContain(`at most ${MAX_DIGEST_BULLETS} bullets`);
			expect(digestFormatInstructions('6h')).toContain(`at most ${MAX_ROLLUP_BULLETS} bullets`);
			expect(digestFormatInstructions('15m')).toContain('15 minutes');
			expect(digestFormatInstructions('6h')).toContain('end of the block');
		});

		it('names the accuracy mistakes small models make', () => {
			expect(DIGEST_ACCURACY_RULES).toMatch(/report what they wrote/);
			expect(DIGEST_ACCURACY_RULES).toMatch(/not an app or a window/);
			expect(DIGEST_ACCURACY_RULES).toMatch(/one-time code/);
			expect(DIGEST_ACCURACY_RULES).toMatch(/drafts of one message/);
			expect(DIGEST_ACCURACY_RULES).not.toMatch(DASHES);
		});
	});

	describe('formatDigestSources', () => {
		it('lists store-relative paths under a Sources heading', () => {
			expect(
				formatDigestSources(['digests/2026-11-11/1800Z.md', 'digests/2026-11-11/1815Z.md'])
			).toBe('### Sources\n\n- `digests/2026-11-11/1800Z.md`\n- `digests/2026-11-11/1815Z.md`');
		});

		it('is empty with no sources', () => {
			expect(formatDigestSources([])).toBe('');
		});
	});
});
__maestroMicrobenchDescribe('appStats', () => {
	const T0 = Date.parse('2026-10-03T14:15:00.000Z');
	const at = (ms: number, id?: string, name?: string) => ({
		ts: new Date(T0 + ms).toISOString(),
		...(id ? { app: { id, name } } : {}),
	});

	describe('appStats', () => {
		it('credits each gap to the previous event app, capped, and keeps the latest name', () => {
			const stats = createAppStats();
			addEventToAppStats(stats, at(0, 'slack', 'Slack'));
			addEventToAppStats(stats, at(30_000, 'chrome', 'Chrome'));
			addEventToAppStats(stats, at(30_000 + 20 * 60_000, 'slack', 'Slack 2'));
			const fields = appStatsIndexFields(stats);
			expect(fields.apps).toEqual({ slack: 2, chrome: 1 });
			expect(fields.names).toEqual({ slack: 'Slack 2', chrome: 'Chrome' });
			expect(fields.activeMs).toEqual({ slack: 30_000, chrome: APP_TIME_IDLE_CAP_MS });
		});

		it('an event with no app ends the previous credit and owns nothing after it', () => {
			const stats = createAppStats();
			addEventToAppStats(stats, at(0, 'slack'));
			addEventToAppStats(stats, at(10_000));
			addEventToAppStats(stats, at(50_000, 'slack'));
			expect(stats.activeMs).toEqual({ slack: 10_000 });
			expect(stats.apps).toEqual({ slack: 2 });
		});

		it('ignores an unparseable timestamp and never credits a negative gap', () => {
			const stats = createAppStats();
			addEventToAppStats(stats, at(5_000, 'a'));
			addEventToAppStats(stats, { ts: 'garbage', app: { id: 'b' } });
			addEventToAppStats(stats, at(1_000, 'a'));
			expect(stats.activeMs).toEqual({ a: 0 });
			expect(stats.apps).toEqual({ a: 2 });
		});

		it('index fields are copies', () => {
			const stats = createAppStats();
			addEventToAppStats(stats, at(0, 'a'));
			const fields = appStatsIndexFields(stats);
			addEventToAppStats(stats, at(1_000, 'a'));
			expect(fields.apps).toEqual({ a: 1 });
		});
	});
});
__maestroMicrobenchDescribe('digestBody', () => {
	describe('splitDigestBody', () => {
		it('separates the header and provenance line from the summary', () => {
			const body = [
				'# 15-minute digest 2026-11-11T02:45:00.000Z - 2026-11-11T03:00:00.000Z',
				'',
				'Segment: `segments/2026-11-11/0245Z.jsonl` (92 events). Written by local model `Qwen3.5 4B`.',
				'',
				'- Opened Obsidian.',
				'- Watched a video.',
				'',
			].join('\n');
			expect(splitDigestBody(body)).toEqual({
				provenance:
					'Segment: segments/2026-11-11/0245Z.jsonl (92 events). Written by local model Qwen3.5 4B.',
				summary: '- Opened Obsidian.\n- Watched a video.',
				sources: [],
			});
		});

		it('reads a roll-up header and CRLF line endings', () => {
			const body =
				'# 6-hour roll-up a - b\r\n\r\nFrom 12 15-minute digest(s). Written by agent `x`.\r\n\r\n- Thread one';
			expect(splitDigestBody(body)).toEqual({
				provenance: 'From 12 15-minute digest(s). Written by agent x.',
				summary: '- Thread one',
				sources: [],
			});
		});

		it('returns text without the header whole', () => {
			expect(splitDigestBody('- just bullets\n')).toEqual({
				provenance: null,
				summary: '- just bullets',
				sources: [],
			});
			expect(splitDigestBody('# Notes\n- not a digest header')).toEqual({
				provenance: null,
				summary: '# Notes\n- not a digest header',
				sources: [],
			});
		});

		it('cuts a roll-up Sources footer off the summary', () => {
			const body = [
				'# 6-hour roll-up a - b',
				'',
				'From 2 15-minute digest(s). Written by agent `x`.',
				'',
				'**Release work**',
				'',
				'### Threads',
				'- **Release:** shipped.',
				'',
				'### Sources',
				'',
				'- `digests/2026-11-11/1800Z.md`',
				'- `digests/2026-11-11/1815Z.md`',
				'',
			].join('\n');
			expect(splitDigestBody(body)).toEqual({
				provenance: 'From 2 15-minute digest(s). Written by agent x.',
				summary: '**Release work**\n\n### Threads\n- **Release:** shipped.',
				sources: ['digests/2026-11-11/1800Z.md', 'digests/2026-11-11/1815Z.md'],
			});
		});

		it('keeps a Sources section the writer wrote itself', () => {
			const body = '# 6-hour roll-up a - b\n\n### Sources\n- the vendor datasheet';
			expect(splitDigestBody(body).summary).toBe('### Sources\n- the vendor datasheet');
			expect(splitDigestBody(body).sources).toEqual([]);
		});
	});
});
__maestroMicrobenchDescribe('paths', () => {
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
});
