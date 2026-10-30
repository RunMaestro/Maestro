/**
 * @file sandbox-security.test.ts
 * @description Security guard for the DataviewJS sandbox (D4, DV-11). Note scripts are untrusted code, so this
 * file pins every piece of hardening D4 requires in one place, in the style of
 * `plugin-host-deps-wiring.test.ts`: weakening any one of them fails the build and forces a security review.
 * The unit suites (`guest-host.test.ts`, `sandboxHost.test.ts`, `window-manager.test.ts`,
 * `src/__tests__/main/preload/dataview-guest.test.ts`, `vault-fs.test.ts`, `DataviewJsFrame.test.tsx`) cover
 * behavior in depth; this file asserts the production wiring end to end:
 *
 * - **The `<webview>` tag** (`DataviewJsFrame.tsx` and the inline host `DataviewJsInlineHost.tsx`, read from
 *   their ASTs): only `partition` and `src` carry meaning, no Node or preload attribute, the partition is the
 *   per-root one, the document the guest URL.
 * - **Partitions**: one in-memory session per vault root and host, never `persist:`, never another surface's.
 * - **The CSP** string, and the guest document carrying it as both a header and a meta tag.
 * - **Attachment** (the live `attachGuestWebviewSecurity()`): renderer-supplied web preferences are replaced,
 *   any other document or a switched-off feature is refused, and the per-root session is hardened.
 * - **Permissions and egress**: every permission request and check denied, every off-scheme request cancelled.
 * - **The attached guest**: `window.open` denied, every navigation prevented, audio muted, no privileged paste.
 * - **The guest preload** (AST): no `contextBridge`, and `ipcRenderer` used only to talk to its embedder.
 * - **`dataview:readInRoot`** (the real `DataviewService` over the real local file system): traversal,
 *   absolute paths, drive paths, and symlinks that resolve outside the root are refused; a symlink that stays
 *   inside is followed.
 * - **The watchdog** (both hosts, AST): a 5 s wall-clock watchdog (per block run, per inline expression), after
 *   a separate budget for the index build, whose expiry, like a dead guest process, destroys the guest by
 *   remounting the tag under a new key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

const { fromPartition, guestSessions } = vi.hoisted(() => {
	const guestSessions = new Map<string, ReturnType<typeof makeFakeSession>>();
	function makeFakeSession() {
		return {
			protocol: { handle: vi.fn() },
			webRequest: { onBeforeRequest: vi.fn() },
			setPermissionRequestHandler: vi.fn(),
			setPermissionCheckHandler: vi.fn(),
		};
	}
	// One object per partition string, as Electron's `session.fromPartition` does.
	const fromPartition = vi.fn((partition: string) => {
		let ses = guestSessions.get(partition);
		if (!ses) {
			ses = makeFakeSession();
			guestSessions.set(partition, ses);
		}
		return ses;
	});
	return { fromPartition, guestSessions };
});

vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir() },
	session: { fromPartition },
	Menu: { buildFromTemplate: vi.fn() },
	shell: { openExternal: vi.fn() },
	clipboard: { writeText: vi.fn() },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/stores/getters', () => ({
	getSshRemoteById: vi.fn(() => undefined),
	getSettingsStore: () => ({ get: () => undefined, set: vi.fn() }),
}));

import { attachGuestWebviewSecurity } from '../../../main/app-lifecycle/guest-webview-security';
import {
	DATAVIEW_GUEST_PRELOAD_FILE,
	serveDataviewGuestDocument,
	setDataviewJsServingCheck,
} from '../../../main/dataview/guest-host';
import { DataviewService } from '../../../main/dataview/dataview-service';
import {
	DATAVIEW_GUEST_CSP,
	DATAVIEW_GUEST_PARTITION_PREFIX,
	DATAVIEW_GUEST_URL,
	DATAVIEW_JS_RUN_TIMEOUT_MS,
	DATAVIEW_JS_INDEX_TIMEOUT_MS,
	dataviewGuestPartition,
	isAllowedDataviewGuestAttachment,
} from '../../../shared/dataview/sandboxHost';

const SRC = path.join(__dirname, '../../../');
const FRAME_PATH = path.join(SRC, 'renderer/components/Markdown/components/DataviewJsFrame.tsx');
const INLINE_HOST_PATH = path.join(
	SRC,
	'renderer/components/Markdown/components/DataviewJsInlineHost.tsx'
);
/** Every component that renders a DataviewJS guest. A new one belongs in this list. */
const GUEST_HOSTS: Array<[string, string]> = [
	['DataviewJsFrame.tsx', FRAME_PATH],
	['DataviewJsInlineHost.tsx', INLINE_HOST_PATH],
];
const PRELOAD_PATH = path.join(SRC, 'main/preload/dataview-guest.ts');

