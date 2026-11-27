/**
 * Code-structure previews: the imports, exports and signatures of a source file
 * an agent read, with every body left out.
 *
 * A preview only MEASURES. It builds the outline a stand-in for the read could
 * carry, counts it against the file exactly as the agent sent it, and reports the
 * difference as a potential reduction. The file the agent asked for stays whole in
 * the request: this module edits no request, reads no file, opens no cache and
 * keeps nothing between calls, so what the model is shown, and every verdict the
 * cache has frozen, are exactly what they were.
 *
 * ## Inputs
 *
 * Only text the caller already holds. The reads come from `analyzeReadOpportunities()`:
 * its findings name each read and carry its hash, and the events the report was built
 * from are the only source of text, checked against that hash before it is used. Nothing
 * outside the supplied text is consulted. No related file is opened or summarized, no
 * import is followed, and no document is turned into headings.
 *
 * A read the analyzer ruled out on its own text (binary-looking, failed, already
 * compressed, unknown numbering) has no entry. A read it merely could not relate to an
 * earlier one (`partial-range`, `reset-between`, `other-context`) is still a read of the
 * file, and gets one. Related reads are not needed here: an outline depends on the text
 * alone, so unlike a delta it needs no baseline and no proof of what the model retains.
 *
 * ## Languages
 *
 * Deliberately few: TypeScript, TSX, JavaScript and Python, chosen by file extension and
 * never by sniffing content. They are the languages whose production grammar already
 * ships, as dependencies of the editor's language packs. Everything else, Markdown,
 * configuration and data included, is `unsupported-language`.
 *
 * ## When the structure is not trusted
 *
 * The text must parse as a whole program. The grammar runs in strict mode, so a syntax
 * error throws at once instead of starting the recovery that makes garbage input cost
 * seconds. Strict mode still leaves error nodes where it forced a reduction, so the tree
 * is scanned too, and one error node is enough: `parse-error`. A grammar that does not
 * know a construct (a decorator before `export`, `declare module 'x'`) therefore yields
 * no outline, never a wrong one.
 *
 * ## What an outline shows
 *
 * Imports and exports as written, and each declaration's signature: functions, classes
 * and their members one level down, interfaces, type aliases and enums, constants and
 * the CommonJS `module.exports` statements. A body is replaced by a notice that counts
 * the lines it spanned. A value spanning several lines is replaced the same way, and any
 * other statement is left out and counted in the marker. Comments are not shown.
 *
 * ## What the figure is
 *
 * Measured against the file exactly as the agent sent it ({@link PotentialReduction.basis}),
 * every marker line counted. It is not a saving: nothing was replaced, and an outline
 * cannot stand in for a file whose bodies are needed. It is an alternative to a
 * `read-previews.ts` figure for the same result, so the two must not be added.
 *
 * ## Work bounds
 *
 * Every limit in {@link CODE_STRUCTURE_LIMITS} is explicit and lowerable per call, and a
 * bound never produces an outline. The parse runs in slices of {@link PARSE_SLICE_STEPS}
 * with a turn of the event loop between them, because the proxy forwards requests in this
 * same process: a large file holds the loop for one slice at a time, not for the whole
 * parse. The slicing changes when work happens, never what it computes. A grammar package
 * is imported when the first source of its language is parsed, so an app that never
 * previews code never loads one.
 */

import type { SyntaxNode, Tree } from '@lezer/common';
import type { LRParser } from '@lezer/lr';
import { getFileExtension } from '../../../shared/fileCategories';
import { yieldToEventLoop } from '../../utils/concurrency';
import { MIN_SAVING_RATIO } from './compress';
import { contentHash } from './compression-cache';
import {
	withoutLineNumbers,
	type ReadEvent,
	type ReadFinding,
	type ReadOpportunityReport,
	type ReadUnsupportedReason,
	type ReadVersion,
} from './read-opportunities';
import {
	MARKER_HASH_CHARS,
	potentialReduction,
	type PotentialReduction,
	type ResultDelivery,
} from './read-previews';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export interface CodeStructureLimits {
	/** Distinct sources parsed per request. The rest are `over-budget`. */
	maxSources: number;
	/** Characters of one source. A parse costs by characters and tree nodes, so there is no line bound. */
	maxSourceChars: number;
	/** Characters across every source parsed. */
	maxTotalChars: number;
	/** Syntax-tree nodes scanned for errors in one source. */
	maxTreeNodes: number;
	/** Characters of one declaration shown as written. A longer one is cut, with a notice. */
	maxEntryChars: number;
}

