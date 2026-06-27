/**
 * @file PluginPanelFrame.test.ts
 * @description withPanelCsp injects a restrictive Content-Security-Policy meta
 * (asserted by the load-bearing connect-src 'none' directive, by substring so
 * extra directives are fine) immediately after <head>, synthesizes a <head> under
 * a bare <html>, or prepends to a fragment - never dropping the original body.
 */

import { describe, it, expect } from 'vitest';
import { withPanelCsp } from '../../../../renderer/components/plugins/PluginPanelFrame';

/** The CSP meta with its load-bearing connect-src 'none', tolerant of additional
 * directives inside the same content attribute. */
const CSP_META = /<meta http-equiv="Content-Security-Policy"[^>]*connect-src 'none'/;

describe('withPanelCsp', () => {
	it('inserts the CSP meta immediately after an existing <head>', () => {
		const out = withPanelCsp('<html><head></head><body>x</body></html>');
		expect(out).toMatch(CSP_META);
		const headIdx = out.indexOf('<head>');
		const metaIdx = out.indexOf('<meta http-equiv="Content-Security-Policy"');
		expect(metaIdx).toBe(headIdx + '<head>'.length);
		expect(out).toContain('<body>x</body>');
	});

	it('creates a <head> with the meta when there is an <html> but no <head>', () => {
		const out = withPanelCsp('<html><body>hello</body></html>');
		expect(out).toMatch(CSP_META);
		expect(out).toContain('<head>');
		expect(out).toContain('</head>');
		// The synthesized head (and its meta) precedes the body.
		expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<body>'));
		expect(out).toContain('<body>hello</body>');
	});

	it('prepends the meta to a bare fragment', () => {
		const out = withPanelCsp('hi');
		expect(out).toMatch(CSP_META);
		expect(out.indexOf('<meta')).toBe(0);
		expect(out.endsWith('hi')).toBe(true);
	});
});
