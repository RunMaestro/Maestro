/**
 * Existing Auto Run Documents Detector
 *
 * Utility functions for checking whether a project has existing Auto Run documents.
 * Used by the inline wizard to determine whether to offer "new" or "iterate" mode.
 */

/**
 * Default Auto Run folder name - matches the constant in phaseGenerator.ts
 */
export const AUTO_RUN_FOLDER_NAME = 'Auto Run Docs';

/**
 * Represents an existing Auto Run document.
 */
export interface ExistingDocument {
	/** Filename without .md extension */
	name: string;
	/** Full filename including .md extension */
	filename: string;
	/** Full path to the document */
	path: string;
}

/**
 * Build the Auto Run folder path for a project.
 *
 * @param projectPath - Root path of the project
 * @returns Full path to the Auto Run Docs folder
 */
export function getAutoRunFolderPath(projectPath: string): string {
	// Handle trailing slashes consistently
	const normalizedPath = projectPath.endsWith('/') ? projectPath.slice(0, -1) : projectPath;
	return `${normalizedPath}/${AUTO_RUN_FOLDER_NAME}`;
}

/**
 * Check if a project has existing Auto Run documents.
 *
 * This is a quick boolean check that can be used to determine whether
 * the inline wizard should offer "new" vs "iterate" mode options.
 *
 * @param projectPath - Root path of the project (not the Auto Run folder)
 * @returns True if the Auto Run Docs folder exists and contains at least one .md file
 *
 * @example
 * const hasExisting = await hasExistingAutoRunDocs('/path/to/project');
 * if (hasExisting) {
 *   // Offer "continue" or "iterate" options in wizard
 * } else {
 *   // Default to "new" mode
 * }
 */
export async function hasExistingAutoRunDocs(projectPath: string): Promise<boolean> {
	try {
		const folderPath = getAutoRunFolderPath(projectPath);
		const result = await window.maestro.autorun.listDocs(folderPath);

		if (!result.success) {
			// Folder doesn't exist or can't be read - no existing docs
			return false;
		}

		// Check if there are any markdown files
		return result.files.length > 0;
	} catch (error) {
		// Any error (folder doesn't exist, permission issues, etc.) means no existing docs
		console.debug('[existingDocsDetector] hasExistingAutoRunDocs error:', error);
		return false;
	}
}

/**
 * Get a list of existing Auto Run documents in a project.
 *
 * Returns metadata about each document in the Auto Run Docs folder.
 * Documents are returned in the order provided by the file system (typically alphabetical).
 *
 * @param projectPath - Root path of the project (not the Auto Run folder)
 * @returns Array of ExistingDocument objects, empty if no documents exist
 *
 * @example
 * const docs = await getExistingAutoRunDocs('/path/to/project');
 * for (const doc of docs) {
 *   console.log(`Found: ${doc.name} at ${doc.path}`);
 * }
 */
export async function getExistingAutoRunDocs(projectPath: string): Promise<ExistingDocument[]> {
	try {
		const folderPath = getAutoRunFolderPath(projectPath);
		const result = await window.maestro.autorun.listDocs(folderPath);

		if (!result.success || !result.files) {
			return [];
		}

		// The listDocs API returns filenames without .md extension
		// Convert to ExistingDocument format
		return result.files.map((name: string) => ({
			name,
			filename: `${name}.md`,
			path: `${folderPath}/${name}.md`,
		}));
	} catch (error) {
		console.debug('[existingDocsDetector] getExistingAutoRunDocs error:', error);
		return [];
	}
}

/**
 * Get the count of existing Auto Run documents without loading full metadata.
 *
 * Slightly more efficient than getExistingAutoRunDocs when you only need the count.
 *
 * @param projectPath - Root path of the project
 * @returns Number of Auto Run documents, 0 if none or folder doesn't exist
 */
export async function getExistingAutoRunDocsCount(projectPath: string): Promise<number> {
	try {
		const folderPath = getAutoRunFolderPath(projectPath);
		const result = await window.maestro.autorun.listDocs(folderPath);

		if (!result.success || !result.files) {
			return 0;
		}

		return result.files.length;
	} catch (error) {
		console.debug('[existingDocsDetector] getExistingAutoRunDocsCount error:', error);
		return 0;
	}
}
