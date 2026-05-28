import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import type { Theme } from '../../renderer/types';
import { getExplorerFileIcon, getExplorerFolderIcon } from '../../renderer/utils/theme';

type IconProps = {
	src?: string;
	'data-file-explorer-icon-theme'?: string;
	'data-file-explorer-icon-key'?: string;
};

const theme: Theme = {
	id: 'integration-theme',
	name: 'Integration Theme',
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

const iconProps = (element: JSX.Element): IconProps => (element as ReactElement<IconProps>).props;

const richFileIcon = (fileName: string): IconProps =>
	iconProps(getExplorerFileIcon(fileName, theme, undefined, 'rich'));

const richFolderIcon = (folderName: string, isExpanded = false): IconProps =>
	iconProps(getExplorerFolderIcon(folderName, isExpanded, theme, 'rich'));

describe('rich file explorer icon theme integration', () => {
	it.each([
		['README', 'readme'],
		['README.md', 'readme'],
		['LICENSE', 'license'],
		['LICENSE.txt', 'license'],
		['package.json', 'package'],
		['pnpm-lock.yaml', 'pnpm'],
		['pnpm-workspace.yaml', 'pnpm'],
		['bun.lock', 'bun'],
		['bun.lockb', 'bun'],
		['yarn.lock', 'yarn'],
		['composer.lock', 'lock'],
		['.gitignore', 'git'],
		['.gitattributes', 'git'],
		['.gitmodules', 'git'],
		['.nvmrc', 'node'],
		['docker-compose.yml', 'docker'],
		['Dockerfile', 'docker'],
		['openapi.schema.json', 'json-schema'],
		['example.vitest.test.ts', 'test'],
		['example.jest.test.ts', 'test'],
		['component.test.jsx', 'test'],
		['component.test.tsx', 'test'],
		['utility.test.ts', 'test'],
		['legacy.test.js', 'test'],
		['types.d.ts', 'typescript-def'],
		['component.tsx', 'react'],
		['component.jsx', 'react'],
		['index.ts', 'typescript'],
		['index.js', 'javascript'],
		['index.mjs', 'javascript'],
		['index.cjs', 'javascript'],
		['tsconfig.json', 'json'],
		['settings.json5', 'json'],
		['settings.jsonc', 'json'],
		['workflow.yaml', 'yaml'],
		['workflow.yml', 'yaml'],
		['vite.config.ts', 'typescript'],
		['.env', 'settings'],
		['settings.toml', 'settings'],
		['index.html', 'html'],
		['index.htm', 'html'],
		['styles.css', 'css'],
		['styles.scss', 'css'],
		['styles.sass', 'css'],
		['styles.less', 'css'],
		['guide.md', 'docs'],
		['guide.mdx', 'docs'],
		['notes.txt', 'docs'],
		['notes.rst', 'docs'],
		['photo.png', 'image'],
		['photo.jpg', 'image'],
		['photo.jpeg', 'image'],
		['photo.gif', 'image'],
		['photo.svg', 'image'],
		['photo.webp', 'image'],
		['photo.ico', 'image'],
		['photo.bmp', 'image'],
		['release.zip', 'archive'],
		['release.tar', 'archive'],
		['release.gz', 'archive'],
		['release.tgz', 'archive'],
		['release.rar', 'archive'],
		['release.7z', 'archive'],
		['data.csv', 'database'],
		['data.tsv', 'database'],
		['query.sql', 'database'],
		['main.py', 'code'],
		['main.rs', 'code'],
		['notes.unknown', 'file'],
	])('routes %s through the rich %s file icon', (fileName, iconKey) => {
		const props = richFileIcon(fileName);

		expect(props['data-file-explorer-icon-theme']).toBe('rich');
		expect(props['data-file-explorer-icon-key']).toBe(iconKey);
		expect(props.src).toBeTruthy();
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
		['secrets', 'secure'],
		['docker', 'docker'],
		['scripts', 'scripts'],
		['dist', 'dist'],
		['coverage', 'coverage'],
		['features', 'folder'],
	])('routes %s through the rich %s folder icon', (folderName, iconKey) => {
		const closed = richFolderIcon(folderName, false);
		const open = richFolderIcon(folderName, true);

		expect(closed['data-file-explorer-icon-theme']).toBe('rich');
		expect(closed['data-file-explorer-icon-key']).toBe(iconKey);
		expect(open['data-file-explorer-icon-key']).toBe(iconKey);
		expect(closed.src).toBeTruthy();
		expect(open.src).toBeTruthy();
		expect(open.src).not.toBe(closed.src);
	});
});
