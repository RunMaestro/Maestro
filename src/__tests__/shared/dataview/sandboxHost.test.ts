/**
 * Tests for the DataviewJS guest naming contract (src/shared/dataview/sandboxHost.ts, D4): the per-root
 * partition, the attachment gate main runs in `will-attach-webview`, and the CSP the guest document carries.
 */

import { describe, expect, it } from 'vitest';
import {
	DATAVIEW_GUEST_CSP,
	DATAVIEW_GUEST_PARTITION_PREFIX,
	DATAVIEW_GUEST_URL,
	dataviewGuestPartition,
	isAllowedDataviewGuestAttachment,
	isDataviewGuestPartition,
} from '../../../shared/dataview';
import { isPluginPanelPartition } from '../../../shared/plugins/panel-host';
import { isAllowedBrowserTabPartition } from '../../../shared/browserTabPartition';

describe('dataviewGuestPartition', () => {
	it('is a short, stable, in-memory partition per root and host', () => {
		const partition = dataviewGuestPartition('/Users/me/Vault', null);
		expect(partition).toMatch(/^dataview-guest:[0-9a-f]{16}$/);
		expect(partition.startsWith('persist:')).toBe(false);
		expect(dataviewGuestPartition('/Users/me/Vault', null)).toBe(partition);
	});

	it('gives every root, and the same path on another host, its own session', () => {
		const partitions = new Set([
			dataviewGuestPartition('/Users/me/Vault', null),
			dataviewGuestPartition('/Users/me/Vault2', null),
			dataviewGuestPartition('/Users/me/Vault', 'remote-1'),
			dataviewGuestPartition('/Users/me/Vault', 'remote-2'),
			dataviewGuestPartition('C:\\Vault', null),
			dataviewGuestPartition('/Users/me/Vault/ü', null),
		]);
		expect(partitions.size).toBe(6);
	});

	it('never reads as a plugin-panel or browser-tab partition', () => {
		const partition = dataviewGuestPartition('/Users/me/Vault', null);
		expect(isPluginPanelPartition(partition)).toBe(false);
		expect(isAllowedBrowserTabPartition(partition)).toBe(false);
	});
});

describe('isDataviewGuestPartition', () => {
	it('accepts only what dataviewGuestPartition makes', () => {
		expect(isDataviewGuestPartition(dataviewGuestPartition('/v', null))).toBe(true);
		for (const partition of [
			'',
			DATAVIEW_GUEST_PARTITION_PREFIX,
			'dataview-guest:nothex',
			'dataview-guest:ABCDEF0123456789',
			'dataview-guest:0123456789abcdef0',
			'persist:dataview-guest:0123456789abcdef',
			'plugin:dataview-guest:0123456789abcdef',
		]) {
			expect(isDataviewGuestPartition(partition), partition).toBe(false);
		}
	});
});

describe('isAllowedDataviewGuestAttachment', () => {
	const partition = dataviewGuestPartition('/v', null);

	it('allows exactly the guest document on a guest partition', () => {
		expect(isAllowedDataviewGuestAttachment(partition, DATAVIEW_GUEST_URL)).toBe(true);
	});

	it('refuses any other document, and the guest document on any other partition', () => {
		for (const src of [
			'',
			'https://example.com/',
			'file:///etc/passwd',
			'about:blank',
			`${DATAVIEW_GUEST_URL}?x=1`,
			`${DATAVIEW_GUEST_URL}#x`,
			DATAVIEW_GUEST_URL.toUpperCase(),
			'dataview-guest://sandbox/other.html',
			'plugin-panel://panel/acme%2Fboard',
		]) {
			expect(isAllowedDataviewGuestAttachment(partition, src), src).toBe(false);
		}
		for (const other of ['plugin:acme', 'persist:maestro-browser-session-1', 'dataview-guest:x']) {
			expect(isAllowedDataviewGuestAttachment(other, DATAVIEW_GUEST_URL), other).toBe(false);
		}
	});
});

describe('DATAVIEW_GUEST_CSP', () => {
	const directives = new Map(
		DATAVIEW_GUEST_CSP.split(';').map((part) => {
			const [name, ...values] = part.trim().split(/\s+/);
			return [name, values.join(' ')] as const;
		})
	);

	it("holds D4's four directives exactly", () => {
		expect(directives.get('default-src')).toBe("'none'");
		expect(directives.get('script-src')).toBe("'unsafe-inline'");
		expect(directives.get('style-src')).toBe("'unsafe-inline'");
		expect(directives.get('img-src')).toBe('data:');
	});

	it('closes every directive that does not fall back to default-src', () => {
		for (const name of [
			'connect-src',
			'child-src',
			'frame-src',
			'object-src',
			'form-action',
			'base-uri',
		]) {
			expect(directives.get(name), name).toBe("'none'");
		}
		expect(directives.get('webrtc')).toBe("'block'");
	});

	it('never allows eval, and never pins script-src to a nonce, hash, or strict-dynamic', () => {
		expect(DATAVIEW_GUEST_CSP).not.toContain('unsafe-eval');
		expect(DATAVIEW_GUEST_CSP).not.toContain('wasm-unsafe-eval');
		expect(directives.get('script-src')).not.toMatch(/nonce-|sha\d+-|strict-dynamic/);
	});
});
