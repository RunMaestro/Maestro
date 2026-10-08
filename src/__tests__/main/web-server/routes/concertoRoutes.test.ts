/**
 * Tests for ConcertoRoutes
 *
 * The web-desktop browser bundle cannot resolve the `maestro-concerto://`
 * scheme the Electron app serves HTML Movements from, so the web server exposes
 * the same documents over HTTP (#1442). The document body and, crucially, the
 * sandboxing headers must match the custom-scheme handler exactly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConcertoRoutes } from '../../../../main/web-server/routes/concertoRoutes';
import {
	applyMovementHtmlPayload,
	clearConcertoHtmlDocumentsForTests,
	CONCERTO_HTML_CSP,
} from '../../../../main/concerto-html';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const CONCERTO_TOKEN = 'concerto-token-abc';
const ROUTE = `/${CONCERTO_TOKEN}/concerto/render`;

function createMockFastify() {
	const routes = new Map<string, Function>();
	return {
		get: vi.fn((path: string, handler: Function) => {
			routes.set(`GET:${path}`, handler);
		}),
		getHandler: (path: string) => routes.get(`GET:${path}`),
		routes,
	};
}

function createMockReply() {
	const state: { code?: number; headers?: Record<string, string>; body?: unknown } = {};
	const reply: any = {
		code: vi.fn((value: number) => {
			state.code = value;
			return reply;
		}),
		type: vi.fn().mockReturnThis(),
		headers: vi.fn((value: Record<string, string>) => {
			state.headers = value;
			return reply;
		}),
		send: vi.fn((value: unknown) => {
			state.body = value;
			return reply;
		}),
		state,
	};
	return reply;
}

describe('ConcertoRoutes', () => {
	let concertoRoutes: ConcertoRoutes;
	let mockFastify: ReturnType<typeof createMockFastify>;

	beforeEach(() => {
		vi.clearAllMocks();
		clearConcertoHtmlDocumentsForTests();
		concertoRoutes = new ConcertoRoutes(CONCERTO_TOKEN);
		mockFastify = createMockFastify();
		concertoRoutes.registerRoutes(mockFastify as any);
	});

	it('registers the render route behind the concerto token', () => {
		expect(mockFastify.getHandler(ROUTE)).toBeDefined();
	});

	it('serves a registered document with the same policy headers as the protocol handler', async () => {
		const html = '<style>b{color:red}</style><button>Buy</button><script>window.ok=1</script>';
		applyMovementHtmlPayload({ op: 'add', id: 'mockup', viewType: 'html', body: html });

		const reply = createMockReply();
		await mockFastify.getHandler(ROUTE)!(
			{ query: { surface: 'movement', id: 'mockup', revision: '1' } },
			reply
		);

		expect(reply.state.code).toBeUndefined();
		expect(reply.state.body).toContain(html);
		expect(reply.state.headers?.['content-security-policy']).toBe(CONCERTO_HTML_CSP);
		expect(reply.state.headers?.['content-type']).toBe('text/html; charset=utf-8');
		expect(reply.state.headers?.['cache-control']).toBe('no-store');
		expect(reply.state.headers?.['x-content-type-options']).toBe('nosniff');
	});

	it('rejects an unknown surface', async () => {
		const reply = createMockReply();
		await mockFastify.getHandler(ROUTE)!({ query: { surface: 'stage', id: 'mockup' } }, reply);
		expect(reply.state.code).toBe(400);
	});

	it('rejects a missing id', async () => {
		const reply = createMockReply();
		await mockFastify.getHandler(ROUTE)!({ query: { surface: 'movement' } }, reply);
		expect(reply.state.code).toBe(400);
	});

	it('404s a document that is not registered', async () => {
		const reply = createMockReply();
		await mockFastify.getHandler(ROUTE)!({ query: { surface: 'movement', id: 'gone' } }, reply);
		expect(reply.state.code).toBe(404);
	});
});
