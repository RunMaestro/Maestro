import { describe, expect, it } from 'vitest';
import {
	validateDocumentReferences,
	validateGitHubUrl,
	validateRepoSlug,
} from '../../../../main/ipc/handlers/symphony-document-validation';
import { buildSymphonyGitHubHeaders } from '../../../../main/ipc/handlers/symphony-github-headers';

describe('Symphony document reference validation', () => {
	it.each([
		'../secrets.md',
		'docs/../../secrets.md',
		'docs/%2e%2e/secrets.md',
		'/etc/passwd',
		'\\\\server\\share\\secrets.md',
		'C:\\secrets.md',
		'docs\\..\\secrets.md',
	])('rejects unsafe repository document path %s', (documentPath) => {
		expect(
			validateDocumentReferences([{ name: 'document.md', path: documentPath, isExternal: false }])
		).toEqual({ valid: false, error: `Invalid document path: ${documentPath}` });
	});

	it('accepts a repository-relative document path', () => {
		expect(
			validateDocumentReferences([
				{ name: 'document.md', path: 'docs/contribution.md', isExternal: false },
			])
		).toEqual({ valid: true });
	});

	it.each([
		'https://github.com/owner/repo/files/document.md',
		'https://raw.githubusercontent.com/owner/repo/main/document.md',
		'https://user-images.githubusercontent.com/1/document.png',
		'https://camo.githubusercontent.com/hash/document.png',
	])('accepts allowed GitHub document host %s', (url) => {
		expect(
			validateDocumentReferences([{ name: 'document.md', path: url, isExternal: true }])
		).toEqual({
			valid: true,
		});
	});

	it.each(['http://github.com/owner/repo/document.md', 'https://github.example/document.md'])(
		'rejects untrusted external document URL %s',
		(url) => {
			expect(
				validateDocumentReferences([{ name: 'document.md', path: url, isExternal: true }])
			).toEqual(expect.objectContaining({ valid: false }));
		}
	);

	it('keeps repository URL and slug validation separate', () => {
		expect(validateGitHubUrl('https://github.com/owner/repo')).toEqual({ valid: true });
		expect(validateRepoSlug('owner/repo')).toEqual({ valid: true });
	});
});

describe('Symphony GitHub request headers', () => {
	it('builds exact anonymous defaults', () => {
		expect(buildSymphonyGitHubHeaders()).toEqual({
			Accept: 'application/vnd.github.v3+json',
			'User-Agent': 'Maestro-Symphony',
		});
	});

	it('adds optional auth without changing defaults', () => {
		expect(buildSymphonyGitHubHeaders(undefined, 'token')).toEqual({
			Accept: 'application/vnd.github.v3+json',
			'User-Agent': 'Maestro-Symphony',
			Authorization: 'Bearer token',
		});
	});

	it('preserves caller headers and explicit defaults', () => {
		expect(
			buildSymphonyGitHubHeaders(
				{
					Accept: 'application/vnd.github.raw+json',
					'Content-Type': 'application/json',
					'If-None-Match': '"etag"',
					Authorization: 'token caller',
				},
				'token'
			)
		).toEqual({
			Accept: 'application/vnd.github.raw+json',
			'Content-Type': 'application/json',
			'If-None-Match': '"etag"',
			Authorization: 'token caller',
			'User-Agent': 'Maestro-Symphony',
		});
	});
});
