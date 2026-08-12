/**
 * ESLint rule: no em-dash or en-dash in comments.
 *
 * CLAUDE.md calls this rule non-negotiable, but nothing enforced it, so the two
 * long-lived branches drifted: at the time this rule landed, 603 of the 2,891
 * source files shared by `main` and `rc` differed ONLY by these two characters.
 * Every one of them was a latent merge conflict that armed itself as soon as
 * either branch edited a line near a dashed comment. Enforcing the rule in CI is
 * what stops that drift from coming back.
 *
 * Scope is deliberately COMMENTS ONLY. A dash inside a string literal can be
 * load-bearing - `'—'` is a real "no value" placeholder in several stat cards,
 * and `documentStats.ts` matches `—` in a regex - so flagging string
 * contents would produce false positives on working code. Comments carry
 * essentially all of the drift and none of the risk.
 *
 * Autofixable: both characters rewrite to a plain hyphen.
 */

const DASHES = /[—–]/g;

/** @type {import('eslint').Rule.RuleModule} */
const noEmDashInComments = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Disallow em-dashes and en-dashes in comments; use a plain hyphen instead',
		},
		fixable: 'whitespace',
		schema: [],
		messages: {
			noDash:
				'Use a plain hyphen (-) instead of {{ name }} in comments. Em/en-dashes read as bot-authored and are a standing source of merge conflicts between main and rc.',
		},
	},
	create(context) {
		const sourceCode = context.sourceCode ?? context.getSourceCode();
		return {
			Program() {
				for (const comment of sourceCode.getAllComments()) {
					DASHES.lastIndex = 0;
					let match;
					while ((match = DASHES.exec(comment.value)) !== null) {
						// comment.range[0] points at the opening `//` or `/*`, so skip the
						// marker to map an offset inside `.value` back to the source text.
						const markerLength = comment.type === 'Line' ? 2 : 2;
						const start = comment.range[0] + markerLength + match.index;
						context.report({
							loc: {
								start: sourceCode.getLocFromIndex(start),
								end: sourceCode.getLocFromIndex(start + 1),
							},
							messageId: 'noDash',
							data: { name: match[0] === '—' ? 'an em-dash (—)' : 'an en-dash (–)' },
							fix: (fixer) => fixer.replaceTextRange([start, start + 1], '-'),
						});
					}
				}
			},
		};
	},
};

export default {
	rules: {
		'no-em-dash-in-comments': noEmDashInComments,
	},
};
