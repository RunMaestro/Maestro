/**
 * Lightweight jq-compatible filter engine for JSONL viewing.
 *
 * Supports: . .foo .foo.bar .[n] .[] | , select() contains() has()
 * keys length type map() test() startswith() endswith() sort_by()
 * group_by() unique to_entries not and or == != > < >= <=
 */

// ── Error ────────────────────────────────────────────────────────────────────

export class JqError extends Error {
	pos?: number;
	constructor(message: string, pos?: number) {
		super(pos !== undefined ? `${message} (at position ${pos})` : message);
		this.name = 'JqError';
		this.pos = pos;
	}
}

// ── Tokens ───────────────────────────────────────────────────────────────────

interface Token {
	type: string;
	value: string;
	pos: number;
}

const T = {
	DOT: 'DOT',
	PIPE: 'PIPE',
	COMMA: 'COMMA',
	SEMICOLON: 'SEMICOLON',
	LBRACKET: 'LBRACKET',
	RBRACKET: 'RBRACKET',
	LPAREN: 'LPAREN',
	RPAREN: 'RPAREN',
	QUESTION: 'QUESTION',
	EQ: 'EQ',
	NEQ: 'NEQ',
	GTE: 'GTE',
	LTE: 'LTE',
	GT: 'GT',
	LT: 'LT',
	PLUS: 'PLUS',
	MINUS: 'MINUS',
	STAR: 'STAR',
	SLASH: 'SLASH',
	PERCENT: 'PERCENT',
	NUMBER: 'NUMBER',
	STRING: 'STRING',
	IDENT: 'IDENT',
	EOF: 'EOF',
} as const;

// ── AST ──────────────────────────────────────────────────────────────────────

export type JqExpr =
	| { kind: 'identity' }
	| { kind: 'literal'; value: unknown }
	| { kind: 'field'; name: string }
	| { kind: 'iterate' }
	| { kind: 'subscript'; expr: JqExpr }
	| { kind: 'pipe'; left: JqExpr; right: JqExpr }
	| { kind: 'comma'; exprs: JqExpr[] }
	| { kind: 'compare'; op: string; left: JqExpr; right: JqExpr }
	| { kind: 'and'; left: JqExpr; right: JqExpr }
	| { kind: 'or'; left: JqExpr; right: JqExpr }
	| { kind: 'try'; expr: JqExpr }
	| { kind: 'func'; name: string; args: JqExpr[] };

// ── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;

	while (i < input.length) {
		if (/\s/.test(input[i])) {
			i++;
			continue;
		}

		const pos = i;
		const ch = input[i];

		// Two-character operators
		if (i + 1 < input.length) {
			const two = input.slice(i, i + 2);
			if (two === '==') {
				tokens.push({ type: T.EQ, value: '==', pos });
				i += 2;
				continue;
			}
			if (two === '!=') {
				tokens.push({ type: T.NEQ, value: '!=', pos });
				i += 2;
				continue;
			}
			if (two === '>=') {
				tokens.push({ type: T.GTE, value: '>=', pos });
				i += 2;
				continue;
			}
			if (two === '<=') {
				tokens.push({ type: T.LTE, value: '<=', pos });
				i += 2;
				continue;
			}
		}

		// Single-character tokens
		const SINGLES: Record<string, string> = {
			'.': T.DOT,
			'|': T.PIPE,
			',': T.COMMA,
			';': T.SEMICOLON,
			'[': T.LBRACKET,
			']': T.RBRACKET,
			'(': T.LPAREN,
			')': T.RPAREN,
			'?': T.QUESTION,
			'>': T.GT,
			'<': T.LT,
			'+': T.PLUS,
			'-': T.MINUS,
			'*': T.STAR,
			'/': T.SLASH,
			'%': T.PERCENT,
		};
		if (SINGLES[ch]) {
			tokens.push({ type: SINGLES[ch], value: ch, pos });
			i++;
			continue;
		}

		// Numbers
		if (/[0-9]/.test(ch)) {
			let num = '';
			while (i < input.length && /[0-9.]/.test(input[i])) {
				num += input[i++];
			}
			tokens.push({ type: T.NUMBER, value: num, pos });
			continue;
		}

		// Strings (double-quoted)
		if (ch === '"') {
			let str = '';
			i++;
			while (i < input.length && input[i] !== '"') {
				if (input[i] === '\\' && i + 1 < input.length) {
					const esc = input[i + 1];
					if (esc === 'n') str += '\n';
					else if (esc === 't') str += '\t';
					else if (esc === 'r') str += '\r';
					else str += esc;
					i += 2;
				} else {
					str += input[i++];
				}
			}
			if (i >= input.length) throw new JqError('Unterminated string', pos);
			i++; // closing quote
			tokens.push({ type: T.STRING, value: str, pos });
			continue;
		}

		// Identifiers / keywords
		if (/[a-zA-Z_]/.test(ch)) {
			let ident = '';
			while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) {
				ident += input[i++];
			}
			tokens.push({ type: T.IDENT, value: ident, pos });
			continue;
		}

		throw new JqError(`Unexpected character '${ch}'`, pos);
	}

	tokens.push({ type: T.EOF, value: '', pos: i });
	return tokens;
}

