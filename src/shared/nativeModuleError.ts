/**
 * One-line diagnosis for a native addon (`better-sqlite3`) that would not load.
 *
 * The raw error is a multi-line dlopen dump naming two ABI numbers and
 * suggesting `npm rebuild`, which in this repo is the wrong advice for the
 * desktop app: the checked-in `postinstall` deliberately builds the addon for
 * Electron's ABI, so the same binary that works in the app refuses to load
 * under plain Node, and vice versa. A server operator reading a journald line
 * needs the cause and the remedy, not a stack.
 *
 * Returns `null` when the error is not a native-load failure, so a caller can
 * fall back to the original message instead of misattributing an unrelated
 * error (a corrupt database, a permission problem) to the build.
 */

export type NativeModuleLoadProblem = 'abi-mismatch' | 'binary-missing' | 'dlopen-failed';

export interface NativeModuleLoadDiagnosis {
	problem: NativeModuleLoadProblem;
	/** One line, safe to print as the whole error. */
	message: string;
}

const SERVER_REMEDY =
	'Under plain Node, install with MAESTRO_SERVER_INSTALL=1 (skips electron-rebuild) or run "npm run rebuild:node-native"; through the desktop app\'s maestro-cli shim it runs on Electron and needs nothing.';

export function describeNativeModuleLoadError(
	error: unknown,
	moduleName = 'better-sqlite3'
): NativeModuleLoadDiagnosis | null {
	const text = error instanceof Error ? error.message : String(error ?? '');
	const code = (error as NodeJS.ErrnoException | undefined)?.code;

	const abi = text.match(/NODE_MODULE_VERSION (\d+)[\s\S]*?NODE_MODULE_VERSION (\d+)/);
	if (abi) {
		return {
			problem: 'abi-mismatch',
			message: `${moduleName} is built for a different runtime (module ABI ${abi[1]}, this ${runtimeName()} needs ${abi[2]}). ${SERVER_REMEDY}`,
		};
	}
	if (/Could not locate the bindings file/i.test(text)) {
		return {
			problem: 'binary-missing',
			message: `${moduleName} has no compiled binary for this ${runtimeName()} (${process.platform}-${process.arch}). ${SERVER_REMEDY}`,
		};
	}
	if (
		code === 'ERR_DLOPEN_FAILED' ||
		/\.node\b.*(invalid ELF|cannot open shared object|wrong ELF class|mach-o)/i.test(text)
	) {
		const firstLine = text.split('\n')[0].trim();
		return {
			problem: 'dlopen-failed',
			message: `${moduleName} could not be loaded: ${firstLine}. ${SERVER_REMEDY}`,
		};
	}
	return null;
}

function runtimeName(): string {
	return process.versions.electron
		? `Electron ${process.versions.electron}`
		: `Node ${process.version}`;
}
