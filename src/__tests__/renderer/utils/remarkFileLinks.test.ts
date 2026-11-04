import { describe, it, expect, vi } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { remarkFileLinks, buildFileTreeIndices } from '../../../renderer/utils/remarkFileLinks';
import type { FileNode } from '../../../renderer/types/fileTree';

// Helper to process markdown and return the result
async function processMarkdown(
	content: string,
	fileTree: FileNode[],
	cwd: string,
	projectRoot?: string,
	homeDir?: string,
	pathExists?: (absolutePath: string) => boolean | undefined
): Promise<string> {
	const result = await unified()
		.use(remarkParse)
		.use(remarkFileLinks, { fileTree, cwd, projectRoot, homeDir, pathExists })
		.use(remarkStringify)
		.process(content);
	return String(result);
}

// Sample file tree for testing
const sampleFileTree: FileNode[] = [
	{
		name: 'OPSWAT',
		type: 'folder',
		children: [
			{
				name: 'Meetings',
				type: 'folder',
				children: [
					{ name: 'OP-0088.md', type: 'file' },
					{ name: 'OP-0200.md', type: 'file' },
				],
			},
			{ name: 'README.md', type: 'file' },
		],
	},
	{
		name: 'Notes',
		type: 'folder',
		children: [
			{ name: 'Meeting Notes.md', type: 'file' },
			{ name: 'TODO.md', type: 'file' },
		],
	},
	{
		name: 'Archive',
		type: 'folder',
		children: [
			{ name: 'Meeting Notes.md', type: 'file' }, // Duplicate filename
		],
	},
	{
		name: 'attachments',
		type: 'folder',
		children: [
			{ name: 'Pasted image 20250519123910.png', type: 'file' },
			{ name: 'screenshot.jpg', type: 'file' },
		],
	},
	{
		name: 'output',
		type: 'folder',
		children: [
			{ name: 'recording.wav', type: 'file' },
			{ name: 'report.pdf', type: 'file' },
			{ name: 'data.csv', type: 'file' },
		],
	},
	{ name: 'README.md', type: 'file' },
	{ name: 'config.json', type: 'file' },
	{ name: 'index.ts', type: 'file' },
];