// ── Parser ───────────────────────────────────────────────────────────────────

class JqParser {
	private tokens: Token[];
	private pos = 0;

	constructor(tokens: Token[]) {
		this.tokens = tokens;
	}

	private peek(): Token {
		return this.tokens[this.pos];
	}

	private advance(): Token {
		return this.tokens[this.pos++];
	}

	private expect(type: string): Token {
		const token = this.peek();
		if (token.type !== type) {
			throw new JqError(`Expected ${type}, got '${token.value}'`, token.pos);
		}
		return this.advance();
	}

	private check(type: string): boolean {
		return this.peek().type === type;
	}

	private match(type: string): boolean {
		if (this.check(type)) {
			this.advance();
			return true;
		}
		return false;
	}

	parse(): JqExpr {
		const expr = this.parseExpression();
		if (!this.check(T.EOF)) {
			const t = this.peek();
			throw new JqError(`Unexpected token '${t.value}'`, t.pos);
		}
		return expr;
	}

	private parseExpression(): JqExpr {
		return this.parsePipe();
	}

	// pipe_expr = comma_expr ('|' comma_expr)*
	private parsePipe(): JqExpr {
		let left = this.parseComma();
		while (this.match(T.PIPE)) {
			const right = this.parseComma();
			left = { kind: 'pipe', left, right };
		}
		return left;
	}

	// comma_expr = or_expr (',' or_expr)*
	private parseComma(): JqExpr {
		const first = this.parseOr();
		if (!this.check(T.COMMA)) return first;
		const exprs = [first];
		while (this.match(T.COMMA)) {
			exprs.push(this.parseOr());
		}
		return { kind: 'comma', exprs };
	}

	// or_expr = and_expr ('or' and_expr)*
	private parseOr(): JqExpr {
		let left = this.parseAnd();
		while (this.check(T.IDENT) && this.peek().value === 'or') {
			this.advance();
			const right = this.parseAnd();
			left = { kind: 'or', left, right };
		}
		return left;
	}

	// and_expr = compare_expr ('and' compare_expr)*
	private parseAnd(): JqExpr {
		let left = this.parseCompare();
		while (this.check(T.IDENT) && this.peek().value === 'and') {
			this.advance();
			const right = this.parseCompare();
			left = { kind: 'and', left, right };
		}
		return left;
	}

	// compare_expr = postfix_expr (cmp_op postfix_expr)?
	private parseCompare(): JqExpr {
		const left = this.parsePostfix();
		const cmpOps = [T.EQ, T.NEQ, T.GT, T.LT, T.GTE, T.LTE];
		if (cmpOps.includes(this.peek().type as (typeof cmpOps)[number])) {
			const op = this.advance().value;
			const right = this.parsePostfix();
			return { kind: 'compare', op, left, right };
		}
		return left;
	}

