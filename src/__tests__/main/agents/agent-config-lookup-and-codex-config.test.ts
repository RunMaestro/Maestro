// Source: src/__tests__/main/agents/agent-config-lookup.test.ts
// Source: src/__tests__/main/agents/codex-config.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { customPathsFromAgentConfigs } from '../../../main/agents/agent-config-lookup';
import * as os from 'os';
import * as path from 'path';
import { getCodexHome } from '../../../main/agents/codex-config';
import { getCodexSkillDirs } from '../../../main/agents/codex-config';
import { getCodexPromptDirs } from '../../../main/agents/codex-config';
import { parseCodexMarkdownDoc } from '../../../main/agents/codex-config';
describeSourceSuite('agent-config-lookup', () => {
	describe('customPathsFromAgentConfigs', () => {
		it('collects each provider that names a custom binary', () => {
			expect(
				customPathsFromAgentConfigs({
					'claude-code': { customPath: '/opt/claude', customArgs: '--x' },
					codex: { customPath: '/opt/codex' },
				})
			).toEqual({ 'claude-code': '/opt/claude', codex: '/opt/codex' });
		});

		it('skips providers with no path, an empty path, or a value that is not a string', () => {
			expect(
				customPathsFromAgentConfigs({
					'claude-code': { customArgs: '--x' },
					codex: { customPath: '' },
					pi: { customPath: 42 },
					opencode: null,
				})
			).toEqual({});
		});
	});
});
describeSourceSuite('codex-config', () => {
	describe('codex-config', () => {
		describe('getCodexHome', () => {
			it('defaults to ~/.codex', () => {
				expect(getCodexHome({})).toBe(path.join(os.homedir(), '.codex'));
			});

			it('honours CODEX_HOME so an alternate profile is probed', () => {
				expect(getCodexHome({ CODEX_HOME: path.join('/custom', 'codex') })).toBe(
					path.join('/custom', 'codex')
				);
			});
		});

		describe('getCodexSkillDirs', () => {
			it('puts the project-local dir ahead of the global one', () => {
				expect(getCodexSkillDirs(path.join('/project'), {})).toEqual([
					path.join('/project', '.codex', 'skills'),
					path.join(os.homedir(), '.codex', 'skills'),
				]);
			});

			it('omits the project dir when there is no cwd', () => {
				expect(getCodexSkillDirs(undefined, {})).toEqual([
					path.join(os.homedir(), '.codex', 'skills'),
				]);
			});
		});

		describe('getCodexPromptDirs', () => {
			it('probes both the project and global prompt dirs', () => {
				expect(getCodexPromptDirs(path.join('/project'), { CODEX_HOME: path.join('/ch') })).toEqual(
					[path.join('/project', '.codex', 'prompts'), path.join('/ch', 'prompts')]
				);
			});
		});

		describe('parseCodexMarkdownDoc', () => {
			it('extracts name and description and strips the frontmatter', () => {
				const doc = parseCodexMarkdownDoc(
					[
						'---',
						'name: ship-it',
						'description: Cut a release',
						'---',
						'',
						'# Ship It',
						'Do the thing.',
					].join('\n')
				);
				expect(doc.name).toBe('ship-it');
				expect(doc.description).toBe('Cut a release');
				expect(doc.userInvocable).toBe(true);
				expect(doc.body).toBe('# Ship It\nDo the thing.');
			});

			it('strips surrounding quotes from frontmatter values', () => {
				const doc = parseCodexMarkdownDoc(
					['---', 'description: "Quoted: value"', '---', 'body'].join('\n')
				);
				expect(doc.description).toBe('Quoted: value');
			});

			it('treats user-invocable: false as not offerable', () => {
				const doc = parseCodexMarkdownDoc(
					['---', 'name: internal', 'user-invocable: false', '---', 'body'].join('\n')
				);
				expect(doc.userInvocable).toBe(false);
			});

			it('defaults userInvocable to true when the key is absent', () => {
				expect(
					parseCodexMarkdownDoc(['---', 'name: x', '---', 'body'].join('\n')).userInvocable
				).toBe(true);
			});

			it('ignores an indented description nested under metadata', () => {
				const doc = parseCodexMarkdownDoc(
					[
						'---',
						'name: nested',
						'metadata:',
						'  description: not the skill description',
						'---',
						'body',
					].join('\n')
				);
				expect(doc.description).toBeUndefined();
			});

			it('treats a file without frontmatter as an all-body prompt', () => {
				const doc = parseCodexMarkdownDoc('Just a prompt body.\n');
				expect(doc.name).toBeUndefined();
				expect(doc.userInvocable).toBe(true);
				expect(doc.body).toBe('Just a prompt body.');
			});

			it('keeps the whole file when the frontmatter block is never closed', () => {
				const raw = '---\nname: broken\nstill going';
				expect(parseCodexMarkdownDoc(raw).body).toBe(raw);
			});

			it('parses CRLF files, so a Windows-authored skill is not skipped', () => {
				const doc = parseCodexMarkdownDoc(
					'---\r\nname: crlf\r\ndescription: Works\r\n---\r\nbody\r\n'
				);
				expect(doc.name).toBe('crlf');
				expect(doc.description).toBe('Works');
				expect(doc.body).toBe('body');
			});
		});
	});
});
