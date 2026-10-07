/**
 * Keeps `docs/maestro-lib.md` true to the entry module it documents.
 *
 * The page is written for a developer outside this repository, who will copy
 * its examples and trust its tables. So every `ts` block on the page is
 * type-checked against `index.ts` exactly as written (only the `maestro-lib`
 * specifier is pointed at the source), and the provider table, the refusal
 * reasons and the version the page names are compared with what the library
 * actually does.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import {
	MAESTRO_LIB_VERSION,
	createOutputParser,
	getAgentCapabilities,
	getVisibleAgentDefinitions,
} from '../index';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const DOC = path.join(REPO_ROOT, 'docs/maestro-lib.md');
const ENTRY = path.resolve(__dirname, '../index');
const SESSION_SOURCE = path.resolve(__dirname, '../run/session.ts');

const doc = fs.readFileSync(DOC, 'utf8');

interface CodeBlock {
	/** 1-based line of the opening fence in the page. */
	line: number;
	code: string;
}

function tsBlocks(markdown: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	const lines = markdown.split('\n');
	for (let index = 0; index < lines.length; index++) {
		if (lines[index].trim() !== '```ts') continue;
		const start = index;
		const body: string[] = [];
		for (index++; index < lines.length && lines[index].trim() !== '```'; index++) {
			body.push(lines[index]);
		}
		blocks.push({ line: start + 1, code: body.join('\n') });
	}
	return blocks;
}

/** Rows of the first markdown table after `heading`, as trimmed cells. */
function tableAfter(markdown: string, heading: string): string[][] {
	const at = markdown.indexOf(heading);
	expect(at, `"${heading}" is on the page`).toBeGreaterThanOrEqual(0);
	const rows: string[][] = [];
	let inTable = false;
	for (const line of markdown.slice(at).split('\n')) {
		if (line.startsWith('|')) {
			inTable = true;
			rows.push(
				line
					.split('|')
					.slice(1, -1)
					.map((cell) => cell.trim())
			);
		} else if (inTable) {
			break;
		}
	}
	// The header and the separator row.
	return rows.slice(2);
}

const unquote = (cell: string): string => cell.replace(/^`|`$/g, '');

describe('docs/maestro-lib.md examples', () => {
	const blocks = tsBlocks(doc);

	it('has an example for each part of the surface', () => {
		const all = blocks.map((block) => block.code).join('\n');
		expect(blocks.length).toBeGreaterThanOrEqual(7);
		for (const name of [
			'MAESTRO_LIB_VERSION',
			'planSessionTurn',
			'runToCompletion',
			'runTurn',
			'resumeSessionId',
			'interrupt()',
			'terminate()',
			'CompletedTurn',
			'setMaestroLibLogger',
			'startTurn',
			'resolveTurnOutcome',
		]) {
			expect(all, name).toContain(name);
		}
	});

	it('imports from maestro-lib and nothing else outside Node', () => {
		for (const block of blocks) {
			const specifiers = [...block.code.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
			expect(specifiers, `block at line ${block.line}`).toEqual(['maestro-lib']);
		}
	});

	it('type-checks every block against the entry module', () => {
		// Each block is served from memory at a path beside this test, so the
		// compiler sees it inside the project and nothing is written to disk.
		const examples = new Map(
			blocks.map((block, index) => [
				path.join(__dirname, `__docs_example_${index}_line_${block.line}.ts`),
				block.code.replace(/from 'maestro-lib'/g, `from '${ENTRY}'`),
			])
		);
		const files = [...examples.keys()];

		const parsed = ts.getParsedCommandLineOfConfigFile(
			path.join(REPO_ROOT, 'tsconfig.cli.json'),
			{},
			{
				...ts.sys,
				onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
					throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
				},
			}
		);
		expect(parsed).toBeDefined();
		const options: ts.CompilerOptions = {
			...parsed!.options,
			noEmit: true,
			// A consumer's own compiler settings decide this; the examples must not
			// depend on Node's types being pulled in by some other file.
			types: ['node'],
		};
		const host = ts.createCompilerHost(options);
		const { fileExists, readFile, getSourceFile } = host;
		host.fileExists = (file) => examples.has(file) || fileExists.call(host, file);
		host.readFile = (file) => examples.get(file) ?? readFile.call(host, file);
		host.getSourceFile = (file, languageVersion, ...rest) => {
			const text = examples.get(file);
			return text === undefined
				? getSourceFile.call(host, file, languageVersion, ...rest)
				: ts.createSourceFile(file, text, languageVersion, true);
		};
		const program = ts.createProgram(files, options, host);
		const exampleFiles = new Set(files);
		const errors = ts
			.getPreEmitDiagnostics(program)
			.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
			.map((diagnostic) => {
				const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
				if (!diagnostic.file) return message;
				const where = exampleFiles.has(diagnostic.file.fileName)
					? path.basename(diagnostic.file.fileName)
					: path.relative(REPO_ROOT, diagnostic.file.fileName);
				const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
				return `${where}:${line + 1}: ${message}`;
			});

		expect(errors).toEqual([]);
	}, 120_000);
});

describe('docs/maestro-lib.md facts', () => {
	it('names the current library version', () => {
		expect(doc).toContain(`What each provider supports in maestro-lib \`${MAESTRO_LIB_VERSION}\``);
	});

	it('lists every visible provider with what the planner accepts for it', () => {
		const yesNo = (value: boolean): string => (value ? 'yes' : 'no');
		const expected = getVisibleAgentDefinitions()
			.map((definition) => {
				const capabilities = getAgentCapabilities(definition.id);
				const runs = capabilities.supportsBatchMode && createOutputParser(definition.id) !== null;
				const resumes = runs && capabilities.supportsResume && Boolean(definition.resumeArgs);
				const readOnly = runs && definition.readOnlyCliEnforced === true;
				return [definition.id, definition.name, yesNo(runs), yesNo(resumes), yesNo(readOnly)];
			})
			.sort((a, b) => a[0].localeCompare(b[0]));

		const documented = tableAfter(doc, 'What each provider supports')
			.map(([id, ...rest]) => [unquote(id), ...rest])
			.sort((a, b) => a[0].localeCompare(b[0]));

		expect(documented).toEqual(expected);
	});

	it('lists every reason planSessionTurn can refuse a request for', () => {
		const source = fs.readFileSync(SESSION_SOURCE, 'utf8');
		const union = source.match(/reason:\s*((?:\s*\|\s*'[a-z-]+')+)/);
		expect(union).not.toBeNull();
		const reasons = [...union![1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]).sort();

		const documented = tableAfter(doc, '`planSessionTurn` checks every request')
			.map(([reason]) => unquote(reason))
			.sort();

		expect(documented).toEqual(reasons);
	});
});
