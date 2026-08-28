import type { FilePreviewToolbarButton } from '../../../../../stores/settingsStore';

export const TOOLBAR_BUTTON_LABELS: Record<FilePreviewToolbarButton, string> = {
	save: 'Save',
	wordWrap: 'Word wrap',
	remoteImages: 'Show remote images',
	htmlRender: 'Render HTML',
	openInBrowser: 'Open in Maestro browser',
	previewTier: 'Preview tier chip',
	editToggle: 'Edit / preview toggle',
	editImage: 'Edit image',
	copyContent: 'Copy content',
	publishGist: 'Publish as gist',
	documentGraph: 'Document graph',
	talkWithDocument: 'Talk with document',
	openInDefault: 'Open in default app',
	// Platform-dependent wording ("Reveal in Finder" / "Explorer" / "File Manager")
	// is resolved at render time via getRevealLabel().
	revealInFolder: 'Reveal in Finder',
	copyPath: 'Copy file path',
	delete: 'Delete file',
};
