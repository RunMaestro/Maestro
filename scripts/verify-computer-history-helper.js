/**
 * electron-builder afterPack hook: refuse to package an app without the
 * Computer History helper (`maestro-computer-history`).
 *
 * The helper reaches the app through an `extraResources` entry that copies
 * dist/native/<platform>-${arch}/ to <resources>/native/. electron-builder
 * skips that entry WITHOUT a warning when the source folder does not exist, so
 * a package built without first running `npm run build:computer-history`
 * used to ship a Computer History that could never record (the status read
 * `binary-missing` and nothing told the user why). This hook makes that a
 * build failure instead.
 *
 * Escape hatch: MAESTRO_ALLOW_MISSING_COMPUTER_HISTORY_HELPER=1 packages
 * anyway, for contributors without the Rust toolchain or for a cross-platform
 * package the host cannot build the helper for.
 */

const fs = require('fs');
const path = require('path');

const BIN = 'maestro-computer-history';
const ESCAPE_ENV = 'MAESTRO_ALLOW_MISSING_COMPUTER_HISTORY_HELPER';

function resourcesDir(context) {
	if (context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas') {
		const appName = `${context.packager.appInfo.productFilename}.app`;
		return path.join(context.appOutDir, appName, 'Contents', 'Resources');
	}
	return path.join(context.appOutDir, 'resources');
}

exports.default = async function verifyComputerHistoryHelper(context) {
	const exe = context.electronPlatformName === 'win32' ? `${BIN}.exe` : BIN;
	const helper = path.join(resourcesDir(context), 'native', exe);
	if (fs.existsSync(helper)) return;

	const message =
		`Computer History helper missing from the package: ${helper}\n` +
		'  Build it first: npm run build:computer-history ' +
		'(add --arch, --target, or --universal to match the package).\n' +
		`  To package without it anyway, set ${ESCAPE_ENV}=1.`;
	if (process.env[ESCAPE_ENV] === '1') {
		console.warn(`WARNING: ${message}`);
		return;
	}
	throw new Error(message);
};
