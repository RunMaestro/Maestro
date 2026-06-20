import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import type { Image, Link, Paragraph, Root } from 'mdast';
import type { FileNode } from '../../renderer/types/fileTree';
import { buildFileTreeIndices, remarkFileLinks } from '../../renderer/utils/remarkFileLinks';

const projectRoot = '/Users/agent/Workspace';

const fileTree: FileNode[] = [
	{ name: 'README.md', type: 'file' },
	{ name: 'config.json', type: 'file' },
	{
		name: 'Guides',
		type: 'folder',
		children: [
			{ name: 'Install.md', type: 'file' },
			{ name: 'Deploy.md', type: 'file' },
			{ name: 'diagram.svg', type: 'file' },
		],
	},
	{
		name: 'Notes',
		type: 'folder',
		children: [
			{ name: 'TODO.md', type: 'file' },
			{ name: 'Meeting Notes.md', type: 'file' },
		],
	},
	{
		name: 'Archive',
		type: 'folder',
		children: [
			{ name: 'Meeting Notes.md', type: 'file' },
			{
				name: 'Project',
				type: 'folder',
				children: [{ name: 'README.md', type: 'file' }],
			},
		],
	},
	{
		name: 'Team',
		type: 'folder',
		children: [
			{
				name: 'Project',
				type: 'folder',
				children: [{ name: 'README.md', type: 'file' }],
			},
		],
	},
	{
		name: 'attachments',
		type: 'folder',
		children: [
			{ name: 'screenshot.jpg', type: 'file' },
			{ name: 'Pasted image 20250519123910.png', type: 'file' },
		],
	},
];

async function renderMarkdown(
	content: string,
	options: {
		cwd?: string;
		projectRoot?: string;
		useIndices?: boolean;
		tree?: FileNode[] | null;
	} = {}
): Promise<string> {
	const { cwd = '' } = options;
	const tree = options.tree === null ? undefined : (options.tree ?? fileTree);
	const indices = options.useIndices ? buildFileTreeIndices(tree ?? []) : undefined;
	const result = await unified()
		.use(remarkParse)
		.use(remarkFileLinks, {
			cwd,
			fileTree: indices ? undefined : tree,
			indices,
			projectRoot: options.projectRoot,
		})
		.use(remarkStringify)
		.process(content);

	return String(result);
}

async function transformMarkdown(
	content: string,
	options: {
		cwd?: string;
		projectRoot?: string;
		useIndices?: boolean;
		tree?: FileNode[] | null;
	} = {}
): Promise<Root> {
	const { cwd = '' } = options;
	const tree = options.tree === null ? undefined : (options.tree ?? fileTree);
	const indices = options.useIndices ? buildFileTreeIndices(tree ?? []) : undefined;
	const processor = unified()
		.use(remarkParse)
		.use(remarkFileLinks, {
			cwd,
			fileTree: indices ? undefined : tree,
			indices,
			projectRoot: options.projectRoot,
		});
	const parsed = processor.parse(content);

	return (await processor.run(parsed)) as Root;
}