/**
 * The character limit matches the read previews'. The node limit sits just above the
 * densest valid source measured at the character bound (about 262,000 nodes), so it
 * stops only a tree larger than any such source.
 */
export const CODE_STRUCTURE_LIMITS: Readonly<CodeStructureLimits> = Object.freeze({
	maxSources: 32,
	maxSourceChars: 262_144,
	maxTotalChars: 1_048_576,
	maxTreeNodes: 300_000,
	maxEntryChars: 2_000,
});

/**
 * Parse steps between two turns of the event loop. Scheduling only: it never changes
 * what a parse returns. In the strict-mode runs measured, 1,024 steps took under 6 ms
 * on source files and on dense generated text, and 16 ms on the worst input found (a
 * chain of 60,000 additions).
 */
export const PARSE_SLICE_STEPS = 1_024;

/** Said wherever an outline figure is shown. */
export const CODE_STRUCTURE_NOTE =
	'Potential reduction only. Each figure compares a whole-file read, as the agent sent it, with an outline of the same text (imports, exports and signatures, bodies left out) that could stand in for it if the bodies were not needed. The file is never replaced and nothing was saved. The outline describes the text as supplied: a read that the tool cut short is outlined as far as it goes. Token counts are estimates at 4 characters per token.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CodeLanguage = 'typescript' | 'tsx' | 'javascript' | 'python';

/** Why a read has no outline. A reason names the missing evidence or the bound. */
export type CodeStructureUnsupportedReason =
	/** A work bound was reached before this source was parsed. */
	| 'over-budget'
	/** The events hold no text for the read. */
	| 'source-missing'
	/** The text supplied is not the text the finding hashed. */
	| 'source-mismatch'
	/** The extension is not one of the supported languages. Documents and data are never outlined. */
	| 'unsupported-language'
	/** The call asked for a range, or the printed line numbers do not start at 1: the text is a piece of the file. */
	| 'partial-range'
	/** The text is longer than {@link CodeStructureLimits.maxSourceChars}. */
	| 'too-large'
	/** The grammar could not read the text as a whole program, so its structure is unknown. */
	| 'parse-error'
	/** The syntax tree has more nodes than {@link CodeStructureLimits.maxTreeNodes}. */
	| 'too-complex'
	/** The text parsed, but holds no import or declaration to show. */
	| 'nothing-to-outline'
	/** The outline, markers included, is not {@link MIN_SAVING_RATIO} smaller than the file. */
	| 'insufficient-reduction';

/** What an outline shows and what it leaves out. */
export interface OutlineCounts {
	/** Import statements shown. */
	imports: number;
	/** Top-level declarations shown: exports, functions, classes, types and constants. */
	declarations: number;
	/** Class members shown. */
	members: number;
	/** Bodies, and values spanning several lines, replaced by a notice. */
	bodies: number;
	/** Lines those bodies and values spanned. */
	omittedLines: number;
	/** Statements and members left out without a notice of their own; the marker counts them. */
	statements: number;
}

export type CodeStructureEntry =
	| {
			status: 'preview';
			/** The source: its path, call, hash and size. */
			read: ReadVersion;
			language: CodeLanguage;
			/** The grammar that read the text. */
			parser: { name: string; dialect: string | null };
			/** Previews exist only for text that parsed with no error node. */
			confidence: 'parsed-without-errors';
			/** What the model is shown for the read itself; `replaced` or `unproven` means compression overlaps. */
			delivery: ResultDelivery | 'unproven';
			potential: PotentialReduction;
			outline: OutlineCounts;
			/** The text a stand-in would carry. It holds lines of the file. */
			text: string;
	  }
	| { status: 'unsupported'; reason: CodeStructureUnsupportedReason; read: ReadVersion };

export interface CodeStructureCounts {
	/** Reads the analyzer accepted as one clean text; each has exactly one entry. */
	examined: number;
	outlined: number;
	unsupported: number;
	unsupportedByReason: Partial<Record<CodeStructureUnsupportedReason, number>>;
	/** Sum over the outlines. Each outline replaces its own result, so the sum is additive. */
	potentialChars: number;
	potentialTokens: number;
}

