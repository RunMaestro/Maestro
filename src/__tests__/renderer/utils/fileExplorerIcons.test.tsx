import { describe, expect, it } from 'vitest';
import {
	getDefaultExplorerFileIcon,
	getDefaultExplorerFolderIcon,
} from '../../../renderer/utils/fileExplorerIcons/defaultTheme';
import {
	getRichExplorerFileIcon,
	getRichExplorerFolderIcon,
} from '../../../renderer/utils/fileExplorerIcons/richTheme';
import {
	getExplorerFileExtension,
	isExplorerTestFile,
	isFileExplorerIconTheme,
	normalizeExplorerName,
} from '../../../renderer/utils/fileExplorerIcons/shared';
import type { ReactElement } from 'react';
import type { FileChangeType, Theme } from '../../../renderer/types';

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		background: '#111111',
		backgroundDim: '#0a0a0a',
		backgroundBright: '#222222',
		textMain: '#ffffff',
		textDim: '#999999',
		textMuted: '#777777',
		textBright: '#ffffff',
		border: '#333333',
		borderBright: '#444444',
		success: '#00ff00',
		warning: '#ffff00',
		error: '#ff0000',
		accent: '#6366f1',
	},
};

type ExplorerIconProps = {
	src?: string;
	style?: Record<string, string>;
	'data-file-explorer-icon-theme'?: string;
	'data-file-explorer-icon-key'?: string;
};

const iconProps = (element: JSX.Element): ExplorerIconProps =>
	(element as ReactElement<ExplorerIconProps>).props;

const defaultFileProps = (fileName: string, type?: FileChangeType): ExplorerIconProps =>
	iconProps(getDefaultExplorerFileIcon(fileName, theme, type));

const defaultFileIconKey = (fileName: string, type?: FileChangeType): string | undefined =>
	defaultFileProps(fileName, type)['data-file-explorer-icon-key'];

const defaultFolderProps = (folderName: string, isExpanded = false): ExplorerIconProps =>
	iconProps(getDefaultExplorerFolderIcon(folderName, isExpanded, theme));

const richFileProps = (fileName: string): ExplorerIconProps =>
	iconProps(getRichExplorerFileIcon(fileName, theme));

const richFolderProps = (folderName: string, isExpanded = false): ExplorerIconProps =>
	iconProps(getRichExplorerFolderIcon(folderName, isExpanded, theme));

const richKey = (fileName: string): string | undefined =>
	richFileProps(fileName)['data-file-explorer-icon-key'];

const richFolderKey = (folderName: string, isExpanded = false): string | undefined =>
	richFolderProps(folderName, isExpanded)['data-file-explorer-icon-key'];

describe('file explorer icon shared helpers', () => {
	it('validates supported icon theme names', () => {
		expect(isFileExplorerIconTheme('default')).toBe(true);
		expect(isFileExplorerIconTheme('rich')).toBe(true);
		expect(isFileExplorerIconTheme('minimal')).toBe(false);
		expect(isFileExplorerIconTheme(null)).toBe(false);
	});

	it('normalizes names and extracts extensions consistently', () => {
		expect(normalizeExplorerName('  README.MD  ')).toBe('readme.md');
		expect(getExplorerFileExtension('archive.tar.gz')).toBe('gz');
		expect(getExplorerFileExtension('Dockerfile')).toBe('');
		expect(getExplorerFileExtension('.env.local')).toBe('local');
		expect(getExplorerFileExtension('filename.')).toBe('');
	});

	it('identifies common test filename patterns', () => {
		expect(isExplorerTestFile('button.test.tsx')).toBe(true);
		expect(isExplorerTestFile('button.spec.ts')).toBe(true);
		expect(isExplorerTestFile('integration.test')).toBe(true);
		expect(isExplorerTestFile('integration.spec')).toBe(true);
		expect(isExplorerTestFile('testing-notes.md')).toBe(false);
	});
});