	// postfix_expr = primary (suffix)*
	// suffix = .IDENT | .STRING | [] | [expr] | ?
	private parsePostfix(): JqExpr {
		let expr = this.parsePrimary();
		while (true) {
			if (this.check(T.DOT)) {
				const next = this.tokens[this.pos + 1];
				if (next && next.type === T.IDENT && !this.isKeyword(next.value)) {
					this.advance(); // dot
					expr = { kind: 'pipe', left: expr, right: { kind: 'field', name: this.advance().value } };
				} else if (next && next.type === T.STRING) {
					this.advance(); // dot
					expr = { kind: 'pipe', left: expr, right: { kind: 'field', name: this.advance().value } };
				} else if (next && next.type === T.LBRACKET) {
					this.advance(); // dot
					// bracket handled next iteration
				} else {
					break;
				}
			} else if (this.check(T.LBRACKET)) {
				this.advance();
				if (this.match(T.RBRACKET)) {
					expr = { kind: 'pipe', left: expr, right: { kind: 'iterate' } };
				} else {
					// Handle negative index: [- NUMBER]
					let negate = false;
					if (this.check(T.MINUS)) {
						negate = true;
						this.advance();
					}
					const inner = this.parseExpression();
					this.expect(T.RBRACKET);
					if (negate && inner.kind === 'literal' && typeof inner.value === 'number') {
						expr = {
							kind: 'pipe',
							left: expr,
							right: { kind: 'subscript', expr: { kind: 'literal', value: -inner.value } },
						};
					} else if (negate) {
						// Wrap in subtraction: 0 - inner
						expr = {
							kind: 'pipe',
							left: expr,
							right: {
								kind: 'subscript',
								expr: {
									kind: 'compare',
									op: '-',
									left: { kind: 'literal', value: 0 },
									right: inner,
								},
							},
						};
					} else {
						expr = { kind: 'pipe', left: expr, right: { kind: 'subscript', expr: inner } };
					}
				}
			} else if (this.check(T.QUESTION)) {
				this.advance();
				expr = { kind: 'try', expr };
			} else {
				break;
			}
		}
		return expr;
	}

	private isKeyword(name: string): boolean {
		return ['and', 'or', 'not', 'true', 'false', 'null'].includes(name);
	}

	// primary = '.' IDENT? | literal | func | '(' expression ')'
	private parsePrimary(): JqExpr {
		const t = this.peek();

		// Dot expression
		if (t.type === T.DOT) {
			this.advance();
			const next = this.peek();
			if (next.type === T.IDENT && !this.isKeyword(next.value)) {
				return { kind: 'field', name: this.advance().value };
			}
			if (next.type === T.STRING) {
				return { kind: 'field', name: this.advance().value };
			}
			return { kind: 'identity' };
		}

		// String literal
		if (t.type === T.STRING) {
			return { kind: 'literal', value: this.advance().value };
		}

		// Number literal
		if (t.type === T.NUMBER) {
			const v = this.advance().value;
			return { kind: 'literal', value: v.includes('.') ? parseFloat(v) : parseInt(v, 10) };
		}

		// Negative number
		if (t.type === T.MINUS && this.tokens[this.pos + 1]?.type === T.NUMBER) {
			this.advance();
			const v = this.advance().value;
			return { kind: 'literal', value: v.includes('.') ? -parseFloat(v) : -parseInt(v, 10) };
		}

		// Grouped expression
		if (t.type === T.LPAREN) {
			this.advance();
			const expr = this.parseExpression();
			this.expect(T.RPAREN);
			return expr;
		}

		// Identifier: keyword or function
		if (t.type === T.IDENT) {
			const name = this.advance().value;

			if (name === 'true') return { kind: 'literal', value: true };
			if (name === 'false') return { kind: 'literal', value: false };
			if (name === 'null') return { kind: 'literal', value: null };
			if (name === 'not') return { kind: 'func', name: 'not', args: [] };

			// Function with args
			if (this.check(T.LPAREN)) {
				this.advance();
				const args: JqExpr[] = [];
				if (!this.check(T.RPAREN)) {
					args.push(this.parseExpression());
					while (this.match(T.SEMICOLON)) {
						args.push(this.parseExpression());
					}
				}
				this.expect(T.RPAREN);
				return { kind: 'func', name, args };
			}

			// 0-arg function
			return { kind: 'func', name, args: [] };
		}

		throw new JqError(`Unexpected '${t.value || t.type}'`, t.pos);
	}
}

