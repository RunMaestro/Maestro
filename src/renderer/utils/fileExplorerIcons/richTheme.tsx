import type { Theme, FileChangeType } from '../../types';
import bunIcon from '../../assets/file-explorer-rich-icons/bun.svg';
import cssIcon from '../../assets/file-explorer-rich-icons/css.svg';
import databaseIcon from '../../assets/file-explorer-rich-icons/database.svg';
import dockerIcon from '../../assets/file-explorer-rich-icons/docker.svg';
import documentIcon from '../../assets/file-explorer-rich-icons/document.svg';
import folderBaseIcon from '../../assets/file-explorer-rich-icons/folder-base.svg';
import folderBaseOpenIcon from '../../assets/file-explorer-rich-icons/folder-base-open.svg';
import folderConfigIcon from '../../assets/file-explorer-rich-icons/folder-config.svg';
import folderConfigOpenIcon from '../../assets/file-explorer-rich-icons/folder-config-open.svg';
import folderCoverageIcon from '../../assets/file-explorer-rich-icons/folder-coverage.svg';
import folderCoverageOpenIcon from '../../assets/file-explorer-rich-icons/folder-coverage-open.svg';
import folderDatabaseIcon from '../../assets/file-explorer-rich-icons/folder-database.svg';
import folderDatabaseOpenIcon from '../../assets/file-explorer-rich-icons/folder-database-open.svg';
import folderDistIcon from '../../assets/file-explorer-rich-icons/folder-dist.svg';
import folderDistOpenIcon from '../../assets/file-explorer-rich-icons/folder-dist-open.svg';
import folderDockerIcon from '../../assets/file-explorer-rich-icons/folder-docker.svg';
import folderDockerOpenIcon from '../../assets/file-explorer-rich-icons/folder-docker-open.svg';
import folderDocsIcon from '../../assets/file-explorer-rich-icons/folder-docs.svg';
import folderDocsOpenIcon from '../../assets/file-explorer-rich-icons/folder-docs-open.svg';
import folderGitHubIcon from '../../assets/file-explorer-rich-icons/folder-github.svg';
import folderGitHubOpenIcon from '../../assets/file-explorer-rich-icons/folder-github-open.svg';
import folderGitIcon from '../../assets/file-explorer-rich-icons/folder-git.svg';
import folderGitOpenIcon from '../../assets/file-explorer-rich-icons/folder-git-open.svg';
import folderImagesIcon from '../../assets/file-explorer-rich-icons/folder-images.svg';
import folderImagesOpenIcon from '../../assets/file-explorer-rich-icons/folder-images-open.svg';
import folderMigrationsIcon from '../../assets/file-explorer-rich-icons/folder-migrations.svg';
import folderMigrationsOpenIcon from '../../assets/file-explorer-rich-icons/folder-migrations-open.svg';
import folderNodeIcon from '../../assets/file-explorer-rich-icons/folder-node.svg';
import folderNodeOpenIcon from '../../assets/file-explorer-rich-icons/folder-node-open.svg';
import folderPackagesIcon from '../../assets/file-explorer-rich-icons/folder-packages.svg';
import folderPackagesOpenIcon from '../../assets/file-explorer-rich-icons/folder-packages-open.svg';
import folderPublicIcon from '../../assets/file-explorer-rich-icons/folder-public.svg';
import folderPublicOpenIcon from '../../assets/file-explorer-rich-icons/folder-public-open.svg';
import folderScriptsIcon from '../../assets/file-explorer-rich-icons/folder-scripts.svg';
import folderScriptsOpenIcon from '../../assets/file-explorer-rich-icons/folder-scripts-open.svg';
import folderSecureIcon from '../../assets/file-explorer-rich-icons/folder-secure.svg';
import folderSecureOpenIcon from '../../assets/file-explorer-rich-icons/folder-secure-open.svg';
import folderSrcIcon from '../../assets/file-explorer-rich-icons/folder-src.svg';
import folderSrcOpenIcon from '../../assets/file-explorer-rich-icons/folder-src-open.svg';
import folderTestIcon from '../../assets/file-explorer-rich-icons/folder-test.svg';
import folderTestOpenIcon from '../../assets/file-explorer-rich-icons/folder-test-open.svg';
import gitIcon from '../../assets/file-explorer-rich-icons/git.svg';
import htmlIcon from '../../assets/file-explorer-rich-icons/html.svg';
import imageIcon from '../../assets/file-explorer-rich-icons/image.svg';
import javascriptIcon from '../../assets/file-explorer-rich-icons/javascript.svg';
import jestIcon from '../../assets/file-explorer-rich-icons/jest.svg';
import jsonIcon from '../../assets/file-explorer-rich-icons/json.svg';
import jsonSchemaIcon from '../../assets/file-explorer-rich-icons/json_schema.svg';
import licenseIcon from '../../assets/file-explorer-rich-icons/license.svg';
import lockIcon from '../../assets/file-explorer-rich-icons/lock.svg';
import markdownIcon from '../../assets/file-explorer-rich-icons/markdown.svg';
import nodejsIcon from '../../assets/file-explorer-rich-icons/nodejs.svg';
import npmIcon from '../../assets/file-explorer-rich-icons/npm.svg';
import pnpmIcon from '../../assets/file-explorer-rich-icons/pnpm.svg';
import reactIcon from '../../assets/file-explorer-rich-icons/react.svg';
import readmeIcon from '../../assets/file-explorer-rich-icons/readme.svg';
import settingsIcon from '../../assets/file-explorer-rich-icons/settings.svg';
import testJsIcon from '../../assets/file-explorer-rich-icons/test-js.svg';
import testJsxIcon from '../../assets/file-explorer-rich-icons/test-jsx.svg';
import testTsIcon from '../../assets/file-explorer-rich-icons/test-ts.svg';
import typescriptDefIcon from '../../assets/file-explorer-rich-icons/typescript-def.svg';
import typescriptIcon from '../../assets/file-explorer-rich-icons/typescript.svg';
import vitestIcon from '../../assets/file-explorer-rich-icons/vitest.svg';
import yamlIcon from '../../assets/file-explorer-rich-icons/yaml.svg';
import yarnIcon from '../../assets/file-explorer-rich-icons/yarn.svg';
import zipIcon from '../../assets/file-explorer-rich-icons/zip.svg';
import {
	ARCHIVE_EXTENSIONS,
	ASSET_FOLDER_NAMES,
	CODE_EXTENSIONS,
	CONFIG_EXTENSIONS,
	CONFIG_FILE_NAMES,
	CONFIG_FOLDER_NAMES,
	COVERAGE_FOLDER_NAMES,
	DATA_FOLDER_NAMES,
	DEP_FOLDER_NAMES,
	DIST_FOLDER_NAMES,
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

type RichFolderIconPair = {
	closed: string;
	open: string;
};

const richIconClassName = 'w-4 h-4 flex-shrink-0 select-none';

const renderRichIcon = (src: string, iconKey: string): JSX.Element => (
	<img
		src={src}
		alt=""
		aria-hidden="true"
		draggable={false}
		className={richIconClassName}
		data-file-explorer-icon-theme="rich"
		data-file-explorer-icon-key={iconKey}
	/>
);

const richFolderIcon = (
	iconKey: string,
	isExpanded: boolean,
	icons: RichFolderIconPair
): JSX.Element => renderRichIcon(isExpanded ? icons.open : icons.closed, iconKey);

const getRichTestIcon = (normalized: string): string => {
	if (normalized.includes('vitest')) return vitestIcon;
	if (normalized.includes('jest')) return jestIcon;
	if (normalized.endsWith('.jsx') || normalized.endsWith('.tsx')) return testJsxIcon;
	if (normalized.endsWith('.ts')) return testTsIcon;
	return testJsIcon;
};

export const getRichExplorerFileIcon = (
	fileName: string,
	_theme: Theme,
	_type?: FileChangeType
): JSX.Element => {
	const normalized = normalizeExplorerName(fileName);
	const ext = getExplorerFileExtension(fileName);

	if (normalized === 'readme' || normalized.startsWith('readme.')) {
		return renderRichIcon(readmeIcon, 'readme');
	}
	if (normalized === 'license' || normalized.startsWith('license.')) {
		return renderRichIcon(licenseIcon, 'license');
	}
	if (normalized === 'package.json') {
		return renderRichIcon(npmIcon, 'package');
	}
	if (normalized === 'pnpm-lock.yaml' || normalized === 'pnpm-workspace.yaml') {
		return renderRichIcon(pnpmIcon, 'pnpm');
	}
	if (normalized === 'bun.lock' || normalized === 'bun.lockb') {
		return renderRichIcon(bunIcon, 'bun');
	}
	if (normalized === 'yarn.lock') {
		return renderRichIcon(yarnIcon, 'yarn');
	}
	if (LOCK_FILE_NAMES.has(normalized)) {
		return renderRichIcon(lockIcon, 'lock');
	}
	if (
		normalized === '.gitignore' ||
		normalized === '.gitattributes' ||
		normalized === '.gitmodules'
	) {
		return renderRichIcon(gitIcon, 'git');
	}
	if (normalized === '.nvmrc') {
		return renderRichIcon(nodejsIcon, 'node');
	}
	if (normalized.includes('docker') || normalized === 'dockerfile') {
		return renderRichIcon(dockerIcon, 'docker');
	}
	if (normalized.includes('schema') && ext === 'json') {
		return renderRichIcon(jsonSchemaIcon, 'json-schema');
	}
	if (isExplorerTestFile(fileName)) {
		return renderRichIcon(getRichTestIcon(normalized), 'test');
	}
	if (normalized.endsWith('.d.ts')) {
		return renderRichIcon(typescriptDefIcon, 'typescript-def');
	}
	if (ext === 'tsx' || ext === 'jsx') {
		return renderRichIcon(reactIcon, 'react');
	}
	if (ext === 'ts') {
		return renderRichIcon(typescriptIcon, 'typescript');
	}
	if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
		return renderRichIcon(javascriptIcon, 'javascript');
	}
	if (ext === 'json' || ext === 'json5' || ext === 'jsonc') {
		return renderRichIcon(jsonIcon, 'json');
	}
	if (ext === 'yaml' || ext === 'yml') {
		return renderRichIcon(yamlIcon, 'yaml');
	}
	if (CONFIG_FILE_NAMES.has(normalized) || CONFIG_EXTENSIONS.has(ext)) {
		return renderRichIcon(settingsIcon, 'settings');
	}
	if (ext === 'html' || ext === 'htm') {
		return renderRichIcon(htmlIcon, 'html');
	}
	if (ext === 'css' || ext === 'scss' || ext === 'sass' || ext === 'less') {
		return renderRichIcon(cssIcon, 'css');
	}
	if (DOC_EXTENSIONS.has(ext)) {
		return renderRichIcon(markdownIcon, 'docs');
	}
	if (IMAGE_EXTENSIONS.has(ext)) {
		return renderRichIcon(imageIcon, 'image');
	}
	if (ARCHIVE_EXTENSIONS.has(ext)) {
		return renderRichIcon(zipIcon, 'archive');
	}
	if (ext === 'csv' || ext === 'tsv' || ext === 'sql') {
		return renderRichIcon(databaseIcon, 'database');
	}
	if (CODE_EXTENSIONS.has(ext)) {
		return renderRichIcon(documentIcon, 'code');
	}
	return renderRichIcon(documentIcon, 'file');
};