describe('default file explorer icons', () => {
	it.each([
		['package-lock.json', 'lock'],
		['vite.config.ts', 'settings'],
		['settings.toml', 'settings'],
		['hero.PNG', 'image'],
		['README.md', 'docs'],
		['release.zip', 'archive'],
		['button.test.tsx', 'test'],
		['index.ts', 'code'],
		['report.csv', 'database'],
		['data.tsv', 'database'],
		['LICENSE', 'file'],
	])('maps %s to the %s default icon key', (fileName, iconKey) => {
		expect(defaultFileIconKey(fileName)).toBe(iconKey);
	});

	it.each([
		['added' as const, 'var(--maestro-success-color)'],
		['deleted' as const, 'var(--maestro-error-color)'],
		['modified' as const, 'var(--maestro-warning-color)'],
		[undefined, theme.colors.accent],
	])('applies file change color styling for %s files', (type, expectedColor) => {
		const props = defaultFileProps('index.ts', type);

		expect(props.style?.color).toBe(expectedColor);
		expect(props.style?.['--maestro-success-color']).toBe(theme.colors.success);
		expect(props.style?.['--maestro-error-color']).toBe(theme.colors.error);
		expect(props.style?.['--maestro-warning-color']).toBe(theme.colors.warning);
	});

	it.each([
		['.git', 'git'],
		['docs', 'docs'],
		['__tests__', 'test'],
		['.vscode', 'config'],
		['assets', 'assets'],
		['node_modules', 'dependencies'],
		['database', 'database'],
		['secrets', 'secure'],
		['scripts', 'infra'],
		['src', 'folder'],
	])('maps %s to the %s default folder icon key', (folderName, iconKey) => {
		expect(defaultFolderProps(folderName)['data-file-explorer-icon-key']).toBe(iconKey);
	});

	it('uses a distinct default icon key for expanded generic folders', () => {
		expect(defaultFolderProps('src', true)['data-file-explorer-icon-key']).toBe('folder-open');
	});
});

describe('rich file explorer icons', () => {
	it.each([
		['README.md', 'readme'],
		['LICENSE.txt', 'license'],
		['package.json', 'package'],
		['pnpm-workspace.yaml', 'pnpm'],
		['bun.lockb', 'bun'],
		['yarn.lock', 'yarn'],
		['composer.lock', 'lock'],
		['.gitmodules', 'git'],
		['.nvmrc', 'node'],
		['Dockerfile', 'docker'],
		['openapi.schema.json', 'json-schema'],
		['types.d.ts', 'typescript-def'],
		['component.tsx', 'react'],
		['component.jsx', 'react'],
		['index.ts', 'typescript'],
		['index.mjs', 'javascript'],
		['tsconfig.json', 'json'],
		['settings.jsonc', 'json'],
		['workflow.yml', 'yaml'],
		['settings.toml', 'settings'],
		['.env', 'settings'],
		['index.html', 'html'],
		['styles.scss', 'css'],
		['guide.mdx', 'docs'],
		['photo.webp', 'image'],
		['bundle.tgz', 'archive'],
		['query.sql', 'database'],
		['main.py', 'code'],
		['notes.unknown', 'file'],
	])('maps %s to the %s rich file icon key', (fileName, iconKey) => {
		expect(richKey(fileName)).toBe(iconKey);
	});

	it('routes different test filename families through the test icon branch', () => {
		const icons = [
			richFileProps('example.vitest.test.ts'),
			richFileProps('example.jest.test.ts'),
			richFileProps('component.test.tsx'),
			richFileProps('utility.test.ts'),
			richFileProps('legacy.test.js'),
		];

		expect(icons.map((icon) => icon['data-file-explorer-icon-key'])).toEqual([
			'test',
			'test',
			'test',
			'test',
			'test',
		]);
		expect(new Set(icons.map((icon) => icon.src)).size).toBeGreaterThan(1);
	});

	it.each([
		['.git', 'git'],
		['.github', 'github'],
		['src', 'src'],
		['docs', 'docs'],
		['tests', 'test'],
		['config', 'config'],
		['public', 'public'],
		['images', 'assets'],
		['node_modules', 'node'],
		['packages', 'packages'],
		['vendor', 'dependencies'],
		['migrations', 'migrations'],
		['database', 'database'],
		['certs', 'secure'],
		['docker', 'docker'],
		['scripts', 'scripts'],
		['dist', 'dist'],
		['coverage', 'coverage'],
		['features', 'folder'],
	])('maps %s to the %s rich folder icon key', (folderName, iconKey) => {
		expect(richFolderKey(folderName)).toBe(iconKey);
	});

	it('uses different rich folder image sources for collapsed and expanded states', () => {
		const closed = richFolderProps('features', false);
		const open = richFolderProps('features', true);

		expect(closed.src).not.toBe(open.src);
	});
});
