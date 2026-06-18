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
