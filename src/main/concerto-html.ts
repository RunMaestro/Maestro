/**
 * Main-process registry and protocol response for interactive Concerto HTML.
 * Documents stay in memory and are served under a dedicated scheme so their
 * own restrictive CSP can permit inline scripts without weakening Maestro's
 * renderer CSP.
 */

import type { WebContents } from 'electron';
import type { CadenzaPayload } from '../shared/cadenza-types';
import type { MovementPayload } from '../shared/movement-types';
import {
	CONCERTO_DESIGNER_CHANNEL,
	parseConcertoHtmlUrl,
	isConcertoHtmlUrl,
	type ConcertoHtmlSurface,
} from '../shared/concerto-html';

export const MAX_CONCERTO_HTML_BYTES = 1_000_000;
const MAX_CONCERTO_HTML_DOCUMENTS = 64;

export const CONCERTO_HTML_CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline' blob:",
	"style-src 'unsafe-inline'",
	'img-src data: blob:',
	'font-src data:',
	'media-src data: blob:',
	"connect-src 'none'",
	"object-src 'none'",
	"frame-src 'none'",
	"child-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
	'sandbox allow-scripts',
].join('; ');

const documents = new Map<string, string>();

/**
 * Runs inside the sandboxed mockup. It exposes a narrow designer harness to
 * the parent renderer: lifecycle/console diagnostics plus click and type by
 * CSS selector. It cannot access Maestro, Node.js, Electron, or the network.
 */
const CONCERTO_DESIGNER_BOOTSTRAP = `<script>
(() => {
	const channel = ${JSON.stringify(CONCERTO_DESIGNER_CHANNEL)};
	const send = (payload) => parent.postMessage({ channel, ...payload }, '*');
	const format = (value) => {
		if (value instanceof Error) return value.stack || value.message;
		if (typeof value === 'string') return value;
		if (typeof value === 'undefined') return 'undefined';
		if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
		try {
			const seen = new WeakSet();
			return JSON.stringify(value, (_key, item) => {
				if (item && typeof item === 'object') {
					if (seen.has(item)) return '[Circular]';
					seen.add(item);
				}
				return item;
			});
		} catch {
			return String(value);
		}
	};
	for (const level of ['log', 'info', 'warn', 'error']) {
		const original = console[level].bind(console);
		console[level] = (...args) => {
			send({ kind: 'console', level, message: args.map(format).join(' ').slice(0, 4000), timestamp: Date.now() });
			original(...args);
		};
	}
	addEventListener('error', (event) => {
		send({
			kind: 'console',
			level: 'error',
			message: String(event.error?.stack || event.message || 'Unknown runtime error').slice(0, 4000),
			timestamp: Date.now(),
			line: event.lineno || undefined,
			column: event.colno || undefined,
		});
	});
	addEventListener('unhandledrejection', (event) => {
		send({
			kind: 'console',
			level: 'error',
			message: ('Unhandled promise rejection: ' + format(event.reason)).slice(0, 4000),
			timestamp: Date.now(),
		});
	});
	const summarize = (element) => ({
		tag: element.tagName.toLowerCase(),
		text: String(element.innerText || element.textContent || '').trim().slice(0, 500),
		ariaLabel: element.getAttribute('aria-label') || undefined,
	});
	addEventListener('message', (event) => {
		const data = event.data;
		if (event.source !== parent || !data || data.channel !== channel || data.kind !== 'command') return;
		const reply = (result) => send({ kind: 'command-result', requestId: data.requestId, ...result });
		let element;
		try {
			element = document.querySelector(data.selector);
		} catch (error) {
			reply({ ok: false, action: data.action, selector: data.selector, message: 'Invalid CSS selector: ' + format(error) });
			return;
		}
		if (!element) {
			reply({ ok: false, action: data.action, selector: data.selector, message: 'No element matched the selector' });
			return;
		}
		if (data.action === 'click') {
			if (typeof element.click === 'function') element.click();
			else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			reply({ ok: true, action: data.action, selector: data.selector, message: 'Clicked element', element: summarize(element) });
			return;
		}
		if (data.action === 'type') {
			const value = String(data.value ?? '');
			if ('value' in element) element.value = value;
			else if (element.isContentEditable) element.textContent = value;
			else {
				reply({ ok: false, action: data.action, selector: data.selector, message: 'Matched element is not editable', element: summarize(element) });
				return;
			}
			element.dispatchEvent(new Event('input', { bubbles: true }));
			element.dispatchEvent(new Event('change', { bubbles: true }));
			reply({ ok: true, action: data.action, selector: data.selector, message: 'Entered text', element: summarize(element) });
			return;
		}
		reply({ ok: false, action: String(data.action), selector: data.selector, message: 'Unsupported designer action' });
	});
	const ready = () => send({ kind: 'ready', timestamp: Date.now() });
	if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready, { once: true });
	else queueMicrotask(ready);
})();
</script>`;

