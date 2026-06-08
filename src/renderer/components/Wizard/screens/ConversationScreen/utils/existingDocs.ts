import { PLAYBOOKS_DIR } from '../../../../../../shared/maestro-paths';
import { logger } from '../../../../../utils/logger';
import type { ExistingDocument } from '../../../services/wizardPrompts';

export async function readExistingDocuments(autoRunPath: string): Promise<ExistingDocument[]> {
	try {
		const listResult = await window.maestro.autorun.listDocs(autoRunPath);

		if (!listResult.success || !listResult.files || listResult.files.length === 0) {
			return [];
		}

		const docs: ExistingDocument[] = [];
		for (const filename of listResult.files) {
			try {
				const readResult = await window.maestro.autorun.readDoc(autoRunPath, filename);
				if (readResult.success && readResult.content) {
					docs.push({
						filename,
						content: readResult.content,
					});
				}
			} catch (err) {
				logger.warn(`Failed to read existing doc ${filename}:`, undefined, err);
			}
		}

		return docs;
	} catch (error) {
		logger.warn('Failed to fetch existing docs:', undefined, error);
		return [];
	}
}

export async function fetchExistingDocsForWizard(
	directoryPath: string,
	existingDocsChoice: 'continue' | 'fresh' | null
): Promise<ExistingDocument[]> {
	if (existingDocsChoice !== 'continue') {
		return [];
	}

	return readExistingDocuments(`${directoryPath}/${PLAYBOOKS_DIR}`);
}
