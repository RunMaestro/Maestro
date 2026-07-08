import { describe, expect, it } from 'vitest';

import {
	CLAUDE_BUILTIN_COMMANDS,
	KNOWN_TOOL_NAMES,
	getSlashCommandDescription,
	isLikelyConcatenatedToolNames,
} from '../../renderer/constants/app';

describe('renderer constants/app', () => {
	describe('isLikelyConcatenatedToolNames', () => {
		it('detects three or more concatenated Claude tool names', () => {
			expect(isLikelyConcatenatedToolNames('TaskGrepRead')).toBe(true);
			expect(isLikelyConcatenatedToolNames('  BashGlobRead  ')).toBe(true);
		});

		it('matches longer tool names before their shorter prefixes', () => {
			expect(isLikelyConcatenatedToolNames('TaskOutputReadWrite')).toBe(true);
		});

		it('detects concatenated MCP tool names', () => {
			expect(
				isLikelyConcatenatedToolNames(
					'mcp__filesystem__read_filemcp__github__create_issuemcp__linear__list_issues'
				)
			).toBe(true);
		});

		it('does not flag normal text, partial tool names, or too-few tool names', () => {
			expect(isLikelyConcatenatedToolNames('TaskGrep')).toBe(false);
			expect(isLikelyConcatenatedToolNames('TaskGrepRead with actual thinking text')).toBe(false);
			expect(isLikelyConcatenatedToolNames('TaskUnknownRead')).toBe(false);
			expect(isLikelyConcatenatedToolNames('')).toBe(false);
		});

		it('keeps the known tool list populated with core tools used by parsing guards', () => {
			expect(KNOWN_TOOL_NAMES).toEqual(expect.arrayContaining(['Task', 'Read', 'Write', 'LSP']));
		});
	});

	describe('getSlashCommandDescription', () => {
		it('returns descriptions for built-in slash commands with or without the leading slash', () => {
			expect(getSlashCommandDescription('/compact')).toBe(CLAUDE_BUILTIN_COMMANDS.compact);
			expect(getSlashCommandDescription('security-review')).toBe(
				CLAUDE_BUILTIN_COMMANDS['security-review']
			);
		});

		it('formats plugin commands from the command and plugin segments', () => {
			expect(getSlashCommandDescription('/github:fix-ci')).toBe('fix-ci (github)');
			expect(getSlashCommandDescription('speckit:generate')).toBe('generate (speckit)');
		});

		it('uses the generic fallback for unknown non-plugin commands', () => {
			expect(getSlashCommandDescription('/custom-command')).toBe('Agent command');
			expect(getSlashCommandDescription('')).toBe('Agent command');
		});
	});
});
