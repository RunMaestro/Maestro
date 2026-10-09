import { logger } from '../../../utils/logger';
import { getAutoRunFolderPath, type ExistingDocument } from '../../../utils/existingDocsDetector';
import type { ExistingDocumentWithContent } from '../../../services/inlineWizardConversation';
import type { InlineWizardSshRemoteConfig } from './types';

export function resolveAutoRunFolderPath(
	projectPath?: string,
	configuredAutoRunFolderPath?: string
): string | null {
	return configuredAutoRunFolderPath || (projectPath ? getAutoRunFolderPath(projectPath) : null);
}

export async function hasExistingDocuments(autoRunFolderPath: string | null): Promise<boolean> {
	if (!autoRunFolderPath) return false;

	try {
		const result = await window.maestro.autorun.listDocs(autoRunFolderPath);
		return result.success && result.files && result.files.length > 0;
	} catch {
		return false;
	}
}

export async function listExistingDocuments(
	autoRunFolderPath: string
): Promise<ExistingDocument[]> {
	try {
		const result = await window.maestro.autorun.listDocs(autoRunFolderPath);
		if (result.success && result.files) {
			return result.files.map((name: string) => ({
				name,
				filename: `${name}.md`,
				path: `${autoRunFolderPath}/${name}.md`,
			}));
		}
	} catch {
		// Folder doesn't exist or can't be read - no existing docs.
	}

	return [];
}

/**
 * Load document contents for existing documents.
 * Converts ExistingDocument[] to ExistingDocumentWithContent[].
 */
export async function loadDocumentContents(
	docs: ExistingDocument[],
	autoRunFolderPath: string
): Promise<ExistingDocumentWithContent[]> {
	const docsWithContent: ExistingDocumentWithContent[] = [];

	for (const doc of docs) {
		try {
			const result = await window.maestro.autorun.readDoc(autoRunFolderPath, doc.name);
			if (result.success && result.content !== null && result.content !== undefined) {
				docsWithContent.push({
					...doc,
					content: result.content,
				});
			} else {
				docsWithContent.push({
					...doc,
					content: '(Failed to load content)',
				});
			}
		} catch (error) {
			logger.warn(`[useInlineWizard] Failed to load ${doc.filename}:`, undefined, error);
			docsWithContent.push({
				...doc,
				content: '(Failed to load content)',
			});
		}
	}

	return docsWithContent;
}

export async function fetchHistoryFilePath(
	sessionId?: string,
	sessionSshRemoteConfig?: InlineWizardSshRemoteConfig
): Promise<string | undefined> {
	if (!sessionId || sessionSshRemoteConfig?.enabled) return undefined;

	try {
		const fetchedPath = await window.maestro.history.getFilePath(sessionId);
		return fetchedPath ?? undefined;
	} catch {
		logger.debug('Could not fetch history file path', '[InlineWizard]', { sessionId });
		return undefined;
	}
}
