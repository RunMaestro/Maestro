// Build only. Never starts Electron, Xvfb, providers or a desktop bridge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const which = require('which');
const { filesUnder, renderedFingerprints } = require('./board-rendered-contract.cjs');
const checkout = path.resolve(__dirname, '..');

function assertOutputPaths(root) {
	assert.equal(fs.realpathSync(path.join(root, 'node_modules')), path.join(root, 'node_modules'));
	const dist = path.join(root, 'dist');
	// lstat catches dangling links too; only a genuinely absent output is safe.
	try {
		fs.lstatSync(dist);
	} catch (error) {
		if (error.code === 'ENOENT') return;
		throw error;
	}
	assert.equal(fs.realpathSync(dist), dist);
	for (const folder of ['main', 'shared', 'types', 'board-rendered']) {
		const relative = path.join('dist', folder);
		try {
			fs.lstatSync(path.join(root, relative));
		} catch (error) {
			if (error.code === 'ENOENT') continue;
			throw error;
		}
		filesUnder(root, relative);
	}
}

async function main() {
	assert.equal(process.argv.length, 2, 'Usage: node scripts/board-rendered-build.cjs');
	assert.equal(fs.realpathSync(process.cwd()), checkout);
	// Check every existing output descendant before clean/build can follow an alias.
	assertOutputPaths(checkout);
	cp.execFileSync(which.sync('npm'), ['run', 'build:main'], {
		cwd: checkout,
		stdio: 'inherit',
		timeout: 180000,
	});
	const { build } = await import('vite');
	await build({
		configFile: path.join(checkout, 'vite.config.mts'),
		root: path.join(checkout, 'src/__tests__/integration/fixtures/board-rendered'),
		publicDir: path.join(checkout, 'src/renderer/public'),
		base: './',
		css: { postcss: checkout },
		build: {
			outDir: path.join(checkout, 'dist/board-rendered'),
			emptyOutDir: true,
			sourcemap: true,
		},
	});
	const git = which.sync('git');
	fs.writeFileSync(
		path.join(checkout, 'dist/board-rendered-build.json'),
		JSON.stringify(
			{
				head: cp
					.execFileSync(git, ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' })
					.trim(),
				files: renderedFingerprints(checkout),
			},
			null,
			2
		) + '\n'
	);
}

if (require.main === module)
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});

module.exports = { assertOutputPaths };