export const getRichExplorerFolderIcon = (
	folderName: string,
	isExpanded: boolean,
	_theme: Theme
): JSX.Element => {
	const normalized = normalizeExplorerName(folderName);

	if (normalized === '.git') {
		return richFolderIcon('git', isExpanded, {
			closed: folderGitIcon,
			open: folderGitOpenIcon,
		});
	}
	if (normalized === '.github') {
		return richFolderIcon('github', isExpanded, {
			closed: folderGitHubIcon,
			open: folderGitHubOpenIcon,
		});
	}
	if (normalized === 'src') {
		return richFolderIcon('src', isExpanded, {
			closed: folderSrcIcon,
			open: folderSrcOpenIcon,
		});
	}
	if (DOC_FOLDER_NAMES.has(normalized)) {
		return richFolderIcon('docs', isExpanded, {
			closed: folderDocsIcon,
			open: folderDocsOpenIcon,
		});
	}
	if (TEST_FOLDER_NAMES.has(normalized)) {
		return richFolderIcon('test', isExpanded, {
			closed: folderTestIcon,
			open: folderTestOpenIcon,
		});
	}
	if (CONFIG_FOLDER_NAMES.has(normalized)) {
		return richFolderIcon('config', isExpanded, {
			closed: folderConfigIcon,
			open: folderConfigOpenIcon,
		});
	}
	if (normalized === 'public') {
		return richFolderIcon('public', isExpanded, {
			closed: folderPublicIcon,
			open: folderPublicOpenIcon,
		});
	}
	if (ASSET_FOLDER_NAMES.has(normalized)) {
		return richFolderIcon('assets', isExpanded, {
			closed: folderImagesIcon,
			open: folderImagesOpenIcon,
		});
	}
	if (normalized === 'node_modules') {
		return richFolderIcon('node', isExpanded, {
			closed: folderNodeIcon,
			open: folderNodeOpenIcon,
		});
	}
	if (normalized === 'packages') {
		return richFolderIcon('packages', isExpanded, {
			closed: folderPackagesIcon,
			open: folderPackagesOpenIcon,
		});
	}
	if (DEP_FOLDER_NAMES.has(normalized)) {
		return richFolderIcon('dependencies', isExpanded, {
			closed: folderPackagesIcon,
			open: folderPackagesOpenIcon,
		});
	}
	if (normalized === 'migrations') {
		return richFolderIcon('migrations', isExpanded, {
			closed: folderMigrationsIcon,
			open: folderMigrationsOpenIcon,
		});
	}
	if (DATA_FOLDER_NAMES.has(normalized)) {
		return richFolderIcon('database', isExpanded, {
			closed: folderDatabaseIcon,
			open: folderDatabaseOpenIcon,
		});
	}
	if (SECURE_FOLDER_NAMES.has(normalized)) {
		return richFolderIcon('secure', isExpanded, {
			closed: folderSecureIcon,
			open: folderSecureOpenIcon,
		});
	}
	if (normalized === 'docker') {
		return richFolderIcon('docker', isExpanded, {
			closed: folderDockerIcon,
			open: folderDockerOpenIcon,
		});
	}
	if (INFRA_FOLDER_NAMES.has(normalized)) {
		return richFolderIcon('scripts', isExpanded, {
			closed: folderScriptsIcon,
			open: folderScriptsOpenIcon,
		});
	}
	if (DIST_FOLDER_NAMES.has(normalized)) {
		return richFolderIcon('dist', isExpanded, {
			closed: folderDistIcon,
			open: folderDistOpenIcon,
		});
	}
	if (COVERAGE_FOLDER_NAMES.has(normalized)) {
		return richFolderIcon('coverage', isExpanded, {
			closed: folderCoverageIcon,
			open: folderCoverageOpenIcon,
		});
	}
	return richFolderIcon('folder', isExpanded, {
		closed: folderBaseIcon,
		open: folderBaseOpenIcon,
	});
};