describe('remarkFileLinks integration', () => {
	it('converts mixed markdown references through the real remark pipeline', async () => {
		const result = await renderMarkdown(
			[
				'README.md starts the line.',
				'See Guides/Install and [[TODO|task list]].',
				'Open `/Users/agent/Workspace/Guides/Deploy.md`, `Guides/Install.md`, and `[[Meeting Notes|meeting]]`.',
				'Images: ![[screenshot.jpg]] and ![[missing.png|320]].',
				'Markdown links: [encoded](Notes%2FMeeting%20Notes.md), [external](https://example.com), [anchor](#top).',
			].join('\n'),
			{ cwd: 'Notes', projectRoot }
		);

		expect(result).toContain('[README.md](maestro-file://README.md) starts the line.');
		expect(result).toContain(
			'[Guides/Install](maestro-file://Guides/Install.md) and [task list](maestro-file://Notes/TODO.md)'
		);
		expect(result).toContain('[Deploy.md](maestro-file://Guides/Deploy.md)');
		expect(result).toContain('[Install.md](maestro-file://Guides/Install.md)');
		expect(result).toContain('[meeting](<maestro-file://Notes/Meeting Notes.md>)');
		expect(result).toContain(
			'![screenshot.jpg](file:///Users/agent/Workspace/attachments/screenshot.jpg)'
		);
		expect(result).toContain(
			'![missing.png](file:///Users/agent/Workspace/Notes/_attachments/missing.png)'
		);
		expect(result).toContain('[encoded](<maestro-file://Notes/Meeting Notes.md>)');
		expect(result).toContain('[external](https://example.com)');
		expect(result).toContain('[anchor](#top)');
		expect(result).not.toContain('![[');
	});

	it('uses prebuilt indices for duplicate filenames and partial-path proximity', async () => {
		const notesResult = await renderMarkdown(
			'[[Meeting Notes]] and [[Archive/Meeting Notes]] and [[Project/README]]',
			{
				cwd: 'Archive',
				useIndices: true,
			}
		);

		expect(notesResult).toContain('[Meeting Notes](<maestro-file://Archive/Meeting Notes.md>)');
		expect(notesResult).toContain(
			'[Archive/Meeting Notes](<maestro-file://Archive/Meeting Notes.md>)'
		);
		expect(notesResult).toContain('[Project/README](maestro-file://Archive/Project/README.md)');

		const teamResult = await renderMarkdown('[[Unknown/Meeting Notes]] and [[Project/README]]', {
			cwd: 'Team',
			useIndices: true,
		});

		expect(teamResult).toContain(
			'[Unknown/Meeting Notes](<maestro-file://Notes/Meeting Notes.md>)'
		);
		expect(teamResult).toContain('[Project/README](maestro-file://Team/Project/README.md)');
	});

	it('leaves unresolved, external, unsupported, and unconfigured references unchanged', async () => {
		const result = await renderMarkdown(
			[
				'Missing [[No Such Note]] and Missing/File.md.',
				'Absolute without root: /Users/agent/Workspace/Guides/Install.md.',
				'Outside root: `/tmp/outside.md` and unsupported `/Users/agent/Workspace/archive.bin`.',
				'Links: [already](maestro-file://README.md), [mail](mailto:test@example.com), [file](file:///tmp/readme.md), [empty]().',
			].join('\n'),
			{ cwd: 'Guides' }
		);

		expect(result).toContain('No Such Note');
		expect(result).toContain('Missing/File.md');
		expect(result).toContain('/Users/agent/Workspace/Guides/Install.md');
		expect(result).toContain('`/tmp/outside.md`');
		expect(result).toContain('`/Users/agent/Workspace/archive.bin`');
		expect(result).toContain('[already](maestro-file://README.md)');
		expect(result).toContain('[mail](mailto:test@example.com)');
		expect(result).toContain('[file](file:///tmp/readme.md)');
		expect(result).toContain('[empty]()');
	});

	it('converts only in-project plain-text absolute paths', async () => {
		const result = await renderMarkdown(
			'Open /Users/agent/Workspace/Guides/Deploy.md but not /tmp/outside.md.',
			{ cwd: 'Guides', projectRoot }
		);

		expect(result).toContain(
			'[/Users/agent/Workspace/Guides/Deploy.md](maestro-file://Guides/Deploy.md)'
		);
		expect(result).toContain('/tmp/outside.md');
	});

	it('resolves full-path wiki references without extensions', async () => {
		const result = await renderMarkdown('See [[Guides/Install]].', {
			cwd: 'Guides',
			useIndices: true,
		});

		expect(result).toContain('[Guides/Install](maestro-file://Guides/Install.md)');
	});

	it('disambiguates duplicate filenames by unique partial suffix', async () => {
		const nestedTree: FileNode[] = [
			{
				name: 'Clients',
				type: 'folder',
				children: [
					{
						name: 'Acme',
						type: 'folder',
						children: [
							{
								name: 'Notes',
								type: 'folder',
								children: [{ name: 'Meeting Notes.md', type: 'file' }],
							},
						],
					},
					{
						name: 'Beta',
						type: 'folder',
						children: [
							{
								name: 'Docs',
								type: 'folder',
								children: [{ name: 'Meeting Notes.md', type: 'file' }],
							},
						],
					},
				],
			},
		];

		const result = await renderMarkdown('See [[Acme/Notes/Meeting Notes]].', {
			cwd: 'Clients',
			tree: nestedTree,
			useIndices: true,
		});

		expect(result).toContain(
			'[Acme/Notes/Meeting Notes](<maestro-file://Clients/Acme/Notes/Meeting Notes.md>)'
		);
	});

	it('adds image metadata for file-tree and cwd-relative fallback images', async () => {
		const tree = await transformMarkdown(
			'![[Pasted image 20250519123910.png|500]] ![[missing.png]]',
			{
				cwd: 'Notes',
				projectRoot,
			}
		);
		const paragraph = tree.children[0] as Paragraph;
		const [fromTree, spacer, fallback] = paragraph.children as [Image, unknown, Image];

		expect(fromTree.url).toBe(
			'file:///Users/agent/Workspace/attachments/Pasted image 20250519123910.png'
		);
		expect(fromTree.alt).toBe('Pasted image 20250519123910.png');
		expect(fromTree.data?.hProperties).toMatchObject({
			'data-maestro-image': 'attachments/Pasted image 20250519123910.png',
			'data-maestro-width': '500',
			'data-maestro-from-tree': 'true',
			style: 'width: 500px; height: auto;',
		});
		expect(spacer).toMatchObject({ type: 'text', value: ' ' });
		expect(fallback.url).toBe('file:///Users/agent/Workspace/Notes/_attachments/missing.png');
		expect(fallback.data?.hProperties).toMatchObject({
			'data-maestro-image': '_attachments/missing.png',
			style: 'max-width: 100%; height: auto;',
		});
	});

	it('builds reusable file-tree indices for files only', () => {
		const indices = buildFileTreeIndices(fileTree);

		expect(indices.allPaths).toBeInstanceOf(Set);
		expect(indices.allPaths.has('Guides/Install.md')).toBe(true);
		expect(indices.allPaths.has('Guides')).toBe(false);
		expect(indices.filenameIndex.get('README.md')).toEqual(
			expect.arrayContaining(['README.md', 'Archive/Project/README.md', 'Team/Project/README.md'])
		);
		expect(indices.filenameIndex.get('Install')).toEqual(['Guides/Install.md']);
	});

	it('falls back only for images when no file paths are indexed', async () => {
		const result = await renderMarkdown('README.md [[TODO]] [todo](TODO) ![[missing.png]]', {
			tree: [],
			cwd: 'Notes',
		});

		expect(result).toContain('README.md');
		expect(result).toContain('TODO');
		expect(result).toContain('[todo](TODO)');
		expect(result).toContain('![missing.png](_attachments/missing.png)');
		expect(result).not.toContain('maestro-file://');
	});

	it('uses empty indices when no file tree or indices are supplied', async () => {
		const result = await renderMarkdown('README.md [[TODO]] ![[missing.png]]', {
			tree: null,
			cwd: 'Notes',
		});

		expect(result).toContain('README.md');
		expect(result).toContain('TODO');
		expect(result).toContain('![missing.png](_attachments/missing.png)');
		expect(result).not.toContain('maestro-file://');
	});

	it('preserves existing link properties while converting standard markdown links', async () => {
		const tree: Root = {
			type: 'root',
			children: [
				{
					type: 'paragraph',
					children: [
						{
							type: 'link',
							url: 'TODO',
							data: {
								hProperties: {
									className: 'existing-link',
								},
							},
							children: [{ type: 'text', value: 'tasks' }],
						},
					],
				},
			],
		};

		const transformer = remarkFileLinks({ cwd: '', fileTree });
		transformer(tree);

		const paragraph = tree.children[0] as Paragraph;
		const link = paragraph.children[0] as Link;
		expect(link.url).toBe('maestro-file://Notes/TODO.md');
		expect(link.data?.hProperties).toMatchObject({
			className: 'existing-link',
			'data-maestro-file': 'Notes/TODO.md',
		});
	});

	it('handles detached AST nodes and inline-code negative branches safely', async () => {
		const transformer = remarkFileLinks({ cwd: '', fileTree, projectRoot });

		expect(() =>
			transformer({ type: 'text', value: 'README.md' } as unknown as Root)
		).not.toThrow();
		expect(() =>
			transformer({ type: 'inlineCode', value: 'README.md' } as unknown as Root)
		).not.toThrow();

		const result = await renderMarkdown(
			[
				'Inline: `[[TODO]]`, `[[Missing]]`, `README.md`, `/tmp/outside.md`, `/Users/agent/Workspace/archive.bin`, and `not-a-path`.',
				'Trailing root: /Users/agent/Workspace/Guides/Deploy.md.',
				'Display path: [[README|/Users/agent/Workspace/README.md]].',
			].join('\n'),
			{ cwd: '', projectRoot: `${projectRoot}/` }
		);

		expect(result).toContain('[TODO](maestro-file://Notes/TODO.md)');
		expect(result).toContain('[README.md](maestro-file://README.md)');
		expect(result).toContain(
			'[/Users/agent/Workspace/Guides/Deploy.md](maestro-file://Guides/Deploy.md)'
		);
		expect(result).toContain('[/Users/agent/Workspace/README.md](maestro-file://README.md)');
		expect(result).toContain('`[[Missing]]`');
		expect(result).toContain('`/tmp/outside.md`');
		expect(result).toContain('`/Users/agent/Workspace/archive.bin`');
		expect(result).toContain('`not-a-path`');
	});
});
