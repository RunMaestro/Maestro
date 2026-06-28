/**
 * @file panel-navigation.test.ts
 * @description The subframe egress guard that closes the plugin-panel
 * self-navigation residual: a sandboxed `srcDoc` subframe must never navigate away
 * from its initial document (the only egress stays the brokered bridge), while the
 * top frame is governed separately by `will-navigate`.
 */

import { describe, it, expect } from 'vitest';
import { blocksSubframeNavigation } from '../../../shared/plugins/panel-navigation';

describe('blocksSubframeNavigation', () => {
	it('never blocks the top frame (will-navigate owns it)', () => {
		expect(blocksSubframeNavigation(true, 'https://evil.example/?d=secret')).toBe(false);
		expect(blocksSubframeNavigation(true, 'app://app/index.html')).toBe(false);
	});

	it('allows a subframe to load its initial about: document', () => {
		expect(blocksSubframeNavigation(false, 'about:srcdoc')).toBe(false);
		expect(blocksSubframeNavigation(false, 'about:blank')).toBe(false);
		expect(blocksSubframeNavigation(false, '')).toBe(false);
		expect(blocksSubframeNavigation(false, '   ')).toBe(false);
	});

	it('is case- and whitespace-insensitive for the initial document', () => {
		expect(blocksSubframeNavigation(false, 'About:SrcDoc')).toBe(false);
		expect(blocksSubframeNavigation(false, '  about:blank  ')).toBe(false);
	});

	it('blocks a subframe navigating to a remote origin (the exfil path)', () => {
		expect(blocksSubframeNavigation(false, 'https://evil.example/?d=secret')).toBe(true);
		expect(blocksSubframeNavigation(false, 'http://10.0.0.1/leak')).toBe(true);
	});

	it('blocks a subframe navigating to data: (drops the CSP, keeps null origin)', () => {
		expect(blocksSubframeNavigation(false, 'data:text/html,<script>1</script>')).toBe(true);
	});

	it('blocks a subframe navigating to the app/dev origin (no legit subframe does)', () => {
		expect(blocksSubframeNavigation(false, 'app://app/index.html')).toBe(true);
		expect(blocksSubframeNavigation(false, 'http://localhost:17173/')).toBe(true);
	});
});
