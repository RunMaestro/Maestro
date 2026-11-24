/**
 * Refuse to package an app whose native addons target the wrong runtime.
 *
 * One node_modules holds one compiled better_sqlite3.node, and two runtimes
 * load it: the app on Electron and vitest on plain Node, each with its own
 * NODE_MODULE_VERSION. `npm test` rebuilds it for Node, so packaging after a
 * test run shipped a Node build. The app does not crash on that: startup
 * catches the load error and runs without the stats and Cue databases. Only a
 * launch of the packaged app noticed, minutes later and on one platform.
 *
 * This check reads the ABI out of the binary instead of loading it, so it
 * works for any target arch on any host (an x64 package built on an arm64
 * Mac). A NAN addon exports `node_register_module_v<ABI>`; the name is a plain
 * string in Mach-O, ELF and PE alike. An N-API addon exports
 * `napi_register_module_v1` and loads under any runtime, so it is skipped.
 *
 * Runs as part of the electron-builder afterPack hook (scripts/after-pack.js)
 * on every package, local or CI. By hand, against the working tree before
 * packaging: `node scripts/verify-native-abi.js [node_modules dir]`.
 */

const fs = require('fs');
const path = require('path');

/** Addons the app cannot run without: a package missing one is refused. */
const REQUIRED_ADDONS = ['better_sqlite3.node'];

const FIX =
	'Rebuild for Electron and package again: node scripts/ensure-native-runtime.mjs electron ' +
	'(or npx electron-rebuild -f -w better-sqlite3).';

/**
 * The ABI a compiled addon was built for, read from its export name.
 * @returns {number | 'napi' | null} null when the file names neither.
 */
function readAddonAbi(filePath) {
	const text = fs.readFileSync(filePath).toString('latin1');
	const nan = text.match(/node_register_module_v(\d+)/);
	if (nan) return Number(nan[1]);
	return /napi_register_module_v\d+/.test(text) ? 'napi' : null;
}

/** Every `.node` file under a directory. */
function findAddons(dir) {
	const found = [];
	if (!fs.existsSync(dir)) return found;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...findAddons(full));
		else if (entry.isFile() && entry.name.endsWith('.node')) found.push(full);
	}
	return found;
}

/**
 * Electron's NODE_MODULE_VERSION. Asks the node-abi that @electron/rebuild
 * uses (it built the addons, and it is updated with electron-builder) before
 * any copy hoisted to the root, which can be too old to know a new Electron.
 */
