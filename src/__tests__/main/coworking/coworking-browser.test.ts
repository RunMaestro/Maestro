import { describe, it, expect, beforeEach } from 'vitest';
import { CoworkingRegistry } from '../../../main/coworking/coworking-registry';
import {
	listBrowsers,
	getBrowserUrl,
	readBrowser,
	browserInteract,
	DEFAULT_BROWSER_MAX_CHARS,
	MAX_BROWSER_MAX_CHARS,
} from '../../../main/coworking/coworking-tools';
import type { CoworkingBrowserInput, BrowserOpResult } from '../../../shared/coworkingBrowser';
import { DEFAULT_BROWSER_CONFIRM_POLICY } from '../../../shared/coworkingBrowser';

function input(
	tabUuid: string,
	url = 'https://example.com',
	title = 'Example',
	extra: Partial<CoworkingBrowserInput> = {}
): CoworkingBrowserInput {
	return { tabUuid, url, title, canGoBack: false, canGoForward: false, isLoading: false, ...extra };
}

function hidden(tabUuid: string, url?: string, title?: string): CoworkingBrowserInput {
	return input(tabUuid, url, title, { hiddenFromAgent: true });
}

/** Reads the registry's PRIVATE `browserIdByTabUuid` map. The tab-close prune
 *  has NO public-API-observable effect (ids stay monotonic whether or not a
 *  retired uuid is deleted), so the memory-leak fix can only be guarded by
 *  inspecting this private field directly. */
