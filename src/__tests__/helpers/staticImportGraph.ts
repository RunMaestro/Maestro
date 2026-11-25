/**
 * The static import graph of a source tree, walked the way a bundler evaluates it.
 *
 * A bundler evaluates every STATIC import eagerly when the entry loads, so a module reachable
 * that way runs at startup whether or not its code is ever called. Ratchet tests use this to keep
 * an entry point from reaching something it cannot load: `maestro-cli` under plain Node
 * (`better-sqlite3`), and the renderer under Vite (a named import from a Node built-in).
 */

import * as fs from 'fs';
import { builtinModules } from 'module';
import * as path from 'path';

/** Static module specifiers in a source file: value imports, re-exports, top-level require. */
export function staticSpecifiers(source: string): string[] {
	const code = stripComments(source);
	const found: string[] = [];
	const patterns = [
		// import x from 'm' / import { a } from 'm' / import * as x from 'm' (not `import type`)
		/(?:^|[;\n])\s*import\s+(?!type\s)[^'";]*?\sfrom\s*['"]([^'"]+)['"]/g,
		// import 'm' (side effect)
		/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g,
		// export { a } from 'm' / export * from 'm' (not `export type`)
		/(?:^|[;\n])\s*export\s+(?!type\s)(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/g,
		// require('m') - the CommonJS shim and any plain require
		/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of code.matchAll(pattern)) found.push(match[1]);
	}
	return found;
}

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/**
 * Node built-ins a file imports by NAME (`import { readdirSync } from 'fs'`, also with a default
 * binding beside the braces). Vite replaces a built-in with a stub that throws on any property
 * read, and a named import reads its property when the module is evaluated, so one of these
 * reachable from the renderer stops the app at startup. A namespace or default import only throws
 * when a function on it is called. Type-only names (`import { type Stats }`) are skipped.
 */
export function namedBuiltinImports(source: string): string[] {
	const code = stripComments(source);
	const found: string[] = [];
	const pattern = /(?:^|[;\n])\s*import\s+(?!type\s)([^'";]*?)\sfrom\s*['"]([^'"]+)['"]/g;
	for (const match of code.matchAll(pattern)) {
		const [, clause, specifier] = match;
		if (!NODE_BUILTINS.has(specifier)) continue;
		const braces = clause.match(/\{([^}]*)\}/);
		if (!braces) continue;
		const valueNames = braces[1]
			.split(',')
			.map((name) => name.trim())
			.filter((name) => name && !name.startsWith('type '));
		if (valueNames.length > 0) found.push(specifier);
	}
	return found;
}

function stripComments(source: string): string {
	// Strip comments so an import inside a doc comment is not followed.
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function resolveRelative(fromFile: string, specifier: string): string | null {
	const base = path.resolve(path.dirname(fromFile), specifier.replace(/\?raw$/, ''));
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		`${base}.cjs`,
		path.join(base, 'index.ts'),
		path.join(base, 'index.tsx'),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return null;
}

/**
 * Every file reachable from `entry` by static imports, with the chain that reached it. Relative
 * specifiers are followed; `resolveBare` maps a bare one the build aliases (the CLI's `electron`
 * shim) to a file, and anything else bare is a package and is not followed.
 */
export function staticGraph(
	entry: string,
	resolveBare: (specifier: string) => string | null = () => null
): Map<string, string[]> {
	const reached = new Map<string, string[]>([[entry, [entry]]]);
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.shift()!;
		if (!/\.(ts|tsx|js|cjs|mjs)$/.test(file)) continue;
		for (const specifier of staticSpecifiers(fs.readFileSync(file, 'utf-8'))) {
			const target = specifier.startsWith('.')
				? resolveRelative(file, specifier)
				: resolveBare(specifier);
			if (!target || reached.has(target)) continue;
			reached.set(target, [...reached.get(file)!, target]);
			queue.push(target);
		}
	}
	return reached;
}

/** A chain of files as `a.ts -> b.ts`, relative to `root`, with forward slashes. */
export function formatChain(chain: string[], root: string): string {
	return chain.map((file) => path.relative(root, file).split(path.sep).join('/')).join(' -> ');
}
