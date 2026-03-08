import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// Read version from package.json as fallback
const packageJson = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
// Use VITE_APP_VERSION env var if set (during CI builds), otherwise use package.json
const appVersion = process.env.VITE_APP_VERSION || packageJson.version;

// Get the first 8 chars of git commit hash for dev mode
function getCommitHash(): string {
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
		// Show commit hash only in development mode
		__COMMIT_HASH__: JSON.stringify(mode === 'development' ? getCommitHash() : ''),
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
	esbuild: {
		// Strip console.* and debugger in production builds
		drop: mode === 'production' ? ['console', 'debugger'] : [],
	},
	build: {
		outDir: path.join(__dirname, 'dist/renderer'),
		emptyOutDir: true,
		// Disable modulepreload polyfill — Electron doesn't need it and eager
		// preloading of lazy chunks (vendor-flow, vendor-mermaid, etc.) can cause
		// "Cannot read properties of undefined (reading 'useState')" at startup
		// when a chunk executes before vendor-react is fully initialised.
		modulePreload: false,
		rollupOptions: {
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
					if (id.includes('node_modules/xterm')) {
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
					if (id.includes('node_modules/reactflow') || id.includes('node_modules/@reactflow')) {
						return 'vendor-flow';
					}

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
	server: {
		port: process.env.VITE_PORT ? parseInt(process.env.VITE_PORT, 10) : 5173,
		hmr: !disableHmr,
		// Disable file watching entirely when HMR is disabled to prevent any reloads
		watch: disableHmr ? null : undefined,
	},
}));
