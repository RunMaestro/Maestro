/**
 * Tests for DataviewJS trust (src/shared/dataview/trust.ts, D3, DV-12, DV-14): the run policy every
 * `dataviewjs` block decides by, how a vault root is matched against `dataviewJsTrustedRoots`, and the list
 * edits the trust verbs make.
 */

import { describe, expect, it } from 'vitest';
import {
	cleanTrustedRoots,
	dataviewJsRunPolicy,
	isTrustableDataviewRoot,
	isTrustedDataviewRoot,
	normalizeTrustedRoot,
	withTrustedRoot,
	withoutTrustedRoot,
	type DataviewJsRunPolicyInput,
} from '../../../shared/dataview';

describe('dataviewJsRunPolicy', () => {
	const trusted: DataviewJsRunPolicyInput = {
		encoreOn: true,
		jsEnabled: true,
		trustedRoots: ['/Users/me/Vault'],
		root: '/Users/me/Vault',
		isWebDesktop: false,
	};

	it('runs in a trusted vault on the desktop', () => {
		expect(dataviewJsRunPolicy(trusted)).toBe('run');
		expect(dataviewJsRunPolicy({ ...trusted, root: '/Users/me/Vault/' })).toBe('run');
	});

	it('is disabled while the Encore Feature or the DataviewJS setting is off, whatever else holds', () => {
		expect(dataviewJsRunPolicy({ ...trusted, encoreOn: false })).toBe('disabled');
		expect(dataviewJsRunPolicy({ ...trusted, jsEnabled: false })).toBe('disabled');
		expect(dataviewJsRunPolicy({ ...trusted, encoreOn: false, isWebDesktop: true })).toBe(
			'disabled'
		);
		expect(dataviewJsRunPolicy({ ...trusted, jsEnabled: false, isWebDesktop: true })).toBe(
			'disabled'
		);
	});

	it('is desktop-only in the browser build, even in a trusted vault', () => {
		expect(dataviewJsRunPolicy({ ...trusted, isWebDesktop: true })).toBe('desktop-only');
		expect(dataviewJsRunPolicy({ ...trusted, isWebDesktop: true, trustedRoots: [] })).toBe(
			'desktop-only'
		);
	});

	it('asks in a vault that is not trusted', () => {
		expect(dataviewJsRunPolicy({ ...trusted, trustedRoots: [] })).toBe('ask');
		expect(dataviewJsRunPolicy({ ...trusted, root: '/Users/me/Other' })).toBe('ask');
		expect(dataviewJsRunPolicy({ ...trusted, root: '/Users/me/Vault/Sub' })).toBe('ask');
	});

	it('asks while the root is not known yet', () => {
		expect(dataviewJsRunPolicy({ ...trusted, root: null })).toBe('ask');
	});
});

describe('isTrustableDataviewRoot', () => {
	it('accepts absolute POSIX and Windows paths', () => {
		expect(isTrustableDataviewRoot('/Users/me/Vault')).toBe(true);
		expect(isTrustableDataviewRoot('  /Users/me/Vault/ ')).toBe(true);
		expect(isTrustableDataviewRoot('C:\\Vault')).toBe(true);
		expect(isTrustableDataviewRoot('/')).toBe(true);
	});

	it('refuses relative paths, empty text, and values that are not strings', () => {
		expect(isTrustableDataviewRoot('Vault')).toBe(false);
		expect(isTrustableDataviewRoot('./Vault')).toBe(false);
		expect(isTrustableDataviewRoot('~/Vault')).toBe(false);
		expect(isTrustableDataviewRoot('')).toBe(false);
		expect(isTrustableDataviewRoot('   ')).toBe(false);
		expect(isTrustableDataviewRoot(null)).toBe(false);
		expect(isTrustableDataviewRoot(['/v'])).toBe(false);
	});
});

describe('trust list edits', () => {
	it('cleans a stored list: strings only, normalized, no empties or repeats', () => {
		expect(cleanTrustedRoots(['/a/', ' /a', '', '  ', null, 3, '/b', '/b//'])).toEqual([
			'/a',
			'/b',
		]);
	});

	it('appends a new root once', () => {
		expect(withTrustedRoot(['/a'], '/b/')).toEqual(['/a', '/b']);
		expect(withTrustedRoot(['/a', '/b'], '/b')).toEqual(['/a', '/b']);
		expect(withTrustedRoot(['/a/'], '/a')).toEqual(['/a']);
		expect(withTrustedRoot(['/a'], '  ')).toEqual(['/a']);
	});

	it('removes every spelling of a root and nothing else', () => {
		expect(withoutTrustedRoot(['/a', '/a/', '/ab', '/a/b'], '/a')).toEqual(['/ab', '/a/b']);
		expect(withoutTrustedRoot(['/a'], '/missing')).toEqual(['/a']);
	});
});

describe('normalizeTrustedRoot', () => {
	it('drops surrounding whitespace and trailing separators', () => {
		expect(normalizeTrustedRoot('  /Users/me/Vault/  ')).toBe('/Users/me/Vault');
		expect(normalizeTrustedRoot('/Users/me/Vault//')).toBe('/Users/me/Vault');
		expect(normalizeTrustedRoot('C:\\Vault\\')).toBe('C:\\Vault');
	});

	it('keeps a filesystem root whole', () => {
		expect(normalizeTrustedRoot('/')).toBe('/');
		expect(normalizeTrustedRoot('//')).toBe('/');
		expect(normalizeTrustedRoot('C:\\')).toBe('C:\\');
		expect(normalizeTrustedRoot('C:\\\\')).toBe('C:\\');
		expect(normalizeTrustedRoot('')).toBe('');
	});
});

describe('isTrustedDataviewRoot', () => {
	it('matches a listed root, however its trailing separator is spelled', () => {
		expect(isTrustedDataviewRoot('/Users/me/Vault', ['/Users/me/Vault/'])).toBe(true);
		expect(isTrustedDataviewRoot('/Users/me/Vault/', ['/Users/me/Vault'])).toBe(true);
	});

	it('never trusts a parent, a child, a sibling with a shared prefix, or another case', () => {
		const trusted = ['/Users/me/Vault'];
		expect(isTrustedDataviewRoot('/Users/me', trusted)).toBe(false);
		expect(isTrustedDataviewRoot('/Users/me/Vault/Sub', trusted)).toBe(false);
		expect(isTrustedDataviewRoot('/Users/me/Vault2', trusted)).toBe(false);
		expect(isTrustedDataviewRoot('/users/me/vault', trusted)).toBe(false);
	});

	it('trusts nothing for an empty list, an empty root, or entries that are not strings', () => {
		expect(isTrustedDataviewRoot('/Users/me/Vault', [])).toBe(false);
		expect(isTrustedDataviewRoot('', [''])).toBe(false);
		expect(isTrustedDataviewRoot('  ', ['  '])).toBe(false);
		expect(isTrustedDataviewRoot('/v', [null, 1, { root: '/v' }, ['/v']])).toBe(false);
	});
});
