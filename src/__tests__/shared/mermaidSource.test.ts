/**
 * Mermaid's flowchart lexer reads `[^\s"]+@(?=[^{"])` as an edge id, and jison
 * takes the longest match - so `-->|@maestro ...|` lexes the arrow, the pipe,
 * and the `@` as one edge-id token and the diagram fails to parse. Separately,
 * the dotted-link-with-text form (`A -. text .-> B`) scans ahead for its
 * closing `.-` without ever entering a text state, so a `.` in the label - a
 * filename, a version - lexes as syntax. And a bracket is a shape delimiter in
 * a node or pipe label while being ordinary prose in an inline one. Every cell
 * asserted here was measured against mermaid's own parser. These tests pin the
 * repairs: escape `@` to `#64;` inside label text, quote a label whose text
 * would lex as syntax, and leave a label that already parses byte-for-byte
 * alone - the rewrite must only ever appear on a diagram that was going to
 * fail.
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

	describe('quotes a dotted-link label the lexer would read as syntax', () => {
		it('quotes a label carrying a filename, spaced or not', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A -. persists in a.json .-> B')).toBe(
				'flowchart LR\n  A -. "persists in a.json" .-> B'
			);
			expect(normalizeMermaidSource('flowchart LR\n  A-.persists in a.json.->B')).toBe(
				'flowchart LR\n  A-."persists in a.json".->B'
			);
		});

		it('quotes the label of every dotted arrow head and length', () => {
			for (const close of ['.->', '.-', '.-x', '.-o', '..->', '...->']) {
				expect(normalizeMermaidSource(`flowchart LR\n  A -. a.json ${close} B`)).toBe(
					`flowchart LR\n  A -. "a.json" ${close} B`
				);
			}
		});

		it('leaves a bracket alone, which an inline label reads as prose', () => {
			const source = 'flowchart LR\n  A -. reads (json) .-> B';
			expect(normalizeMermaidSource(source)).toBe(source);
		});

		it('quotes a thick link whose label carries an =', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A == a = b ==> B')).toBe(
				'flowchart LR\n  A == "a = b" ==> B'
			);
		});

		it('leaves a bare thick connector alone', () => {
			for (const link of ['==>', '===>', '==', '==x', '==o']) {
				const source = `flowchart LR\n  A ${link} B`;
				expect(normalizeMermaidSource(source)).toBe(source);
			}
		});

		it('quotes rather than escapes a dotted label that also carries @', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A -. from @maestro v1.2 .-> B')).toBe(
				'flowchart LR\n  A -. "from @maestro v1.2" .-> B'
			);
		});

		it('leaves a bare dotted connector alone', () => {
			for (const link of ['-.->', '-.-', '-..->', '-.-x', '-.-o']) {
				const source = `flowchart LR\n  A ${link} B`;
				expect(normalizeMermaidSource(source)).toBe(source);
			}
		});

		it('leaves a dotted label that already parses alone', () => {
			for (const source of [
				'flowchart LR\n  A -. reads it .-> B',
				'flowchart LR\n  A -. "a.json" .-> B',
				'flowchart LR\n  A -.->|reads a.json| B',
			]) {
				expect(normalizeMermaidSource(source)).toBe(source);
			}
		});

		it('leaves a dotted link in a non-flowchart diagram alone', () => {
			const source = 'sequenceDiagram\n  A->>B: reads a.json';
			expect(normalizeMermaidSource(source)).toBe(source);
		});

		it('is idempotent - a second pass finds nothing left to quote', () => {
			const once = normalizeMermaidSource('flowchart LR\n  A -. persists in a.json .-> B');
			expect(normalizeMermaidSource(once)).toBe(once);
		});
	});

	describe('quotes a node or pipe label carrying a bracket', () => {
		it('quotes a bracketed label in every node shape', () => {
			for (const [open, close] of [
				['[', ']'],
				['(', ')'],
				['([', '])'],
				['[[', ']]'],
				['[(', ')]'],
				['((', '))'],
				['{', '}'],
				['{{', '}}'],
				['[/', '/]'],
				['[\\', '\\]'],
			]) {
				expect(normalizeMermaidSource(`flowchart LR\n  A${open}reads (json)${close} --> B`)).toBe(
					`flowchart LR\n  A${open}"reads (json)"${close} --> B`
				);
			}
		});

		it('quotes a pipe label carrying a bracket', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A -->|writes {a,b}| B')).toBe(
				'flowchart LR\n  A -->|"writes {a,b}"| B'
			);
		});

		it('quotes a label whose own brackets balance', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A[a [b] c] --> B')).toBe(
				'flowchart LR\n  A["a [b] c"] --> B'
			);
		});

		it('quotes rather than escapes when a label carries both a bracket and @', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A[reads (json) from @svc] --> B')).toBe(
				'flowchart LR\n  A["reads (json) from @svc"] --> B'
			);
		});

		it('keeps surrounding whitespace outside the quotes', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A[ a (b) ] --> C')).toBe(
				'flowchart LR\n  A[ "a (b)" ] --> C'
			);
		});

		it('quotes each label on a line that carries several', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A[x (1)] -->|to (2)| B[y (3)]')).toBe(
				'flowchart LR\n  A["x (1)"] -->|"to (2)"| B["y (3)"]'
			);
		});

		it('leaves a label with no bracket alone', () => {
			const source = 'flowchart LR\n  A[reads a.json] -->|then| B[two]';
			expect(normalizeMermaidSource(source)).toBe(source);
		});

		it('leaves a bracket that is not glued to a node id alone', () => {
			const source = 'flowchart LR\n  A -- reads (json) --> B';
			expect(normalizeMermaidSource(source)).toBe(source);
		});

		it('leaves an already quoted label and a markdown string alone', () => {
			for (const source of [
				'flowchart LR\n  A["reads (json)"] --> B',
				'flowchart LR\n  A["`**bold** (text)`"] --> B',
			]) {
				expect(normalizeMermaidSource(source)).toBe(source);
			}
		});

		it('leaves shape data, comments, and statement lines alone', () => {
			for (const source of [
				'flowchart LR\n  A@{ shape: rect, label: "hi (there)" }\n  A --> B',
				'flowchart LR\n  %% a (comment) here\n  A --> B',
				'flowchart LR\n  A --> B\n  click A "https://x.com" "tip (here)"',
				'flowchart LR\n  A --> B\n  style A fill:#f00,stroke-width:2px',
			]) {
				expect(normalizeMermaidSource(source)).toBe(source);
			}
		});

		it('leaves an unbalanced bracket alone rather than guessing where a label ends', () => {
			const source = 'flowchart LR\n  A[unclosed (\n  B --> C';
			expect(normalizeMermaidSource(source)).toBe(source);
		});

		it('is idempotent - a second pass finds nothing left to quote', () => {
			const once = normalizeMermaidSource('flowchart LR\n  A[reads (json)] -->|to {x}| B');
			expect(normalizeMermaidSource(once)).toBe(once);
		});

		it('quotes a pipe inside a node label', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A[a|b] --> B')).toBe(
				'flowchart LR\n  A["a|b"] --> B'
			);
		});

		it('leaves a pipe alone in the slash shapes, which tolerate one', () => {
			for (const [open, close] of [
				['[/', '/]'],
				['[\\', '\\]'],
				['[/', '\\]'],
				['[\\', '/]'],
			]) {
				const source = `flowchart LR\n  A${open}a|b${close} --> B`;
				expect(normalizeMermaidSource(source)).toBe(source);
			}
		});

		it('does not mistake a pipe inside a node label for an edge delimiter', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A --> B((a|b))')).toBe(
				'flowchart LR\n  A --> B(("a|b"))'
			);
		});

		it('finds the label end when its own brackets do not balance', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A([a b) c]) --> B')).toBe(
				'flowchart LR\n  A(["a b) c"]) --> B'
			);
			expect(normalizeMermaidSource('flowchart LR\n  A(a (b c) --> B')).toBe(
				'flowchart LR\n  A("a (b c") --> B'
			);
		});

		it('bounds that search at the link, so a later node is not swallowed', () => {
			expect(normalizeMermaidSource('flowchart LR\n  A(a (b c) --> B(x (y z)')).toBe(
				'flowchart LR\n  A("a (b c") --> B("x (y z")'
			);
		});

		it('declines the two ambiguous inputs rather than guessing', () => {
			for (const source of [
				// Which `|` closes the label is unknowable.
				'flowchart LR\n  A -->|a|b| B',
				// A bare quote cannot be told from the quoting this module adds.
				'flowchart LR\n  A[a "q" b] --> B',
			]) {
				expect(normalizeMermaidSource(source)).toBe(source);
			}
		});
	});

	describe('quotes a subgraph title in either of its forms', () => {
		it('quotes a bracketed title carrying a bracket', () => {
			expect(normalizeMermaidSource('flowchart LR\n  subgraph S1 [My (Title)]\n  end')).toBe(
				'flowchart LR\n  subgraph S1 ["My (Title)"]\n  end'
			);
		});

		it('quotes a bare title carrying a bracket or an @', () => {
			expect(normalizeMermaidSource('flowchart LR\n  subgraph My (Title)\n  end')).toBe(
				'flowchart LR\n  subgraph "My (Title)"\n  end'
			);
			expect(normalizeMermaidSource('flowchart LR\n  subgraph @maestro team\n  end')).toBe(
				'flowchart LR\n  subgraph "@maestro team"\n  end'
			);
		});

		it('leaves a title that already parses alone', () => {
			for (const source of [
				'flowchart LR\n  subgraph S1 [My Title]\n  end',
				'flowchart LR\n  subgraph Preview\n  end',
				'flowchart LR\n  subgraph S1 ["My (Title)"]\n  end',
			]) {
				expect(normalizeMermaidSource(source)).toBe(source);
			}
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
