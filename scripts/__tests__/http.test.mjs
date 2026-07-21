import { afterEach, expect, test } from 'bun:test';
import http from 'node:http';
import { httpsGet } from '../lib/http.mjs';

const servers = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((server) => {
			server.closeAllConnections();
			return new Promise((resolve) => server.close(resolve));
		})
	);
});

async function serve(handler) {
	const server = http.createServer(handler);
	servers.push(server);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return `http://127.0.0.1:${port}`;
}

test('httpsGet preserves successful UTF-8 bodies, response headers, caller headers, and direct proxy policy', async () => {
	let proxyRequests = 0;
	const proxyUrl = await serve((_request, response) => {
		proxyRequests++;
		response.writeHead(502);
		response.end();
	});
	const originalProxy = process.env.HTTP_PROXY;
	process.env.HTTP_PROXY = proxyUrl;
	try {
		const baseUrl = await serve((request, response) => {
			expect(request.headers['user-agent']).toBe('Maestro-Test');
			response.setHeader('x-source', 'fixture');
			response.end('✓');
		});

		const response = await httpsGet(`${baseUrl}/success`, {
			headers: { 'User-Agent': 'Maestro-Test' },
		});
		expect(response).toMatchObject({ data: '✓', headers: { 'x-source': 'fixture' } });
		expect(proxyRequests).toBe(0);
	} finally {
		if (originalProxy === undefined) delete process.env.HTTP_PROXY;
		else process.env.HTTP_PROXY = originalProxy;
	}
});

test('httpsGet follows 301 and 302 redirects with the original headers', async () => {
	const baseUrl = await serve((request, response) => {
		if (request.url === '/start') {
			response.writeHead(301, { Location: `${baseUrl}/middle` });
			response.end();
			return;
		}
		if (request.url === '/middle') {
			response.writeHead(302, { Location: `${baseUrl}/final` });
			response.end();
			return;
		}
		expect(request.headers['x-refresh']).toBe('present');
		response.end('redirected');
	});

	await expect(
		httpsGet(`${baseUrl}/start`, { headers: { 'X-Refresh': 'present' } })
	).resolves.toMatchObject({ data: 'redirected' });
});

test('httpsGet retains non-200 error text', async () => {
	const baseUrl = await serve((_request, response) => {
		response.writeHead(404);
		response.end('missing');
	});
	const url = `${baseUrl}/missing`;

	await expect(httpsGet(url)).rejects.toThrow(`HTTP 404: ${url}`);
});

test('httpsGet rejects with the caller timeout text', async () => {
	const baseUrl = await serve(() => {});
	const url = `${baseUrl}/slow`;

	await expect(httpsGet(url, { timeoutMs: 50 })).rejects.toThrow(
		`Request timed out after 50ms: ${url}`
	);
});

test('httpsGet rejects a truncated response', async () => {
	const baseUrl = await serve((_request, response) => {
		response.writeHead(200, { 'Content-Length': '20' });
		response.write('partial');
		response.socket.destroy();
	});

	await expect(httpsGet(`${baseUrl}/truncated`)).rejects.toThrow();
});
