/**
 * Vite config for the Maestro Web-Desktop bundle.
 *
 * Builds the same src/renderer tree that Electron loads, but for the browser,
 * by aliasing `electron` and `@sentry/electron/renderer` to web-side shims.
 * window.maestro is populated by the preload factories (which run unchanged
 * under the alias) and ipcRenderer.invoke calls become bridge.invoke WS frames.
 *
 * Output: dist/web-desktop/
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';

const packageJson = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
const appVersion = process.env.VITE_APP_VERSION || packageJson.version;

export default defineConfig(({ mode }) => ({
	plugins: [react()],

	root: path.join(__dirname, 'src/web-desktop'),
	// Copy the PWA assets (manifest.json, service worker, icons/) from the shared
	// public dir into the bundle output so the Fastify server can serve them
	// alongside the app. This is the only surviving consumer of src/web/public
	// after the legacy mobile bundle was retired.
	publicDir: path.join(__dirname, 'src/web/public'),
	base: './',

	define: {
		__APP_VERSION__: JSON.stringify(appVersion),
		__GIT_HASH__: JSON.stringify('web-desktop'),
		'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
	},

	esbuild: {
		drop: mode === 'production' ? ['debugger'] : [],
	},

	resolve: {
		alias: {
			// Aliases for the renderer's own imports.
			'@renderer': path.join(__dirname, 'src/renderer'),
			'@web': path.join(__dirname, 'src/web'),
			'@shared': path.join(__dirname, 'src/shared'),
			// Critical: redirect Electron + Sentry imports to web shims.
			electron: path.join(__dirname, 'src/web-desktop/electron-shim.ts'),
			'@sentry/electron/renderer': path.join(__dirname, 'src/web-desktop/sentry-shim.ts'),
			'@sentry/electron': path.join(__dirname, 'src/web-desktop/sentry-shim.ts'),
		},
	},

	build: {
		outDir: path.join(__dirname, 'dist/web-desktop'),
		emptyOutDir: true,
		sourcemap: true,
		rollupOptions: {
			input: {
				main: path.join(__dirname, 'src/web-desktop/index.html'),
			},
			output: {
				manualChunks: (id) => {
					if (id.includes('node_modules/react-dom')) {
						return 'vendor-react';
					}
					if (id.includes('node_modules/react/') || id.includes('node_modules/react-is')) {
						return 'vendor-react';
					}
					if (id.includes('node_modules/scheduler')) {
						return 'vendor-react';
					}
					// Keep these CJS-heavy libraries isolated. Letting Rollup tuck
					// their interop helpers into unrelated lazy chunks has produced
					// production-only boot failures in sibling Vite builds.
					if (id.includes('node_modules/dayjs')) {
						return 'vendor-dayjs';
					}
					if (id.includes('node_modules/khroma')) {
						return 'vendor-khroma';
					}
					return undefined;
				},
			},
		},
		target: 'es2020',
		minify: mode === 'production' ? 'esbuild' : false,
		cssMinify: 'esbuild',
	},

	server: {
		port: 5176,
		strictPort: true,
	},

	css: { devSourcemap: true },
	optimizeDeps: { include: ['react', 'react-dom'] },
}));
