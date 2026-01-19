import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

// Read version from package.json as fallback
const packageJson = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
// Use VITE_APP_VERSION env var if set (during CI builds), otherwise use package.json
const appVersion = process.env.VITE_APP_VERSION || packageJson.version;

// Get git hash
function getGitHash() {
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return 'unknown';
  }
}
const gitHash = getGitHash();

const disableHmr = process.env.DISABLE_HMR === '1';

export default defineConfig(({ mode }) => ({
  plugins: [react({ fastRefresh: !disableHmr })],
  root: path.join(__dirname, 'src/renderer'),
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __GIT_HASH__: JSON.stringify(gitHash),
    // Explicitly define NODE_ENV for React and related packages
    'process.env.NODE_ENV': JSON.stringify(mode),
  },
  resolve: {
    alias: {
      // In development, use wdyr.dev.ts which loads why-did-you-render
      // In production, use wdyr.ts which is empty (prevents bundling the library)
      './wdyr': mode === 'development'
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
  },
  server: {
    port: process.env.VITE_PORT ? parseInt(process.env.VITE_PORT) : 5173,
    hmr: !disableHmr,
    // Disable file watching entirely when HMR is disabled to prevent any reloads
    watch: disableHmr ? null : undefined,
  },
}));
