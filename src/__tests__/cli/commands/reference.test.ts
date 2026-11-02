/**
 * @file reference.test.ts
 * @description The generated CLI reference must stay valid MDX for Mintlify.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { argSignature, escapeMdxProse } from '../../../cli/commands/reference';

describe('argSignature', () => {
	it('preserves variadic argument markers', () => {
		const command = new Command('send').argument('[message...]');
		expect(argSignature(command)).toBe('[message...]');
	});
});

describe('escapeMdxProse', () => {
	it('escapes a bare placeholder that MDX would read as an unclosed tag', () => {
		expect(escapeMdxProse('find IDs via "list playbooks -a <agent>"')).toBe(
			'find IDs via "list playbooks -a &lt;agent>"'
		);
	});

	it('escapes braces that MDX would read as an expression', () => {
		expect(escapeMdxProse('a {{VAR}} template')).toBe('a \\{\\{VAR\\}\\} template');
	});

	it('leaves code spans alone', () => {
		expect(escapeMdxProse('use `-a <agent>` or <id>')).toBe('use `-a <agent>` or &lt;id>');
	});

	it('passes plain text through unchanged', () => {
		expect(escapeMdxProse('Target agent ID')).toBe('Target agent ID');
	});
});