export interface CodeStructureReport {
	version: 1;
	/** A report measures text that was never sent. Nothing in it edits a request or a cached verdict. */
	mode: 'preview';
	note: typeof CODE_STRUCTURE_NOTE;
	/** False when the analyzer or a work bound here left reads unexamined. */
	complete: boolean;
	limits: CodeStructureLimits;
	previews: CodeStructureEntry[];
	counts: CodeStructureCounts;
}

export interface CodeStructureInput {
	/** `analyzeReadOpportunities()` output. Its first, repeated and merely unrelated reads are outlined. */
	report: ReadOpportunityReport;
	/** The events that report was built from. The only source of text. */
	events: readonly ReadEvent[];
	/** By the event's `order`; see `resultDeliveries()`. A read with no entry is reported as `unproven`. */
	deliveries?: ReadonlyMap<number, ResultDelivery>;
	limits?: Partial<CodeStructureLimits>;
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

type Grammar = 'javascript' | 'python';

interface LanguageSpec {
	grammar: Grammar;
	/** The grammar package, named in a preview as its provenance. */
	package: string;
	/** The grammar's dialect flags, or null for none. */
	dialect: string | null;
}

const LANGUAGES: Readonly<Record<CodeLanguage, LanguageSpec>> = {
	typescript: { grammar: 'javascript', package: '@lezer/javascript', dialect: 'ts' },
	tsx: { grammar: 'javascript', package: '@lezer/javascript', dialect: 'ts jsx' },
	// JSX only gives meaning to text plain JavaScript rejects, so a file with no JSX parses the same.
	javascript: { grammar: 'javascript', package: '@lezer/javascript', dialect: 'jsx' },
	python: { grammar: 'python', package: '@lezer/python', dialect: null },
};

/** By extension only; a map, so an extension such as `constructor` is not a key of the prototype. */
const EXTENSIONS: ReadonlyMap<string, CodeLanguage> = new Map<string, CodeLanguage>([
	['ts', 'typescript'],
	['mts', 'typescript'],
	['cts', 'typescript'],
	['tsx', 'tsx'],
	['js', 'javascript'],
	['mjs', 'javascript'],
	['cjs', 'javascript'],
	['jsx', 'javascript'],
	['py', 'python'],
]);

/** The supported language of a path, or null. The file's content never decides it. */
export function codeLanguageOf(path: string): CodeLanguage | null {
	return EXTENSIONS.get(getFileExtension(path)) ?? null;
}

/** How a language writes the places where an outline leaves something out. */
interface Syntax {
	/** What stands where a value, or the rest of a cut declaration, was left out, carrying `note`. */
	elided(note: string): string;
	/** A header whose body is replaced by `note`. */
	stub(head: string, note: string): string;
	/** A header followed by the members shown under it. */
	open(head: string): string;
	/** The line that ends those members, or null when indentation does. */
	close: string | null;
	/** A header with no member to show. */
	empty(head: string): string;
}

const BRACES: Syntax = {
	elided: (note) => `/* ${note} */`,
	stub: (head, note) => `${head} { /* ${note} */ }`,
	open: (head) => `${head} {`,
	close: '}',
	empty: (head) => `${head} {}`,
};

const INDENTED: Syntax = {
	elided: (note) => `...  # ${note}`,
	stub: (head, note) => `${head}: ...  # ${note}`,
	open: (head) => `${head}:`,
	close: null,
	empty: (head) => `${head}: ...`,
};

/** The node names of a grammar that the outline cares about. */
interface Profile {
	syntax: Syntax;
	/** Not statements: never shown and never counted as left out. */
	comments: ReadonlySet<string>;
	imports: ReadonlySet<string>;
	/** Outer nodes (export, declare, decorators) that wrap the declaration they introduce. */
	wrappers: ReadonlySet<string>;
	/** Nodes with a body, and the child that holds it. The body is replaced by a notice. */
	functions: ReadonlyMap<string, string>;
	/** Nodes with members, and the child that holds them. */
	containers: ReadonlyMap<string, string>;
	/** Declarations that are signatures already: shown as written. */
	types: ReadonlySet<string>;
	/** Declarations that bind a value: as written when on one line, without the value when on several. */
	bindings: ReadonlySet<string>;
	/** Whether `module.exports = ...` and `exports.name = ...` statements are exports. */
	commonJs: boolean;
}

const SCRIPT: Profile = {
	syntax: BRACES,
	comments: new Set(['LineComment', 'BlockComment', 'Hashbang']),
	imports: new Set(['ImportDeclaration']),
	wrappers: new Set(['ExportDeclaration', 'AmbientDeclaration']),
	functions: new Map([
		['FunctionDeclaration', 'Block'],
		['MethodDeclaration', 'Block'],
		['NamespaceDeclaration', 'Block'],
		['GlobalDeclaration', 'Block'],
	]),
	containers: new Map([['ClassDeclaration', 'ClassBody']]),
	types: new Set(['InterfaceDeclaration', 'TypeAliasDeclaration', 'EnumDeclaration']),
	bindings: new Set(['VariableDeclaration', 'PropertyDeclaration']),
	commonJs: true,
};

const PYTHON: Profile = {
	syntax: INDENTED,
	comments: new Set(['Comment']),
	imports: new Set(['ImportStatement']),
	wrappers: new Set(['DecoratedStatement']),
	functions: new Map([['FunctionDefinition', 'Body']]),
	containers: new Map([['ClassDefinition', 'Body']]),
	types: new Set(),
	bindings: new Set(['AssignStatement']),
	commonJs: false,
};

const PROFILES: Readonly<Record<Grammar, Profile>> = { javascript: SCRIPT, python: PYTHON };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const parsers = new Map<CodeLanguage, LRParser>();

/**
 * The strict parser of a language. Strict mode throws at the first syntax error
 * instead of recovering from it, and recovery is the expensive path: it is what
 * makes garbage input cost seconds.
 */
async function loadParser(language: CodeLanguage): Promise<LRParser> {
	let parser = parsers.get(language);
	if (!parser) {
		const { grammar, dialect } = LANGUAGES[language];
		const base =
			grammar === 'python'
				? (await import('@lezer/python')).parser
				: (await import('@lezer/javascript')).parser;
		parser = base.configure({ strict: true, ...(dialect ? { dialect } : {}) });
		parsers.set(language, parser);
	}
	return parser;
}

/** The syntax tree, or null when the text is not a whole program of the grammar. */
async function parseText(parser: LRParser, text: string): Promise<Tree | null> {
	const parse = parser.startParse(text);
	try {
		for (let steps = 1; ; steps++) {
			const tree = parse.advance();
			if (tree) return tree;
			if (steps % PARSE_SLICE_STEPS === 0) await yieldToEventLoop();
		}
	} catch (error) {
		// Strict mode reports "No parse at N" as a SyntaxError. Anything else is a bug and surfaces.
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

/** Why a parsed tree cannot be trusted, or null. Strict mode still leaves error nodes where it forced a reduction. */
function treeProblem(tree: Tree, maxNodes: number): 'parse-error' | 'too-complex' | null {
	let nodes = 0;
	const cursor = tree.cursor();
	do {
		if (cursor.type.isError) return 'parse-error';
		if (++nodes > maxNodes) return 'too-complex';
	} while (cursor.next());
	return null;
}

// ---------------------------------------------------------------------------
// The outline
// ---------------------------------------------------------------------------

interface Outliner {
	text: string;
	profile: Profile;
	maxEntryChars: number;
	lines: string[];
	counts: OutlineCounts;
}

/** Node names of statements and members start with a capital; punctuation and keywords do not. */
const STRUCTURAL = /^[A-Z]/;

const FUNCTION_VALUES: ReadonlySet<string> = new Set(['ArrowFunction', 'FunctionExpression']);

/** The nodes after which a value starts: `=` in the script grammar, `default` in `export default`, `=` in Python. */
const VALUE_STARTS: ReadonlySet<string> = new Set(['Equals', 'default', 'AssignOp']);

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Lines a text spans, where a trailing line break does not start one: pass it trimmed. */
function lineSpan(text: string): number {
	let lines = 1;
	for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines++;
	return lines;
}

/**
 * The whitespace the source put before a member on its own line, so a header that
 * continues on the next line (a decorator, a wrapped signature) still lines up. A
 * member that shares its line with other text falls back to one tab per level.
 */
function indentation(text: string, at: number, depth: number): string {
	if (depth === 0) return '';
	const lead = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
	return lead !== '' && /^[ \t]*$/.test(lead) ? lead : '\t'.repeat(depth);
}

/**
 * The text with line breaks as LF, and cut with a notice when longer than the bound.
 * A text of several lines is cut at the last line break inside the bound, so no line
 * is shown half way; a single long line is cut at the bound.
 */
function capped(outliner: Outliner, raw: string): string {
	const text = raw.replace(/\r\n?/g, '\n');
	const { maxEntryChars, profile } = outliner;
	if (text.length <= maxEntryChars) return text;
	const lineBreak = text.lastIndexOf('\n', maxEntryChars);
	const end = lineBreak > 0 ? lineBreak : maxEntryChars;
	const notice = profile.syntax.elided(`${plural(text.length - end, 'more character')} omitted`);
	return `${text.slice(0, end)}${lineBreak > 0 ? '\n' : ' '}${notice}`;
}

/** A header with its body replaced by a notice that says how many lines it spanned. */
function stub(outliner: Outliner, outer: SyntaxNode, body: SyntaxNode): string {
	const { text, counts, profile } = outliner;
	const omitted = lineSpan(text.slice(body.from, body.to).trim());
	counts.bodies++;
	counts.omittedLines += omitted;
	const head = capped(outliner, text.slice(outer.from, body.from).trimEnd());
	return profile.syntax.stub(head, `${plural(omitted, 'line')} omitted`);
}

/** The `=` (or `default`) after which a value starts, in a declaration or an assignment statement. */
function valueCut(node: SyntaxNode): SyntaxNode | null {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (VALUE_STARTS.has(child.name)) return child;
	}
	return node.getChild('AssignmentExpression')?.getChild('Equals') ?? null;
}

/** The block body of a function that is the value after `cut`, or null. */
function functionBlock(cut: SyntaxNode): SyntaxNode | null {
	const value = cut.nextSibling;
	return value && FUNCTION_VALUES.has(value.name) ? value.getChild('Block') : null;
}

/**
 * A declaration that binds a value. A function value is a signature and a body, like a
 * function declaration. Any other value is shown as written when the declaration fits
 * on one line, and replaced by a notice when it spans several, because a value is
 * implementation and not structure.
 */
function binding(outliner: Outliner, outer: SyntaxNode, node: SyntaxNode): string {
	const { text, profile } = outliner;
	const written = text.slice(outer.from, outer.to).trimEnd();
	const cut = valueCut(node);
	if (cut) {
		const body = functionBlock(cut);
		if (body && /^\s*;?\s*$/.test(text.slice(body.to, outer.to))) {
			return stub(outliner, outer, body) + (written.endsWith(';') ? ';' : '');
		}
		if (written.includes('\n')) {
			const omitted = lineSpan(text.slice(cut.to, outer.to).trim());
			outliner.counts.bodies++;
			outliner.counts.omittedLines += omitted;
			const head = capped(outliner, text.slice(outer.from, cut.to));
			const note = profile.syntax.elided(`${plural(omitted, 'line')} omitted`);
			return `${head} ${note}${written.endsWith(';') ? ';' : ''}`;
		}
	}
	return capped(outliner, written);
}

function isCommonJsExport(outliner: Outliner, node: SyntaxNode): boolean {
	return (
		outliner.profile.commonJs &&
		node.name === 'ExpressionStatement' &&
		node.firstChild?.name === 'AssignmentExpression' &&
		/^(?:module\.)?exports\b/.test(outliner.text.slice(node.from, node.from + 16))
	);
}

function isDeclaration(profile: Profile, name: string): boolean {
	return (
		profile.imports.has(name) ||
		profile.wrappers.has(name) ||
		profile.functions.has(name) ||
		profile.containers.has(name) ||
		profile.types.has(name) ||
		profile.bindings.has(name)
	);
}

/** The declaration an export, `declare` or decorator wraps, or null. */
function wrapped(profile: Profile, node: SyntaxNode): SyntaxNode | null {
	if (!profile.wrappers.has(node.name)) return null;
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (isDeclaration(profile, child.name)) return child;
	}
	return null;
}

/** A class: its header, then the members shown under it. A class nested in a class is summarized, not expanded. */
function container(outliner: Outliner, outer: SyntaxNode, body: SyntaxNode): boolean {
	const { text, profile, lines, counts } = outliner;
	const head = capped(outliner, text.slice(outer.from, body.from).trimEnd());
	const start = lines.length;
	lines.push(profile.syntax.open(head));
	counts.declarations++;
	for (let member = body.firstChild; member; member = member.nextSibling) {
		if (profile.comments.has(member.name)) continue;
		if (!show(outliner, member, 1) && STRUCTURAL.test(member.name)) counts.statements++;
	}
	if (lines.length === start + 1) lines[start] = profile.syntax.empty(head);
	else if (profile.syntax.close !== null) lines.push(profile.syntax.close);
	return true;
}

/**
 * Show one statement or member. False when it is not something an outline shows. A
 * wrapper (export, decorator) is shown from its own start, so the keyword or the
 * decorator is part of the signature, and the declaration inside decides the shape.
 */
function show(outliner: Outliner, outer: SyntaxNode, depth: number): boolean {
	const { text, profile, lines, counts } = outliner;
	let node = outer;
	for (let inner = wrapped(profile, node); inner; inner = wrapped(profile, node)) node = inner;

	const group = depth > 0 ? 'members' : profile.imports.has(node.name) ? 'imports' : 'declarations';
	const emit = (shown: string): boolean => {
		lines.push(`${indentation(text, outer.from, depth)}${shown}`);
		counts[group]++;
		return true;
	};
	const asWritten = () => capped(outliner, text.slice(outer.from, outer.to).trimEnd());

	if (profile.imports.has(node.name) || profile.types.has(node.name)) return emit(asWritten());

	const bodyName = profile.functions.get(node.name);
	if (bodyName !== undefined) {
		const body = node.getChild(bodyName);
		return emit(body ? stub(outliner, outer, body) : asWritten());
	}

	const membersName = profile.containers.get(node.name);
	if (membersName !== undefined) {
		const body = node.getChild(membersName);
		if (!body) return emit(asWritten());
		return depth > 0 ? emit(stub(outliner, outer, body)) : container(outliner, outer, body);
	}

	// A wrapper that is still a wrapper holds no declaration: a re-export, or `export default <value>`.
	if (
		profile.bindings.has(node.name) ||
		profile.wrappers.has(node.name) ||
		isCommonJsExport(outliner, node)
	) {
		return emit(binding(outliner, outer, node));
	}
	return false;
}

type Outlined =
	| { ok: true; lines: string[]; counts: OutlineCounts }
	| { ok: false; reason: CodeStructureUnsupportedReason };

/** Parse one source and outline it. `text` carries no printed line numbers. */
async function outlineSource(
	language: CodeLanguage,
	text: string,
	limits: CodeStructureLimits
): Promise<Outlined> {
	const tree = await parseText(await loadParser(language), text);
	if (!tree) return { ok: false, reason: 'parse-error' };
	const problem = treeProblem(tree, limits.maxTreeNodes);
	if (problem) return { ok: false, reason: problem };
	const outliner: Outliner = {
		text,
		profile: PROFILES[LANGUAGES[language].grammar],
		maxEntryChars: limits.maxEntryChars,
		lines: [],
		counts: { imports: 0, declarations: 0, members: 0, bodies: 0, omittedLines: 0, statements: 0 },
	};
	for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
		if (outliner.profile.comments.has(node.name)) continue;
		if (!show(outliner, node, 0) && STRUCTURAL.test(node.name)) outliner.counts.statements++;
	}
	const { lines, counts } = outliner;
	if (counts.imports + counts.declarations === 0)
		return { ok: false, reason: 'nothing-to-outline' };
	return { ok: true, lines, counts };
}

