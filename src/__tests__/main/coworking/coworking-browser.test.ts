import { describe, it, expect, beforeEach } from 'vitest';
import { CoworkingRegistry } from '../../../main/coworking/coworking-registry';
import {
	listBrowsers,
	getBrowserUrl,
	readBrowser,
	browserInteract,
} from '../../../main/coworking/coworking-tools';
import type { CoworkingBrowserInput, BrowserOpResult } from '../../../shared/coworkingBrowser';

function input(
	tabUuid: string,
	url = 'https://example.com',
	title = 'Example'
): CoworkingBrowserInput {
	return { tabUuid, url, title, canGoBack: false, canGoForward: false, isLoading: false };
}

describe('CoworkingRegistry browser methods', () => {
	let registry: CoworkingRegistry;
	beforeEach(() => {
		registry = new CoworkingRegistry();
	});

	it('assigns stable monotonic browser:N ids in sync order', () => {
		registry.syncSessionBrowsers('s1', [input('u-a'), input('u-b')], false);
		expect(registry.listBrowsersForSession('s1').map((b) => b.id)).toEqual([
			'browser:1',
			'browser:2',
		]);
	});

	it('keeps ids stable across re-sync and never reuses a retired id', () => {
		registry.syncSessionBrowsers('s1', [input('u-a'), input('u-b')], false);
		// Close u-a, open u-c.
		registry.syncSessionBrowsers('s1', [input('u-b'), input('u-c')], false);
		expect(registry.resolveBrowserTabUuidForSession('s1', 'browser:2')).toBe('u-b');
		expect(registry.resolveBrowserTabUuidForSession('s1', 'browser:3')).toBe('u-c');
		// browser:1 (u-a) is retired, never reused.
		expect(registry.resolveBrowserTabUuidForSession('s1', 'browser:1')).toBeNull();
		expect(registry.listBrowsersForSession('s1')).toHaveLength(2);
	});

	it('scopes browser entries and id resolution to the requested session', () => {
		registry.syncSessionBrowsers('s1', [input('u-a', 'https://a')], false);
		registry.syncSessionBrowsers('s2', [input('u-b', 'https://b')], false);
		expect(registry.listBrowsersForSession('s1').map((b) => b.url)).toEqual(['https://a']);
		expect(registry.listBrowsersForSession('s2').map((b) => b.url)).toEqual(['https://b']);
		expect(registry.resolveBrowserTabUuidForSession('s1', 'browser:1')).toBe('u-a');
		expect(registry.resolveBrowserTabUuidForSession('s2', 'browser:1')).toBe('u-b');
	});

	it('removeSession clears browser records, ids and interaction permission', () => {
		registry.syncSessionBrowsers('s1', [input('u-a')], true);
		expect(registry.isBrowserInteractionEnabled('s1')).toBe(true);
		registry.removeSession('s1');
		expect(registry.listBrowsersForSession('s1')).toEqual([]);
		expect(registry.isBrowserInteractionEnabled('s1')).toBe(false);
		// A fresh sync after removal restarts ids at browser:1.
		registry.syncSessionBrowsers('s1', [input('u-z')], false);
		expect(registry.listBrowsersForSession('s1')[0].id).toBe('browser:1');
	});

	it('isBrowserInteractionEnabled reflects the synced permission flag', () => {
		registry.syncSessionBrowsers('s1', [input('u-a')], false);
		expect(registry.isBrowserInteractionEnabled('s1')).toBe(false);
		registry.syncSessionBrowsers('s1', [input('u-a')], true);
		expect(registry.isBrowserInteractionEnabled('s1')).toBe(true);
		expect(registry.isBrowserInteractionEnabled('unknown')).toBe(false);
	});
});