// ── Evaluator ────────────────────────────────────────────────────────────────

function isTruthy(v: unknown): boolean {
	return v !== false && v !== null && v !== undefined;
}

function jqCompare(op: string, a: unknown, b: unknown): boolean {
	switch (op) {
		case '==':
			return JSON.stringify(a) === JSON.stringify(b);
		case '!=':
			return JSON.stringify(a) !== JSON.stringify(b);
		case '>':
			return (a as number) > (b as number);
		case '<':
			return (a as number) < (b as number);
		case '>=':
			return (a as number) >= (b as number);
		case '<=':
			return (a as number) <= (b as number);
		default:
			return false;
	}
}

function evaluate(expr: JqExpr, input: unknown): unknown[] {
	switch (expr.kind) {
		case 'identity':
			return [input];

		case 'literal':
			return [expr.value];

		case 'field': {
			if (input === null || input === undefined) return [null];
			if (typeof input !== 'object') return [null];
			return [(input as Record<string, unknown>)[expr.name] ?? null];
		}

		case 'iterate': {
			if (Array.isArray(input)) return input;
			if (input !== null && typeof input === 'object') return Object.values(input);
			return [];
		}

		case 'subscript': {
			const indices = evaluate(expr.expr, input);
			return indices.flatMap((idx) => {
				if (typeof idx === 'number') {
					if (Array.isArray(input)) {
						const i = idx < 0 ? input.length + idx : idx;
						return i >= 0 && i < input.length ? [input[i]] : [null];
					}
					return [null];
				}
				if (typeof idx === 'string') {
					if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
						return [(input as Record<string, unknown>)[idx] ?? null];
					}
					return [null];
				}
				return [null];
			});
		}

		case 'pipe': {
			const leftResults = evaluate(expr.left, input);
			return leftResults.flatMap((r) => evaluate(expr.right, r));
		}

		case 'comma':
			return expr.exprs.flatMap((e) => evaluate(e, input));

		case 'compare': {
			const leftVals = evaluate(expr.left, input);
			const rightVals = evaluate(expr.right, input);
			if (leftVals.length === 0 || rightVals.length === 0) return [];
			return [jqCompare(expr.op, leftVals[0], rightVals[0])];
		}

		case 'and': {
			const lv = evaluate(expr.left, input);
			const rv = evaluate(expr.right, input);
			return [isTruthy(lv[0]) && isTruthy(rv[0])];
		}

		case 'or': {
			const lv = evaluate(expr.left, input);
			const rv = evaluate(expr.right, input);
			return [isTruthy(lv[0]) || isTruthy(rv[0])];
		}

		case 'try': {
			try {
				return evaluate(expr.expr, input);
			} catch {
				return [];
			}
		}

		case 'func':
			return evaluateFunc(expr.name, expr.args, input);
	}
}

// ── Built-in Functions ───────────────────────────────────────────────────────

const KNOWN_FUNCTIONS = new Set([
	'select',
	'keys',
	'values',
	'length',
	'type',
	'not',
	'empty',
	'has',
	'contains',
	'startswith',
	'endswith',
	'test',
	'map',
	'sort',
	'sort_by',
	'group_by',
	'unique',
	'unique_by',
	'flatten',
	'reverse',
	'add',
	'min',
	'max',
	'min_by',
	'max_by',
	'first',
	'last',
	'any',
	'all',
	'to_entries',
	'from_entries',
	'with_entries',
	'del',
	'ascii_downcase',
	'ascii_upcase',
	'ltrimstr',
	'rtrimstr',
	'split',
	'join',
	'tonumber',
	'tostring',
]);

