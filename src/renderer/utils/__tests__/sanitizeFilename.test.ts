import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../sanitizeFilename';

describe('sanitizeFilename', () => {
	it('replaces separators and Windows-invalid characters without losing Unicode', () => {
		expect(sanitizeFilename('計画/phase:1?.md')).toBe('計画-phase�1�.md');
		expect(sanitizeFilename('folder\\résumé|draft.md')).toBe('folder-résumé�draft.md');
	});

	it('removes traversal and trims Windows-incompatible trailing dots and spaces', () => {
		expect(sanitizeFilename('  ...report..draft.md.  ')).toBe('reportdraft.md');
		expect(sanitizeFilename('.hidden')).toBe('hidden');
	});

	it('uses the fallback for empty and Windows-reserved names', () => {
		expect(sanitizeFilename('')).toBe('document');
		expect(sanitizeFilename('...')).toBe('document');
		expect(sanitizeFilename('CON.txt')).toBe('document');
		expect(sanitizeFilename('lpt9')).toBe('document');
	});

	it('limits filenames to 255 Unicode code points', () => {
		const filename = `計${'a'.repeat(300)}`;
		const sanitized = sanitizeFilename(filename);

		expect(Array.from(sanitized)).toHaveLength(255);
		expect(sanitized).toBe(`計${'a'.repeat(254)}`);
	});
});
