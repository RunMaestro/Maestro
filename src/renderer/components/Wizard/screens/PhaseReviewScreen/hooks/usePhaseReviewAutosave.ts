import { useCallback, useEffect, useRef } from 'react';
import type { GeneratedDocument } from '../../../WizardContext';
import { logger } from '../../../../../utils/logger';
import { captureException } from '../../../../../utils/sentry';

const AUTO_SAVE_DELAY = 2000;

export function usePhaseReviewAutosave({
	localContent,
	folderPath,
	currentDoc,
	currentDocumentIndex,
	setEditedPhase1Content,
}: {
	localContent: string;
	folderPath: string;
	currentDoc: GeneratedDocument | undefined;
	currentDocumentIndex: number;
	setEditedPhase1Content: (content: string | null) => void;
}) {
	const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastSavedContentRef = useRef<string>(localContent);
	const isSavingRef = useRef<boolean>(false);
	const pendingSaveContentRef = useRef<string | null>(null);
	const currentDocKeyRef = useRef<string | undefined>(currentDoc?.filename);

	useEffect(() => {
		if (currentDocKeyRef.current !== currentDoc?.filename) {
			currentDocKeyRef.current = currentDoc?.filename;
			lastSavedContentRef.current = localContent;
			pendingSaveContentRef.current = null;
		}
	}, [currentDoc?.filename, localContent]);

	const persistContent = useCallback(
		async (content: string) => {
			if (!currentDoc) return;

			await window.maestro.autorun.writeDoc(folderPath, currentDoc.filename, content);
			lastSavedContentRef.current = content;
			if (currentDocumentIndex === 0) {
				setEditedPhase1Content(content);
			}
		},
		[currentDoc, currentDocumentIndex, folderPath, setEditedPhase1Content]
	);

	const saveNow = useCallback(
		async (content: string = localContent) => {
			if (!currentDoc || content === lastSavedContentRef.current) return;
			await persistContent(content);
		},
		[currentDoc, localContent, persistContent]
	);

	useEffect(() => {
		if (localContent === lastSavedContentRef.current) return;

		if (autoSaveTimeoutRef.current) {
			clearTimeout(autoSaveTimeoutRef.current);
		}

		autoSaveTimeoutRef.current = setTimeout(async () => {
			if (isSavingRef.current) {
				pendingSaveContentRef.current = localContent;
				return;
			}

			if (localContent !== lastSavedContentRef.current && currentDoc) {
				isSavingRef.current = true;
				try {
					await persistContent(localContent);
				} catch (err) {
					logger.error('Auto-save failed:', undefined, err);
					captureException(err, {
						extra: {
							context: 'usePhaseReviewAutosave.autosave',
							folderPath,
							filename: currentDoc.filename,
							currentDocumentIndex,
						},
					});
				} finally {
					isSavingRef.current = false;

					if (
						pendingSaveContentRef.current !== null &&
						pendingSaveContentRef.current !== lastSavedContentRef.current
					) {
						const pendingContent = pendingSaveContentRef.current;
						pendingSaveContentRef.current = null;
						try {
							isSavingRef.current = true;
							await persistContent(pendingContent);
						} catch (err) {
							logger.error('Auto-save (pending) failed:', undefined, err);
							captureException(err, {
								extra: {
									context: 'usePhaseReviewAutosave.pendingAutosave',
									folderPath,
									filename: currentDoc.filename,
									currentDocumentIndex,
								},
							});
						} finally {
							isSavingRef.current = false;
						}
					}
				}
			}
		}, AUTO_SAVE_DELAY);

		return () => {
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
			}
		};
	}, [currentDoc, currentDocumentIndex, folderPath, localContent, persistContent]);

	return {
		lastSavedContentRef,
		saveNow,
	};
}