function electronAbi(electronVersion) {
	const candidates = [];
	try {
		candidates.push(
			require.resolve('node-abi', { paths: [path.dirname(require.resolve('@electron/rebuild'))] })
		);
	} catch {
		// Not installed through @electron/rebuild: fall back to the root copy.
	}
	candidates.push('node-abi');
	let lastError;
	for (const candidate of candidates) {
		try {
			return Number(require(candidate).getAbi(electronVersion, 'electron'));
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`Cannot tell which NODE_MODULE_VERSION Electron ${electronVersion} uses: ${lastError?.message ?? lastError}`
	);
}

/** "Node 24" / "Electron 41" for an ABI, when node-abi knows it. */
function describeAbi(abi) {
	for (const runtime of ['node', 'electron']) {
		try {
			const target = require('node-abi').getTarget(String(abi), runtime);
			return `${runtime === 'node' ? 'Node' : 'Electron'} ${String(target).split('.')[0]}`;
		} catch {
			// Not this runtime.
		}
	}
	return 'an unknown runtime';
}

/**
 * The module folders that ship unpacked, from `build.asarUnpack`
 * (`node_modules/<name>/**` and `node_modules/@scope/<prefix>-*`), as they
 * exist under `nodeModules`. Native addons only work unpacked, so this is
 * every addon the app can load. Dev-only addons never ship and are not checked.
 */
function shippedModuleDirs(nodeModules, asarUnpack) {
	const dirs = new Set();
	for (const pattern of asarUnpack ?? []) {
		const parts = pattern.split('/');
		if (parts[0] !== 'node_modules' || !parts[1]) continue;
		const nameParts = parts[1].startsWith('@') ? [parts[1], parts[2]] : [parts[1]];
		if (nameParts.some((part) => !part)) continue;
		const parent = path.join(nodeModules, ...nameParts.slice(0, -1));
		const leaf = nameParts[nameParts.length - 1];
		if (!leaf.includes('*')) {
			const dir = path.join(parent, leaf);
			if (fs.existsSync(dir)) dirs.add(dir);
			continue;
		}
		const match = new RegExp(`^${leaf.split('*').map(escapeRegExp).join('.*')}$`);
		if (!fs.existsSync(parent)) continue;
		for (const entry of fs.readdirSync(parent)) {
			if (match.test(entry)) dirs.add(path.join(parent, entry));
		}
	}
	return [...dirs];
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every problem with the addons under `dirs` for a runtime that needs `abi`.
 * @param {string | string[]} dirs
 * @returns {string[]} empty when the package is good.
 */
function checkAddons(dirs, abi) {
	const roots = Array.isArray(dirs) ? dirs : [dirs];
	const addons = roots.flatMap((root) => findAddons(root).map((file) => ({ root, file })));
	const problems = [];
	for (const required of REQUIRED_ADDONS) {
		if (!addons.some(({ file }) => path.basename(file) === required)) {
			problems.push(`${required} is missing under ${roots.join(', ')}`);
		}
	}
	for (const { root, file } of addons) {
		const dir = path.dirname(root);
		const found = readAddonAbi(file);
		if (typeof found === 'number' && found !== abi) {
			problems.push(
				`${path.relative(dir, file)} targets NODE_MODULE_VERSION ${found} (${describeAbi(found)}); ` +
					`Electron needs ${abi}`
			);
		}
	}
	return problems;
}

function resourcesDir(context) {
	if (context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas') {
		const appName = `${context.packager.appInfo.productFilename}.app`;
		return path.join(context.appOutDir, appName, 'Contents', 'Resources');
	}
	return path.join(context.appOutDir, 'resources');
}

function packagedElectronVersion(context) {
	return context.packager?.config?.electronVersion ?? require('electron/package.json').version;
}

/** electron-builder afterPack step: check the addons the package actually holds. */
async function verifyPackagedNativeAbi(context) {
	const version = packagedElectronVersion(context);
	const abi = electronAbi(version);
	const unpacked = path.join(resourcesDir(context), 'app.asar.unpacked', 'node_modules');
	const problems = checkAddons(unpacked, abi);
	if (problems.length) {
		throw new Error(
			`Native addons in the package do not match Electron ${version} (ABI ${abi}):\n  ` +
				`${problems.join('\n  ')}\n  ${FIX}`
		);
	}
	console.log(`  • native addons match Electron ${version} (ABI ${abi})`);
}

module.exports = {
	REQUIRED_ADDONS,
	readAddonAbi,
	findAddons,
	shippedModuleDirs,
	electronAbi,
	checkAddons,
	verifyPackagedNativeAbi,
};

if (require.main === module) {
	const rootDir = path.join(__dirname, '..');
	const nodeModules = path.resolve(process.argv[2] ?? path.join(rootDir, 'node_modules'));
	const { asarUnpack } = require(path.join(rootDir, 'package.json')).build;
	const dirs = shippedModuleDirs(nodeModules, asarUnpack);
	const version = require('electron/package.json').version;
	const abi = electronAbi(version);
	const problems = checkAddons(dirs, abi);
	if (problems.length) {
		console.error(
			`[native] shipped addons do not match Electron ${version} (ABI ${abi}):\n  ` +
				`${problems.join('\n  ')}\n  ${FIX}`
		);
		process.exit(1);
	}
	console.log(
		`[native] ${dirs.length} shipped modules match Electron ${version} (ABI ${abi}): ` +
			dirs.map((dir) => path.relative(nodeModules, dir)).join(', ')
	);
}
