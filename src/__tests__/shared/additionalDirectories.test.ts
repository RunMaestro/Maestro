/**
 * Additional Directories - normalization + system-prompt rendering.
 *
 * These grants are enforced only by what the agent reads in its system prompt,
 * so the rendered block is the actual feature. Assert on it directly.
 */

import { describe, it, expect } from 'vitest';

import {
	normalizeAdditionalDirectories,
	formatAdditionalDirectoriesForPrompt,
} from '../../shared/additionalDirectories';
import { substituteTemplateVariables } from '../../shared/templateVariables';
import type { AdditionalDirectory } from '../../shared/types';

const session = {
	id: 'agent-1',
	name: 'Test Agent',
	toolType: 'claude-code',
	cwd: '/Users/test/project',
};

describe('normalizeAdditionalDirectories', () => {
	it('returns undefined for an empty or missing list', () => {
		expect(normalizeAdditionalDirectories(undefined)).toBeUndefined();
		expect(normalizeAdditionalDirectories([])).toBeUndefined();
	});

	it('trims paths and drops blank rows', () => {
		const result = normalizeAdditionalDirectories([
			{ path: '  /a/docs  ', read: true, write: false },
			{ path: '   ', read: true, write: true },
		]);
		expect(result).toEqual([{ path: '/a/docs', read: true, write: false }]);
	});

	it('returns undefined when every row is blank', () => {
		expect(
			normalizeAdditionalDirectories([{ path: '  ', read: true, write: true }])
		).toBeUndefined();
	});

	it('expands a leading tilde against the supplied home directory', () => {
		const result = normalizeAdditionalDirectories(
			[
				{ path: '~/notes', read: true, write: true },
				{ path: '~', read: true, write: false },
			],
			'/Users/test'
		);
		expect(result).toEqual([
			{ path: '/Users/test/notes', read: true, write: true },
			{ path: '/Users/test', read: true, write: false },
		]);
	});

	it('leaves the tilde alone when no home directory is known', () => {
		const result = normalizeAdditionalDirectories([{ path: '~/notes', read: true, write: false }]);
		expect(result).toEqual([{ path: '~/notes', read: true, write: false }]);
	});

	it("collapses duplicate paths, keeping the last row's permissions", () => {
		const result = normalizeAdditionalDirectories([
			{ path: '/a/docs', read: true, write: false },
			{ path: '/a/docs', read: false, write: true },
		]);
		expect(result).toEqual([{ path: '/a/docs', read: false, write: true }]);
	});

	it('keeps a row with no permissions so toggling off does not delete the path', () => {
		const result = normalizeAdditionalDirectories([{ path: '/a/docs', read: false, write: false }]);
		expect(result).toEqual([{ path: '/a/docs', read: false, write: false }]);
	});

	it('carries a trimmed description through', () => {
		const result = normalizeAdditionalDirectories([
			{ path: '/a/docs', read: true, write: false, description: '  API reference material  ' },
		]);
		expect(result).toEqual([
			{ path: '/a/docs', read: true, write: false, description: 'API reference material' },
		]);
	});

	it('omits the description field when it is blank', () => {
		const result = normalizeAdditionalDirectories([
			{ path: '/a/docs', read: true, write: false, description: '   ' },
		]);
		expect(result).toEqual([{ path: '/a/docs', read: true, write: false }]);
		expect(result?.[0]).not.toHaveProperty('description');
	});
});

describe('formatAdditionalDirectoriesForPrompt', () => {
	it('renders nothing when there are no grants', () => {
		expect(formatAdditionalDirectoriesForPrompt(undefined)).toBe('');
		expect(formatAdditionalDirectoriesForPrompt([])).toBe('');
	});

	it('omits the heading entirely when every row is inert', () => {
		// A bare "## Additional Directories" heading with no table under it reads
		// to the agent like a section that failed to load.
		expect(formatAdditionalDirectoriesForPrompt([{ path: '/a', read: false, write: false }])).toBe(
			''
		);
	});

	it('labels each access combination distinctly', () => {
		const dirs: AdditionalDirectory[] = [
			{ path: '/rw', read: true, write: true },
			{ path: '/ro', read: true, write: false },
			{ path: '/wo', read: false, write: true },
		];
		const block = formatAdditionalDirectoriesForPrompt(dirs);

		expect(block).toContain('## Additional Directories');
		expect(block).toContain('| `/rw` | Read + Write |');
		expect(block).toContain('| `/ro` | Read only |');
		expect(block).toContain('| `/wo` | Write only |');
	});

	it('drops inert rows but keeps the granted ones', () => {
		const block = formatAdditionalDirectoriesForPrompt([
			{ path: '/granted', read: true, write: false },
			{ path: '/inert', read: false, write: false },
		]);
		expect(block).toContain('/granted');
		expect(block).not.toContain('/inert');
	});

	it('keeps the two-column table when no grant has a description', () => {
		const block = formatAdditionalDirectoriesForPrompt([{ path: '/ro', read: true, write: false }]);
		expect(block).toContain('| Directory | Access |');
		expect(block).not.toContain('| Notes |');
	});

	it('adds a Notes column carrying each description when any grant has one', () => {
		const block = formatAdditionalDirectoriesForPrompt([
			{ path: '/specs', read: true, write: false, description: 'API reference material' },
			{ path: '/drop', read: false, write: true },
		]);
		expect(block).toContain('| Directory | Access | Notes |');
		expect(block).toContain('| `/specs` | Read only | API reference material |');
		// A grant with no description still renders its (empty) cell.
		expect(block).toContain('| `/drop` | Write only |  |');
	});

	it('escapes pipes and collapses newlines in a description so the table survives', () => {
		const block = formatAdditionalDirectoriesForPrompt([
			{
				path: '/specs',
				read: true,
				write: false,
				description: 'read a | b\nthen stop',
			},
		]);
		expect(block).toContain('| `/specs` | Read only | read a \\| b then stop |');
	});
});

describe('{{ADDITIONAL_DIRECTORIES}} substitution', () => {
	it('renders the grants block into the template', () => {
		const result = substituteTemplateVariables('BEFORE\n{{ADDITIONAL_DIRECTORIES}}\nAFTER', {
			session: {
				...session,
				additionalDirectories: [{ path: '/shared/specs', read: true, write: false }],
			},
		});

		expect(result).toContain('BEFORE');
		expect(result).toContain('| `/shared/specs` | Read only |');
		expect(result).toContain('AFTER');
	});

	it('collapses to an empty string when the agent has no grants', () => {
		const result = substituteTemplateVariables('BEFORE\n{{ADDITIONAL_DIRECTORIES}}\nAFTER', {
			session,
		});

		expect(result).toBe('BEFORE\n\nAFTER');
	});

	it('inserts a path containing $ literally rather than as a replacement pattern', () => {
		const result = substituteTemplateVariables('{{ADDITIONAL_DIRECTORIES}}', {
			session: {
				...session,
				additionalDirectories: [{ path: '/tmp/$&cache', read: true, write: true }],
			},
		});

		expect(result).toContain('| `/tmp/$&cache` | Read + Write |');
	});
});