// ---------------------------------------------------------------------------
// Building the previews
// ---------------------------------------------------------------------------

/** Names the source by the hash the finding carries, the way the read previews' markers do. */
function marker(language: CodeLanguage, read: ReadVersion, counts: OutlineCounts): string {
	return (
		`[maestro-preview code-structure language=${language} ` +
		`sha256=${read.hash.slice(0, MARKER_HASH_CHARS)} lines=${read.lines} ` +
		`bodies-omitted=${counts.bodies} statements-omitted=${counts.statements}]`
	);
}

/**
 * Reasons that only say a read could not be related to an earlier one. Its own text
 * passed every check, so it can be outlined.
 */
const RELATION_ONLY: ReadonlySet<ReadUnsupportedReason> = new Set([
	'partial-range',
	'reset-between',
	'other-context',
]);

/** The read of a finding whose text the analyzer accepted, or null. */
function acceptedRead(finding: ReadFinding): ReadVersion | null {
	if (finding.status === 'unsupported') {
		return RELATION_ONLY.has(finding.reason) ? finding.version : null;
	}
	return finding.read;
}

/**
 * Outline the source files of one analysis. Deterministic: the inputs are not
 * modified, and the same inputs give the same report however the event loop is
 * scheduled around the parse.
 *
 * Every accepted read gets exactly one entry, in the report's order: a preview, or
 * `unsupported` with the reason. A source is parsed once however many reads show it.
 */
