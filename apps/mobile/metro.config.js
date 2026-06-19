const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

// Repo root for monorepo-style setup
const repoRoot = path.resolve(__dirname, '../..');

/** @type {import('expo/metro-config').MetroConfig} */
let config = getDefaultConfig(__dirname);

// Apply uniwind first
config = withUniwindConfig(config, {
	cssEntryFile: './src/global.css',
	debug: true,
});

// Add repo root's src/ directory to watchFolders for cross-tree imports (decision 9A)
config.watchFolders = [...(config.watchFolders || []), path.join(repoRoot, 'src')];

// Ensure node_modules from both mobile app and repo root are accessible
// IMPORTANT: Mobile app's node_modules must come first so that when resolving
// from src/web/hooks/, packages like 'react' are found in the mobile app's deps
config.resolver.nodeModulesPaths = [
	path.join(__dirname, 'node_modules'),
	...(config.resolver.nodeModulesPaths || []),
	path.join(repoRoot, 'node_modules'),
];

// Shim paths for browser-only imports
const shimsDir = path.join(__dirname, 'shims');
const configShim = path.join(shimsDir, 'config.ts');
const loggerShim = path.join(shimsDir, 'logger.ts');

// Enable symlinks for monorepo-style cross-tree imports
// We use symlinks at node_modules/@maestro/* pointing to src/web/hooks, src/shared, etc.
config.resolver.unstable_enableSymlinks = true;

// Store any existing resolveRequest (from uniwind or expo default)
const existingResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
	// Handle @expo/ui SwiftUI shims (web-only)
	if (
		platform === 'web' &&
		['@expo/ui/swift-ui', '@expo/ui/swift-ui/modifiers'].includes(moduleName)
	) {
		return { type: 'empty' };
	}

	// Redirect browser-only imports to shims when resolving from mobile/web-hooks tree
	const origin = context.originModulePath || '';
	const inMobileOrWebHooks = origin.includes('apps/mobile/') || origin.includes('src/web/hooks/');
	if (inMobileOrWebHooks) {
		if (moduleName.endsWith('/web/utils/config') || moduleName === '../utils/config') {
			return { type: 'sourceFile', filePath: configShim };
		}
		if (moduleName.endsWith('/web/utils/logger') || moduleName === '../utils/logger') {
			return { type: 'sourceFile', filePath: loggerShim };
		}
	}

	// Fall back to existing resolver (uniwind or default)
	if (existingResolveRequest) {
		return existingResolveRequest(context, moduleName, platform);
	}
	return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
