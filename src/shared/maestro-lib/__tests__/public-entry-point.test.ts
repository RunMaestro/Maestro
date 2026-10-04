/**
 * Public entry point drift guard.
 *
 * `index.ts` is the only module a library client (the TUI, and eventually
 * every other caller) is meant to import. Today most callers still reach into
 * deep paths such as `maestro-lib/launch/launch-plan`, and they will be moved
 * onto the entry one at a time. That move is only mechanical if every symbol
 * they import from a deep path is already exported from `index.ts`, so this
 * test scans every importer under `src/` (outside the library itself) and
 * fails the moment a deep import names something the entry does not export.
 *
 * Symbols are compared through the TypeScript checker rather than the runtime
 * module object, because type-only exports (`TurnFacts`, `AgentLaunchPlan`)
 * are erased at runtime and would be invisible to `Object.keys`. A namespace
 * import, a re-export-all, or a dynamic `import()` of a deep path names no
 * symbols, so for those the whole target module must be covered.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const LIB_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.resolve(LIB_ROOT, '..', '..');
const INDEX_FILE = path.join(LIB_ROOT, 'index.ts');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** One deep import: the library module it lands on, and what it names. */
interface DeepImport {
	importer: string;
	target: string;
	/** `null` means the importer takes the whole module (namespace, `export *`, `import()`). */
	names: string[] | null;
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (full === LIB_ROOT || entry.name === 'node_modules') continue;
			collectSourceFiles(full, out);
		} else if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
			out.push(full);
		}
	}
	return out;
}

/** Resolves a relative specifier to a library source file, or null when it lands elsewhere. */
function resolveLibraryModule(importer: string, specifier: string): string | null {
	if (!specifier.startsWith('.')) return null;
	const base = path.resolve(path.dirname(importer), specifier);
	if (!base.startsWith(LIB_ROOT + path.sep)) return null;
	const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
	const file = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
	if (!file) throw new Error(`${importer} imports ${specifier}, which resolves to no file`);
	return file === INDEX_FILE ? null : file;
}

function collectDeepImports(): DeepImport[] {
	const found: DeepImport[] = [];
	for (const file of collectSourceFiles(SRC_ROOT)) {
		const text = fs.readFileSync(file, 'utf-8');
		if (!text.includes('maestro-lib')) continue;
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

		const record = (specifierNode: ts.Expression | undefined, names: string[] | null) => {
			if (!specifierNode || !ts.isStringLiteralLike(specifierNode)) return;
			const target = resolveLibraryModule(file, specifierNode.text);
			if (target) found.push({ importer: file, target, names });
		};

		const visit = (node: ts.Node): void => {
			if (ts.isImportDeclaration(node)) {
				const clause = node.importClause;
				const bindings = clause?.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings)) {
					record(node.moduleSpecifier, null);
				} else if (bindings && ts.isNamedImports(bindings)) {
					record(
						node.moduleSpecifier,
						bindings.elements.map((el) => (el.propertyName ?? el.name).text)
					);
				}
				if (clause?.name) record(node.moduleSpecifier, ['default']);
			} else if (ts.isExportDeclaration(node)) {
				const clause = node.exportClause;
				if (clause && ts.isNamedExports(clause)) {
					record(
						node.moduleSpecifier,
						clause.elements.map((el) => (el.propertyName ?? el.name).text)
					);
				} else {
					record(node.moduleSpecifier, null);
				}
			} else if (
				ts.isCallExpression(node) &&
				node.expression.kind === ts.SyntaxKind.ImportKeyword
			) {
				record(node.arguments[0], null);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return found;
}

function moduleExportSymbols(
	checker: ts.TypeChecker,
	program: ts.Program,
	file: string
): Map<string, ts.Symbol> {
	const source = program.getSourceFile(file);
	if (!source) throw new Error(`TypeScript did not load ${file}`);
	const symbol = checker.getSymbolAtLocation(source);
	if (!symbol) return new Map();
	return new Map(checker.getExportsOfModule(symbol).map((s) => [s.getName(), s]));
}

/** Follows re-export and `export default x` aliases to the declaration they name. */
function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
	return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

describe('maestro-lib public entry point', () => {
	const deepImports = collectDeepImports();

	it('finds the deep importers it is meant to guard', () => {
		// A scan that silently matched nothing would make the drift check vacuous.
		expect(deepImports.length).toBeGreaterThan(50);
	});

	it('exports every symbol imported from a maestro-lib deep path', () => {
		const targets = [...new Set(deepImports.map((d) => d.target))];
		const program = ts.createProgram([INDEX_FILE, ...targets], {
			noEmit: true,
			skipLibCheck: true,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			jsx: ts.JsxEmit.ReactJSX,
			esModuleInterop: true,
		});
		const checker = program.getTypeChecker();
		const indexExports = moduleExportSymbols(checker, program, INDEX_FILE);
		// `export *` never carries a default export, so a deep `default` import is
		// covered when the entry exports the same declaration under its own name.
		const indexDeclarations = new Set(
			[...indexExports.values()].map((s) => resolveAlias(checker, s))
		);

		const missing = new Set<string>();
		for (const { importer, target, names } of deepImports) {
			const targetExports = moduleExportSymbols(checker, program, target);
			for (const name of names ?? [...targetExports.keys()]) {
				const covered =
					name === 'default'
						? targetExports.has('default') &&
							indexDeclarations.has(resolveAlias(checker, targetExports.get('default')!))
						: indexExports.has(name);
				if (!covered) {
					missing.add(
						`${name} (${path.relative(LIB_ROOT, target)}, imported by ${path.relative(SRC_ROOT, importer)})`
					);
				}
			}
		}
		expect([...missing].sort()).toEqual([]);
	}, 60_000);

	it('does not expose bin/', () => {
		const content = fs.readFileSync(INDEX_FILE, 'utf-8');
		expect(content).not.toMatch(/from '\.\/bin\//);
	});
});
