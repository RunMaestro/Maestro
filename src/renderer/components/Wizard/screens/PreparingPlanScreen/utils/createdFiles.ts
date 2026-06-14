import type { CreatedFileInfo } from '../types';

export function upsertCreatedFile(
	files: CreatedFileInfo[],
	file: CreatedFileInfo
): CreatedFileInfo[] {
	const existingIndex = files.findIndex((existing) => existing.filename === file.filename);
	if (existingIndex === -1) {
		return [...files, file];
	}

	return files.map((existing, index) => (index === existingIndex ? file : existing));
}

export function countCreatedFileTasks(files: CreatedFileInfo[]): number {
	return files.reduce((sum, file) => sum + (file.taskCount || 0), 0);
}
