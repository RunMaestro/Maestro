/**
 * Mermaid's flowchart lexer reads `[^\s"]+@(?=[^{"])` as an edge id, and jison
 * takes the longest match - so `-->|@maestro ...|` lexes the arrow, the pipe,
 * and the `@` as one edge-id token and the diagram fails to parse. These tests
 * pin the repair: escape `@` to `#64;` inside label text, leave every `@` the
 * grammar actually owns alone.
 */

import { describe, it, expect } from 'vitest';
import { normalizeMermaidSource } from '../../shared/mermaidSource';

describe('normalizeMermaidSource', () => {
	describe('escapes @ where the edge-id rule would swallow it', () => {
		it('escapes an edge label that starts with @', () => {
			expect(normalizeMermaidSource('flowchart LR\n  C -->|@maestro from user| E[send]')).toBe(
				'flowchart LR\n  C -->|#64;maestro from user| E[send]'
			);
		});

		it('escapes @ inside an edge label regardless of arrow style', () => {
			for (const arrow of ['-->', '-.->', '==>', '---']) {
				expect(normalizeMermaidSource(`flowchart LR\n  A ${arrow}|a@b| B`)).toBe(
					`flowchart LR\n  A ${arrow}|a#64;b| B`
				);
			}
		});

		it('escapes @ in node labels of every bracket shape', () => {
			for (const [open, close] of [
				['[', ']'],
				['(', ')'],
				['{', '}'],
				['([', '])'],
			]) {
				expect(normalizeMermaidSource(`flowchart LR\n  A${open}a@b${close} --> B`)).toBe(
					`flowchart LR\n  A${open}a#64;b${close} --> B`
				);
			}
		});

		it('quotes a bare subgraph title containing @', () => {
			// `#64;` is no help here: the `;` reads as a statement separator, so
			// quoting is the only repair the grammar accepts.
			expect(normalizeMermaidSource('flowchart LR\n  subgraph @maestro team\n  end')).toBe(
				'flowchart LR\n  subgraph "@maestro team"\n  end'
			);
		});

		it('leaves the `subgraph id [Title]` form to the bracket scanner', () => {
			expect(normalizeMermaidSource('flowchart LR\n  subgraph one [Title @x]\n  end')).toBe(
				'flowchart LR\n  subgraph one [Title #64;x]\n  end'
			);
		});
	});

	describe('leaves @ alone where the grammar owns it', () => {
		it('preserves an edge id', () => {
			const source = 'flowchart LR\n  A e1@--> B\n  e1@{ animate: true }';
			expect(normalizeMermaidSource(source)).toBe(source);
		});

		it('preserves shape data, including an @ inside its quoted label', () => {
			const source = 'flowchart LR\n  A@{ shape: rect, label: "a@b" } --> B';
			expect(normalizeMermaidSource(source)).toBe(source);
		});

		it('preserves a quoted label, which the lexer rule already stops at', () => {
			const source = 'flowchart LR\n  A["a@b"] -->|"@x"| B';
			expect(normalizeMermaidSource(source)).toBe(source);
		});

		it('preserves comments and quoted click targets', () => {
			const source =
				'flowchart LR\n  %% ping @bob\n  A --> B\n  click A href "https://x.com/@user" _blank';
			expect(normalizeMermaidSource(source)).toBe(source);
		});

		it('leaves non-flowchart diagrams untouched', () => {
			// Only the flowchart grammar has the edge-id rule.
			const source = 'sequenceDiagram\n  Alice->>Bob: hi @bob';
			expect(normalizeMermaidSource(source)).toBe(source);
		});

		it('returns the source unchanged when it has no @ at all', () => {
			const source = 'flowchart LR\n  A[one] --> B[two]';
			expect(normalizeMermaidSource(source)).toBe(source);
		});
	});

	it('detects a flowchart behind frontmatter, comments, and init directives', () => {
		const source =
			'---\ntitle: Flow\n---\n%%{init: {"theme":"dark"}}%%\n%% note\n\nflowchart LR\n  A[a@b] --> B';
		expect(normalizeMermaidSource(source)).toContain('A[a#64;b]');
	});

	it('is idempotent - a second pass finds nothing left to escape', () => {
		const source = 'flowchart LR\n  C -->|@maestro| E[a@b]\n  subgraph @team\n  end';
		const once = normalizeMermaidSource(source);
		expect(normalizeMermaidSource(once)).toBe(once);
	});

	it('does not let an unbalanced bracket leak label state into the next line', () => {
		const source = 'flowchart LR\n  A[unclosed\n  B --> C\n  D e1@--> E';
		expect(normalizeMermaidSource(source)).toBe(source);
	});
});
