import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyCadenzaHtmlPayload,
	applyMovementHtmlPayload,
	attachConcertoHtmlNavigationGuard,
	clearConcertoHtmlDocumentsForTests,
	CODEX_VISUALIZATION_CSP,
	CONCERTO_HTML_CSP,
	createConcertoHtmlResponse,
	getConcertoHtmlDocumentRevision,
	injectConcertoDesignerBootstrap,
	MAX_CONCERTO_HTML_BYTES,
	MAX_CONCERTO_HTML_DOCUMENTS,
	MAX_CODEX_VISUALIZATION_DOCUMENTS,
	registerCodexVisualizationDocument,
	releaseConcertoHtmlDocument,
	restoreConcertoHtmlDocument,
} from '../../main/concerto-html';
import { buildConcertoHtmlUrl, CONCERTO_DESIGNER_CHANNEL } from '../../shared/concerto-html';

describe('Concerto HTML document protocol', () => {
	beforeEach(clearConcertoHtmlDocumentsForTests);

	it('serves inline CSS and JavaScript with a restrictive response policy', async () => {
		const html =
			'<style>button{color:red}</style><button>Buy</button><script>window.ready=true</script>';
		applyMovementHtmlPayload({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			body: html,
		});

		const response = createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup', 1));
		expect(response.status).toBe(200);
		const served = await response.text();
		expect(served).toContain(html);
		expect(served).toContain(CONCERTO_DESIGNER_CHANNEL);
		expect(served).toContain("data.action === 'click'");
		expect(served.indexOf("'RTCPeerConnection'")).toBeLessThan(served.indexOf('window.ready=true'));
		expect(response.headers.get('content-security-policy')).toBe(CONCERTO_HTML_CSP);
		expect(CONCERTO_HTML_CSP).toContain("script-src 'unsafe-inline' blob:");
		expect(CONCERTO_HTML_CSP).toContain("connect-src 'none'");
		expect(CONCERTO_HTML_CSP).toContain("webrtc 'block'");
		expect(CONCERTO_HTML_CSP).toContain("frame-src 'none'");
		expect(CONCERTO_HTML_CSP).toContain('sandbox allow-scripts');
		expect(response.headers.get('x-dns-prefetch-control')).toBe('off');
	});

	it('updates an existing HTML document without requiring viewType again', async () => {
		applyCadenzaHtmlPayload({
			op: 'open',
			id: 'mini',
			viewType: 'html',
			body: '<button>First</button>',
		});
		applyCadenzaHtmlPayload({ op: 'update', id: 'mini', body: '<button>Second</button>' });

		const response = createConcertoHtmlResponse(buildConcertoHtmlUrl('cadenza', 'mini', 2));
		expect(await response.text()).toContain('<button>Second</button>');
	});

	it('injects the designer harness at the start of head', () => {
		const result = injectConcertoDesignerBootstrap(
			'<!doctype html><html><head><title>Mockup</title></head><body></body></html>'
		);
		expect(result.indexOf(CONCERTO_DESIGNER_CHANNEL)).toBeGreaterThan(result.indexOf('<head>'));
		expect(result.indexOf(CONCERTO_DESIGNER_CHANNEL)).toBeLessThan(result.indexOf('<title>'));
	});

	it('removes documents and rejects oversized payloads', () => {
		applyMovementHtmlPayload({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			body: '<p>ok</p>',
		});
		applyMovementHtmlPayload({ op: 'remove', id: 'mockup' });
		expect(createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup', 1)).status).toBe(
			404
		);

		expect(() =>
			applyMovementHtmlPayload({
				op: 'add',
				id: 'too-large',
				viewType: 'html',
				body: 'x'.repeat(MAX_CONCERTO_HTML_BYTES + 1),
			})
		).toThrow(/size limit/);
	});

	it('assigns a new revision whenever HTML content changes', () => {
		const first = applyMovementHtmlPayload({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			body: '<p>first</p>',
		});
		const second = applyMovementHtmlPayload({
			op: 'update',
			id: 'mockup',
			body: '<p>second</p>',
		});

		expect(first.revision).toBe(1);
		expect(second.revision).toBe(2);
		expect(getConcertoHtmlDocumentRevision('movement', 'mockup')).toBe(2);
	});

	it('restores a released document with a fresh revision', async () => {
		applyMovementHtmlPayload({
			op: 'add',
			id: 'mockup',
			viewType: 'html',
			body: '<p>original</p>',
		});
		releaseConcertoHtmlDocument('movement', 'mockup');

		const revision = restoreConcertoHtmlDocument('movement', 'mockup', '<p>fresh</p>');

		expect(revision).toBe(2);
		const response = createConcertoHtmlResponse(
			buildConcertoHtmlUrl('movement', 'mockup', revision)
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('<p>fresh</p>');
	});

	it('rejects capacity instead of evicting a live document and accepts explicit release', () => {
		for (let index = 0; index < MAX_CONCERTO_HTML_DOCUMENTS; index += 1) {
			applyMovementHtmlPayload({
				op: 'add',
				id: `mockup-${index}`,
				viewType: 'html',
				body: `<p>${index}</p>`,
			});
		}

		expect(() =>
			applyMovementHtmlPayload({
				op: 'add',
				id: 'overflow',
				viewType: 'html',
				body: '<p>overflow</p>',
			})
		).toThrow(/document limit reached/);
		expect(createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup-0', 1)).status).toBe(
			200
		);

		releaseConcertoHtmlDocument('movement', 'mockup-0');
		expect(createConcertoHtmlResponse(buildConcertoHtmlUrl('movement', 'mockup-0', 1)).status).toBe(
			404
		);
		expect(() =>
			applyMovementHtmlPayload({
				op: 'add',
				id: 'replacement',
				viewType: 'html',
				body: '<p>replacement</p>',
			})
		).not.toThrow();
	});

	it('blocks an HTML frame from navigating away from the local protocol', () => {
		let guard:
			| ((details: {
					preventDefault: () => void;
					isMainFrame: boolean;
					url: string;
					frame: { url: string } | null;
					initiator: { url: string } | null;
			  }) => void)
			| undefined;
		const webContents = {
			on: vi.fn((name: string, listener: typeof guard) => {
				if (name === 'will-frame-navigate') guard = listener;
			}),
		};
		attachConcertoHtmlNavigationGuard(webContents as never);
		const preventDefault = vi.fn();
		guard?.({
			preventDefault,
			isMainFrame: false,
			url: 'https://example.com/exfiltrate',
			frame: { url: buildConcertoHtmlUrl('movement', 'mockup', 1) },
			initiator: null,
		});
		expect(preventDefault).toHaveBeenCalledOnce();

		guard?.({
			preventDefault,
			isMainFrame: true,
			url: 'https://example.com/top-navigation',
			frame: { url: 'file:///maestro/index.html' },
			initiator: { url: buildConcertoHtmlUrl('movement', 'mockup', 1) },
		});
		expect(preventDefault).toHaveBeenCalledTimes(2);
	});

	it('serves a Codex visualization under its own CDN-allowlist policy', async () => {
		const revision = registerCodexVisualizationDocument('viz', '<div id="v">chart</div>');
		const response = createConcertoHtmlResponse(
			buildConcertoHtmlUrl('visualization', 'viz', revision)
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('<div id="v">chart</div>');
		const csp = response.headers.get('content-security-policy');
		expect(csp).toBe(CODEX_VISUALIZATION_CSP);
		expect(csp).toContain('https://unpkg.com');
		expect(csp).toContain('connect-src blob: data:');
		expect(csp).toContain("webrtc 'block'");
		expect(csp).toContain('sandbox allow-scripts');
	});

	it('keeps a visualization revision while its HTML is unchanged', () => {
		const first = registerCodexVisualizationDocument('viz', '<p>a</p>');
		expect(registerCodexVisualizationDocument('viz', '<p>a</p>')).toBe(first);
		expect(registerCodexVisualizationDocument('viz', '<p>b</p>')).toBeGreaterThan(first);
	});

	it('evicts the oldest visualization instead of filling the registry', () => {
		for (let i = 0; i <= MAX_CODEX_VISUALIZATION_DOCUMENTS; i += 1) {
			registerCodexVisualizationDocument(`viz-${i}`, `<p>${i}</p>`);
		}
		expect(getConcertoHtmlDocumentRevision('visualization', 'viz-0')).toBeNull();
		expect(
			getConcertoHtmlDocumentRevision('visualization', `viz-${MAX_CODEX_VISUALIZATION_DOCUMENTS}`)
		).not.toBeNull();
		expect(getConcertoHtmlDocumentRevision('visualization', 'viz-1')).not.toBeNull();
	});
});
