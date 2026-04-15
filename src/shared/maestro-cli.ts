export interface MaestroCliStatus {
	expectedVersion: string;
	installed: boolean;
	inPath: boolean;
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
	restartRequired: boolean;
	shellFilesUpdated: string[];
}
