import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// Read version from package.json as fallback
const packageJson = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
// Use VITE_APP_VERSION env var if set (during CI builds), otherwise use package.json
const appVersion = process.env.VITE_APP_VERSION || packageJson.version;

// Get the first 8 chars of the git commit hash. Honors VITE_COMMIT_HASH when set
// (CI builds from a tarball / shallow checkout where `git rev-parse` may fail),
// otherwise reads it from the local repo. Empty string when neither is available.
function getCommitHash(): string {
	if (process.env.VITE_COMMIT_HASH) {
		return process.env.VITE_COMMIT_HASH.trim().slice(0, 8);
	}
	try {
		// Note: execSync is safe here - no user input, static git command
		return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim().slice(0, 8);
	} catch {
		return '';
	}
}

const disableHmr = process.env.DISABLE_HMR === '1';

export default defineConfig(({ mode }) => ({
	plugins: [
		react({ fastRefresh: !disableHmr }),
		// In dev mode, relax CSP to allow Vite's inline HMR/React Refresh scripts
		mode === 'development' && {
			name: 'dev-csp-relaxation',
			transformIndexHtml(html: string) {
				return html.replace(
					"script-src 'self'",
					"script-src 'self' 'unsafe-inline' http://localhost:*"
				);
			},
		},
	].filter(Boolean),
	root: path.join(__dirname, 'src/renderer'),
	base: './',
	define: {
		__APP_VERSION__: JSON.stringify(appVersion),
		// Embed the commit hash in every build (dev AND production) so the About modal
		// can show exactly what HEAD a local/packaged build was cut from. Empty only
		// when git isn't reachable and VITE_COMMIT_HASH isn't set.
		__COMMIT_HASH__: JSON.stringify(getCommitHash()),
		// Explicitly define NODE_ENV for React and related packages
		'process.env.NODE_ENV': JSON.stringify(mode),
	},
	resolve: {
		alias: {
			// In development, use wdyr.dev.ts which loads why-did-you-render
			// In production, use wdyr.ts which is empty (prevents bundling the library)
			'./wdyr':
				mode === 'development'
					? path.join(__dirname, 'src/renderer/wdyr.dev.ts')
					: path.join(__dirname, 'src/renderer/wdyr.ts'),
		},
	},
	// Vite 8 with Rolldown uses oxc; the older esbuild config is silently
	// ignored in this path. Express the same drop intent via oxc. JSX Fast
	// Refresh is handled by @vitejs/plugin-react above (`fastRefresh` option),
	// so an oxc-level toggle here would be redundant and could double-inject.
	oxc: {
		drop: mode === 'production' ? ['console', 'debugger'] : [],
	},
	build: {
		outDir: path.join(__dirname, 'dist/renderer'),
		emptyOutDir: true,
		// TODO(vite-css): revisit this pin once one of these is true:
		//   1) lightningcss tolerates xterm's malformed selectors (see
		//      `[-:\s|]`-style class on or near style.css line ~2801)
		//   2) xterm.js fixes its CSS upstream
		//   3) we pre-process xterm's CSS through a tolerant pass before vite
		// Vite 8 flipped the default CSS minifier to lightningcss, which is
		// strict about malformed CSS that esbuild's minifier silently passed
		// through. esbuild here matches prior (Vite 5-7) behavior.
		cssMinify: 'esbuild',
		// Disable modulepreload polyfill — Electron loads from local filesystem
		modulePreload: false,
		rollupOptions: {
			// Prevent esbuild from re-minifying xterm's pre-minified code.
			// Double-minification corrupts variable scoping in requestMode(),
			// causing a "ReferenceError: <letter> is not defined" throw inside
			// xterm.js's CSI parser when a TUI sends a DECRQM query (CSI ? N $ p).
			// The throw poisons the parser state, so all subsequent output and
			// user keystrokes are dropped — the terminal tab appears frozen
			// (seen with OpenCode on Linux and vim on macOS).
			//
			// Vite's esbuild-transpile minifier runs as an `enforce: 'post'`
			// renderChunk hook, so a plain renderChunk returning the input
			// unchanged is a no-op. Capture the pre-minify chunk code at
			// regular renderChunk order, then overwrite the final chunk in
			// generateBundle (which fires after every renderChunk hook,
			// including the minifier).
			//
			// Rolldown caveat: Vite 8 swaps Rollup for Rolldown, which defers
			// cross-chunk filename placeholder substitution (`name-!~{NNN}~.ext`)
			// to a finalization pass that runs AFTER renderChunk. The cached
			// pre-minify code therefore still contains literal `!~{NNN}~`
			// placeholders. The minified `asset.code` in generateBundle has the
			// resolved filenames — so we use it as a lookup table to substitute
			// placeholders in the cached code before writing back. Without this
			// step the app hangs on splash with `ENOENT rolldown-runtime-!~{001}~.js`.
			plugins: (() => {
				const xtermPreMinifyCache = new Map<string, string>();
				const placeholderRe = /([\w./-]+)-!~\{\d+\}~\.([a-z]+)/g;
				return [
					{
						name: 'skip-xterm-minify',
						renderChunk(code, chunk) {
							if (chunk.name === 'vendor-xterm') {
								xtermPreMinifyCache.set(chunk.name, code);
							}
							return null;
						},
						generateBundle(_options, bundle) {
							for (const asset of Object.values(bundle)) {
								if (asset.type !== 'chunk' || !xtermPreMinifyCache.has(asset.name)) {
									continue;
								}
								const preMinified = xtermPreMinifyCache.get(asset.name)!;
								const resolvedSource = asset.code;
								let fixed = preMinified;
								const seen = new Set<string>();
								for (const match of preMinified.matchAll(placeholderRe)) {
									const placeholder = match[0];
									if (seen.has(placeholder)) continue;
									seen.add(placeholder);
									const prefix = match[1];
									const ext = match[2];
									const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
									const resolvedMatch = resolvedSource.match(
										new RegExp(`${escapedPrefix}-([\\w-]+)\\.${ext}`)
									);
									if (!resolvedMatch) {
										throw new Error(
											`skip-xterm-minify: could not resolve placeholder ${placeholder} ` +
												`in ${asset.fileName} — Rolldown internals may have changed.`
										);
									}
									fixed = fixed.split(placeholder).join(`${prefix}-${resolvedMatch[1]}.${ext}`);
								}
								asset.code = fixed;
							}
							xtermPreMinifyCache.clear();
						},
					},
				];
			})(),
			output: {
				// Manual chunking for better caching and code splitting
				manualChunks: (id) => {
					// React core in its own chunk for optimal caching
					if (id.includes('node_modules/react-dom')) {
						return 'vendor-react';
					}
					if (id.includes('node_modules/react/') || id.includes('node_modules/react-is')) {
						return 'vendor-react';
					}
					if (id.includes('node_modules/scheduler')) {
						return 'vendor-react';
					}

					// Terminal (xterm) in its own chunk - large and not immediately needed
					if (id.includes('node_modules/@xterm') || id.includes('node_modules/xterm')) {
						return 'vendor-xterm';
					}

					// Markdown processing libraries
					if (
						id.includes('node_modules/react-markdown') ||
						id.includes('node_modules/remark-') ||
						id.includes('node_modules/rehype-') ||
						id.includes('node_modules/unified') ||
						id.includes('node_modules/unist-') ||
						id.includes('node_modules/mdast-') ||
						id.includes('node_modules/hast-') ||
						id.includes('node_modules/micromark')
					) {
						return 'vendor-markdown';
					}

					// Syntax highlighting (large)
					if (
						id.includes('node_modules/react-syntax-highlighter') ||
						id.includes('node_modules/prismjs') ||
						id.includes('node_modules/refractor')
					) {
						return 'vendor-syntax';
					}

					// Heavy visualization libraries (lazy-loaded components)
					if (id.includes('node_modules/mermaid')) {
						return 'vendor-mermaid';
					}
					if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) {
						return 'vendor-charts';
					}
					// NOTE: reactflow / @reactflow intentionally omitted from manualChunks.
					// They are only used by lazy-loaded components (CueModal, DocumentGraphView).
					// Forcing them into a dedicated chunk causes Rollup to place shared CJS
					// interop helpers there, which then forces the main entry to eagerly import
					// the chunk — crashing at startup with "Cannot read properties of undefined
					// (reading 'useState')" because React hooks run before React is initialised.

					// Diff viewer
					if (id.includes('node_modules/react-diff-view') || id.includes('node_modules/diff')) {
						return 'vendor-diff';
					}

					// Return undefined to let Rollup handle other modules automatically
					return undefined;
				},
			},
		},
	},
	// Pre-bundle deps that are ONLY reachable through lazy-loaded components.
	// Vite's startup dep-scan walks the static import graph from the entry, so
	// deps behind a dynamic import() (e.g. CueModal -> GitDiffViewer's `diff`,
	// CuePipelineEditor's `reactflow` and `js-yaml`) are never discovered up
	// front. The first
	// time such a component lazy-loads, Vite *discovers* the dep, re-optimizes,
	// bumps the dep cache hash, and invalidates the page's cached deps - which
	// 504s ("Outdated Optimize Dep") the dynamic import that's still in flight.
	// The user sees "Failed to fetch dynamically imported module" and only a
	// manual reload recovers. Listing them here forces pre-bundling at server
	// startup, eliminating the mid-import re-optimization. Dev-only; no effect
	// on the production build.
	optimizeDeps: {
		include: ['diff', 'reactflow', 'js-yaml'],
	},
	server: {
		// Fallback must match DEFAULT_START_PORT in scripts/dev-port.mjs. Never
		// 5173 (Vite's default): an agent-built dev server on that port would
		// otherwise hijack the URL Electron loads and replace the app shell.
		port: process.env.VITE_PORT ? parseInt(process.env.VITE_PORT, 10) : 17173,
		strictPort: true,
		hmr: !disableHmr,
		// Disable file watching entirely when HMR is disabled to prevent any reloads
		watch: disableHmr ? null : undefined,
	},
}));