function parse(filePath: string): ts.SourceFile {
	const kind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	return ts.createSourceFile(
		path.basename(filePath),
		fs.readFileSync(filePath, 'utf-8'),
		ts.ScriptTarget.Latest,
		true,
		kind
	);
}

/** Every node in `root` for which `match` holds. */
function findAll<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] {
	const found: T[] = [];
	const visit = (node: ts.Node): void => {
		if (match(node)) found.push(node);
		ts.forEachChild(node, visit);
	};
	visit(root);
	return found;
}

function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
	return (
		ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
	);
}

// ---------------------------------------------------------------------------
// The <webview> tag
// ---------------------------------------------------------------------------

describe('only the guest hosts render a DataviewJS <webview>', () => {
	it('lists every renderer file that loads the guest document', () => {
		const found: string[] = [];
		const visit = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) visit(full);
				else if (
					/\.tsx?$/.test(entry.name) &&
					fs.readFileSync(full, 'utf-8').includes('DATAVIEW_GUEST_URL')
				)
					found.push(full);
			}
		};
		visit(path.join(SRC, 'renderer'));
		expect(found.sort()).toEqual(GUEST_HOSTS.map(([, file]) => file).sort());
	});
});

describe.each(GUEST_HOSTS)('the guest <webview> tag (%s)', (_name, hostPath) => {
	const frameSource = parse(hostPath);
	const tags = findAll(
		frameSource,
		(node): node is ts.JsxSelfClosingElement | ts.JsxOpeningElement =>
			(ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
			node.tagName.getText() === 'webview'
	);

	function attributes(): Map<string, string> {
		const map = new Map<string, string>();
		for (const property of tags[0].attributes.properties) {
			expect(ts.isJsxAttribute(property), 'no spread attributes on the guest tag').toBe(true);
			if (!ts.isJsxAttribute(property)) continue;
			map.set(property.name.getText().toLowerCase(), property.initializer?.getText() ?? '');
		}
		return map;
	}

	it('is the only <webview> the component renders', () => {
		expect(tags).toHaveLength(1);
	});

	it('sets only partition and src (plus key, ref, title, and style), never Node, a preload, or popups', () => {
		const names = [...attributes().keys()].sort();
		expect(names).toEqual(['key', 'partition', 'ref', 'src', 'style', 'title']);
		for (const banned of [
			'nodeintegration',
			'nodeintegrationinsubframes',
			'preload',
			'webpreferences',
			'allowpopups',
			'disablewebsecurity',
			'plugins',
			'disableblinkfeatures',
			'enableblinkfeatures',
		]) {
			expect(names, banned).not.toContain(banned);
		}
	});

	it('loads exactly the guest document on the per-root partition', () => {
		const attrs = attributes();
		expect(attrs.get('src')).toBe('{DATAVIEW_GUEST_URL}');
		expect(attrs.get('partition')).toBe('{partition}');
		const declarations = findAll(
			frameSource,
			(node): node is ts.VariableDeclaration =>
				ts.isVariableDeclaration(node) && node.name.getText() === 'partition'
		);
		expect(declarations).toHaveLength(1);
		const calls = findAll(declarations[0], (node): node is ts.CallExpression =>
			isCallTo(node, 'dataviewGuestPartition')
		);
		expect(calls, 'partition comes from dataviewGuestPartition(root, sshRemoteId)').toHaveLength(1);
		expect(calls[0].arguments.map((arg) => arg.getText())).toEqual([
			'snapshot.root',
			'snapshot.sshRemoteId',
		]);
	});

	it('remounts the tag when the guest key changes (how a guest is destroyed)', () => {
		expect(attributes().get('key')).toContain('guestKey');
	});
});

// ---------------------------------------------------------------------------
// Partitions
// ---------------------------------------------------------------------------

describe('guest partitions', () => {
	it('are one in-memory session per vault root and host, stable, and never persistent', () => {
		const a = dataviewGuestPartition('/vault/a', null);
		expect(a).toBe(dataviewGuestPartition('/vault/a', null));
		expect(a).not.toBe(dataviewGuestPartition('/vault/b', null));
		expect(a).not.toBe(dataviewGuestPartition('/vault/a', 'remote-1'));
		expect(a.startsWith(DATAVIEW_GUEST_PARTITION_PREFIX)).toBe(true);
		expect(a.startsWith('persist:')).toBe(false);
	});

	it('only ever host the guest document, and no other surface partition passes the gate', () => {
		const partition = dataviewGuestPartition('/vault', null);
		expect(isAllowedDataviewGuestAttachment(partition, DATAVIEW_GUEST_URL)).toBe(true);
		for (const src of [
			'https://example.com/',
			'file:///etc/passwd',
			`${DATAVIEW_GUEST_URL}?x=1`,
			`${DATAVIEW_GUEST_URL}#x`,
			'dataview-guest://sandbox/other.html',
			'about:blank',
		]) {
			expect(isAllowedDataviewGuestAttachment(partition, src), src).toBe(false);
		}
		for (const other of [
			'persist:maestro-browser-session-1',
			'plugin:com.example.panel',
			'dataview-guest:nothex',
			`persist:${partition}`,
			'',
		]) {
			expect(isAllowedDataviewGuestAttachment(other, DATAVIEW_GUEST_URL), other).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// The CSP
// ---------------------------------------------------------------------------

describe('the guest CSP', () => {
	const directives = new Map(
		DATAVIEW_GUEST_CSP.split(';')
			.map((part) => part.trim().split(/\s+/))
			.filter((tokens) => tokens[0])
			.map((tokens) => [tokens[0], tokens.slice(1)])
	);

	it('is exactly the D4 policy plus every directive that does not fall back to default-src', () => {
		expect(Object.fromEntries(directives)).toEqual({
			'default-src': ["'none'"],
			'script-src': ["'unsafe-inline'"],
			'style-src': ["'unsafe-inline'"],
			'img-src': ['data:'],
			'connect-src': ["'none'"],
			'child-src': ["'none'"],
			'frame-src': ["'none'"],
			'object-src': ["'none'"],
			'form-action': ["'none'"],
			'base-uri': ["'none'"],
			webrtc: ["'block'"],
		});
	});

	it('never allows eval, a host source, a nonce, a hash, or strict-dynamic for scripts', () => {
		const scriptSrc = directives.get('script-src') ?? [];
		for (const token of scriptSrc) {
			expect(token).not.toMatch(/unsafe-eval|wasm-unsafe-eval|strict-dynamic|^'nonce-|^'sha/);
			expect(token).not.toMatch(/^(https?:|\*|blob:|data:|'self')/);
		}
	});

	it('is served with the guest document as both a response header and a meta tag, and nothing else is', async () => {
		const html = '<!doctype html><html><head><meta charset="utf-8" /></head><body></body></html>';
		const options = {
			documentDir: '/dist/main',
			isServing: () => true,
			readDocument: async () => html,
		};
		const response = await serveDataviewGuestDocument({ url: DATAVIEW_GUEST_URL }, options);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Security-Policy')).toBe(DATAVIEW_GUEST_CSP);
		const body = await response.text();
		expect(body).toContain(
			`<meta http-equiv="Content-Security-Policy" content="${DATAVIEW_GUEST_CSP}">`
		);

		const other = await serveDataviewGuestDocument({ url: `${DATAVIEW_GUEST_URL}?x` }, options);
		expect(other.status).toBe(404);
		const off = await serveDataviewGuestDocument(
			{ url: DATAVIEW_GUEST_URL },
			{ ...options, isServing: () => false }
		);
		expect(off.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Attachment, session, and the attached guest (the live window wiring)
// ---------------------------------------------------------------------------

type Handler = (...args: any[]) => unknown;

function wireWindow() {
	const handlers = new Map<string, Handler>();
	const send = vi.fn();
	const browserWindow = {
		webContents: {
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			send,
		},
	};
	attachGuestWebviewSecurity(browserWindow as never, '/dist/main/preload.js');
	return { handlers, send };
}

function attach(
	handlers: Map<string, Handler>,
	partition: string,
	src: string,
	webPreferences: Record<string, unknown> = {}
) {
	const preventDefault = vi.fn();
	const prefs: Record<string, unknown> = { partition, ...webPreferences };
	handlers.get('will-attach-webview')!({ preventDefault }, prefs, { src });
	return { preventDefault, prefs };
}

describe('attaching a guest (attachGuestWebviewSecurity)', () => {
	const partition = dataviewGuestPartition('/vault', null);

	beforeEach(() => {
		guestSessions.clear();
		fromPartition.mockClear();
		setDataviewJsServingCheck(() => true);
	});

	afterEach(() => {
		setDataviewJsServingCheck(() => false);
	});

	it('replaces every web preference the renderer supplied with the locked set and the bridge-only preload', () => {
		const { handlers } = wireWindow();
		const { preventDefault, prefs } = attach(handlers, partition, DATAVIEW_GUEST_URL, {
			preload: '/tmp/evil-preload.js',
			preloadURL: 'file:///tmp/evil-preload.js',
			nodeIntegration: true,
			nodeIntegrationInSubFrames: true,
			nodeIntegrationInWorker: true,
			contextIsolation: false,
			sandbox: false,
			webSecurity: false,
			allowRunningInsecureContent: true,
			webviewTag: true,
			plugins: true,
		});
		expect(preventDefault).not.toHaveBeenCalled();
		expect(prefs).toEqual({
			partition,
			preload: path.join('/dist/main', DATAVIEW_GUEST_PRELOAD_FILE),
			nodeIntegration: false,
			nodeIntegrationInSubFrames: false,
			nodeIntegrationInWorker: false,
			contextIsolation: true,
			sandbox: true,
			webSecurity: true,
			allowRunningInsecureContent: false,
			webviewTag: false,
			plugins: false,
		});
	});

	it('refuses any other document, a forged partition, and every guest while DataviewJS is off', () => {
		const { handlers } = wireWindow();
		for (const [attemptPartition, src] of [
			[partition, 'https://example.com/'],
			[partition, 'file:///etc/passwd'],
			[partition, 'javascript:alert(1)'],
			[partition, ''],
			[`${DATAVIEW_GUEST_PARTITION_PREFIX}nothex`, DATAVIEW_GUEST_URL],
		]) {
			const { preventDefault, prefs } = attach(handlers, attemptPartition, src, {
				nodeIntegration: true,
			});
			expect(preventDefault, `${attemptPartition} ${src}`).toHaveBeenCalled();
			expect(prefs.preload, 'a refused guest gets no preload').toBeUndefined();
		}
		setDataviewJsServingCheck(() => false);
		expect(attach(handlers, partition, DATAVIEW_GUEST_URL).preventDefault).toHaveBeenCalled();
		expect(guestSessions.size).toBe(0);
	});

	it('denies every permission request and check on the per-root session', () => {
		const { handlers } = wireWindow();
		attach(handlers, partition, DATAVIEW_GUEST_URL);
		expect(fromPartition).toHaveBeenCalledWith(partition);
		const ses = guestSessions.get(partition)!;
		const requestHandler = ses.setPermissionRequestHandler.mock.calls[0][0] as Handler;
		const checkHandler = ses.setPermissionCheckHandler.mock.calls[0][0] as Handler;
		for (const permission of [
			'media',
			'camera',
			'microphone',
			'geolocation',
			'notifications',
			'clipboard-read',
			'clipboard-sanitized-write',
			'midi',
			'midiSysex',
			'pointerLock',
			'fullscreen',
			'openExternal',
			'display-capture',
			'hid',
			'serial',
			'usb',
			'storage-access',
			'window-management',
			'unknown',
		]) {
			const callback = vi.fn();
			requestHandler({}, permission, callback, {});
			expect(callback, permission).toHaveBeenCalledWith(false);
			expect(checkHandler({}, permission, DATAVIEW_GUEST_URL, {}), permission).toBe(false);
		}
	});

	it('cancels every request off the guest scheme, and serves the guest scheme through the guest host', () => {
		const { handlers } = wireWindow();
		attach(handlers, partition, DATAVIEW_GUEST_URL);
		const ses = guestSessions.get(partition)!;
		expect(ses.protocol.handle).toHaveBeenCalledWith('dataview-guest', expect.any(Function));
		const onBeforeRequest = ses.webRequest.onBeforeRequest.mock.calls[0][0] as Handler;
		const decide = (url: string) => {
			let cancel: boolean | undefined;
			onBeforeRequest({ url }, (response: { cancel: boolean }) => (cancel = response.cancel));
			return cancel;
		};
		for (const url of [
			'https://example.com/',
			'http://127.0.0.1:8080/',
			'wss://example.com/socket',
			'file:///etc/passwd',
			'app://app/index.html',
			'plugin://com.example/panel.html',
			'data:text/html,hi',
			'blob:null/1234',
		]) {
			expect(decide(url), url).toBe(true);
		}
		expect(decide(DATAVIEW_GUEST_URL)).toBe(false);
	});

	it('locks an attached guest down: no popups, no navigation, muted, and no privileged paste', () => {
		const { handlers, send } = wireWindow();
		attach(handlers, partition, DATAVIEW_GUEST_URL);
		const guestHandlers = new Map<string, Handler>();
		const guest = {
			session: guestSessions.get(partition),
			on: vi.fn((event: string, handler: Handler) => guestHandlers.set(event, handler)),
			setWindowOpenHandler: vi.fn(),
			setAudioMuted: vi.fn(),
			paste: vi.fn(),
			executeJavaScript: vi.fn(),
		};
		handlers.get('did-attach-webview')!({}, guest);

		const openHandler = guest.setWindowOpenHandler.mock.calls[0][0] as Handler;
		expect(openHandler({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
		for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
			const preventDefault = vi.fn();
			guestHandlers.get(event)!(
				{ preventDefault, url: 'https://example.com/' },
				'https://example.com/'
			);
			expect(preventDefault, event).toHaveBeenCalled();
		}
		expect(guest.setAudioMuted).toHaveBeenCalledWith(true);

		// Only the lockdown and the shortcut forwarder listen; no console bridge, context menu, or injection.
		expect([...guestHandlers.keys()].sort()).toEqual([
			'before-input-event',
			'will-frame-navigate',
			'will-navigate',
			'will-redirect',
		]);
		expect(guest.executeJavaScript).not.toHaveBeenCalled();

		const pasteEvent = { preventDefault: vi.fn() };
		guestHandlers.get('before-input-event')!(pasteEvent, {
			type: 'keyDown',
			key: 'v',
			code: 'KeyV',
			meta: true,
			control: false,
			alt: false,
			shift: false,
		});
		expect(guest.paste).not.toHaveBeenCalled();
		expect(pasteEvent.preventDefault).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// The guest preload
// ---------------------------------------------------------------------------

describe('the guest preload (src/main/preload/dataview-guest.ts)', () => {
	const preload = parse(PRELOAD_PATH);

	it('imports only ipcRenderer from electron, and never contextBridge', () => {
		const electronImports = preload.statements.filter(
			(statement): statement is ts.ImportDeclaration =>
				ts.isImportDeclaration(statement) &&
				ts.isStringLiteral(statement.moduleSpecifier) &&
				statement.moduleSpecifier.text === 'electron'
		);
		expect(electronImports).toHaveLength(1);
		const bindings = electronImports[0].importClause?.namedBindings;
		expect(bindings && ts.isNamedImports(bindings)).toBe(true);
		const names = (bindings as ts.NamedImports).elements.map((element) => element.name.text);
		expect(names).toEqual(['ipcRenderer']);

		const identifiers = findAll(preload, (node): node is ts.Identifier =>
			ts.isIdentifier(node)
		).map((node) => node.text);
		expect(identifiers).not.toContain('contextBridge');
		expect(identifiers).not.toContain('exposeInMainWorld');
		expect(identifiers).not.toContain('require');
	});

	it('uses ipcRenderer only to talk to its embedder, never to call main', () => {
		const used = findAll(
			preload,
			(node): node is ts.PropertyAccessExpression =>
				ts.isPropertyAccessExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'ipcRenderer'
		).map((node) => node.name.text);
		expect(used.length).toBeGreaterThan(0);
		expect([...new Set(used)].sort()).toEqual(['on', 'sendToHost']);
	});

	it('never writes to window, so the page sees nothing from the preload', () => {
		const writes = findAll(
			preload,
			(node): node is ts.BinaryExpression =>
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
				/^(window|globalThis|self)\b/.test(node.left.getText())
		);
		expect(writes.map((node) => node.getText())).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// dataview:readInRoot over the real file system
// ---------------------------------------------------------------------------

describe('dataview:readInRoot (DataviewService over the local file system)', () => {
	let root: string;
	let outside: string;
	let service: DataviewService;

	beforeEach(() => {
		// realpath: macOS hands out /var/folders/... under the /private/var symlink.
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-sandbox-root-')));
		outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-sandbox-outside-')));
		fs.mkdirSync(path.join(root, 'Notes'));
		fs.mkdirSync(path.join(root, 'data'));
		fs.mkdirSync(path.join(root, '.obsidian'));
		fs.writeFileSync(path.join(root, 'Notes', 'Note.md'), '# Note\n');
		fs.writeFileSync(path.join(root, 'data', 'people.csv'), 'name\nA\n');
		fs.writeFileSync(path.join(root, '.obsidian', 'app.json'), '{"token":"secret"}');
		fs.writeFileSync(path.join(outside, 'secret.md'), 'outside secret');
		service = new DataviewService({
			cacheDir: () => null,
			watch: false,
			resolveRoot: async () => root,
			resolveAgent: () => ({ agentCwd: root, sshRemoteId: null }),
			isEnabled: () => true,
			isJsEnabled: () => true,
			trustedRoots: () => [root],
			setTrustedRoots: () => {},
		});
	});

	afterEach(async () => {
		await service.disposeAll();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	});

	const read = (requested: string) =>
		service.readInRoot({
			filePath: path.join(root, 'Notes', 'Note.md'),
			agentId: 'local',
			path: requested,
		});

	it('reads a file inside the root', async () => {
		await expect(read('data/people.csv')).resolves.toMatchObject({
			root,
			path: 'data/people.csv',
			text: 'name\nA\n',
		});
	});

	it('refuses traversal, absolute and drive paths, the root itself, and dot folders', async () => {
		for (const requested of [
			'../outside.md',
			'data/../../outside.md',
			`../${path.basename(outside)}/secret.md`,
			path.join(outside, 'secret.md'),
			'/etc/passwd',
			'C:\\Windows\\win.ini',
			'C:/Windows/win.ini',
			'\\\\server\\share\\x',
			'',
			'.',
			'.obsidian/app.json',
		]) {
			await expect(read(requested), requested).rejects.toThrow(/Dataview: /);
		}
	});

	it.skipIf(process.platform === 'win32')(
		'refuses a symlink that resolves outside the root or into a dot folder, and follows one that stays inside',
		async () => {
			fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'data', 'escape.md'));
			fs.symlinkSync(outside, path.join(root, 'linked-out'));
			fs.symlinkSync(path.join(root, 'data', 'people.csv'), path.join(root, 'alias.csv'));
			fs.symlinkSync(path.join(root, '.obsidian'), path.join(root, 'settings'));

			await expect(read('data/escape.md')).rejects.toThrow('resolves outside');
			await expect(read('linked-out/secret.md')).rejects.toThrow('resolves outside');
			await expect(read('alias.csv')).resolves.toMatchObject({ text: 'name\nA\n' });
			// Inside the real root, but a symlink must not lead around the dot-folder refusal.
			await expect(read('settings/app.json')).rejects.toThrow('DataviewJS cannot read');
		}
	);

	it('refuses everything in a root that is not trusted', async () => {
		const untrusted = new DataviewService({
			cacheDir: () => null,
			watch: false,
			resolveRoot: async () => root,
			resolveAgent: () => ({ agentCwd: root, sshRemoteId: null }),
			isEnabled: () => true,
			isJsEnabled: () => true,
			trustedRoots: () => [],
			setTrustedRoots: () => {},
		});
		try {
			await expect(
				untrusted.readInRoot({
					filePath: path.join(root, 'Notes', 'Note.md'),
					agentId: 'local',
					path: 'data/people.csv',
				})
			).rejects.toThrow('not trusted');
		} finally {
			await untrusted.disposeAll();
		}
	});
});

// ---------------------------------------------------------------------------
// The watchdog
// ---------------------------------------------------------------------------

describe.each(GUEST_HOSTS)('the run watchdog (%s)', (_name, hostPath) => {
	const frameSource = parse(hostPath);
	const isInlineHost = hostPath === INLINE_HOST_PATH;
	function functionBody(name: string): ts.Node {
		const declarations = findAll(
			frameSource,
			(node): node is ts.VariableDeclaration =>
				ts.isVariableDeclaration(node) && node.name.getText() === name
		);
		expect(declarations, name).toHaveLength(1);
		return declarations[0];
	}

	it('times out at 5 seconds, after 30 for the index build', () => {
		expect(DATAVIEW_JS_RUN_TIMEOUT_MS).toBe(5000);
		expect(DATAVIEW_JS_INDEX_TIMEOUT_MS).toBe(30_000);
	});

	it('arms every watchdog with one of the two budgets, the index budget once per run', () => {
		// The one function that builds a watchdog, and the argument that carries its budget.
		const [armName, budgetArg] = isInlineHost ? ['armWatchdog', 1] : ['runWatchdog', 0];
		const arm = functionBody(armName);
		const budgetParam = findAll(arm, (node): node is ts.ParameterDeclaration =>
			ts.isParameter(node)
		).find((param) => param.name.getText() === 'idleMs');
		expect(budgetParam, `${armName} takes the budget as idleMs`).toBeDefined();
		if (isInlineHost)
			expect(budgetParam!.initializer?.getText()).toBe('DATAVIEW_JS_RUN_TIMEOUT_MS');

		const arms = findAll(frameSource, (node): node is ts.CallExpression => isCallTo(node, armName));
		const budgets = arms.map(
			(call) => call.arguments[budgetArg]?.getText() ?? budgetParam!.initializer?.getText()
		);
		expect(budgets.length).toBeGreaterThanOrEqual(2);
		for (const budget of budgets)
			expect(['DATAVIEW_JS_INDEX_TIMEOUT_MS', 'DATAVIEW_JS_RUN_TIMEOUT_MS']).toContain(budget);
		expect(budgets.filter((budget) => budget === 'DATAVIEW_JS_INDEX_TIMEOUT_MS')).toHaveLength(1);
	});

	it('builds the watchdog in one place, with no maximum, and never touches it (wall clock)', () => {
		const watchdogs = findAll(frameSource, (node): node is ts.CallExpression =>
			isCallTo(node, 'createIdleWatchdog')
		);
		expect(watchdogs).toHaveLength(1);
		const options = watchdogs[0].arguments[0];
		expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
		const props = new Map(
			(options as ts.ObjectLiteralExpression).properties.map((p) => [p.name?.getText(), p])
		);
		// The budget is the arming function's parameter, checked by the test above.
		expect(props.get('idleMs')?.getText()).toBe('idleMs');
		expect(props.has('maxMs')).toBe(false);
		// Expiry destroys the guest with a timeout.
		const onIdle = props.get('onIdle');
		expect(onIdle).toBeDefined();
		const stops = findAll(onIdle!, (node): node is ts.CallExpression =>
			isCallTo(node, 'stopGuest')
		);
		expect(stops.map((call) => call.arguments[0]?.getText())).toEqual(["{ kind: 'timeout' }"]);

		const touches = findAll(
			frameSource,
			(node): node is ts.PropertyAccessExpression =>
				ts.isPropertyAccessExpression(node) && node.name.text === 'touch'
		);
		expect(
			touches.map((node) => node.getText()),
			'a touched watchdog is no longer wall clock'
		).toEqual([]);
	});

	it('destroys the guest by bumping its key, and does so for a dead guest process too', () => {
		const stopGuest = functionBody('stopGuest');
		expect(
			findAll(stopGuest, (node): node is ts.CallExpression => isCallTo(node, 'setGuestKey')),
			'stopGuest remounts the <webview>'
		).toHaveLength(1);
		if (isInlineHost) {
			// The expression the run was on is halted (the last argument of resolve) until it registers afresh.
			const resolves = findAll(
				stopGuest,
				(node): node is ts.CallExpression =>
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					node.expression.name.text === 'resolve'
			);
			expect(resolves.map((call) => call.arguments[call.arguments.length - 1]?.getText())).toEqual([
				'true',
			]);
		} else {
			expect(
				findAll(stopGuest, (node): node is ts.CallExpression => isCallTo(node, 'setHalted')).map(
					(call) => call.arguments[0]?.getText()
				),
				'and halts the block until the source changes or Run again'
			).toEqual(['true']);
		}

		const goneListeners = findAll(
			frameSource,
			(node): node is ts.CallExpression =>
				isCallTo(node, 'useEventListener') &&
				ts.isStringLiteral(node.arguments[0]) &&
				node.arguments[0].text === 'render-process-gone'
		);
		expect(goneListeners).toHaveLength(1);
		expect(
			findAll(goneListeners[0], (node): node is ts.CallExpression => isCallTo(node, 'stopGuest'))
		).toHaveLength(1);
	});
});
