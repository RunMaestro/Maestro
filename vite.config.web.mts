/**
 * Vite configuration for Maestro Web Interface
 *
 * This config builds the web interface (both mobile and desktop)
 * as a standalone bundle that can be served by the Fastify server.
 *
 * Output: dist/web/
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, 'package.json'), 'utf-8')
);
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

export default defineConfig(({ mode }) => ({
  plugins: [react()],

  // Entry point for web interface
  root: path.join(__dirname, 'src/web'),

  // Public directory for static assets (manifest.json, icons, etc.)
  // Files here are copied to the build output root as-is
  publicDir: path.join(__dirname, 'src/web/public'),

  // Use relative paths for assets (served from Fastify)
  base: './',

  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __GIT_HASH__: JSON.stringify(gitHash),
  },

  esbuild: {
    // Strip console.log and console.debug in production builds
    drop: mode === 'production' ? ['console', 'debugger'] : [],
  },

  resolve: {
    alias: {
      // Allow importing from renderer types/constants
      '@renderer': path.join(__dirname, 'src/renderer'),
      '@web': path.join(__dirname, 'src/web'),
      '@shared': path.join(__dirname, 'src/shared'),
    },
  },

  build: {
    outDir: path.join(__dirname, 'dist/web'),
    emptyOutDir: true,

    // Generate source maps for debugging
    sourcemap: true,

    rollupOptions: {
      input: {
        // Single entry point that handles routing to mobile/desktop
        main: path.join(__dirname, 'src/web/index.html'),
      },
      output: {
        // Organize output by type
        entryFileNames: 'assets/[name]-[hash].js',
        // Use dynamic chunk names that preserve mobile/desktop distinction
        chunkFileNames: (chunkInfo) => {
          // Preserve mobile/desktop naming for their respective chunks
          if (chunkInfo.name?.includes('mobile') || chunkInfo.facadeModuleId?.includes('/mobile/')) {
            return 'assets/mobile-[hash].js';
          }
          if (chunkInfo.name?.includes('desktop') || chunkInfo.facadeModuleId?.includes('/desktop/')) {
            return 'assets/desktop-[hash].js';
          }
          // Named chunks (react, vendor) keep their names
          if (chunkInfo.name && !chunkInfo.name.startsWith('_')) {
            return `assets/${chunkInfo.name}-[hash].js`;
          }
          return 'assets/[name]-[hash].js';
        },
        assetFileNames: 'assets/[name]-[hash].[ext]',

        // Manual chunking for better caching and code splitting
        manualChunks: (id) => {
          // React core in its own chunk for optimal caching
          if (id.includes('node_modules/react-dom')) {
            return 'react';
          }
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-is')) {
            return 'react';
          }
          // Scheduler is a React dependency
          if (id.includes('node_modules/scheduler')) {
            return 'react';
          }

          // Mobile-specific dependencies (future-proofing for Phase 1)
          // When mobile-specific libraries are added, they'll be bundled separately
          if (id.includes('/mobile/') && !id.includes('node_modules')) {
            return 'mobile';
          }

          // Desktop-specific dependencies (future-proofing for Phase 2)
          // When desktop-specific libraries are added, they'll be bundled separately
          if (id.includes('/desktop/') && !id.includes('node_modules')) {
            return 'desktop';
          }

          // Shared web components stay in main bundle or get split automatically
          // This allows React.lazy() to create async chunks for mobile/desktop

          // Return undefined for other modules to let Rollup handle them
          return undefined;
        },
      },
    },

    // Target modern browsers (web interface doesn't need legacy support)
    target: 'es2020',

    // Minimize bundle size
    minify: 'esbuild',

    // Report chunk sizes
    reportCompressedSize: true,
  },

  // Development server (for testing web interface standalone)
  server: {
    port: process.env.VITE_WEB_PORT ? parseInt(process.env.VITE_WEB_PORT) : 5174, // Different from renderer dev server (5173)
    strictPort: true,
    // Proxy API calls to the running Maestro app during development
    proxy: {
      '/api': {
        target: 'http://localhost:45678',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:45678',
        ws: true,
      },
    },
  },

  // Preview server for testing production build
  preview: {
    port: 5175,
    strictPort: true,
  },

  // Enable CSS code splitting
  css: {
    devSourcemap: true,
  },

  // Optimize dependencies
  optimizeDeps: {
    include: ['react', 'react-dom'],
  },
}));
