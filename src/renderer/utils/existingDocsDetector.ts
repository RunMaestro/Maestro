/**
 * Existing Auto Run Documents Detector
 *
 * Utility functions for checking whether a project has existing Auto Run documents.
 * Used by the inline wizard to determine whether to offer "new" or "iterate" mode.
 */

import { PLAYBOOKS_DIR, LEGACY_PLAYBOOKS_DIR } from '../../shared/maestro-paths';

/**
 * @deprecated Import PLAYBOOKS_DIR from shared/maestro-paths instead.
 */
export const AUTO_RUN_FOLDER_NAME = PLAYBOOKS_DIR;

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
 * Build the playbooks folder path for a project.
 * Checks .maestro/playbooks first, falls back to legacy Auto Run Docs.
 *
 * @param projectPath - Root path of the project
 * @returns Full path to the playbooks folder
 */
export function getAutoRunFolderPath(projectPath: string): string {
	// Handle trailing slashes consistently
	const normalizedPath = projectPath.endsWith('/') ? projectPath.slice(0, -1) : projectPath;
	return `${normalizedPath}/${PLAYBOOKS_DIR}`;
}

/**
 * Resolve the actual playbooks folder path, checking canonical then legacy.
 * Returns the path that exists, or the canonical path if neither exists.
 */
export async function resolvePlaybooksFolderPath(projectPath: string): Promise<string> {
	const normalizedPath = projectPath.endsWith('/') ? projectPath.slice(0, -1) : projectPath;
	const canonicalPath = `${normalizedPath}/${PLAYBOOKS_DIR}`;
	const legacyPath = `${normalizedPath}/${LEGACY_PLAYBOOKS_DIR}`;

	// Check canonical first
	try {
		const result = await window.maestro.autorun.listDocs(canonicalPath);
		if (result.success && result.files.length > 0) return canonicalPath;
	} catch {
		// ignore
	}

	// Check legacy
	try {
		const result = await window.maestro.autorun.listDocs(legacyPath);
		if (result.success && result.files.length > 0) return legacyPath;
	} catch {
		// ignore
	}

	// Default to canonical (for new projects)
	return canonicalPath;
}

/**
 * Check if a project has existing Auto Run documents.
 * Checks both canonical (.maestro/playbooks) and legacy (Auto Run Docs) locations.
 *
 * @param projectPath - Root path of the project (not the playbooks folder)
 * @returns True if either playbooks folder exists and contains at least one .md file
 */
export async function hasExistingAutoRunDocs(projectPath: string): Promise<boolean> {
	try {
		const folderPath = await resolvePlaybooksFolderPath(projectPath);
		const result = await window.maestro.autorun.listDocs(folderPath);

		if (!result.success) {
			return false;
		}

		return result.files.length > 0;
	} catch (error) {
		console.debug('[existingDocsDetector] hasExistingAutoRunDocs error:', error);
		return false;
	}
}

/**
 * Get a list of existing Auto Run documents in a project.
 * Checks both canonical and legacy locations.
 *
 * @param projectPath - Root path of the project (not the playbooks folder)
 * @returns Array of ExistingDocument objects, empty if no documents exist
 */
export async function getExistingAutoRunDocs(projectPath: string): Promise<ExistingDocument[]> {
	try {
		const folderPath = await resolvePlaybooksFolderPath(projectPath);
		const result = await window.maestro.autorun.listDocs(folderPath);

		if (!result.success || !result.files) {
			return [];
		}

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
 * @param projectPath - Root path of the project
 * @returns Number of Auto Run documents, 0 if none or folder doesn't exist
 */
export async function getExistingAutoRunDocsCount(projectPath: string): Promise<number> {
	try {
		const folderPath = await resolvePlaybooksFolderPath(projectPath);
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
