import { describe, expect, it } from 'vitest';
import {
	captureTypographySnapshot,
	parseTypographySnapshot,
	typographySnapshotMatches,
	typographySnapshotPatch,
} from '../../shared/typographySnapshot';
import { TYPOGRAPHY_SURFACE_LIST, INHERIT_TERMINAL } from '../../shared/typography';

const LIVE = {
	fontFamily: 'Inter',
	terminalFontFamily: 'JetBrains Mono',
	chatFontFamily: '',
	filePreviewFontFamily: INHERIT_TERMINAL,
	fileEditorFontFamily: 'Fira Code',
	documentGraphFontFamily: '',
	fontSize: 15,
	terminalFontSize: 13,
	chatFontSize: 0,
	filePreviewFontSize: 0,
	fileEditorFontSize: 12,
	documentGraphFontSize: 0,
};

describe('captureTypographySnapshot', () => {
	it('captures every registered surface, so a new surface cannot be silently dropped', () => {
		const snapshot = captureTypographySnapshot(LIVE, 1000);
		expect(snapshot.savedAt).toBe(1000);
		for (const spec of TYPOGRAPHY_SURFACE_LIST) {
			expect(snapshot.fonts).toHaveProperty(spec.fontKey);
			expect(snapshot.sizes).toHaveProperty(spec.sizeKey);
		}
	});

	it('preserves the inherit sentinels rather than resolving them', () => {
		const snapshot = captureTypographySnapshot(LIVE);
		expect(snapshot.fonts.chatFontFamily).toBe('');
		expect(snapshot.fonts.filePreviewFontFamily).toBe(INHERIT_TERMINAL);
		expect(snapshot.sizes.chatFontSize).toBe(0);
	});

	it('never captures a zero interface size, which would mean "inherit from myself"', () => {
		const snapshot = captureTypographySnapshot({ ...LIVE, fontSize: 0 });
		expect(snapshot.sizes.fontSize).toBe(14);
	});

	it('round-trips through the restore patch unchanged', () => {
		const snapshot = captureTypographySnapshot(LIVE);
		expect(typographySnapshotPatch(snapshot)).toMatchObject({
			fontFamily: 'Inter',
			terminalFontFamily: 'JetBrains Mono',
			filePreviewFontFamily: INHERIT_TERMINAL,
			fontSize: 15,
			fileEditorFontSize: 12,
		});
		expect(typographySnapshotMatches(snapshot, LIVE)).toBe(true);
	});
});

describe('parseTypographySnapshot', () => {
	it('rejects values that are not a snapshot', () => {
		expect(parseTypographySnapshot(null)).toBeNull();
		expect(parseTypographySnapshot('hacker')).toBeNull();
		expect(parseTypographySnapshot({})).toBeNull();
		expect(parseTypographySnapshot({ fonts: {}, sizes: {} })).toBeNull();
	});

	it('drops unknown keys and non-string families a hand-edited file could carry', () => {
		const parsed = parseTypographySnapshot({
			savedAt: 5,
			fonts: { fontFamily: 'Inter', bogusFontFamily: 'Nope', terminalFontFamily: 42 },
			sizes: { fontSize: 15, bogusFontSize: 9, chatFontSize: 'big' },
		});
		expect(parsed).toEqual({
			savedAt: 5,
			fonts: { fontFamily: 'Inter' },
			sizes: { fontSize: 15 },
		});
	});

	it('defaults a missing savedAt rather than rejecting an otherwise usable save', () => {
		const parsed = parseTypographySnapshot({ fonts: { fontFamily: 'Inter' }, sizes: {} });
		expect(parsed?.savedAt).toBe(0);
		expect(parsed?.fonts.fontFamily).toBe('Inter');
	});
});

describe('typographySnapshotPatch', () => {
	it('writes only the surfaces the save knows about', () => {
		// A snapshot taken before the document graph surface existed must not
		// blank that surface's font on restore.
		const parsed = parseTypographySnapshot({
			savedAt: 1,
			fonts: { fontFamily: 'Inter' },
			sizes: { fontSize: 15 },
		});
		expect(typographySnapshotPatch(parsed!)).toEqual({ fontFamily: 'Inter', fontSize: 15 });
	});

	it('clamps a size that was persisted out of range', () => {
		const parsed = parseTypographySnapshot({
			savedAt: 1,
			fonts: { fontFamily: 'Inter' },
			sizes: { fontSize: 999, chatFontSize: 999 },
		});
		expect(typographySnapshotPatch(parsed!)).toMatchObject({ fontSize: 32, chatFontSize: 32 });
	});
});

describe('typographySnapshotMatches', () => {
	it('is false with nothing saved', () => {
		expect(typographySnapshotMatches(null, LIVE)).toBe(false);
	});

	it('notices a single changed family or size', () => {
		const snapshot = captureTypographySnapshot(LIVE);
		expect(typographySnapshotMatches(snapshot, { ...LIVE, chatFontFamily: 'Georgia' })).toBe(false);
		expect(typographySnapshotMatches(snapshot, { ...LIVE, fileEditorFontSize: 13 })).toBe(false);
	});

	it('ignores settings the snapshot does not cover, such as zoom', () => {
		const snapshot = captureTypographySnapshot(LIVE);
		expect(typographySnapshotMatches(snapshot, { ...LIVE, fontZoom: 1.4 })).toBe(true);
	});
});