export function injectConcertoDesignerBootstrap(html: string): string {
	const head = /<head(?:\s[^>]*)?>/i.exec(html);
	if (head?.index !== undefined) {
		const insertionPoint = head.index + head[0].length;
		return `${html.slice(0, insertionPoint)}${CONCERTO_DESIGNER_BOOTSTRAP}${html.slice(insertionPoint)}`;
	}
	const doctype = /<!doctype[^>]*>/i.exec(html);
	if (doctype?.index !== undefined) {
		const insertionPoint = doctype.index + doctype[0].length;
		return `${html.slice(0, insertionPoint)}${CONCERTO_DESIGNER_BOOTSTRAP}${html.slice(insertionPoint)}`;
	}
	return `${CONCERTO_DESIGNER_BOOTSTRAP}${html}`;
}

function documentKey(surface: ConcertoHtmlSurface, id: string): string {
	return `${surface}\0${id}`;
}

function setDocument(surface: ConcertoHtmlSurface, id: string, html: string): void {
	const bytes = Buffer.byteLength(html, 'utf8');
	if (bytes > MAX_CONCERTO_HTML_BYTES) {
		throw new Error(`Concerto HTML exceeds the ${MAX_CONCERTO_HTML_BYTES}-byte size limit`);
	}
	const key = documentKey(surface, id);
	documents.delete(key);
	documents.set(key, html);
	while (documents.size > MAX_CONCERTO_HTML_DOCUMENTS) {
		const oldest = documents.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		documents.delete(oldest);
	}
}

function deleteDocument(surface: ConcertoHtmlSurface, id: string): void {
	documents.delete(documentKey(surface, id));
}

function clearSurface(surface: ConcertoHtmlSurface): void {
	for (const key of documents.keys()) {
		if (key.startsWith(`${surface}\0`)) documents.delete(key);
	}
}

function hasDocument(surface: ConcertoHtmlSurface, id: string): boolean {
	return documents.has(documentKey(surface, id));
}

export function applyMovementHtmlPayload(payload: MovementPayload): void {
	if (payload.op === 'clear') {
		clearSurface('movement');
		return;
	}
	if (!payload.id) return;
	if (payload.op === 'remove') {
		deleteDocument('movement', payload.id);
		return;
	}
	if (payload.op === 'move') return;
	if (payload.viewType === 'view') {
		deleteDocument('movement', payload.id);
		return;
	}
	const isHtml = payload.viewType === 'html' || hasDocument('movement', payload.id);
	if (isHtml && payload.body !== undefined) setDocument('movement', payload.id, payload.body);
}

export function applyCadenzaHtmlPayload(payload: CadenzaPayload): void {
	if (payload.op === 'close') {
		deleteDocument('cadenza', payload.id);
		return;
	}
	if (payload.viewType !== undefined && payload.viewType !== 'html') {
		deleteDocument('cadenza', payload.id);
		return;
	}
	const isHtml = payload.viewType === 'html' || hasDocument('cadenza', payload.id);
	if (isHtml && payload.body !== undefined) setDocument('cadenza', payload.id, payload.body);
}

export function createConcertoHtmlResponse(requestUrl: string): Response {
	const target = parseConcertoHtmlUrl(requestUrl);
	if (!target) return new Response('bad request', { status: 400 });
	const html = documents.get(documentKey(target.surface, target.id));
	if (html === undefined) return new Response('not found', { status: 404 });
	return new Response(injectConcertoDesignerBootstrap(html), {
		status: 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'content-security-policy': CONCERTO_HTML_CSP,
			'permissions-policy':
				'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=(), payment=(), usb=()',
			'x-content-type-options': 'nosniff',
		},
	});
}

/** Block a Concerto document from navigating its own frame away from the local scheme. */
export function attachConcertoHtmlNavigationGuard(webContents: WebContents): void {
	webContents.on('will-frame-navigate', (details) => {
		if (isConcertoHtmlUrl(details.url)) return;
		const currentUrl = details.frame?.url;
		const initiatorUrl = details.initiator?.url;
		if (isConcertoHtmlUrl(currentUrl) || isConcertoHtmlUrl(initiatorUrl)) {
			details.preventDefault();
		}
	});
}

/** Test-only reset for the in-memory registry. */
export function clearConcertoHtmlDocumentsForTests(): void {
	documents.clear();
}
