/**
 * Maestro Web Service Worker
 *
 * Provides light offline resilience for the web-desktop bundle served through
 * the embedded web server. The bundle's JS/CSS assets are content-hashed and
 * change every build, so this worker does NOT precache a fixed asset list
 * (which would go stale). Instead it caches conservatively at runtime:
 *
 * - network-first for navigations (the HTML document) and for the desktop
 *   bundle assets under `/<token>/desktop/assets/*` - online always serves
 *   fresh content, identical to having no service worker; the cache is only a
 *   fallback when the network is down.
 * - cache-first for `/<token>/icons/*` and `manifest.json` - effectively
 *   immutable, so serving them from cache keeps the home-screen icon and PWA
 *   metadata available offline without changing the bytes.
 * - network-only for `/<token>/api/*` and `/<token>/ws/*` - these require a
 *   live connection; offline they return a structured JSON error.
 * - everything else is left to the browser's default handling.
 */

const CACHE_NAME = 'maestro-webdesktop-v1';

// Install: no precache. The runtime strategy below populates the cache as the
// app is used, so there is no fixed asset list to go stale on rebuild.
self.addEventListener('install', (event) => {
	console.log('[SW] Installing service worker...');
	// Activate immediately instead of waiting for existing tabs to close.
	event.waitUntil(self.skipWaiting());
});

// Activate: drop caches from older worker versions (including the legacy
// mobile precache), then take control of open pages immediately.
self.addEventListener('activate', (event) => {
	console.log('[SW] Activating service worker...');

	event.waitUntil(
		caches
			.keys()
			.then((cacheNames) => {
				return Promise.all(
					cacheNames
						.filter((name) => name.startsWith('maestro-') && name !== CACHE_NAME)
						.map((name) => {
							console.log('[SW] Deleting old cache:', name);
							return caches.delete(name);
						})
				);
			})
			.then(() => {
				console.log('[SW] Activation complete');
				return self.clients.claim();
			})
	);
});

// Fetch: route each request to the appropriate strategy.
self.addEventListener('fetch', (event) => {
	const { request } = event;

	// Only GET requests are cacheable; everything else passes through untouched.
	if (request.method !== 'GET') {
		return;
	}

	const url = new URL(request.url);

	// Never intercept WebSocket upgrades.
	if (url.protocol === 'ws:' || url.protocol === 'wss:') {
		return;
	}

	// API / WS paths require a live connection - network only, with a JSON
	// offline fallback so callers get a structured error instead of a throw.
	if (url.pathname.includes('/api/') || url.pathname.includes('/ws/')) {
		event.respondWith(
			fetch(request).catch(
				() =>
					new Response(
						JSON.stringify({
							error: 'offline',
							message: 'You are offline. Please reconnect to use Maestro.',
						}),
						{
							status: 503,
							statusText: 'Service Unavailable',
							headers: { 'Content-Type': 'application/json' },
						}
					)
			)
		);
		return;
	}

	// Icons and the manifest are effectively immutable - cache-first keeps them
	// available offline. Online, the first request still misses the cache and
	// hits the network, so the bytes are identical.
	if (url.pathname.includes('/icons/') || url.pathname.endsWith('/manifest.json')) {
		event.respondWith(cacheFirst(request));
		return;
	}

	// Navigations (the HTML document) and the desktop bundle assets are
	// network-first: online serves fresh content (identical to no service
	// worker), and the cached copy is only used when the network fails.
	if (request.mode === 'navigate' || url.pathname.includes('/desktop/assets/')) {
		event.respondWith(networkFirst(request));
		return;
	}

	// Anything else: leave it to the browser's default handling. Not calling
	// respondWith() is the most conservative choice - indistinguishable from
	// having no service worker at all.
});

/**
 * Cache-first: serve from cache when present, otherwise fetch and cache.
 */
async function cacheFirst(request) {
	const cached = await caches.match(request);
	if (cached) {
		return cached;
	}
	const response = await fetch(request);
	if (response && response.ok) {
		const cache = await caches.open(CACHE_NAME);
		cache.put(request, response.clone());
	}
	return response;
}

/**
 * Network-first: fetch and cache on success; fall back to cache (and, for
 * navigations, the cached app root) when the network is unavailable.
 */
async function networkFirst(request) {
	try {
		const response = await fetch(request);
		if (response && response.ok) {
			const cache = await caches.open(CACHE_NAME);
			cache.put(request, response.clone());
		}
		return response;
	} catch (error) {
		const cached = await caches.match(request);
		if (cached) {
			return cached;
		}
		// Last resort for a navigation with no cached copy: the app root.
		if (request.mode === 'navigate') {
			const root = await caches.match(self.registration.scope);
			if (root) {
				return root;
			}
		}
		throw error;
	}
}

// Handle messages from the main app.
self.addEventListener('message', (event) => {
	if (event.data === 'skipWaiting') {
		self.skipWaiting();
	}

	// Allow the main app to check if the SW is active (see pingServiceWorker).
	if (event.data === 'ping') {
		event.ports[0]?.postMessage('pong');
	}
});

// Broadcast connection status changes to all clients so the UI can reflect
// offline state (consumed by serviceWorker.ts's onOfflineChange handler).
async function broadcastToClients(message) {
	const clients = await self.clients.matchAll({ type: 'window' });
	clients.forEach((client) => {
		client.postMessage(message);
	});
}

self.addEventListener('online', () => {
	console.log('[SW] Online');
	broadcastToClients({ type: 'connection-change', online: true });
});

self.addEventListener('offline', () => {
	console.log('[SW] Offline');
	broadcastToClients({ type: 'connection-change', online: false });
});
