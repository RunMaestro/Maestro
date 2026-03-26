export const FILE_EXPLORER_ICON_THEMES = ['default', 'rich'] as const;

export type FileExplorerIconTheme = (typeof FILE_EXPLORER_ICON_THEMES)[number];

export const isFileExplorerIconTheme = (value: unknown): value is FileExplorerIconTheme =>
	typeof value === 'string' && FILE_EXPLORER_ICON_THEMES.includes(value as FileExplorerIconTheme);

export const CODE_EXTENSIONS = new Set([
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

export const CONFIG_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg']);
export const DOC_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'rst']);
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);
export const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z']);

export const LOCK_FILE_NAMES = new Set([
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'bun.lock',
	'bun.lockb',
	'composer.lock',
	'cargo.lock',
	'poetry.lock',
]);

export const CONFIG_FILE_NAMES = new Set([
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

export const DOC_FOLDER_NAMES = new Set(['docs', 'doc', 'documentation', 'notes', 'wiki']);
export const TEST_FOLDER_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e']);
export const CONFIG_FOLDER_NAMES = new Set([
	'.github',
	'.vscode',
	'.claude',
	'.codex',
	'config',
	'configs',
	'settings',
]);
export const ASSET_FOLDER_NAMES = new Set([
	'assets',
	'images',
	'img',
	'icons',
	'public',
	'static',
	'media',
]);
export const DEP_FOLDER_NAMES = new Set(['node_modules', 'vendor', 'deps', 'packages']);
export const DATA_FOLDER_NAMES = new Set(['data', 'db', 'database', 'migrations', 'seeds']);
export const SECURE_FOLDER_NAMES = new Set(['secrets', 'certs', 'certificates', 'keys']);
export const INFRA_FOLDER_NAMES = new Set([
	'scripts',
	'infra',
	'deployment',
	'docker',
	'ops',
	'bin',
]);
export const DIST_FOLDER_NAMES = new Set(['dist', 'build']);
export const COVERAGE_FOLDER_NAMES = new Set(['coverage']);

export const normalizeExplorerName = (name: string): string => name.trim().toLowerCase();

export const getExplorerFileExtension = (name: string): string => {
	const normalized = normalizeExplorerName(name);
	return normalized.includes('.') ? (normalized.split('.').pop() ?? '') : '';
};

export const isExplorerTestFile = (name: string): boolean => {
	const normalized = normalizeExplorerName(name);
	return (
		normalized.includes('.test.') ||
		normalized.includes('.spec.') ||
		normalized.endsWith('.test') ||
		normalized.endsWith('.spec')
	);
};
