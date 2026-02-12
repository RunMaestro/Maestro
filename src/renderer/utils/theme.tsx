import {
	BookOpen,
	Database,
	File,
	FileCode,
	FileImage,
	FilePlus,
	FileText,
	FlaskConical,
	Folder,
	FolderOpen,
	GitBranch,
	ImageIcon,
	Lock,
	Package,
	Server,
	Settings,
	Trash2,
} from 'lucide-react';
import type { Theme, SessionState, FileChangeType } from '../types';

// Re-export formatActiveTime from formatters for backwards compatibility
export { formatActiveTime } from './formatters';

// Get color based on context usage percentage.
// Thresholds default to 60/80 but can be overridden to match user's context warning settings.
export const getContextColor = (
	usage: number,
	theme: Theme,
	yellowThreshold = 60,
	redThreshold = 80
): string => {
	if (usage >= redThreshold) return theme.colors.error;
	if (usage >= yellowThreshold) return theme.colors.warning;
	return theme.colors.success;
};

// Get color based on session state
// Status indicator colors:
// - Green: ready and waiting (idle)
// - Yellow: agent is thinking (busy, waiting_input)
// - Red: no connection with agent (error)
// - Pulsing orange: attempting to establish connection (connecting)
export const getStatusColor = (state: SessionState, theme: Theme): string => {
	switch (state) {
		case 'idle':
			return theme.colors.success; // Green - ready and waiting
		case 'busy':
			return theme.colors.warning; // Yellow - agent is thinking
		case 'waiting_input':
			return theme.colors.warning; // Yellow - waiting for input
		case 'error':
			return theme.colors.error; // Red - no connection
		case 'connecting':
			return '#ff8800'; // Orange - attempting to connect
		default:
			return theme.colors.success;
	}
};

// Get file icon based on change type
export const getFileIcon = (type: FileChangeType | undefined, theme: Theme): JSX.Element => {
	switch (type) {
		case 'added':
			return <FilePlus className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />;
		case 'deleted':
			return <Trash2 className="w-3.5 h-3.5" style={{ color: theme.colors.error }} />;
		case 'modified':
			return <FileCode className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />;
		default:
			return <FileText className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />;
	}
};

const CODE_EXTENSIONS = new Set([
	'ts',
	'tsx',
	'js',
	'jsx',
	'mjs',
	'cjs',
	'py',
	'rb',
	'go',
	'rs',
	'java',
	'kt',
	'swift',
	'cpp',
	'c',
	'h',
	'hpp',
	'cs',
	'php',
	'lua',
	'sh',
	'zsh',
	'fish',
	'bash',
	'sql',
]);

const CONFIG_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg']);
const DOC_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'rst']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z']);
const LOCK_FILE_NAMES = new Set([
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'bun.lock',
	'bun.lockb',
	'composer.lock',
	'cargo.lock',
	'poetry.lock',
]);
const CONFIG_FILE_NAMES = new Set([
	'.env',
	'.env.local',
	'.env.development',
	'.env.production',
	'.gitignore',
	'.gitattributes',
	'dockerfile',
	'compose.yml',
	'compose.yaml',
	'docker-compose.yml',
	'docker-compose.yaml',
	'tsconfig.json',
	'vite.config.ts',
	'vite.config.js',
	'webpack.config.js',
	'eslint.config.js',
	'eslint.config.mjs',
	'prettier.config.js',
	'next.config.js',
	'next.config.ts',
]);

const DOC_FOLDER_NAMES = new Set(['docs', 'doc', 'documentation', 'notes', 'wiki']);
const TEST_FOLDER_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e']);
const CONFIG_FOLDER_NAMES = new Set([
	'.github',
	'.vscode',
	'.claude',
	'.codex',
	'config',
	'configs',
	'settings',
]);
const ASSET_FOLDER_NAMES = new Set(['assets', 'images', 'img', 'icons', 'public', 'static', 'media']);
const DEP_FOLDER_NAMES = new Set(['node_modules', 'vendor', 'deps', 'packages']);
const DATA_FOLDER_NAMES = new Set(['data', 'db', 'database', 'migrations', 'seeds']);
const SECURE_FOLDER_NAMES = new Set(['secrets', 'certs', 'certificates', 'keys']);
const INFRA_FOLDER_NAMES = new Set(['scripts', 'infra', 'deployment', 'docker', 'ops', 'bin']);