describe('coworking browser tools', () => {
	let registry: CoworkingRegistry;
	beforeEach(() => {
		registry = new CoworkingRegistry();
		registry.syncSessionBrowsers(
			's1',
			[
				{
					tabUuid: 'u-a',
					url: 'https://example.com',
					title: 'Example',
					canGoBack: true,
					canGoForward: false,
					isLoading: false,
				},
			],
			false
		);
	});

	it('listBrowsers returns entries scoped to the caller session', () => {
		expect(listBrowsers('s1', registry).browsers).toEqual([
			{
				id: 'browser:1',
				url: 'https://example.com',
				title: 'Example',
				canGoBack: true,
				canGoForward: false,
				isLoading: false,
			},
		]);
		expect(listBrowsers('s2', registry).browsers).toEqual([]);
	});

	it('getBrowserUrl returns id/url/title for a known tab and throws for unknown', () => {
		expect(getBrowserUrl('s1', { id: 'browser:1' }, registry)).toEqual({
			id: 'browser:1',
			url: 'https://example.com',
			title: 'Example',
		});
		expect(() => getBrowserUrl('s1', { id: 'browser:9' }, registry)).toThrow();
	});

	it('readBrowser returns resolver content with the default text format', async () => {
		const out = await readBrowser(
			's1',
			{ id: 'browser:1' },
			{
				registry,
				resolver: async (_s, _u, op): Promise<BrowserOpResult> => ({
					ok: true,
					content: op.kind === 'read' ? 'PAGE TEXT' : '',
					url: 'https://example.com',
					title: 'Example',
				}),
			}
		);
		expect(out.content).toBe('PAGE TEXT');
		expect(out.format).toBe('text');
		expect(out.truncated).toBe(false);
		expect(out.totalChars).toBe('PAGE TEXT'.length);
	});

	it('readBrowser passes the requested format through to the resolver', async () => {
		let seenFormat = '';
		await readBrowser(
			's1',
			{ id: 'browser:1', format: 'html' },
			{
				registry,
				resolver: async (_s, _u, op): Promise<BrowserOpResult> => {
					if (op.kind === 'read') seenFormat = op.format;
					return { ok: true, content: '<html></html>' };
				},
			}
		);
		expect(seenFormat).toBe('html');
	});

	it('readBrowser head-truncates to maxChars and reports the true totalChars', async () => {
		const out = await readBrowser(
			's1',
			{ id: 'browser:1', maxChars: 4 },
			{
				registry,
				resolver: async (): Promise<BrowserOpResult> => ({ ok: true, content: 'abcdefgh' }),
			}
		);
		expect(out.content).toBe('abcd');
		expect(out.truncated).toBe(true);
		expect(out.totalChars).toBe(8);
	});

	it('readBrowser throws on unknown id, missing resolver, and cross-session reads', async () => {
		await expect(
			readBrowser(
				's1',
				{ id: 'browser:9' },
				{ registry, resolver: async (): Promise<BrowserOpResult> => ({ ok: true }) }
			)
		).rejects.toThrow();
		await expect(readBrowser('s1', { id: 'browser:1' }, { registry })).rejects.toThrow();
		await expect(
			readBrowser(
				's2',
				{ id: 'browser:1' },
				{ registry, resolver: async (): Promise<BrowserOpResult> => ({ ok: true, content: 'x' }) }
			)
		).rejects.toThrow();
	});

	it('browserInteract resolves the tab and forwards the op to the resolver', async () => {
		let seen: { sessionId: string; tabUuid: string; kind: string } | null = null;
		const out = await browserInteract(
			's1',
			{ id: 'browser:1', op: { kind: 'reload' } },
			{
				registry,
				resolver: async (sessionId, tabUuid, op): Promise<BrowserOpResult> => {
					seen = { sessionId, tabUuid, kind: op.kind };
					return { ok: true, content: 'reloaded' };
				},
			}
		);
		expect(seen).toEqual({ sessionId: 's1', tabUuid: 'u-a', kind: 'reload' });
		expect(out.ok).toBe(true);
	});

	it('browserInteract throws on an unknown id', async () => {
		await expect(
			browserInteract(
				's1',
				{ id: 'browser:9', op: { kind: 'reload' } },
				{ registry, resolver: async (): Promise<BrowserOpResult> => ({ ok: true }) }
			)
		).rejects.toThrow();
	});
});
