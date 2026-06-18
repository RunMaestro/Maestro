import { describe, expect, it } from 'vitest';
import { parseJsonWithBom, stripJsonBom } from '../../shared/jsonUtils';

describe('jsonUtils', () => {
	it('strips a leading UTF-8 BOM', () => {
		expect(stripJsonBom('\uFEFF{"ok":true}')).toBe('{"ok":true}');
	});

	it('does not strip non-leading BOM characters', () => {
		expect(stripJsonBom('{"value":"\uFEFF"}')).toBe('{"value":"\uFEFF"}');
	});

	it('parses BOM-prefixed JSON', () => {
		expect(parseJsonWithBom<{ ok: boolean }>('\uFEFF{"ok":true}')).toEqual({ ok: true });
	});
});
