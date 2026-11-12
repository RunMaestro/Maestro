import { describe, expect, it } from 'vitest';
import { splitDigestBody } from '../../../shared/computer-history/digestBody';

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