const normalizeName = (name: string): string => name.trim().toLowerCase();

const fileTypeColor = (type: FileChangeType | undefined, fallback: string): string => {
	if (type === 'added') return 'var(--maestro-success-color)';
	if (type === 'deleted') return 'var(--maestro-error-color)';
	if (type === 'modified') return 'var(--maestro-warning-color)';
	return fallback;
};

export const getExplorerFileIcon = (
	fileName: string,
	theme: Theme,
	type?: FileChangeType
): JSX.Element => {
	const normalized = normalizeName(fileName);
	const ext = normalized.includes('.') ? normalized.split('.').pop() ?? '' : '';
	const isTestFile =
		normalized.includes('.test.') ||
		normalized.includes('.spec.') ||
		normalized.endsWith('.test') ||
		normalized.endsWith('.spec');

	const style = {
		'--maestro-success-color': theme.colors.success,
		'--maestro-error-color': theme.colors.error,
		'--maestro-warning-color': theme.colors.warning,
	};

	if (LOCK_FILE_NAMES.has(normalized)) {
		return <Lock className="w-3.5 h-3.5" style={{ ...style, color: fileTypeColor(type, theme.colors.warning) }} />;
	}
	if (CONFIG_FILE_NAMES.has(normalized) || CONFIG_EXTENSIONS.has(ext)) {
		return (
			<Settings
				className="w-3.5 h-3.5"
				style={{ ...style, color: fileTypeColor(type, theme.colors.warning) }}
			/>
		);
	}
	if (IMAGE_EXTENSIONS.has(ext)) {
		return (
			<FileImage
				className="w-3.5 h-3.5"
				style={{ ...style, color: fileTypeColor(type, theme.colors.accent) }}
			/>
		);
	}
	if (DOC_EXTENSIONS.has(ext)) {
		return (
			<BookOpen
				className="w-3.5 h-3.5"
				style={{ ...style, color: fileTypeColor(type, theme.colors.accent) }}
			/>
		);
	}
	if (ARCHIVE_EXTENSIONS.has(ext)) {
		return (
			<Package
				className="w-3.5 h-3.5"
				style={{ ...style, color: fileTypeColor(type, theme.colors.warning) }}
			/>
		);
	}
	if (isTestFile) {
		return (
			<FlaskConical
				className="w-3.5 h-3.5"
				style={{ ...style, color: fileTypeColor(type, theme.colors.warning) }}
			/>
		);
	}
	if (CODE_EXTENSIONS.has(ext)) {
		return (
			<FileCode
				className="w-3.5 h-3.5"
				style={{ ...style, color: fileTypeColor(type, theme.colors.accent) }}
			/>
		);
	}
	if (ext === 'csv' || ext === 'tsv') {
		return (
			<Database
				className="w-3.5 h-3.5"
				style={{ ...style, color: fileTypeColor(type, theme.colors.accent) }}
			/>
		);
	}
	return <File className="w-3.5 h-3.5" style={{ ...style, color: fileTypeColor(type, theme.colors.textDim) }} />;
};

export const getExplorerFolderIcon = (
	folderName: string,
	isExpanded: boolean,
	theme: Theme
): JSX.Element => {
	const normalized = normalizeName(folderName);

	if (normalized === '.git') {
		return <GitBranch className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />;
	}
	if (DOC_FOLDER_NAMES.has(normalized)) {
		return <BookOpen className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />;
	}
	if (TEST_FOLDER_NAMES.has(normalized)) {
		return <FlaskConical className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />;
	}
	if (CONFIG_FOLDER_NAMES.has(normalized)) {
		return <Settings className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />;
	}
	if (ASSET_FOLDER_NAMES.has(normalized)) {
		return <ImageIcon className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />;
	}
	if (DEP_FOLDER_NAMES.has(normalized)) {
		return <Package className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />;
	}
	if (DATA_FOLDER_NAMES.has(normalized)) {
		return <Database className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />;
	}
	if (SECURE_FOLDER_NAMES.has(normalized)) {
		return <Lock className="w-3.5 h-3.5" style={{ color: theme.colors.error }} />;
	}
	if (INFRA_FOLDER_NAMES.has(normalized)) {
		return <Server className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />;
	}
	return isExpanded ? (
		<FolderOpen className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
	) : (
		<Folder className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
	);
};
