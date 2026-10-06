/**
 * argv flag prefix used to pass the resolved on-disk maestro-cli.js path from
 * the main process into the (sandboxed) renderer preload. The preload strips
 * this prefix off its process.argv entry and exposes the value as
 * `window.maestro.maestroCliPath`.
 */
export const MAESTRO_CLI_PATH_ARG_PREFIX = '--maestro-cli-path=';

export interface MaestroCliStatus {
	expectedVersion: string;
	installed: boolean;
	inPath: boolean;
	inShellPath: boolean;
	commandPath: string | null;
	installedVersion: string | null;
	versionMatch: boolean;
	needsInstallOrUpdate: boolean;
	installDir: string;
	bundledCliPath: string | null;
}

export interface MaestroCliInstallResult {
	success: boolean;
	status: MaestroCliStatus;
	pathUpdated: boolean;
	pathUpdateError?: string;
	restartRequired: boolean;
	shellFilesUpdated: string[];
}
