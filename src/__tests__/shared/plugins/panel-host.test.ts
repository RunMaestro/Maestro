/**
 * @file panel-host.test.ts
 * @description The pure naming/validation contract of the plugin panel render
 * host: per-plugin partitions (`plugin:<id>`, never persist:), panel document
 * URLs (`plugin-panel://panel/<encoded id>`, exactly one path segment, fail
 * closed on anything malformed), the attachment gate (partition and document
 * MUST name the same plugin), and the CSP injection (header content and meta
 * placement — connect-src 'none' is the load-bearing egress directive).
 */

import { describe, it, expect } from 'vitest';
import {
	PANEL_CSP_CONTENT,
	PLUGIN_PANEL_PARTITION_PREFIX,
	pluginPanelPartition,
	isPluginPanelPartition,
	pluginIdFromPanelPartition,
	pluginPanelUrl,
	panelIdFromPluginPanelUrl,
	isAllowedPluginPanelAttachment,
	withPanelCsp,
} from '../../../shared/plugins/panel-host';

describe('panel partition naming', () => {
	it('builds and parses a per-plugin partition round-trip', () => {
		const partition = pluginPanelPartition('acme.tools');
		expect(partition).toBe('plugin:acme.tools');
		expect(isPluginPanelPartition(partition)).toBe(true);
		expect(pluginIdFromPanelPartition(partition)).toBe('acme.tools');
	});

	it('is never a persist: partition (in-memory session, wiped on relaunch)', () => {
		expect(PLUGIN_PANEL_PARTITION_PREFIX.startsWith('persist:')).toBe(false);
		expect(pluginPanelPartition('a.b').startsWith('persist:')).toBe(false);
	});

	it('rejects foreign partitions and an empty plugin id', () => {
		expect(isPluginPanelPartition('persist:maestro-browser-session-1')).toBe(false);
		expect(pluginIdFromPanelPartition('persist:maestro-browser-session-1')).toBeNull();
		expect(pluginIdFromPanelPartition('plugin:')).toBeNull();
		expect(pluginIdFromPanelPartition('')).toBeNull();
	});
});

describe('panel document URLs', () => {
	it('round-trips a namespaced panel id through the URL', () => {
		const url = pluginPanelUrl('acme.tools/board');
		// The `/` in the id is encoded — a single opaque path segment.
		expect(url).toBe('plugin-panel://panel/acme.tools%2Fboard');
		expect(panelIdFromPluginPanelUrl(url)).toBe('acme.tools/board');
	});

	it('fails closed on wrong scheme, wrong host, or extra segments', () => {
		expect(panelIdFromPluginPanelUrl('https://panel/acme%2Fboard')).toBeNull();
		expect(panelIdFromPluginPanelUrl('plugin-panel://evil/acme%2Fboard')).toBeNull();
		expect(panelIdFromPluginPanelUrl('plugin-panel://panel/acme/board')).toBeNull();
		expect(panelIdFromPluginPanelUrl('plugin-panel://panel/')).toBeNull();
		expect(panelIdFromPluginPanelUrl('plugin-panel://panel')).toBeNull();
		expect(panelIdFromPluginPanelUrl('not a url')).toBeNull();
		expect(panelIdFromPluginPanelUrl('')).toBeNull();
	});

	it('fails closed on query/fragment smuggling and bad encodings', () => {
		expect(panelIdFromPluginPanelUrl('plugin-panel://panel/a%2Fb?x=1')).toBeNull();
		expect(panelIdFromPluginPanelUrl('plugin-panel://panel/a%2Fb#f')).toBeNull();
		expect(panelIdFromPluginPanelUrl('plugin-panel://panel/%E0%A4%A')).toBeNull();
	});
});

describe('isAllowedPluginPanelAttachment (the will-attach-webview gate)', () => {
	it('allows a partition paired with its OWN plugin panel document', () => {
		expect(
			isAllowedPluginPanelAttachment('plugin:acme.tools', pluginPanelUrl('acme.tools/board'))
		).toBe(true);
	});

	it("rejects another plugin's panel document (cross-plugin session reuse)", () => {
		expect(
			isAllowedPluginPanelAttachment('plugin:acme.tools', pluginPanelUrl('evil.corp/board'))
		).toBe(false);
		// Prefix confusion: `acme.toolsX` must not pass as `acme.tools`.
		expect(
			isAllowedPluginPanelAttachment('plugin:acme.tools', pluginPanelUrl('acme.toolsX/board'))
		).toBe(false);
	});

	it('rejects arbitrary URLs, empty local ids, and non-panel partitions', () => {
		expect(isAllowedPluginPanelAttachment('plugin:acme.tools', 'https://evil.example/')).toBe(
			false
		);
		expect(isAllowedPluginPanelAttachment('plugin:acme.tools', 'about:blank')).toBe(false);
		expect(isAllowedPluginPanelAttachment('plugin:acme.tools', pluginPanelUrl('acme.tools/'))).toBe(
			false
		);
		expect(
			isAllowedPluginPanelAttachment(
				'persist:maestro-browser-session-1',
				pluginPanelUrl('acme.tools/board')
			)
		).toBe(false);
		expect(isAllowedPluginPanelAttachment('plugin:acme.tools', '')).toBe(false);
	});
});

/** The CSP meta with its load-bearing connect-src 'none', tolerant of
 * additional directives inside the same content attribute. */
const CSP_META = /<meta http-equiv="Content-Security-Policy"[^>]*connect-src 'none'/;

describe('panel CSP', () => {
	it('the header policy denies egress, subframes, and form posts', () => {
		expect(PANEL_CSP_CONTENT).toContain("default-src 'none'");
		expect(PANEL_CSP_CONTENT).toContain("connect-src 'none'");
		expect(PANEL_CSP_CONTENT).toContain("child-src 'none'");
		expect(PANEL_CSP_CONTENT).toContain("frame-src 'none'");
		expect(PANEL_CSP_CONTENT).toContain("form-action 'none'");
		expect(PANEL_CSP_CONTENT).toContain("base-uri 'none'");
	});

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