type RegistryInternals = { browserIdByTabUuid: Map<string, Map<string, number>> };
function browserIdMap(
	registry: CoworkingRegistry,
	sessionId: string
): Map<string, number> | undefined {
	// Unchecked cast to reach a private field: intentional white-box access for a
	// leak guard with no public surface. Named, not inlined into the member access.
	const internals = registry as unknown as RegistryInternals;
	return internals.browserIdByTabUuid.get(sessionId);
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

	it('excludes hidden tabs from listBrowsersForSession', () => {
		registry.syncSessionBrowsers('s1', [input('u-a'), hidden('u-b')], false);
		expect(registry.listBrowsersForSession('s1').map((b) => b.id)).toEqual(['browser:1']);
	});

	it('hidden tabs are unaddressable even with their correct browser:N id', () => {
		registry.syncSessionBrowsers('s1', [input('u-a'), hidden('u-b')], false);
		// u-b owns browser:2 internally, but hidden must be indistinguishable
		// from "not found" so the tab's existence never leaks to the agent.
		expect(registry.resolveBrowserTabUuidForSession('s1', 'browser:2')).toBeNull();
		expect(registry.resolveBrowserTabUuidForSession('s1', 'browser:1')).toBe('u-a');
	});

	it('keeps browser:N ids stable across hide -> unhide -> sync cycles', () => {
		registry.syncSessionBrowsers('s1', [input('u-a'), input('u-b')], false);
		expect(registry.resolveBrowserTabUuidForSession('s1', 'browser:2')).toBe('u-b');
		// Hide u-b: unaddressable, but the id must not be retired or reassigned.
		registry.syncSessionBrowsers('s1', [input('u-a'), hidden('u-b')], false);
		expect(registry.resolveBrowserTabUuidForSession('s1', 'browser:2')).toBeNull();
		// A new tab while u-b is hidden takes the NEXT id, not u-b's.
		registry.syncSessionBrowsers('s1', [input('u-a'), hidden('u-b'), input('u-c')], false);
		expect(registry.resolveBrowserTabUuidForSession('s1', 'browser:3')).toBe('u-c');
		// Unhide: u-b reappears under its original id.
		registry.syncSessionBrowsers('s1', [input('u-a'), input('u-b'), input('u-c')], false);
		expect(registry.resolveBrowserTabUuidForSession('s1', 'browser:2')).toBe('u-b');
		expect(registry.listBrowsersForSession('s1').map((b) => b.id)).toEqual([
			'browser:1',
			'browser:2',
			'browser:3',
		]);
	});

	it('getBrowserConfirmPolicy mirrors the synced policy and fails closed otherwise', () => {
		// Never configured -> the shared fail-closed default, not 'off'.
		expect(registry.getBrowserConfirmPolicy('s1')).toBe(DEFAULT_BROWSER_CONFIRM_POLICY);
		registry.syncSessionBrowsers('s1', [input('u-a')], true, 'claude-code', 'off');
		expect(registry.getBrowserConfirmPolicy('s1')).toBe('off');
		registry.syncSessionBrowsers('s1', [input('u-a')], true, 'claude-code', 'all');
		expect(registry.getBrowserConfirmPolicy('s1')).toBe('all');
	});

	it('removeSession and reset clear the confirm policy back to the default', () => {
		registry.syncSessionBrowsers('s1', [input('u-a')], true, 'claude-code', 'off');
		registry.removeSession('s1');
		expect(registry.getBrowserConfirmPolicy('s1')).toBe(DEFAULT_BROWSER_CONFIRM_POLICY);
		registry.syncSessionBrowsers('s2', [input('u-b')], true, 'codex', 'off');
		registry.reset();
		expect(registry.getBrowserConfirmPolicy('s2')).toBe(DEFAULT_BROWSER_CONFIRM_POLICY);
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

	it('getBrowserUrl returns id/url/title/isLoading and throws for unknown', () => {
		// isLoading reflects the registry entry's value: false here (from beforeEach).
		expect(getBrowserUrl('s1', { id: 'browser:1' }, registry)).toEqual({
			id: 'browser:1',
			url: 'https://example.com',
			title: 'Example',
			isLoading: false,
		});
		// ...and true for a tab the registry reports as still loading. Re-sync s1
		// with a second, mid-load tab (u-a keeps browser:1; u-loading is browser:2).
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
				{
					tabUuid: 'u-loading',
					url: 'https://loading.example',
					title: 'Loading',
					canGoBack: false,
					canGoForward: false,
					isLoading: true,
				},
			],
			false
		);
		expect(getBrowserUrl('s1', { id: 'browser:2' }, registry)).toEqual({
			id: 'browser:2',
			url: 'https://loading.example',
			title: 'Loading',
			isLoading: true,
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

	it('readBrowser forwards the selector into the read op', async () => {
		let seenOp: { kind: string; selector?: string } | null = null;
		await readBrowser(
			's1',
			{ id: 'browser:1', selector: '#main' },
			{
				registry,
				resolver: async (_s, _u, op): Promise<BrowserOpResult> => {
					seenOp = op;
					return { ok: true, content: 'scoped' };
				},
			}
		);
		expect(seenOp).toMatchObject({ kind: 'read', selector: '#main' });
	});

	it('browserInteract routes newTab past tab resolution with an empty tabUuid', async () => {
		let seen: { sessionId: string; tabUuid: string; kind: string } | null = null;
		// No id supplied and no matching tab needed: newTab is session-scoped.
		const out = await browserInteract(
			's-without-any-tabs',
			{ op: { kind: 'newTab', url: 'https://x.com', ephemeral: true } },
			{
				registry,
				resolver: async (sessionId, tabUuid, op): Promise<BrowserOpResult> => {
					seen = { sessionId, tabUuid, kind: op.kind };
					return { ok: true, content: 'opened' };
				},
			}
		);
		expect(seen).toEqual({ sessionId: 's-without-any-tabs', tabUuid: '', kind: 'newTab' });
		expect(out.ok).toBe(true);
	});

	it('browserInteract still requires an id for tab-scoped ops', async () => {
		await expect(
			browserInteract(
				's1',
				{ op: { kind: 'closeTab' } },
				{ registry, resolver: async (): Promise<BrowserOpResult> => ({ ok: true }) }
			)
		).rejects.toThrow(/`id` is required/);
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

	it('readBrowser applies DEFAULT_BROWSER_MAX_CHARS when maxChars is omitted', async () => {
		// An oversized page with no explicit cap is still head-truncated to the
		// default; totalChars reports the true (untruncated) length.
		const full = 'a'.repeat(DEFAULT_BROWSER_MAX_CHARS + 100);
		const out = await readBrowser(
			's1',
			{ id: 'browser:1' },
			{ registry, resolver: async (): Promise<BrowserOpResult> => ({ ok: true, content: full }) }
		);
		expect(out.truncated).toBe(true);
		expect(out.totalChars).toBe(full.length);
		expect(out.content).toHaveLength(DEFAULT_BROWSER_MAX_CHARS);
	});

	it('readBrowser clamps an explicit maxChars above MAX_BROWSER_MAX_CHARS to the ceiling', async () => {
		// Page just over the ceiling; request a cap well past it. Without the clamp
		// the requested cap exceeds the content and nothing truncates - the clamp
		// forces the cap down to the ceiling, trimming content and flipping truncated.
		const full = 'b'.repeat(MAX_BROWSER_MAX_CHARS + 10);
		const out = await readBrowser(
			's1',
			{ id: 'browser:1', maxChars: MAX_BROWSER_MAX_CHARS * 2 },
			{ registry, resolver: async (): Promise<BrowserOpResult> => ({ ok: true, content: full }) }
		);
		expect(out.truncated).toBe(true);
		expect(out.totalChars).toBe(full.length);
		expect(out.content).toHaveLength(MAX_BROWSER_MAX_CHARS);
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

	it('browserInteract rejects cross-session access', async () => {
		// browser:1 belongs to s1; s2 must not be able to drive it. This exercises
		// the real session-scoped tabUuid lookup, which the bridge suite mocks away.
		await expect(
			browserInteract(
				's2',
				{ id: 'browser:1', op: { kind: 'reload' } },
				{ registry, resolver: async (): Promise<BrowserOpResult> => ({ ok: true }) }
			)
		).rejects.toThrow(/not found in your session/);
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

describe('CoworkingRegistry browser id-map retirement (leak regression)', () => {
	let registry: CoworkingRegistry;
	beforeEach(() => {
		registry = new CoworkingRegistry();
	});

	it('tracks every live tab uuid in the private id map on first sync', () => {
		registry.syncSessionBrowsers('s', [input('tab-A'), input('tab-B')], true);
		expect(registry.listBrowsersForSession('s').map((b) => b.id)).toEqual([
			'browser:1',
			'browser:2',
		]);
		const map = browserIdMap(registry, 's');
		expect(map?.get('tab-A')).toBe(1);
		expect(map?.get('tab-B')).toBe(2);
	});

	it("retires a closed tab's id-map entry so the map cannot grow unbounded", () => {
		registry.syncSessionBrowsers('s', [input('tab-A'), input('tab-B')], true);
		// tab-B closed: absent from the next sync.
		registry.syncSessionBrowsers('s', [input('tab-A')], true);

		expect(registry.listBrowsersForSession('s').map((b) => b.id)).toEqual(['browser:1']);
		expect(registry.resolveBrowserTabUuidForSession('s', 'browser:2')).toBeNull();
		// The leak guard proper: the private id-map no longer holds tab-B's uuid.
		// Public id resolution stays monotonic with or without the prune, so only
		// this assertion reddens if the prune loop regresses.
		const map = browserIdMap(registry, 's');
		expect(map?.has('tab-B')).toBe(false);
		expect(map?.has('tab-A')).toBe(true);
	});

	it('never reuses a retired id and keeps live ids stable when a new tab opens', () => {
		registry.syncSessionBrowsers('s', [input('tab-A'), input('tab-B')], true);
		registry.syncSessionBrowsers('s', [input('tab-A')], true); // tab-B closed
		// tab-C opens after tab-B's id was retired.
		registry.syncSessionBrowsers('s', [input('tab-A'), input('tab-C')], true);

		// tab-C gets a FRESH id (browser:3); browser:2 is never handed out again.
		expect(registry.resolveBrowserTabUuidForSession('s', 'browser:3')).toBe('tab-C');
		expect(registry.resolveBrowserTabUuidForSession('s', 'browser:2')).toBeNull();
		// tab-A's id is stable across all three syncs.
		expect(registry.resolveBrowserTabUuidForSession('s', 'browser:1')).toBe('tab-A');
		expect(registry.listBrowsersForSession('s').map((b) => b.id)).toEqual([
			'browser:1',
			'browser:3',
		]);
	});
});
