/**
 * Loading Maestro's prompts without a desktop: customization, `{{REF:}}`, `{{INCLUDE:}}`.
 * The desktop's prompt manager and the CLI loader call the same directive rules.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	bundledPromptCandidates,
	createPromptLoader,
	findBundledPromptsDir,
	resolvePromptDirectives,
} from '../../../../shared/maestro-lib/prompts/load';
import { CORE_PROMPTS } from '../../../../shared/promptDefinitions';

let dir: string;
let bundled: string;
let customizations: string;

function bundle(name: string, content: string) {
	fs.writeFileSync(path.join(bundled, `${name}.md`), content);
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-prompts-'));
	bundled = path.join(dir, 'bundled');
	fs.mkdirSync(bundled);
	customizations = path.join(dir, 'core-prompts-customizations.json');
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolvePromptDirectives', () => {
	const host = (prompts: Record<string, string>, warnings: string[] = []) => ({
		bundledPromptsDir: '/bundled',
		readPrompt: (name: string) => prompts[name] ?? null,
		warn: (message: string) => warnings.push(message),
	});

	it('expands a REF to the absolute path of the bundled file', () => {
		const target = CORE_PROMPTS[0];
		const out = resolvePromptDirectives('p', `see {{REF:${target.id}}} now`, host({}));
		expect(out).toBe(`see ${path.resolve('/bundled', target.filename)} now`);
	});

	it('leaves a REF to an unknown prompt in place and says so', () => {
		const warnings: string[] = [];
		const out = resolvePromptDirectives('p', '{{REF:no-such-prompt}}', host({}, warnings));
		expect(out).toBe('{{REF:no-such-prompt}}');
		expect(warnings[0]).toContain('no-such-prompt');
	});

	it('inlines an include', () => {
		expect(resolvePromptDirectives('p', 'a {{INCLUDE:b}} c', host({ b: 'BEE' }))).toBe('a BEE c');
	});

	it('inlines includes recursively', () => {
		const out = resolvePromptDirectives(
			'p',
			'{{INCLUDE:b}}',
			host({ b: 'b+{{INCLUDE:c}}', c: 'c' })
		);
		expect(out).toBe('b+c');
	});

	it('stops a cycle and leaves the directive', () => {
		const warnings: string[] = [];
		const out = resolvePromptDirectives(
			'p',
			'{{INCLUDE:b}}',
			host({ b: 'b{{INCLUDE:c}}', c: 'c{{INCLUDE:b}}' }, warnings)
		);
		expect(out).toBe('bc{{INCLUDE:b}}');
		expect(warnings.some((w) => w.includes('Circular'))).toBe(true);
	});

	it('does not let a prompt include itself', () => {
		const out = resolvePromptDirectives('p', 'x{{INCLUDE:p}}', host({ p: 'x{{INCLUDE:p}}' }));
		expect(out).toBe('x{{INCLUDE:p}}');
	});

	it('stops at depth 3', () => {
		const prompts = {
			a: '{{INCLUDE:b}}',
			b: '{{INCLUDE:c}}',
			c: '{{INCLUDE:d}}',
			d: 'deep',
		};
		expect(resolvePromptDirectives('p', '{{INCLUDE:a}}', host(prompts))).toBe('{{INCLUDE:d}}');
	});

	it('leaves a missing include in place and says so', () => {
		const warnings: string[] = [];
		const out = resolvePromptDirectives('p', '{{INCLUDE:gone}}', host({}, warnings));
		expect(out).toBe('{{INCLUDE:gone}}');
		expect(warnings[0]).toContain('gone');
	});

	it('resolves refs on the top-level text only: an included block keeps its refs', () => {
		const target = CORE_PROMPTS[0];
		const out = resolvePromptDirectives(
			'p',
			'{{INCLUDE:b}}',
			host({ b: `ref {{REF:${target.id}}}` })
		);
		expect(out).toBe(`ref {{REF:${target.id}}}`);
	});
});

describe('createPromptLoader', () => {
	function loader() {
		return createPromptLoader({ bundledPromptsDir: bundled, customizationsFile: customizations });
	}

	it('reads the bundled file', () => {
		bundle('maestro-system-prompt', 'bundled text');
		expect(loader().get('maestro-system-prompt')).toBe('bundled text');
	});

	it('returns undefined for a prompt that does not exist anywhere', () => {
		expect(loader().get('maestro-system-prompt')).toBeUndefined();
	});

	it('prefers a customization the user marked modified', () => {
		bundle('maestro-system-prompt', 'bundled text');
		fs.writeFileSync(
			customizations,
			JSON.stringify({
				prompts: { 'maestro-system-prompt': { content: 'my text', isModified: true } },
			})
		);
		expect(loader().get('maestro-system-prompt')).toBe('my text');
	});

	it('ignores a stored prompt that is not marked modified', () => {
		bundle('maestro-system-prompt', 'bundled text');
		fs.writeFileSync(
			customizations,
			JSON.stringify({
				prompts: { 'maestro-system-prompt': { content: 'stale', isModified: false } },
			})
		);
		expect(loader().get('maestro-system-prompt')).toBe('bundled text');
	});

	it('re-reads customizations on every get, so a desktop edit applies to the next turn', () => {
		bundle('maestro-system-prompt', 'bundled text');
		const l = loader();
		expect(l.get('maestro-system-prompt')).toBe('bundled text');
		fs.writeFileSync(
			customizations,
			JSON.stringify({
				prompts: { 'maestro-system-prompt': { content: 'edited later', isModified: true } },
			})
		);
		expect(l.get('maestro-system-prompt')).toBe('edited later');
	});

	it('falls back to the bundled file when the customizations file is not JSON', () => {
		bundle('maestro-system-prompt', 'bundled text');
		fs.writeFileSync(customizations, '{ not json');
		expect(loader().get('maestro-system-prompt')).toBe('bundled text');
	});

	it('includes another prompt, customization-aware', () => {
		bundle('maestro-system-prompt', 'top {{INCLUDE:file-access-rules}}');
		bundle('file-access-rules', 'bundled rules');
		fs.writeFileSync(
			customizations,
			JSON.stringify({
				prompts: { 'file-access-rules': { content: 'edited rules', isModified: true } },
			})
		);
		expect(loader().get('maestro-system-prompt')).toBe('top edited rules');
	});

	it('expands a REF to the bundled directory it was given', () => {
		const target = CORE_PROMPTS[0];
		bundle('maestro-system-prompt', `read {{REF:${target.id}}}`);
		expect(loader().get('maestro-system-prompt')).toBe(
			`read ${path.resolve(bundled, target.filename)}`
		);
	});
});

describe('bundledPromptCandidates', () => {
	it('probes the checkout at both bundle depths, then the packaged and standalone locations', () => {
		const moduleDirectory = path.join('/repo', 'dist', 'cli');
		const candidates = bundledPromptCandidates('x.md', moduleDirectory);
		expect(candidates).toContain(path.join('/repo', 'src', 'prompts', 'x.md'));
		expect(candidates).toContain(path.join(moduleDirectory, '..', 'prompts', 'core', 'x.md'));
		expect(new Set(candidates).size).toBe(candidates.length);
	});
});

describe('findBundledPromptsDir', () => {
	it('finds the checkout prompts from a module two levels below the root', () => {
		// This test file lives under src/__tests__; the repo root is four directories up.
		const root = path.resolve(__dirname, '..', '..', '..', '..', '..');
		const found = findBundledPromptsDir(path.join(root, 'dist', 'cli'));
		expect(found).toBe(path.join(root, 'src', 'prompts'));
	});

	it('returns undefined when no candidate exists', () => {
		expect(findBundledPromptsDir(path.join(dir, 'nowhere', 'a', 'b'))).toBeUndefined();
	});
});