describe('remarkFileLinks', () => {
	describe('path-style references', () => {
		it('converts valid path with slash to link', async () => {
			const result = await processMarkdown(
				'See OPSWAT/Meetings/OP-0088 for details.',
				sampleFileTree,
				''
			);
			expect(result).toContain(
				'[OPSWAT/Meetings/OP-0088](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
		});

		it('converts path with .md extension', async () => {
			const result = await processMarkdown('Check OPSWAT/README.md for info.', sampleFileTree, '');
			expect(result).toContain('[OPSWAT/README.md](maestro-file://OPSWAT/README.md)');
		});

		it('converts single file reference with extension', async () => {
			const result = await processMarkdown('See README.md for details.', sampleFileTree, '');
			expect(result).toContain('[README.md](maestro-file://README.md)');
		});

		it('converts file references with various extensions', async () => {
			const result = await processMarkdown('Check config.json and index.ts', sampleFileTree, '');
			expect(result).toContain('[config.json](maestro-file://config.json)');
			expect(result).toContain('[index.ts](maestro-file://index.ts)');
		});

		it('does not convert non-existent paths', async () => {
			const result = await processMarkdown(
				'See NonExistent/Path/File for details.',
				sampleFileTree,
				''
			);
			expect(result).not.toContain('maestro-file://');
			expect(result).toContain('NonExistent/Path/File');
		});

		it('does not convert URLs', async () => {
			const result = await processMarkdown(
				'Visit https://example.com/path/file for more.',
				sampleFileTree,
				''
			);
			expect(result).not.toContain('maestro-file://');
		});

		it('handles multiple path references in same text', async () => {
			const result = await processMarkdown(
				'See OPSWAT/Meetings/OP-0088 and OPSWAT/Meetings/OP-0200 for details.',
				sampleFileTree,
				''
			);
			expect(result).toContain(
				'[OPSWAT/Meetings/OP-0088](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
			expect(result).toContain(
				'[OPSWAT/Meetings/OP-0200](maestro-file://OPSWAT/Meetings/OP-0200.md)'
			);
		});
	});

	describe('wiki-style references', () => {
		it('converts wiki link to matching file', async () => {
			const result = await processMarkdown('See [[TODO]] for tasks.', sampleFileTree, '');
			expect(result).toContain('[TODO](maestro-file://Notes/TODO.md)');
		});

		it('converts wiki link with full path', async () => {
			const result = await processMarkdown(
				'Check [[OPSWAT/Meetings/OP-0088]] for meeting notes.',
				sampleFileTree,
				''
			);
			expect(result).toContain(
				'[OPSWAT/Meetings/OP-0088](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
		});

		it('converts wiki link with .md extension', async () => {
			const result = await processMarkdown('See [[README.md]] for info.', sampleFileTree, '');
			expect(result).toContain('[README.md](maestro-file://README.md)');
		});

		it('does not convert non-existent wiki links', async () => {
			const result = await processMarkdown(
				'See [[NonExistent File]] for details.',
				sampleFileTree,
				''
			);
			// Should not create a maestro-file link for non-existent files
			expect(result).not.toContain('maestro-file://');
			// The brackets will be escaped by remark-stringify
			expect(result).toContain('NonExistent File');
		});

		it('handles multiple wiki links in same text', async () => {
			const result = await processMarkdown(
				'Check [[TODO]] and [[README.md]] for updates.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[TODO](maestro-file://Notes/TODO.md)');
			expect(result).toContain('[README.md](maestro-file://README.md)');
		});

		it('converts wiki link with alias (pipe syntax)', async () => {
			const result = await processMarkdown(
				'Established in 2024: [[Notes/TODO|my tasks]]',
				sampleFileTree,
				''
			);
			expect(result).toContain('[my tasks](maestro-file://Notes/TODO.md)');
		});

		it('converts wiki link with alias and spaces in display text', async () => {
			const result = await processMarkdown(
				'See [[OPSWAT/README|OPSWAT Documentation]] for details.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[OPSWAT Documentation](maestro-file://OPSWAT/README.md)');
		});

		it('converts wiki link with alias preserving original display', async () => {
			const result = await processMarkdown(
				'Check the [[config.json|configuration file]] settings.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[configuration file](maestro-file://config.json)');
		});

		it('handles alias with complex path', async () => {
			const result = await processMarkdown(
				'Meeting details: [[OPSWAT/Meetings/OP-0088|ELT Call Notes]]',
				sampleFileTree,
				''
			);
			expect(result).toContain('[ELT Call Notes](maestro-file://OPSWAT/Meetings/OP-0088.md)');
		});
	});

	describe('duplicate filename resolution', () => {
		it('picks closest file to cwd when multiple matches exist', async () => {
			// With cwd in Notes, Notes/Meeting Notes.md should be closer
			const result = await processMarkdown(
				'See [[Meeting Notes]] for details.',
				sampleFileTree,
				'Notes'
			);
			// remark-stringify wraps URLs with spaces in angle brackets
			expect(result).toContain('[Meeting Notes](<maestro-file://Notes/Meeting Notes.md>)');
		});

		it('picks file in Archive when cwd is Archive', async () => {
			const result = await processMarkdown(
				'See [[Meeting Notes]] for details.',
				sampleFileTree,
				'Archive'
			);
			// remark-stringify wraps URLs with spaces in angle brackets
			expect(result).toContain('[Meeting Notes](<maestro-file://Archive/Meeting Notes.md>)');
		});

		it('disambiguates with partial path', async () => {
			const result = await processMarkdown(
				'See [[Notes/Meeting Notes]] for details.',
				sampleFileTree,
				''
			);
			// remark-stringify wraps URLs with spaces in angle brackets
			expect(result).toContain('[Notes/Meeting Notes](<maestro-file://Notes/Meeting Notes.md>)');
		});
	});

	describe('edge cases', () => {
		it('handles empty file tree', async () => {
			const result = await processMarkdown('See OPSWAT/Meetings/OP-0088 for details.', [], '');
			expect(result).not.toContain('maestro-file://');
			expect(result).toContain('OPSWAT/Meetings/OP-0088');
		});

		it('handles text with no file references', async () => {
			const result = await processMarkdown(
				'This is just regular text with no file references.',
				sampleFileTree,
				''
			);
			expect(result).not.toContain('maestro-file://');
			expect(result).toContain('This is just regular text');
		});

		it('preserves existing markdown links', async () => {
			const result = await processMarkdown(
				'Check [Google](https://google.com) for search.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[Google](https://google.com)');
		});

		it('handles file references inside code blocks (should not convert)', async () => {
			const result = await processMarkdown('```\nOPSWAT/Meetings/OP-0088\n```', sampleFileTree, '');
			// Code blocks content should remain unchanged
			expect(result).toContain('OPSWAT/Meetings/OP-0088');
		});

		it('handles inline code (should not convert)', async () => {
			const result = await processMarkdown(
				'Run `OPSWAT/Meetings/OP-0088` command.',
				sampleFileTree,
				''
			);
			// The plugin operates on text nodes, inline code is a different node type
			expect(result).toContain('`OPSWAT/Meetings/OP-0088`');
		});

		it('handles mixed path and wiki links', async () => {
			const result = await processMarkdown(
				'See OPSWAT/README.md and [[TODO]] for info.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[OPSWAT/README.md](maestro-file://OPSWAT/README.md)');
			expect(result).toContain('[TODO](maestro-file://Notes/TODO.md)');
		});
	});

	describe('proximity calculation', () => {
		it('calculates proximity correctly for nested paths', async () => {
			// Create a tree where files are at different depths
			const deepTree: FileNode[] = [
				{
					name: 'a',
					type: 'folder',
					children: [
						{
							name: 'b',
							type: 'folder',
							children: [{ name: 'target.md', type: 'file' }],
						},
					],
				},
				{
					name: 'x',
					type: 'folder',
					children: [{ name: 'target.md', type: 'file' }],
				},
			];

			// With cwd at 'a/b', the a/b/target.md should be closest
			const result = await processMarkdown('See [[target]] for details.', deepTree, 'a/b');
			expect(result).toContain('[target](maestro-file://a/b/target.md)');
		});
	});

	describe('absolute path references', () => {
		it('converts absolute paths when projectRoot is provided', async () => {
			const result = await processMarkdown(
				'See /Users/pedram/Project/OPSWAT/README.md for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[/Users/pedram/Project/OPSWAT/README.md](maestro-file://OPSWAT/README.md)'
			);
		});

		it('converts absolute paths outside projectRoot to file:// links', async () => {
			const result = await processMarkdown(
				'See /other/path/README.md for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Outside projectRoot, so it gets the same file:// treatment as a tilde
			// path - openFileUrl routes it to the preview tab, player, or the OS.
			expect(result).toContain('[/other/path/README.md](file:///other/path/README.md)');
			expect(result).not.toContain('maestro-file://');
		});

		it('does not convert absolute paths when projectRoot is not provided', async () => {
			const result = await processMarkdown(
				'See /Users/pedram/Project/OPSWAT/README.md for details.',
				sampleFileTree,
				''
			);
			// Should not be converted since projectRoot is not provided
			expect(result).toContain('/Users/pedram/Project/OPSWAT/README.md');
			expect(result).not.toContain('maestro-file://');
		});

		it('handles absolute paths with spaces in folder/file names', async () => {
			const result = await processMarkdown(
				'See /Users/pedram/Project/Notes/Meeting Notes.md for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// remark-stringify wraps URLs with spaces in angle brackets
			expect(result).toContain(
				'[/Users/pedram/Project/Notes/Meeting Notes.md](<maestro-file://Notes/Meeting Notes.md>)'
			);
		});

		it('handles absolute paths with dashes and complex names', async () => {
			const result = await processMarkdown(
				'See /Users/pedram/Project/OPSWAT/Meetings/OP-0088.md - May 2025',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[/Users/pedram/Project/OPSWAT/Meetings/OP-0088.md](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
		});

		it('handles multiple absolute paths in bulleted list', async () => {
			const result = await processMarkdown(
				'• /Users/pedram/Project/OPSWAT/Meetings/OP-0088.md - first\n• /Users/pedram/Project/OPSWAT/Meetings/OP-0200.md - second',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[/Users/pedram/Project/OPSWAT/Meetings/OP-0088.md](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
			expect(result).toContain(
				'[/Users/pedram/Project/OPSWAT/Meetings/OP-0200.md](maestro-file://OPSWAT/Meetings/OP-0200.md)'
			);
		});

		it('links absolute paths even when file is not in file tree', async () => {
			// This file does NOT exist in sampleFileTree, but should still be linked
			// because absolute paths are explicit - the file click handler will try to open it
			const result = await processMarkdown(
				'See /Users/pedram/Project/SomeOther/NonExistent File.md for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Should still create a link because path is within projectRoot
			expect(result).toContain(
				'[/Users/pedram/Project/SomeOther/NonExistent File.md](<maestro-file://SomeOther/NonExistent File.md>)'
			);
		});

		// MAESTRO-176 / MAESTRO-175: an agent brief written as prose, with a bare
		// alias `P=` for a project folder and `P/...` references. The old pattern
		// matched from the first `/` to the last `name.md` in the paragraph, and
		// clicking the link sent the whole paragraph to fs:stat (ENAMETOOLONG).
		it('does not turn a paragraph of prose into one absolute path', async () => {
			const brief =
				'Status /handoff checked; no output found. You are the worker, do not delegate. ' +
				'P=/Users/someone/Documents/Drafts (long form notes)/.collab. ' +
				'Read P/drafts/one/abc-PREP.md and manifest P/requests/abc-rewrite.md. ' +
				'Read /Users/someone/.tools/skills/voice/SKILL.md INCLUDING references/style.md. ' +
				'Write the report to P/drafts/two/task-PROPOSAL.md';
			const result = await processMarkdown(brief, sampleFileTree, '', '/Users/pedram/Project');
			expect(result).not.toContain('handoff checked](');
			expect(result).not.toMatch(/\]\(<?file:\/\/\/handoff/);
			expect(result).not.toMatch(/\]\(<?file:\/\/\/(drafts|requests|one|two)\//);
			// The one genuine absolute path in the paragraph still links.
			expect(result).toContain(
				'[/Users/someone/.tools/skills/voice/SKILL.md](file:///Users/someone/.tools/skills/voice/SKILL.md)'
			);
		});

		// MAESTRO-16F / MAESTRO-16G: a run report in a non-Latin script, where `/`
		// is used as "or" between words. Nothing in it is an absolute path.
		it('does not link slash-separated prose that ends in a file name', async () => {
			for (const lead of ['Итог: ok', 'Итог: ok ']) {
				const report =
					`${lead}/[INF]/пустых/повторов), pass 2 (100% новых, 0 совпадений; 5/6 частей - ` +
					'часть 3 rc=143@600s; s3=995/st=148). Список: docs/analysis/issues.md - ' +
					'11 пунктов (3 high / 4 medium / 4 low). Разница: compare-v1/run-notes.md';
				const result = await processMarkdown(report, sampleFileTree, '', '/Users/pedram/Project');
				expect(result).not.toContain('file://');
			}
		});

		it('does not start an absolute path inside a word', async () => {
			const result = await processMarkdown(
				'Read C/bozze/codex/notes.md and and/or/other.md next.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).not.toContain('file://');
		});

		it('still links an absolute path right after an opening bracket or quote', async () => {
			const result = await processMarkdown(
				'Saved ("/other/place/report.md") and [/other/place/two.md].',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('(file:///other/place/report.md)');
			expect(result).toContain('(file:///other/place/two.md)');
		});

		it('keeps a multi-dot file name whole', async () => {
			const result = await processMarkdown(
				'Backup at /other/place/archive.tar.gz is ready.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[/other/place/archive.tar.gz](file:///other/place/archive.tar.gz)');
		});

		it.each([
			['Open /other/place/first.md and second.md now.', 'first.md and second'],
			['See /other/place/first.md, then second.md.', 'first.md, then second'],
		])(
			'stops the file name at the first extension that ends a path: %j',
			async (text, swallowed) => {
				const result = await processMarkdown(text, sampleFileTree, '', '/Users/pedram/Project');
				expect(result).toContain('[/other/place/first.md](file:///other/place/first.md)');
				expect(result).not.toContain(swallowed);
			}
		);

		it('keeps prose that runs into a later absolute path out of the link', async () => {
			const result = await processMarkdown(
				'Read /handoff notes in /other/place/report.md first.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[/other/place/report.md](file:///other/place/report.md)');
			expect(result).not.toContain('file:///handoff');
		});

		// A slash command in prose followed, much later, by a URL ending in a
		// file name read as one path whose root directory was the whole sentence.
		it('does not link a slash command that runs into a URL ending in a file name', async () => {
			const result = await processMarkdown(
				"let's modify the /maestro-build command so that we upload it to example.com/dropbox/maestro.zip then offer it",
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).not.toContain('file://');
			expect(result).not.toContain('maestro-build command](');
		});

		it('still links spaces below the root directory', async () => {
			const result = await processMarkdown(
				'Synced to /Volumes/My Drive/notes/plan.md today.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('(<file:///Volumes/My Drive/notes/plan.md>)');
		});

		describe('with a pathExists check', () => {
			const spaced = 'Synced to /Volumes/My Drive/notes/plan.md today.';

			it('links a path with whitespace once it is known to exist', async () => {
				const pathExists = vi.fn(() => true);
				const result = await processMarkdown(
					spaced,
					sampleFileTree,
					'',
					'/Users/pedram/Project',
					undefined,
					pathExists
				);
				expect(pathExists).toHaveBeenCalledWith('/Volumes/My Drive/notes/plan.md');
				expect(result).toContain('(<file:///Volumes/My Drive/notes/plan.md>)');
			});

			it.each([
				['missing', false],
				['still being checked', undefined],
			])('leaves a path with whitespace as text while it is %s', async (_label, answer) => {
				const result = await processMarkdown(
					spaced,
					sampleFileTree,
					'',
					'/Users/pedram/Project',
					undefined,
					() => answer
				);
				expect(result).not.toContain('file://');
			});

			it('trusts the file tree for a path with whitespace inside the project', async () => {
				const pathExists = vi.fn(() => false);
				const result = await processMarkdown(
					'See /Users/pedram/Project/Notes/Meeting Notes.md for details.',
					sampleFileTree,
					'',
					'/Users/pedram/Project',
					undefined,
					pathExists
				);
				expect(pathExists).not.toHaveBeenCalled();
				expect(result).toContain('(<maestro-file://Notes/Meeting Notes.md>)');
			});

			it('does not check a path without whitespace', async () => {
				const pathExists = vi.fn(() => false);
				const result = await processMarkdown(
					'Backup at /other/place/archive.tar.gz is ready.',
					sampleFileTree,
					'',
					'/Users/pedram/Project',
					undefined,
					pathExists
				);
				expect(pathExists).not.toHaveBeenCalled();
				expect(result).toContain('(file:///other/place/archive.tar.gz)');
			});
		});

		// Chinese and Japanese put no space between words, so a path written
		// straight after one is still a path, not the middle of a word.
		it('links an absolute path written straight after CJK text', async () => {
			const result = await processMarkdown(
				'ファイルは/other/place/report.md',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[/other/place/report.md](file:///other/place/report.md)');
		});

		it('does not link CJK prose that uses slashes and full stops', async () => {
			const result = await processMarkdown(
				'読む/書く。完了しました。結果は docs/notes.md',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).not.toContain('file://');
		});

		// Deliberate: a folder whose name holds a file name and a space reads the
		// same as prose after a path (`/a/SKILL.md and refs/b.md`), and the match
		// stops at the first file name rather than risk swallowing a sentence.
		it('stops at the first file name even when a folder name contains one', async () => {
			const result = await processMarkdown(
				'Open /other/node.js backup/report.md now.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[/other/node.js](file:///other/node.js)');
		});
	});

	describe('markdown links with absolute path hrefs', () => {
		it('converts markdown link with absolute path href to maestro-file link', async () => {
			// Agents like Codex emit [display](absolute-path) style links
			const result = await processMarkdown(
				'Modified [src/components/CameraModal.tsx](/Users/pedram/Project/src/components/CameraModal.tsx) to add callback.',
				[
					{
						name: 'src',
						type: 'folder',
						children: [
							{
								name: 'components',
								type: 'folder',
								children: [{ name: 'CameraModal.tsx', type: 'file' }],
							},
						],
					},
				],
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[src/components/CameraModal.tsx](maestro-file://src/components/CameraModal.tsx)'
			);
		});

		it('converts markdown link with absolute path href even when file not in tree', async () => {
			// Absolute paths within projectRoot should link even without file tree match
			const result = await processMarkdown(
				'See [App.tsx](/Users/pedram/Project/src/App.tsx) for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[App.tsx](maestro-file://src/App.tsx)');
		});

		it('converts markdown link with absolute path outside projectRoot to file:// URL', async () => {
			const result = await processMarkdown(
				'See [file.tsx](/other/path/file.tsx) for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[file.tsx](file:///other/path/file.tsx)');
			expect(result).not.toContain('maestro-file://');
		});

		it('converts markdown link with tilde path href to maestro-file link', async () => {
			const result = await processMarkdown(
				'See [README.md](~/Project/OPSWAT/README.md) for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain('[README.md](maestro-file://OPSWAT/README.md)');
		});

		it('converts markdown link with tilde path outside projectRoot to file:// URL', async () => {
			const result = await processMarkdown(
				'See [notes.md](~/Documents/notes.md) for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain('[notes.md](file:///Users/pedram/Documents/notes.md)');
		});
	});

	describe('inline code paths (backticks)', () => {
		it('converts absolute path in backticks to link with filename display', async () => {
			const result = await processMarkdown(
				'Check `/Users/pedram/Project/OPSWAT/README.md` for info.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Should convert to link showing just the filename
			expect(result).toContain('[README.md](maestro-file://OPSWAT/README.md)');
			// Should NOT contain backticks around the path anymore
			expect(result).not.toContain('`/Users/pedram/Project/OPSWAT/README.md`');
		});

		it('converts absolute path in backticks outside projectRoot to file:// link', async () => {
			const result = await processMarkdown(
				'Check `/Volumes/Audio/takes/recording.wav` for the take.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[recording.wav](file:///Volumes/Audio/takes/recording.wav)');
			expect(result).not.toContain('maestro-file://');
		});

		it('converts relative path in backticks to link when file exists', async () => {
			const result = await processMarkdown(
				'See `OPSWAT/README.md` for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[README.md](maestro-file://OPSWAT/README.md)');
		});

		it('converts wiki link in backticks to link', async () => {
			const result = await processMarkdown(
				'Reference `[[OPSWAT/README]]` here.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('[OPSWAT/README](maestro-file://OPSWAT/README.md)');
		});

		it('leaves non-path inline code unchanged', async () => {
			const result = await processMarkdown(
				'Use `npm install` to install.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('`npm install`');
		});

		it('handles absolute path with spaces in backticks', async () => {
			const result = await processMarkdown(
				'File: `/Users/pedram/Project/Notes/Meeting Notes.md`',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// remark-stringify adds angle brackets around URLs with spaces
			expect(result).toContain('[Meeting Notes.md](<maestro-file://Notes/Meeting Notes.md>)');
		});
	});

	describe('image embeds', () => {
		it('converts image embed to inline image', async () => {
			const result = await processMarkdown(
				'Here is the screenshot: ![[Pasted image 20250519123910.png]]',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Should convert to markdown image with file:// URL
			expect(result).toContain('![Pasted image 20250519123910.png]');
			expect(result).toContain(
				'file:///Users/pedram/Project/attachments/Pasted image 20250519123910.png'
			);
			// Should NOT contain the original embed syntax
			expect(result).not.toContain('![[');
		});

		it('converts image embed with path', async () => {
			const result = await processMarkdown(
				'See ![[attachments/screenshot.jpg]] for details.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('![attachments/screenshot.jpg]');
			expect(result).toContain('file:///Users/pedram/Project/attachments/screenshot.jpg');
		});

		it('converts image embed even when not in file tree (uses _attachments fallback)', async () => {
			const result = await processMarkdown(
				'Missing: ![[nonexistent.png]]',
				sampleFileTree,
				'some/folder',
				'/Users/pedram/Project'
			);
			// Should still create an image with _attachments fallback path
			// With projectRoot and cwd, full path is: projectRoot/cwd/_attachments/image
			expect(result).toContain('![nonexistent.png]');
			expect(result).toContain(
				'file:///Users/pedram/Project/some/folder/_attachments/nonexistent.png'
			);
		});

		it('handles multiple image embeds', async () => {
			const result = await processMarkdown(
				'First ![[screenshot.jpg]] and second ![[Pasted image 20250519123910.png]]',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('![screenshot.jpg]');
			expect(result).toContain('![Pasted image 20250519123910.png]');
		});

		it('handles image embed mixed with wiki links', async () => {
			const result = await processMarkdown(
				'Image: ![[screenshot.jpg]] and link: [[README]]',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Image should be converted
			expect(result).toContain('![screenshot.jpg]');
			// Link should also be converted
			expect(result).toContain('[README](maestro-file://README.md)');
		});

		it('handles image embed with width syntax', async () => {
			const result = await processMarkdown(
				'Resized: ![[screenshot.jpg|300]]',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			// Should convert to image
			expect(result).toContain('![screenshot.jpg]');
			// Should include the file URL
			expect(result).toContain('file:///Users/pedram/Project/attachments/screenshot.jpg');
		});

		it('handles image embed with width and spaces in filename', async () => {
			const result = await processMarkdown(
				'Image: ![[Pasted image 20250519123910.png|500]]',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain('![Pasted image 20250519123910.png]');
		});
	});

	describe('buildFileTreeIndices', () => {
		it('builds allPaths Set containing all file paths', () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			expect(indices.allPaths).toBeInstanceOf(Set);
			expect(indices.allPaths.has('README.md')).toBe(true);
			expect(indices.allPaths.has('config.json')).toBe(true);
			expect(indices.allPaths.has('OPSWAT/README.md')).toBe(true);
			expect(indices.allPaths.has('OPSWAT/Meetings/OP-0088.md')).toBe(true);
			expect(indices.allPaths.has('Notes/TODO.md')).toBe(true);
		});

		it('builds filenameIndex Map for quick filename lookup', () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			expect(indices.filenameIndex).toBeInstanceOf(Map);
			// README.md exists in multiple locations
			const readmePaths = indices.filenameIndex.get('README.md');
			expect(readmePaths).toBeDefined();
			expect(readmePaths).toContain('README.md');
			expect(readmePaths).toContain('OPSWAT/README.md');
		});

		it('handles duplicate filenames correctly', () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			// Meeting Notes.md exists in both Notes and Archive
			const meetingNotesPaths = indices.filenameIndex.get('Meeting Notes.md');
			expect(meetingNotesPaths).toBeDefined();
			expect(meetingNotesPaths?.length).toBe(2);
			expect(meetingNotesPaths).toContain('Notes/Meeting Notes.md');
			expect(meetingNotesPaths).toContain('Archive/Meeting Notes.md');
		});

		it('returns empty indices for empty file tree', () => {
			const indices = buildFileTreeIndices([]);

			expect(indices.allPaths.size).toBe(0);
			expect(indices.filenameIndex.size).toBe(0);
		});

		it('does not include folder paths, only files', () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			// Folders should not be in the paths
			expect(indices.allPaths.has('OPSWAT')).toBe(false);
			expect(indices.allPaths.has('Notes')).toBe(false);
			expect(indices.allPaths.has('attachments')).toBe(false);
		});
	});

	describe('extended file extensions', () => {
		it('converts media file references (wav, mp3, etc.)', async () => {
			const result = await processMarkdown(
				'Listen to output/recording.wav for the sample.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[output/recording.wav](maestro-file://output/recording.wav)');
		});

		it('converts document file references (pdf, csv, etc.)', async () => {
			const result = await processMarkdown(
				'See output/report.pdf and output/data.csv for results.',
				sampleFileTree,
				''
			);
			expect(result).toContain('[output/report.pdf](maestro-file://output/report.pdf)');
			expect(result).toContain('[output/data.csv](maestro-file://output/data.csv)');
		});

		it('converts absolute paths with media extensions', async () => {
			const result = await processMarkdown(
				'File at /Users/pedram/Project/output/recording.wav here.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[/Users/pedram/Project/output/recording.wav](maestro-file://output/recording.wav)'
			);
		});

		it('converts absolute media paths outside projectRoot to file:// links', async () => {
			// The floating player is reached through openFileUrl, which only ever
			// sees a file:// href - a bare absolute path is a dead link.
			const result = await processMarkdown(
				'File at /Volumes/Audio/takes/recording.wav here.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).toContain(
				'[/Volumes/Audio/takes/recording.wav](file:///Volumes/Audio/takes/recording.wav)'
			);
		});
	});

	describe('tilde path references', () => {
		it('converts tilde paths within projectRoot to maestro-file links', async () => {
			const result = await processMarkdown(
				'See ~/Project/output/recording.wav for the audio.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain(
				'[~/Project/output/recording.wav](maestro-file://output/recording.wav)'
			);
		});

		it('converts tilde paths outside projectRoot to file:// links', async () => {
			const result = await processMarkdown(
				'See ~/Downloads/audio/sample.wav for the sample.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain(
				'[~/Downloads/audio/sample.wav](file:///Users/pedram/Downloads/audio/sample.wav)'
			);
		});

		it('does not convert tilde paths when homeDir is not provided', async () => {
			const result = await processMarkdown(
				'See ~/Downloads/audio/sample.wav for the sample.',
				sampleFileTree,
				'',
				'/Users/pedram/Project'
			);
			expect(result).not.toContain('file://');
			expect(result).not.toContain('maestro-file://');
			expect(result).toContain('~/Downloads/audio/sample.wav');
		});

		it('handles multiple tilde paths in same text', async () => {
			const result = await processMarkdown(
				'Compare ~/Downloads/a.wav and ~/Downloads/b.mp3 side by side.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain('[~/Downloads/a.wav](file:///Users/pedram/Downloads/a.wav)');
			expect(result).toContain('[~/Downloads/b.mp3](file:///Users/pedram/Downloads/b.mp3)');
		});

		it('converts tilde path in inline code', async () => {
			const result = await processMarkdown(
				'Check `~/Downloads/audio/sample.wav` for the file.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain('[sample.wav](file:///Users/pedram/Downloads/audio/sample.wav)');
			expect(result).not.toContain('`~/Downloads');
		});

		it('converts tilde path in inline code within projectRoot', async () => {
			const result = await processMarkdown(
				'See `~/Project/output/recording.wav` here.',
				sampleFileTree,
				'',
				'/Users/pedram/Project',
				'/Users/pedram'
			);
			expect(result).toContain('[recording.wav](maestro-file://output/recording.wav)');
		});
	});

	describe('bare maestro:// deep links', () => {
		it('auto-linkifies a bare maestro:// URL in running text', async () => {
			const result = await processMarkdown(
				'Go to maestro://session/abc/tab/xyz now.',
				sampleFileTree,
				''
			);
			// remark-stringify emits CommonMark autolinks as <url> when the link
			// text equals the URL, which is what we get when we wrap a bare URL.
			expect(result).toContain('<maestro://session/abc/tab/xyz>');
		});

		it('does not rewrite an explicit markdown link with a maestro:// href', async () => {
			const result = await processMarkdown(
				'See [the agent](maestro://group/grp1).',
				sampleFileTree,
				''
			);
			expect(result).toContain('[the agent](maestro://group/grp1)');
			expect(result).not.toContain('maestro-file://');
		});
	});

	describe('remarkFileLinks with pre-built indices', () => {
		it('uses pre-built indices when provided', async () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			const result = await unified()
				.use(remarkParse)
				.use(remarkFileLinks, { indices, cwd: '' })
				.use(remarkStringify)
				.process('See [[TODO]] for tasks.');

			expect(String(result)).toContain('[TODO](maestro-file://Notes/TODO.md)');
		});

		it('works with pre-built indices for path-style references', async () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			const result = await unified()
				.use(remarkParse)
				.use(remarkFileLinks, { indices, cwd: '' })
				.use(remarkStringify)
				.process('Check OPSWAT/Meetings/OP-0088.md for details.');

			expect(String(result)).toContain(
				'[OPSWAT/Meetings/OP-0088.md](maestro-file://OPSWAT/Meetings/OP-0088.md)'
			);
		});

		it('handles cwd-based proximity with pre-built indices', async () => {
			const indices = buildFileTreeIndices(sampleFileTree);

			const result = await unified()
				.use(remarkParse)
				.use(remarkFileLinks, { indices, cwd: 'Archive' })
				.use(remarkStringify)
				.process('See [[Meeting Notes]] for details.');

			// Should pick Archive/Meeting Notes.md based on cwd proximity
			expect(String(result)).toContain(
				'[Meeting Notes](<maestro-file://Archive/Meeting Notes.md>)'
			);
		});
	});

	describe('malformed percent-encoding in link targets (MAESTRO-XS)', () => {
		// decodeURIComponent throws URIError on a stray '%'. This plugin runs
		// inside the unified transform, so the throw escaped react-markdown's
		// render and blanked the entire message body in chat.
		const cases = [
			['a bare percent', '[see](100% done.md)'],
			['a truncated escape', '[see](report%E0%A4%A.md)'],
			['an invalid hex pair', '[see](weird%ZZ.md)'],
			['a trailing percent', '[see](draft%)'],
		];

		for (const [label, markdown] of cases) {
			it(`does not throw on ${label}`, async () => {
				await expect(
					processMarkdown(markdown, sampleFileTree, '', '/project')
				).resolves.toBeTruthy();
			});
		}

		it('leaves an unresolvable malformed target as-is', async () => {
			const result = await processMarkdown('[see](100% done.md)', sampleFileTree, '');
			expect(result).not.toContain('maestro-file://');
		});

		it('still resolves valid escapes to maestro-file:// links', async () => {
			const tree: FileNode[] = [{ name: 'My Notes.md', type: 'file', path: 'My Notes.md' }];
			const result = await processMarkdown('[notes](My%20Notes.md)', tree, '');
			expect(result).toContain('maestro-file://My Notes.md');
		});
	});
});
