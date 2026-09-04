/**
 * ESLint rule: no-arbitrary-font-sizes
 *
 * Forbids hard-pixel font-size classes like text-[9px], text-[10px], text-[11px], text-[12px],
 * and hover:bg-opacity- classes in JSX className attributes.
 *
 * These break layout when users change the root font-size setting. Use named font sizes instead:
 * - 5-9px -> text-3xs (0.5625rem)
 * - 10px -> text-2xs (0.714rem)
 * - 11px -> text-xs-plus (0.786rem)
 * - 12px -> text-xs
 *
 * For hover effects, use .row-hover instead of hover:bg-opacity-.
 *
 * Autofixable: No (requires manual replacement with correct named class)
 */

/** @type {import('eslint').Rule.RuleModule} */
const noArbitraryFontSizes = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow arbitrary text-[Npx] font-size classes and hover:bg-opacity- in className',
		},
		fixable: null,
		schema: [],
		messages: {
			noFontSize:
				'Avoid text-[Npx] arbitrary font-size classes; they freeze when users change root font-size. Use named sizes: 5-9px -> text-3xs, 10px -> text-2xs, 11px -> text-xs-plus, 12px -> text-xs',
			noHoverOpacity:
				'Avoid hover:bg-opacity-* classes; use .row-hover instead for hover state effects',
		},
	},
	create(context) {
		return {
			JSXAttribute(node) {
				// Only check attributes named 'className' or 'class'
				if (node.name.name !== 'className' && node.name.name !== 'class') {
					return;
				}

				// Extract the class string from various possible attribute value types
				let classString = null;

				if (node.value) {
					// String literal: className="text-[10px]"
					if (node.value.type === 'Literal' && typeof node.value.value === 'string') {
						classString = node.value.value;
					}
					// JSX expression with string literal: className={'text-[10px]'}
					else if (
						node.value.type === 'JSXExpressionContainer' &&
						node.value.expression.type === 'Literal' &&
						typeof node.value.expression.value === 'string'
					) {
						classString = node.value.expression.value;
					}
					// Template literal: className={`text-[10px]`}
					else if (
						node.value.type === 'JSXExpressionContainer' &&
						node.value.expression.type === 'TemplateLiteral'
					) {
						// For template literals, check quasis (static parts)
						const quasis = node.value.expression.quasis;
						for (const quasi of quasis) {
							if (quasi.value.raw) {
								classString = quasi.value.raw;
								if (/text-\[\d+px\]/.test(classString) || /hover:bg-opacity-/.test(classString)) {
									context.report({
										node,
										messageId: /text-\[\d+px\]/.test(classString) ? 'noFontSize' : 'noHoverOpacity',
									});
									return;
								}
							}
						}
						return;
					}
				}

				if (!classString) {
					return;
				}

				// Check for text-[Npx]
				if (/text-\[\d+px\]/.test(classString)) {
					context.report({
						node,
						messageId: 'noFontSize',
					});
				}

				// Check for hover:bg-opacity-
				if (/hover:bg-opacity-/.test(classString)) {
					context.report({
						node,
						messageId: 'noHoverOpacity',
					});
				}
			},
		};
	},
};

export default {
	rules: {
		'no-arbitrary-font-sizes': noArbitraryFontSizes,
	},
};