export async function buildCodeStructurePreviews(
	input: CodeStructureInput
): Promise<CodeStructureReport> {
	const limits: CodeStructureLimits = { ...CODE_STRUCTURE_LIMITS, ...input.limits };
	const texts = new Map<number, string>();
	for (const event of input.events) if (event.status === 'read') texts.set(event.order, event.text);
	/** One outline per distinct text and language: the same file read twice is parsed once. */
	const outlines = new Map<string, Outlined>();
	let parsedSources = 0;
	let parsedChars = 0;
	let complete = input.report.complete;

	const evaluate = async (read: ReadVersion): Promise<CodeStructureEntry> => {
		const refuse = (reason: CodeStructureUnsupportedReason): CodeStructureEntry => ({
			status: 'unsupported',
			reason,
			read,
		});
		const language = codeLanguageOf(read.path);
		if (!language) return refuse('unsupported-language');
		if (read.offset !== null || read.limit !== null || (read.numbered?.startLine ?? 1) !== 1) {
			return refuse('partial-range');
		}
		if (read.chars > limits.maxSourceChars) return refuse('too-large');
		const sent = texts.get(read.order);
		if (sent === undefined) return refuse('source-missing');
		if (sent.length !== read.chars || contentHash(sent) !== read.hash) {
			return refuse('source-mismatch');
		}

		const key = `${language}:${read.hash}`;
		let result = outlines.get(key);
		if (!result) {
			if (parsedSources >= limits.maxSources || parsedChars + sent.length > limits.maxTotalChars) {
				complete = false;
				return refuse('over-budget');
			}
			parsedSources++;
			parsedChars += sent.length;
			result = await outlineSource(
				language,
				read.numbered ? withoutLineNumbers(sent) : sent,
				limits
			);
			outlines.set(key, result);
			// Many small sources never reach a slice boundary, so each parse gives the loop a turn too.
			await yieldToEventLoop();
		}
		if (!result.ok) return refuse(result.reason);

		const text = `${marker(language, read, result.counts)}\n${result.lines.join('\n')}`;
		// The compressor's own bar, markers included: an outline must be clearly smaller.
		if (text.length > sent.length * (1 - MIN_SAVING_RATIO)) return refuse('insufficient-reduction');
		const spec = LANGUAGES[language];
		return {
			status: 'preview',
			read,
			language,
			parser: { name: spec.package, dialect: spec.dialect },
			confidence: 'parsed-without-errors',
			delivery: input.deliveries?.get(read.order) ?? 'unproven',
			potential: potentialReduction(sent, text),
			outline: { ...result.counts },
			text,
		};
	};

	const previews: CodeStructureEntry[] = [];
	const counts: CodeStructureCounts = {
		examined: 0,
		outlined: 0,
		unsupported: 0,
		unsupportedByReason: {},
		potentialChars: 0,
		potentialTokens: 0,
	};
	for (const finding of input.report.findings) {
		const read = acceptedRead(finding);
		if (!read) continue;
		counts.examined++;
		const entry = await evaluate(read);
		previews.push(entry);
		if (entry.status === 'preview') {
			counts.outlined++;
			counts.potentialChars += entry.potential.reducibleChars;
			counts.potentialTokens += entry.potential.reducibleTokens;
		} else {
			counts.unsupported++;
			counts.unsupportedByReason[entry.reason] =
				(counts.unsupportedByReason[entry.reason] ?? 0) + 1;
		}
	}

	return {
		version: 1,
		mode: 'preview',
		note: CODE_STRUCTURE_NOTE,
		complete,
		limits,
		previews,
		counts,
	};
}
