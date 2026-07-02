/**
 * Setup symlinks for @maestro/* path aliases
 *
 * Metro uses symlinks at node_modules/@maestro/* to resolve cross-tree imports
 * from the repo's src/shared and src/web/hooks directories.
 *
 * This script is run via postinstall to recreate the symlinks after npm install.
 */

const fs = require('fs');
const path = require('path');

const nodeModulesDir = path.join(__dirname, '..', 'node_modules');
const maestroDir = path.join(nodeModulesDir, '@maestro');
const repoRoot = path.join(__dirname, '..', '..', '..');

// Symlink mappings: @maestro/<name> -> <target>
const symlinks = {
	shared: path.join(repoRoot, 'src', 'shared'),
	'web-hooks': path.join(repoRoot, 'src', 'web', 'hooks'),
};

// Create @maestro directory if it doesn't exist
if (!fs.existsSync(maestroDir)) {
	fs.mkdirSync(maestroDir, { recursive: true });
}

// Create each symlink
for (const [name, target] of Object.entries(symlinks)) {
	const linkPath = path.join(maestroDir, name);

	// Remove existing symlink or directory if it exists
	try {
		const stats = fs.lstatSync(linkPath);
		if (stats.isSymbolicLink() || stats.isDirectory()) {
			fs.rmSync(linkPath, { recursive: true, force: true });
		}
	} catch {
		// Path doesn't exist, nothing to remove
	}

	// Create symlink (use absolute path to avoid cross-platform issues)
	fs.symlinkSync(target, linkPath, 'dir');
	console.log(`Created symlink: @maestro/${name} -> ${target}`);
}

console.log('Symlinks setup complete');
