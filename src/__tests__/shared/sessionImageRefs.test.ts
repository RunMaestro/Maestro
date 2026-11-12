/**
 * Tests for the shared session image reference grammar.
 *
 * Three runtimes parse `maestro-image://store/<sha>.<ext>` (the main-process
 * store, the renderer's web src resolver, and the web server route). These
 * pin the grammar they share, especially the traversal guard.
 */

import { describe, it, expect } from 'vitest';
import {
	SESSION_IMAGE_REF_PREFIX,
	isSessionImageRef,
	sessionImageRefBasename,
	sessionImageHttpPath,
} from '../../shared/sessionImageRefs';

const SHA = 'a'.repeat(64);

describe('sessionImageRefs', () => {
	it('recognizes a store reference and nothing else', () => {
		expect(isSessionImageRef(`${SESSION_IMAGE_REF_PREFIX}${SHA}.png`)).toBe(true);
		expect(isSessionImageRef('data:image/png;base64,AAAA')).toBe(false);
		expect(isSessionImageRef('https://example.com/a.png')).toBe(false);
		expect(isSessionImageRef(undefined)).toBe(false);
		expect(isSessionImageRef(42)).toBe(false);
	});

	it('returns the basename of a well-formed reference', () => {
		expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.png`)).toBe(`${SHA}.png`);
		expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.jpeg`)).toBe(`${SHA}.jpeg`);
		expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.svg`)).toBe(`${SHA}.svg`);
	});

	it('rejects anything the store would never have written', () => {
		// Traversal
		expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}../../etc/passwd`)).toBeNull();
		expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.png/../x.png`)).toBeNull();
		// Wrong hash shape
		expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${'A'.repeat(64)}.png`)).toBeNull();
		expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${'a'.repeat(63)}.png`)).toBeNull();
		// Unknown extension
		expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}.exe`)).toBeNull();
		expect(sessionImageRefBasename(`${SESSION_IMAGE_REF_PREFIX}${SHA}`)).toBeNull();
		// Not a reference at all
		expect(sessionImageRefBasename('data:image/png;base64,AAAA')).toBeNull();
		expect(sessionImageRefBasename(null)).toBeNull();
	});

	it('builds the token-scoped HTTP path under apiBase', () => {
		expect(sessionImageHttpPath('/tok/api', `${SHA}.png`)).toBe(`/tok/api/images/${SHA}.png`);
		// A trailing slash on apiBase does not double up.
		expect(sessionImageHttpPath('/tok/api/', `${SHA}.png`)).toBe(`/tok/api/images/${SHA}.png`);
	});
});
