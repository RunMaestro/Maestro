import { describe, it, expect } from 'vitest';
import {
	resolveFileReference,
	stripLineColumnSuffix,
} from '../../../../renderer/utils/fileLinks/resolve';

describe('stripLineColumnSuffix', () => {
	it('drops a line suffix', () => {
		expect(stripLineColumnSuffix('src/foo.ts:42')).toBe('src/foo.ts');
	});

	it('drops a line:column suffix', () => {
		expect(stripLineColumnSuffix('src/foo.ts:42:7')).toBe('src/foo.ts');
	});

	it('leaves a path with no suffix alone', () => {
		expect(stripLineColumnSuffix('src/foo.ts')).toBe('src/foo.ts');
	});
});

describe('resolveFileReference', () => {
	it('joins a project-relative reference onto the root', () => {
		expect(resolveFileReference('/Users/p/Vault', 'Claude/Reminders Archive.md')).toBe(
			'/Users/p/Vault/Claude/Reminders Archive.md'
		);
	});

	it('uses an absolute reference verbatim', () => {
		expect(resolveFileReference('/Users/p/Vault', '/tmp/other.md')).toBe('/tmp/other.md');
	});

	it('uses a Windows absolute reference verbatim', () => {
		expect(resolveFileReference('C:\\Repo', 'C:\\elsewhere\\file.md')).toBe(
			'C:\\elsewhere\\file.md'
		);
	});

	it('joins with the separator the root already speaks', () => {
		expect(resolveFileReference('C:\\Repo', 'docs\\file.md')).toBe('C:\\Repo\\docs\\file.md');
	});

	it('strips a line suffix before resolving', () => {
		expect(resolveFileReference('/root', 'src/foo.ts:42')).toBe('/root/src/foo.ts');
	});

	it('collapses a trailing root separator at the join', () => {
		expect(resolveFileReference('/root/', 'nested/file.md')).toBe('/root/nested/file.md');
	});

	it('trims surrounding whitespace before resolving', () => {
		expect(resolveFileReference('/root', '  docs/file.md  ')).toBe('/root/docs/file.md');
	});
});