function evaluateFunc(name: string, args: JqExpr[], input: unknown): unknown[] {
	switch (name) {
		case 'select': {
			if (args.length !== 1) throw new JqError('select() requires 1 argument');
			const cond = evaluate(args[0], input);
			return isTruthy(cond[0]) ? [input] : [];
		}

		case 'keys': {
			if (Array.isArray(input)) return [input.map((_, i) => i)];
			if (input !== null && typeof input === 'object') return [Object.keys(input).sort()];
			throw new JqError('keys requires an object or array');
		}

		case 'values': {
			if (Array.isArray(input)) return [input];
			if (input !== null && typeof input === 'object') return [Object.values(input)];
			throw new JqError('values requires an object or array');
		}

		case 'length': {
			if (typeof input === 'string') return [input.length];
			if (Array.isArray(input)) return [input.length];
			if (input !== null && typeof input === 'object') return [Object.keys(input).length];
			if (input === null) return [0];
			throw new JqError('length requires a string, array, or object');
		}

		case 'type': {
			if (input === null) return ['null'];
			if (Array.isArray(input)) return ['array'];
			return [typeof input];
		}

		case 'not':
			return [!isTruthy(input)];

		case 'empty':
			return [];

		case 'has': {
			if (args.length !== 1) throw new JqError('has() requires 1 argument');
			const keyVals = evaluate(args[0], input);
			const key = keyVals[0];
			if (
				typeof key === 'string' &&
				input !== null &&
				typeof input === 'object' &&
				!Array.isArray(input)
			) {
				return [Object.prototype.hasOwnProperty.call(input, key)];
			}
			if (typeof key === 'number' && Array.isArray(input)) {
				return [key >= 0 && key < input.length];
			}
			return [false];
		}

		case 'contains': {
			if (args.length !== 1) throw new JqError('contains() requires 1 argument');
			const searchVals = evaluate(args[0], input);
			const search = searchVals[0];
			if (typeof input === 'string' && typeof search === 'string') {
				return [input.toLowerCase().includes(search.toLowerCase())];
			}
			if (Array.isArray(input)) {
				if (typeof search === 'string') {
					return [
						input.some(
							(item) =>
								typeof item === 'string' && item.toLowerCase().includes(search.toLowerCase())
						),
					];
				}
				return [input.includes(search)];
			}
			return [false];
		}

		case 'startswith': {
			if (args.length !== 1) throw new JqError('startswith() requires 1 argument');
			const prefixVals = evaluate(args[0], input);
			if (typeof input === 'string' && typeof prefixVals[0] === 'string') {
				return [input.startsWith(prefixVals[0])];
			}
			return [false];
		}

		case 'endswith': {
			if (args.length !== 1) throw new JqError('endswith() requires 1 argument');
			const suffixVals = evaluate(args[0], input);
			if (typeof input === 'string' && typeof suffixVals[0] === 'string') {
				return [input.endsWith(suffixVals[0])];
			}
			return [false];
		}

		case 'test': {
			if (args.length !== 1) throw new JqError('test() requires 1 argument');
			const patternVals = evaluate(args[0], input);
			if (typeof input === 'string' && typeof patternVals[0] === 'string') {
				try {
					return [new RegExp(patternVals[0]).test(input)];
				} catch {
					throw new JqError(`Invalid regex: ${patternVals[0]}`);
				}
			}
			return [false];
		}

		case 'map': {
			if (args.length !== 1) throw new JqError('map() requires 1 argument');
			if (!Array.isArray(input)) throw new JqError('map requires an array');
			return [input.flatMap((item) => evaluate(args[0], item))];
		}

		case 'sort': {
			if (!Array.isArray(input)) throw new JqError('sort requires an array');
			return [
				[...input].sort((a, b) => {
					if (typeof a === 'number' && typeof b === 'number') return a - b;
					return String(a).localeCompare(String(b));
				}),
			];
		}

		case 'sort_by': {
			if (args.length !== 1) throw new JqError('sort_by() requires 1 argument');
			if (!Array.isArray(input)) throw new JqError('sort_by requires an array');
			return [
				[...input].sort((a, b) => {
					const ak = evaluate(args[0], a)[0];
					const bk = evaluate(args[0], b)[0];
					if (typeof ak === 'number' && typeof bk === 'number') return ak - bk;
					return String(ak ?? '').localeCompare(String(bk ?? ''));
				}),
			];
		}

		case 'group_by': {
			if (args.length !== 1) throw new JqError('group_by() requires 1 argument');
			if (!Array.isArray(input)) throw new JqError('group_by requires an array');
			const groups = new Map<string, unknown[]>();
			for (const item of input) {
				const key = JSON.stringify(evaluate(args[0], item)[0]);
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key)!.push(item);
			}
			return [Array.from(groups.values())];
		}

		case 'unique': {
			if (!Array.isArray(input)) throw new JqError('unique requires an array');
			const seen = new Set<string>();
			return [
				input.filter((item) => {
					const key = JSON.stringify(item);
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				}),
			];
		}

		case 'unique_by': {
			if (args.length !== 1) throw new JqError('unique_by() requires 1 argument');
			if (!Array.isArray(input)) throw new JqError('unique_by requires an array');
			const seenBy = new Set<string>();
			return [
				input.filter((item) => {
					const key = JSON.stringify(evaluate(args[0], item)[0]);
					if (seenBy.has(key)) return false;
					seenBy.add(key);
					return true;
				}),
			];
		}

		case 'flatten': {
			if (!Array.isArray(input)) throw new JqError('flatten requires an array');
			const depth = args.length > 0 ? (evaluate(args[0], input)[0] as number) : Infinity;
			return [input.flat(depth)];
		}

		case 'reverse': {
			if (Array.isArray(input)) return [[...input].reverse()];
			if (typeof input === 'string') return [input.split('').reverse().join('')];
			throw new JqError('reverse requires an array or string');
		}

		case 'add': {
			if (!Array.isArray(input)) throw new JqError('add requires an array');
			if (input.length === 0) return [null];
			if (typeof input[0] === 'number')
				return [input.reduce((a, b) => (a as number) + (b as number), 0)];
			if (typeof input[0] === 'string') return [input.join('')];
			if (Array.isArray(input[0])) return [input.flat()];
			return [null];
		}

		case 'min': {
			if (!Array.isArray(input) || input.length === 0) return [null];
			return [input.reduce((m, v) => ((v as number) < (m as number) ? v : m))];
		}

		case 'max': {
			if (!Array.isArray(input) || input.length === 0) return [null];
			return [input.reduce((m, v) => ((v as number) > (m as number) ? v : m))];
		}

		case 'min_by': {
			if (args.length !== 1) throw new JqError('min_by() requires 1 argument');
			if (!Array.isArray(input) || input.length === 0) return [null];
			return [
				input.reduce((m, item) => {
					const mk = evaluate(args[0], m)[0];
					const ik = evaluate(args[0], item)[0];
					return (ik as number) < (mk as number) ? item : m;
				}),
			];
		}

		case 'max_by': {
			if (args.length !== 1) throw new JqError('max_by() requires 1 argument');
			if (!Array.isArray(input) || input.length === 0) return [null];
			return [
				input.reduce((m, item) => {
					const mk = evaluate(args[0], m)[0];
					const ik = evaluate(args[0], item)[0];
					return (ik as number) > (mk as number) ? item : m;
				}),
			];
		}

		case 'first': {
			if (args.length === 1) {
				const results = evaluate(args[0], input);
				return results.length > 0 ? [results[0]] : [];
			}
			if (Array.isArray(input) && input.length > 0) return [input[0]];
			return [null];
		}

		case 'last': {
			if (args.length === 1) {
				const results = evaluate(args[0], input);
				return results.length > 0 ? [results[results.length - 1]] : [];
			}
			if (Array.isArray(input) && input.length > 0) return [input[input.length - 1]];
			return [null];
		}

		case 'any': {
			if (!Array.isArray(input)) return [false];
			if (args.length === 1) {
				return [input.some((item) => isTruthy(evaluate(args[0], item)[0]))];
			}
			return [input.some(isTruthy)];
		}

		case 'all': {
			if (!Array.isArray(input)) return [false];
			if (args.length === 1) {
				return [input.every((item) => isTruthy(evaluate(args[0], item)[0]))];
			}
			return [input.every(isTruthy)];
		}

		case 'to_entries': {
			if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
				return [
					Object.entries(input as Record<string, unknown>).map(([key, value]) => ({ key, value })),
				];
			}
			throw new JqError('to_entries requires an object');
		}

		case 'from_entries': {
			if (!Array.isArray(input)) throw new JqError('from_entries requires an array');
			const obj: Record<string, unknown> = {};
			for (const entry of input) {
				if (entry && typeof entry === 'object' && 'key' in entry && 'value' in entry) {
					obj[String((entry as { key: unknown }).key)] = (entry as { value: unknown }).value;
				}
			}
			return [obj];
		}

		case 'with_entries': {
			if (args.length !== 1) throw new JqError('with_entries() requires 1 argument');
			if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
				const entries = Object.entries(input as Record<string, unknown>).map(([key, value]) => ({
					key,
					value,
				}));
				const transformed = entries.flatMap((entry) => evaluate(args[0], entry));
				const result: Record<string, unknown> = {};
				for (const entry of transformed) {
					if (entry && typeof entry === 'object' && 'key' in entry && 'value' in entry) {
						result[String((entry as { key: unknown }).key)] = (entry as { value: unknown }).value;
					}
				}
				return [result];
			}
			throw new JqError('with_entries requires an object');
		}

		case 'del': {
			if (args.length !== 1) throw new JqError('del() requires 1 argument');
			if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
				const copy = { ...(input as Record<string, unknown>) };
				if (args[0].kind === 'field') {
					delete copy[args[0].name];
					return [copy];
				}
			}
			return [input];
		}

		case 'ascii_downcase':
			if (typeof input === 'string') return [input.toLowerCase()];
			throw new JqError('ascii_downcase requires a string');

		case 'ascii_upcase':
			if (typeof input === 'string') return [input.toUpperCase()];
			throw new JqError('ascii_upcase requires a string');

		case 'ltrimstr': {
			if (args.length !== 1) throw new JqError('ltrimstr() requires 1 argument');
			const pVals = evaluate(args[0], input);
			if (typeof input === 'string' && typeof pVals[0] === 'string' && input.startsWith(pVals[0])) {
				return [input.slice(pVals[0].length)];
			}
			return [input];
		}

		case 'rtrimstr': {
			if (args.length !== 1) throw new JqError('rtrimstr() requires 1 argument');
			const sVals = evaluate(args[0], input);
			if (typeof input === 'string' && typeof sVals[0] === 'string' && input.endsWith(sVals[0])) {
				return [input.slice(0, -sVals[0].length)];
			}
			return [input];
		}

		case 'split': {
			if (args.length !== 1) throw new JqError('split() requires 1 argument');
			const delimVals = evaluate(args[0], input);
			if (typeof input === 'string' && typeof delimVals[0] === 'string') {
				return [input.split(delimVals[0])];
			}
			throw new JqError('split requires a string');
		}

		case 'join': {
			if (args.length !== 1) throw new JqError('join() requires 1 argument');
			const sepVals = evaluate(args[0], input);
			if (Array.isArray(input) && typeof sepVals[0] === 'string') {
				return [input.map(String).join(sepVals[0])];
			}
			throw new JqError('join requires an array');
		}

		case 'tonumber': {
			if (typeof input === 'number') return [input];
			if (typeof input === 'string') {
				const n = parseFloat(input);
				if (isNaN(n)) throw new JqError(`Cannot convert "${input}" to number`);
				return [n];
			}
			throw new JqError('tonumber requires a string or number');
		}

		case 'tostring': {
			if (typeof input === 'string') return [input];
			return [JSON.stringify(input)];
		}

		default:
			if (!KNOWN_FUNCTIONS.has(name)) {
				throw new JqError(`Unknown function '${name}'`);
			}
			return [null];
	}
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface JqFilterResult {
	results: unknown[];
	error?: string;
}

export function parseJq(expression: string): JqExpr {
	const tokens = tokenize(expression);
	return new JqParser(tokens).parse();
}

export function evaluateJq(expr: JqExpr, data: unknown): unknown[] {
	return evaluate(expr, data);
}

export function applyJqFilter(expression: string, data: unknown): JqFilterResult {
	try {
		const expr = parseJq(expression);
		return { results: evaluate(expr, data) };
	} catch (e) {
		return { results: [], error: e instanceof Error ? e.message : String(e) };
	}
}

export { KNOWN_FUNCTIONS };
