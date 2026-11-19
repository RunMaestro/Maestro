// Source: src/__tests__/main/coworking/coworking-socket-path.test.ts
// Source: src/__tests__/main/coworking/coworking-browser.test.ts
// Source: src/__tests__/main/coworking/coworking-registry.test.ts
// Source: src/__tests__/main/coworking/coworking-tools.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { CoworkingRegistry } from '../../../main/coworking/coworking-registry';
import { listBrowsers } from '../../../main/coworking/coworking-tools';
import { getBrowserUrl } from '../../../main/coworking/coworking-tools';
import { readBrowser } from '../../../main/coworking/coworking-tools';
import { browserInteract } from '../../../main/coworking/coworking-tools';
import { DEFAULT_BROWSER_MAX_CHARS } from '../../../main/coworking/coworking-tools';
import { MAX_BROWSER_MAX_CHARS } from '../../../main/coworking/coworking-tools';
import type { CoworkingBrowserInput } from '../../../shared/coworkingBrowser';
import type { BrowserOpResult } from '../../../shared/coworkingBrowser';
import { DEFAULT_BROWSER_CONFIRM_POLICY } from '../../../shared/coworkingBrowser';
import { listTerminals } from '../../../main/coworking/coworking-tools';
import { readTerminal } from '../../../main/coworking/coworking-tools';
import { MAX_TERMINAL_LINES } from '../../../main/coworking/coworking-tools';
const { userDataPath } = vi.hoisted(() => ({ userDataPath: { value: '/tmp/maestro' } }));
vi.mock('electron', () => ({
	app: { getPath: (name: string) => (name === 'userData' ? userDataPath.value : '/unused') },
}));
describeSourceSuite('coworking-socket-path', () => {
	const realPlatform = process.platform;

	function setPlatform(platform: NodeJS.Platform): void {
		Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	}

	/** Fresh module instance so SUN_PATH_MAX re-evaluates for the stubbed platform. */
	async function loadGetBridgeSocketPath(): Promise<() => string> {
		vi.resetModules();
		const mod = await import('../../../main/coworking/coworking-socket-path');
		return mod.getBridgeSocketPath;
	}

	describe('getBridgeSocketPath', () => {
		beforeEach(() => {
			userDataPath.value = '/tmp/maestro';
		});

		afterEach(() => {
			Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
		});

		it('keeps the socket inside userData when the path fits in sun_path', async () => {
			setPlatform('darwin');
			userDataPath.value = '/Users/dev/Library/Application Support/maestro';
			const getBridgeSocketPath = await loadGetBridgeSocketPath();

			expect(getBridgeSocketPath()).toBe(
				'/Users/dev/Library/Application Support/maestro/coworking.sock'
			);
		});

		it('falls back to a short temp-dir socket when userData overflows sun_path', async () => {
			setPlatform('darwin');
			// The exact path from MAESTRO-WH: 123 bytes with /coworking.sock appended,
			// against a 104-byte macOS sun_path.
			userDataPath.value =
				'/Users/felipegobbi/Library/Application Support/maestro/Maestro-rc/artifacts/runtime/starred-unread-test-data';
			const getBridgeSocketPath = await loadGetBridgeSocketPath();

			const socketPath = getBridgeSocketPath();

			expect(socketPath).not.toContain('starred-unread-test-data');
			expect(path.dirname(socketPath)).toBe(os.tmpdir());
			expect(path.basename(socketPath)).toMatch(/^maestro-coworking-[0-9a-f]{16}\.sock$/);
			// The whole point: the result is actually bindable.
			expect(Buffer.byteLength(socketPath) + 1).toBeLessThanOrEqual(104);
		});

		it('honours the larger Linux sun_path limit', async () => {
			// 106 bytes with /coworking.sock appended: over the macOS 104 limit but
			// inside the Linux 108 one, so Linux must keep it in userData.
			const dir = `/home/dev/${'d'.repeat(80)}`;
			userDataPath.value = dir;
			expect(Buffer.byteLength(`${dir}/coworking.sock`) + 1).toBe(106);

			setPlatform('linux');
			const onLinux = await loadGetBridgeSocketPath();
			expect(onLinux()).toBe(`${dir}/coworking.sock`);

			setPlatform('darwin');
			const onDarwin = await loadGetBridgeSocketPath();
			expect(path.dirname(onDarwin())).toBe(os.tmpdir());
		});

		it('gives different userData directories different fallback sockets', async () => {
			setPlatform('darwin');
			const deep = `/Users/dev/Library/Application Support/maestro/${'nested/'.repeat(10)}`;

			userDataPath.value = `${deep}profile-a`;
			const first = (await loadGetBridgeSocketPath())();
			userDataPath.value = `${deep}profile-b`;
			const second = (await loadGetBridgeSocketPath())();

			expect(path.dirname(first)).toBe(os.tmpdir());
			expect(first).not.toBe(second);
		});

		it('still returns a per-userData named pipe on Windows', async () => {
			setPlatform('win32');
			userDataPath.value = 'C:\\Users\\dev\\AppData\\Roaming\\maestro';
			const getBridgeSocketPath = await loadGetBridgeSocketPath();

			expect(getBridgeSocketPath()).toMatch(/^\\\\\.\\pipe\\maestro-coworking-[0-9a-f]{16}$/);
		});
	});
});
describeSourceSuite('coworking-browser', () => {
	function input(
		tabUuid: string,
		url = 'https://example.com',
		title = 'Example',
		extra: Partial<CoworkingBrowserInput> = {}
	): CoworkingBrowserInput {
		return {
			tabUuid,
			url,
			title,
			canGoBack: false,
			canGoForward: false,
			isLoading: false,
			...extra,
		};
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

		it('getBrowserIdForTab maps a tab back to its browser:N id, scoped and privacy-safe', () => {
			registry.syncSessionBrowsers('s1', [input('u-a'), hidden('u-b')], false);
			registry.syncSessionBrowsers('s2', [input('u-c')], false);
			expect(registry.getBrowserIdForTab('s1', 'u-a')).toBe('browser:1');
			// Hidden is indistinguishable from unknown: no id to hand out.
			expect(registry.getBrowserIdForTab('s1', 'u-b')).toBeNull();
			// Another session's tab does not resolve in this one.
			expect(registry.getBrowserIdForTab('s1', 'u-c')).toBeNull();
			expect(registry.getBrowserIdForTab('s2', 'u-c')).toBe('browser:1');
			expect(registry.getBrowserIdForTab('s1', 'never-synced')).toBeNull();
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
});
describeSourceSuite('coworking-registry', () => {
	describe('CoworkingRegistry', () => {
		let registry: CoworkingRegistry;

		beforeEach(() => {
			registry = new CoworkingRegistry();
		});

		function rec(id: string, tabUuid: string, sessionId: string, cwd = '/tmp', title = 'Terminal') {
			return { id, tabUuid, sessionId, cwd, title };
		}

		it('returns an empty list for a session with no records', () => {
			expect(registry.listForSession('sess-1')).toEqual([]);
		});

		it('lists terminals scoped to the requested sessionId only', () => {
			registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
			registry.upsertTerminal(rec('term:1', 'uuid-b', 'sess-2'));
			expect(registry.listForSession('sess-1')).toEqual([
				{ id: 'term:1', cwd: '/tmp', title: 'Terminal' },
			]);
			expect(registry.listForSession('sess-2')).toEqual([
				{ id: 'term:1', cwd: '/tmp', title: 'Terminal' },
			]);
		});

		it('does NOT leak records across sessions (privacy regression test for PR #948 blocker)', () => {
			// Session A has term:3 only; session B has term:1 only. Asking for either
			// session must never include the other's records, regardless of insertion order.
			registry.upsertTerminal(rec('term:3', 'uuid-a3', 'sess-A', '/a', 'A-Term-3'));
			registry.upsertTerminal(rec('term:1', 'uuid-b1', 'sess-B', '/b', 'B-Term-1'));
			expect(registry.listForSession('sess-A')).toEqual([
				{ id: 'term:3', cwd: '/a', title: 'A-Term-3' },
			]);
			expect(registry.listForSession('sess-B')).toEqual([
				{ id: 'term:1', cwd: '/b', title: 'B-Term-1' },
			]);
			expect(registry.resolveTabUuidForSession('sess-A', 'term:1')).toBeNull();
			expect(registry.resolveTabUuidForSession('sess-B', 'term:3')).toBeNull();
		});

		it('sorts entries by numeric coworkingId', () => {
			registry.upsertTerminal(rec('term:10', 'uuid-c', 'sess-1'));
			registry.upsertTerminal(rec('term:2', 'uuid-d', 'sess-1'));
			registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
			expect(registry.listForSession('sess-1').map((e) => e.id)).toEqual([
				'term:1',
				'term:2',
				'term:10',
			]);
		});

		it('resolveTabUuidForSession resolves only within the requested session', () => {
			registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
			registry.upsertTerminal(rec('term:1', 'uuid-b', 'sess-2'));
			expect(registry.resolveTabUuidForSession('sess-1', 'term:1')).toBe('uuid-a');
			expect(registry.resolveTabUuidForSession('sess-2', 'term:1')).toBe('uuid-b');
			expect(registry.resolveTabUuidForSession('sess-3', 'term:1')).toBeNull();
		});

		it('removeTerminal drops the record', () => {
			registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
			expect(registry.listForSession('sess-1')).toHaveLength(1);
			registry.removeTerminal('uuid-a');
			expect(registry.listForSession('sess-1')).toHaveLength(0);
		});

		it('syncSessionTerminals replaces only the targeted session', () => {
			registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
			registry.upsertTerminal(rec('term:1', 'uuid-x', 'sess-2'));
			registry.syncSessionTerminals('sess-1', [
				rec('term:2', 'uuid-b', 'sess-1', '/home', 'Alpha'),
				rec('term:3', 'uuid-c', 'sess-1', '/home', 'Beta'),
			]);
			expect(registry.listForSession('sess-1').map((e) => e.id)).toEqual(['term:2', 'term:3']);
			expect(registry.listForSession('sess-2').map((e) => e.id)).toEqual(['term:1']);
		});

		it("removeSession clears all of a session's terminals", () => {
			registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
			registry.upsertTerminal(rec('term:2', 'uuid-b', 'sess-1'));
			registry.upsertTerminal(rec('term:1', 'uuid-c', 'sess-2'));
			registry.removeSession('sess-1');
			expect(registry.listForSession('sess-2')).toHaveLength(1);
			expect(registry.listForSession('sess-1')).toHaveLength(0);
		});

		it('onChange fires on mutations and unsubscribe stops it', () => {
			let calls = 0;
			const off = registry.onChange(() => {
				calls += 1;
			});
			registry.upsertTerminal(rec('term:1', 'uuid-a', 'sess-1'));
			registry.removeTerminal('uuid-a');
			expect(calls).toBe(2);
			off();
			registry.upsertTerminal(rec('term:2', 'uuid-b', 'sess-1'));
			expect(calls).toBe(2);
		});
	});
});
describeSourceSuite('coworking-tools', () => {
	describe('coworking-tools', () => {
		let registry: CoworkingRegistry;

		beforeEach(() => {
			registry = new CoworkingRegistry();
			registry.upsertTerminal({
				id: 'term:1',
				tabUuid: 'uuid-a',
				sessionId: 'sess-1',
				cwd: '/home/user/proj',
				title: 'Terminal 1',
			});
		});

		it('listTerminals returns entries scoped to the caller sessionId', () => {
			const out = listTerminals('sess-1', registry);
			expect(out.terminals).toEqual([
				{ id: 'term:1', cwd: '/home/user/proj', title: 'Terminal 1' },
			]);
		});

		it('listTerminals returns [] for a session with no records (even if the registry has others)', () => {
			expect(listTerminals('sess-other', registry).terminals).toEqual([]);
		});

		it('readTerminal returns the buffer when the resolver provides it', async () => {
			const out = await readTerminal(
				'sess-1',
				{ id: 'term:1' },
				{ registry, resolver: async () => '$ ls\nfoo\nbar\n' }
			);
			expect(out.id).toBe('term:1');
			expect(out.content).toBe('$ ls\nfoo\nbar\n');
			expect(out.truncated).toBe(false);
			expect(out.totalLines).toBeGreaterThan(0);
		});

		it('readTerminal forwards the caller sessionId into the resolver', async () => {
			let seenSession: string | null = null;
			await readTerminal(
				'sess-1',
				{ id: 'term:1' },
				{
					registry,
					resolver: async (sid) => {
						seenSession = sid;
						return 'ok';
					},
				}
			);
			expect(seenSession).toBe('sess-1');
		});

		it('readTerminal tail-truncates when lines is set and exceeded', async () => {
			const buf = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
			const out = await readTerminal(
				'sess-1',
				{ id: 'term:1', lines: 2 },
				{ registry, resolver: async () => buf }
			);
			expect(out.truncated).toBe(true);
			expect(out.content).toBe('l4\nl5');
			expect(out.totalLines).toBe(5);
		});

		it('readTerminal does not truncate when lines >= total', async () => {
			const buf = 'one\ntwo';
			const out = await readTerminal(
				'sess-1',
				{ id: 'term:1', lines: 10 },
				{ registry, resolver: async () => buf }
			);
			expect(out.truncated).toBe(false);
			expect(out.content).toBe(buf);
		});

		it('readTerminal clamps a requested line count to MAX_TERMINAL_LINES', async () => {
			// Buffer one line past the ceiling and ask for far more than the cap.
			// Without the clamp the whole buffer returns untruncated; the clamp forces
			// exactly MAX_TERMINAL_LINES tail lines back and flips truncated true.
			const total = MAX_TERMINAL_LINES + 1;
			const buf = Array.from({ length: total }, (_, i) => `l${i}`).join('\n');
			const out = await readTerminal(
				'sess-1',
				{ id: 'term:1', lines: MAX_TERMINAL_LINES * 5 },
				{ registry, resolver: async () => buf }
			);
			expect(out.truncated).toBe(true);
			expect(out.totalLines).toBe(total);
			expect(out.content.split('\n')).toHaveLength(MAX_TERMINAL_LINES);
			// Tail semantics: the oldest line (l0) is dropped, the newest retained.
			expect(out.content.split('\n')[0]).toBe('l1');
			expect(out.content.endsWith(`l${total - 1}`)).toBe(true);
		});

		it('treats a single trailing newline as a terminator, not a line', async () => {
			const out = await readTerminal(
				'sess-1',
				{ id: 'term:1' },
				{ registry, resolver: async () => '$ ls\nfoo\nbar\n' }
			);
			expect(out.totalLines).toBe(3);
			const tailed = await readTerminal(
				'sess-1',
				{ id: 'term:1', lines: 2 },
				{ registry, resolver: async () => '$ ls\nfoo\nbar\n' }
			);
			expect(tailed.totalLines).toBe(3);
			expect(tailed.content).toBe('foo\nbar');
		});

		it('reports zero lines for an empty buffer', async () => {
			const out = await readTerminal(
				'sess-1',
				{ id: 'term:1' },
				{ registry, resolver: async () => '' }
			);
			expect(out.totalLines).toBe(0);
			expect(out.content).toBe('');
			expect(out.truncated).toBe(false);
		});

		it('readTerminal throws on unknown id', async () => {
			await expect(
				readTerminal('sess-1', { id: 'term:99' }, { registry, resolver: async () => 'irrelevant' })
			).rejects.toThrow(/term:99/);
		});

		it("readTerminal cannot read another session's terminal even with a matching id", async () => {
			registry.upsertTerminal({
				id: 'term:1',
				tabUuid: 'uuid-foreign',
				sessionId: 'sess-other',
				cwd: '/other',
				title: 'Foreign Terminal 1',
			});
			// sess-1 has its own term:1 (uuid-a) - calling from sess-1 must resolve to uuid-a.
			let seenTab: string | null = null;
			const out = await readTerminal(
				'sess-1',
				{ id: 'term:1' },
				{
					registry,
					resolver: async (_sid, tabUuid) => {
						seenTab = tabUuid;
						return 'own';
					},
				}
			);
			expect(seenTab).toBe('uuid-a');
			expect(out.content).toBe('own');
			// And calling from a session that has no record at that id must throw.
			await expect(
				readTerminal('sess-empty', { id: 'term:1' }, { registry, resolver: async () => 'leak' })
			).rejects.toThrow(/term:1/);
		});

		it('readTerminal throws when resolver is not configured', async () => {
			await expect(readTerminal('sess-1', { id: 'term:1' }, { registry })).rejects.toThrow(
				/resolver not configured/
			);
		});
	});
});
