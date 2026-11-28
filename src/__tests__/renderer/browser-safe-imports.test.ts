/**
 * Ratchet: the renderer loads in a browser context.
 *
 * Vite replaces every Node built-in (`fs`, `child_process`, `net`, ...) in the renderer bundle
 * with a stub that throws on any property read. A NAMED import reads its property when the module
 * is evaluated, so `import { readdirSync } from 'fs'` anywhere the renderer reaches by static
 * imports stops the app at its splash screen with "Module "fs" has been externalized for browser
 * compatibility. Cannot access "fs.readdirSync" in client code." (2026-11-24: the renderer took
 * pure record helpers from `lift-return.ts`, whose imports reached `process-tree.ts`.)
 *
 * Shared code the renderer needs must sit in a module whose static imports stay browser-safe; the
 * Node-only half belongs in a separate file the renderer does not import.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { formatChain, namedBuiltinImports, staticGraph } from '../helpers/staticImportGraph';

const SRC = path.join(__dirname, '../..');
const ENTRY = path.join(SRC, 'renderer/main.tsx');

describe('renderer static imports are browser-safe', () => {
	const graph = staticGraph(ENTRY);

	it('walks a real graph (guards against a walker that silently finds nothing)', () => {
		const rel = [...graph.keys()].map((f) => path.relative(SRC, f).split(path.sep).join('/'));
		expect(rel).toContain('renderer/App.tsx');
		expect(rel).toContain('renderer/hooks/remote/useAppRemoteEventListeners.ts');
		expect(graph.size).toBeGreaterThan(500);
	});

	it('detects a named built-in import when one is reachable (positive control)', () => {
		const fromProcessTree = staticGraph(
			path.join(SRC, 'shared/maestro-lib/control/process-tree.ts')
		);
		const hit = [...fromProcessTree.keys()].some(
			(file) => namedBuiltinImports(fs.readFileSync(file, 'utf-8')).length > 0
		);
		expect(hit).toBe(true);
	});

	it('reads named, namespace, default and type-only imports correctly', () => {
		expect(namedBuiltinImports(`import { readdirSync } from 'fs';`)).toEqual(['fs']);
		expect(namedBuiltinImports(`import fs, { existsSync } from 'node:fs';`)).toEqual(['node:fs']);
		expect(namedBuiltinImports(`import * as fs from 'fs';`)).toEqual([]);
		expect(namedBuiltinImports(`import os from 'os';`)).toEqual([]);
		expect(namedBuiltinImports(`import type { Stats } from 'fs';`)).toEqual([]);
		expect(namedBuiltinImports(`import { type Stats } from 'fs';`)).toEqual([]);
		expect(namedBuiltinImports(`import { useState } from 'react';`)).toEqual([]);
	});

	it('never reaches a named import from a Node built-in', () => {
		const offenders = [...graph.entries()]
			.filter(([file]) => namedBuiltinImports(fs.readFileSync(file, 'utf-8')).length > 0)
			.map(([file, chain]) => {
				const modules = namedBuiltinImports(fs.readFileSync(file, 'utf-8')).join(', ');
				return `${formatChain(chain, SRC)} (${modules})`;
			});
		expect(
			offenders,
			'split the browser-safe part into its own module, or import the built-in as a namespace'
		).toEqual([]);
	});
});
