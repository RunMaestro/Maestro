import http from 'node:http';
import https from 'node:https';

function transportFor(url) {
	return new URL(url).protocol === 'http:' ? http : https;
}

/**
 * Gets a text resource using the refresh scripts' shared transport mechanics.
 * Callers retain their own headers, timeout, parsing, and destination policy.
 */
export function httpsGet(url, options = {}) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timeout;

		const settle = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			callback(value);
		};

		const request = transportFor(url).get(url, { headers: options.headers }, (response) => {
			if (response.statusCode === 301 || response.statusCode === 302) {
				response.resume();
				settle(resolve, httpsGet(response.headers.location, options));
				return;
			}

			if (response.statusCode !== 200) {
				response.resume();
				settle(reject, new Error(`HTTP ${response.statusCode}: ${url}`));
				return;
			}

			let data = '';
			response.setEncoding('utf8');
			response.on('data', (chunk) => (data += chunk));
			response.on('end', () => settle(resolve, { data, headers: response.headers }));
			response.on('aborted', () => settle(reject, new Error(`Response aborted: ${url}`)));
			response.on('error', (error) => settle(reject, error));
		});

		if (options.timeoutMs !== undefined) {
			timeout = setTimeout(() => {
				const error = new Error(`Request timed out after ${options.timeoutMs}ms: ${url}`);
				settle(reject, error);
				request.destroy(error);
			}, options.timeoutMs);
		}
		request.on('error', (error) => settle(reject, error));
	});
}
