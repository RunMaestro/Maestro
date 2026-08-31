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

import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'path';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const packageJson = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
const appVersion = process.env.VITE_APP_VERSION || packageJson.version;

// Get the first 8 chars of the git commit hash. Honors VITE_COMMIT_HASH when set
// (CI builds from a tarball / shallow checkout where `git rev-parse` may fail),
// otherwise reads it from the local repo. Empty string when neither is available.
// Mirrors vite.config.mts's getCommitHash().
function getCommitHash(): string {
	if (process.env.VITE_COMMIT_HASH) {
		return process.env.VITE_COMMIT_HASH.trim().slice(0, 8);
	}
	try {
		return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim().slice(0, 8);
	} catch {
		return '';
	}
}

/**
 * Serve and emit the bundled webfonts.
 *
 * The renderer's stylesheet (shared with this build) references `/fonts/*.woff2`,
 * but those live in the RENDERER's public dir and Vite allows only one
 * `publicDir` per config - this one is already pointed at `src/web/public` for
 * the PWA assets. Without this the web client silently falls back to whatever
 * the OS has, which is the exact divergence between desktop and web that
 * bundling the fonts was meant to remove.
 */
function bundledFontsPlugin(): PluginOption {
	const fontsDir = path.join(__dirname, 'src/renderer/public/fonts');
	return {
		name: 'maestro-bundled-fonts',
		// Dev: map the request path onto the renderer's public dir.
		configureServer(server) {
			server.middlewares.use('/fonts', (req, res, next) => {
				const name = path.basename(req.url ?? '');
				const file = path.join(fontsDir, name);
				if (!name.endsWith('.woff2') || !fs.existsSync(file)) return next();
				res.setHeader('Content-Type', 'font/woff2');
				res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
				fs.createReadStream(file).pipe(res);
			});
		},
		// Build: emit each file so the Fastify server ships them alongside the app.
		generateBundle() {
			if (!fs.existsSync(fontsDir)) return;
			for (const name of fs.readdirSync(fontsDir)) {
				if (!name.endsWith('.woff2')) continue;
				this.emitFile({
					type: 'asset',
					fileName: `fonts/${name}`,
					source: fs.readFileSync(path.join(fontsDir, name)),
				});
			}
		},
	};
}

export default defineConfig(({ mode }) => ({
	plugins: [react(), bundledFontsPlugin()],

	root: path.join(__dirname, 'src/web-desktop'),
	// Copy the PWA assets (manifest.json, service worker, icons/) from the shared
	// public dir into the bundle output so the Fastify server can serve them
	// alongside the app. This is the only surviving consumer of src/web/public
	// after the legacy mobile bundle was retired.
	publicDir: path.join(__dirname, 'src/web/public'),
	base: './',

	define: {
		__APP_VERSION__: JSON.stringify(appVersion),
		__COMMIT_HASH__: JSON.stringify(getCommitHash()),
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
