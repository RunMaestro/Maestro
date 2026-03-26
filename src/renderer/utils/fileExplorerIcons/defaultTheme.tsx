import {
	BookOpen,
	Database,
	File,
	FileCode,
	FileImage,
	FlaskConical,
	Folder,
	FolderOpen,
	GitBranch,
	ImageIcon,
	Lock,
	Package,
	Server,
	Settings,
} from 'lucide-react';
import type { Theme, FileChangeType } from '../../types';
import {
	ARCHIVE_EXTENSIONS,
	ASSET_FOLDER_NAMES,
	CODE_EXTENSIONS,
	CONFIG_EXTENSIONS,
	CONFIG_FILE_NAMES,
	CONFIG_FOLDER_NAMES,
	DATA_FOLDER_NAMES,
	DEP_FOLDER_NAMES,
	DOC_EXTENSIONS,
	DOC_FOLDER_NAMES,
	IMAGE_EXTENSIONS,
	INFRA_FOLDER_NAMES,
	LOCK_FILE_NAMES,
	SECURE_FOLDER_NAMES,
	TEST_FOLDER_NAMES,
	getExplorerFileExtension,
	isExplorerTestFile,
	normalizeExplorerName,
} from './shared';

const fileTypeColor = (type: FileChangeType | undefined, fallback: string): string => {
	if (type === 'added') return 'var(--maestro-success-color)';
	if (type === 'deleted') return 'var(--maestro-error-color)';
	if (type === 'modified') return 'var(--maestro-warning-color)';
	return fallback;
};

const defaultFileIconProps = (
	iconKey: string,
	theme: Theme,
	type: FileChangeType | undefined,
	fallbackColor: string
) => ({
	className: 'w-3.5 h-3.5',
	style: {
		'--maestro-success-color': theme.colors.success,
		'--maestro-error-color': theme.colors.error,
		'--maestro-warning-color': theme.colors.warning,
		color: fileTypeColor(type, fallbackColor),
	},
	'data-file-explorer-icon-theme': 'default',
	'data-file-explorer-icon-key': iconKey,
});

const defaultFolderIconProps = (iconKey: string, color: string) => ({
	className: 'w-3.5 h-3.5',
	style: { color },
	'data-file-explorer-icon-theme': 'default',
	'data-file-explorer-icon-key': iconKey,
});

export const getDefaultExplorerFileIcon = (
	fileName: string,
	theme: Theme,
	type?: FileChangeType
): JSX.Element => {
	const normalized = normalizeExplorerName(fileName);
	const ext = getExplorerFileExtension(fileName);

	if (LOCK_FILE_NAMES.has(normalized)) {
		return <Lock {...defaultFileIconProps('lock', theme, type, theme.colors.accent)} />;
	}
	if (CONFIG_FILE_NAMES.has(normalized) || CONFIG_EXTENSIONS.has(ext)) {
		return <Settings {...defaultFileIconProps('settings', theme, type, theme.colors.accent)} />;
	}
	if (IMAGE_EXTENSIONS.has(ext)) {
		return <FileImage {...defaultFileIconProps('image', theme, type, theme.colors.accent)} />;
	}
	if (DOC_EXTENSIONS.has(ext)) {
		return <BookOpen {...defaultFileIconProps('docs', theme, type, theme.colors.accent)} />;
	}
	if (ARCHIVE_EXTENSIONS.has(ext)) {
		return <Package {...defaultFileIconProps('archive', theme, type, theme.colors.accent)} />;
	}
	if (isExplorerTestFile(fileName)) {
		return <FlaskConical {...defaultFileIconProps('test', theme, type, theme.colors.accent)} />;
	}
	if (CODE_EXTENSIONS.has(ext)) {
		return <FileCode {...defaultFileIconProps('code', theme, type, theme.colors.accent)} />;
	}
	if (ext === 'csv' || ext === 'tsv') {
		return <Database {...defaultFileIconProps('database', theme, type, theme.colors.accent)} />;
	}
	return <File {...defaultFileIconProps('file', theme, type, theme.colors.accent)} />;
};

export const getDefaultExplorerFolderIcon = (
	folderName: string,
	isExpanded: boolean,
	theme: Theme
): JSX.Element => {
	const normalized = normalizeExplorerName(folderName);

	if (normalized === '.git') {
		return <GitBranch {...defaultFolderIconProps('git', theme.colors.accent)} />;
	}
	if (DOC_FOLDER_NAMES.has(normalized)) {
		return <BookOpen {...defaultFolderIconProps('docs', theme.colors.accent)} />;
	}
	if (TEST_FOLDER_NAMES.has(normalized)) {
		return <FlaskConical {...defaultFolderIconProps('test', theme.colors.accent)} />;
	}
	if (CONFIG_FOLDER_NAMES.has(normalized)) {
		return <Settings {...defaultFolderIconProps('config', theme.colors.accent)} />;
	}
	if (ASSET_FOLDER_NAMES.has(normalized)) {
		return <ImageIcon {...defaultFolderIconProps('assets', theme.colors.accent)} />;
	}
	if (DEP_FOLDER_NAMES.has(normalized)) {
		return <Package {...defaultFolderIconProps('dependencies', theme.colors.accent)} />;
	}
	if (DATA_FOLDER_NAMES.has(normalized)) {
		return <Database {...defaultFolderIconProps('database', theme.colors.accent)} />;
	}
	if (SECURE_FOLDER_NAMES.has(normalized)) {
		return <Lock {...defaultFolderIconProps('secure', theme.colors.error)} />;
	}
	if (INFRA_FOLDER_NAMES.has(normalized)) {
		return <Server {...defaultFolderIconProps('infra', theme.colors.accent)} />;
	}
	return isExpanded ? (
		<FolderOpen {...defaultFolderIconProps('folder-open', theme.colors.accent)} />
	) : (
		<Folder {...defaultFolderIconProps('folder', theme.colors.accent)} />
	);
};
