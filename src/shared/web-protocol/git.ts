export interface GitStatusFile {
	path: string;
	status: string;
	staged: boolean;
}

export interface GitStatusResult {
	branch: string;
	files: GitStatusFile[];
	ahead: number;
	behind: number;
}

export interface GitDiffResult {
	diff: string;
	files: string[];
}
