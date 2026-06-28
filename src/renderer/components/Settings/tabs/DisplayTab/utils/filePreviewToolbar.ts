import type { FilePreviewToolbarButton } from '../../../../../stores/settingsStore';

export const TOOLBAR_BUTTON_LABELS: Record<FilePreviewToolbarButton, string> = {
	save: 'Save',
	wordWrap: 'Word wrap',
	remoteImages: 'Show remote images',
	htmlRender: 'Render HTML',
	previewTier: 'Preview tier chip',
	editToggle: 'Edit / preview toggle',
	editImage: 'Edit image',
	copyContent: 'Copy content',
	publishGist: 'Publish as gist',
	documentGraph: 'Document graph',
	openInBrowser: 'Open in Maestro browser',
	openInDefault: 'Open in default app',
	copyPath: 'Copy file path',
};
