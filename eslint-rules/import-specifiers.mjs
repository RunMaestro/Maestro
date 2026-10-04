/**
 * Shared visitor for the import-boundary rules.
 *
 * Every way a module can name another module is a dependency: `import`,
 * `export * from`, `export { y } from`, dynamic `import()`, and a literal
 * `require()`. A rule that visits only `ImportDeclaration` leaves the
 * re-export shim and the lazy load as holes, so the boundary rules all route
 * through this one visitor and cannot drift on which forms they cover.
 */

/**
 * Build the visitor map for a rule's `create()`.
 *
 * @param {(reportNode: import('estree').Node, specifier: string) => void} check
 *   Called once per module specifier, with the node to report on.
 * @returns {import('eslint').Rule.RuleListener}
 */
export function visitModuleSpecifiers(check) {
	return {
		ImportDeclaration(node) {
			check(node.source, node.source.value);
		},
		ExportAllDeclaration(node) {
			// `export *` has no sourceless form, so `source` is always set here.
			check(node.source, node.source.value);
		},
		ExportNamedDeclaration(node) {
			// Null for a local `export { y }` / `export const y`, which names
			// nothing outside this file.
			if (node.source) {
				check(node.source, node.source.value);
			}
		},
		ImportExpression(node) {
			if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
				check(node.source, node.source.value);
			}
		},
		CallExpression(node) {
			if (
				node.callee.type === 'Identifier' &&
				node.callee.name === 'require' &&
				node.arguments.length === 1 &&
				node.arguments[0].type === 'Literal' &&
				typeof node.arguments[0].value === 'string'
			) {
				check(node.arguments[0], node.arguments[0].value);
			}
		},
	};
}
