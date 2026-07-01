import { describe, it, expect } from 'vitest';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import { remarkFrontmatterTable } from '../../../../renderer/utils/remarkFrontmatterTable';
import { remarkFileLinks } from '../../../../renderer/utils/remarkFileLinks';
import { remarkMentionChips } from '../../../../renderer/utils/remarkMentionChips';
import { remarkPromoteDisplayMath } from '../../../../shared/remarkPromoteDisplayMath';
import { buildMarkdownPlugins } from '../../../../renderer/components/Markdown/plugins';

// Helper: a tuple plugin is [plugin, options]; a bare plugin is the function.
function pluginFn(entry: unknown): unknown {
	return Array.isArray(entry) ? entry[0] : entry;
}

function pluginFns(list: unknown[] | undefined): unknown[] {
	return (list ?? []).map(pluginFn);
}

describe('buildMarkdownPlugins', () => {
	it('includes GFM + frontmatter + frontmatter-table by default', () => {
		const { remarkPlugins, rehypePlugins } = buildMarkdownPlugins();
		const fns = pluginFns(remarkPlugins as unknown[]);
		expect(fns).toContain(remarkGfm);
		expect(fns).toContain(remarkFrontmatter);
		expect(fns).toContain(remarkFrontmatterTable);
		// No optional plugins
		expect(fns).not.toContain(remarkBreaks);
		expect(fns).not.toContain(remarkMath);
		expect(fns).not.toContain(remarkFileLinks);
		// rehype empty -> undefined (react-markdown expects undefined, not [])
		expect(rehypePlugins).toBeUndefined();
	});

	it('omits frontmatter plugins when frontmatter: false', () => {
		const { remarkPlugins } = buildMarkdownPlugins({ frontmatter: false });
		const fns = pluginFns(remarkPlugins as unknown[]);
		expect(fns).toContain(remarkGfm);
		expect(fns).not.toContain(remarkFrontmatter);
		expect(fns).not.toContain(remarkFrontmatterTable);
	});

	it('adds remark-breaks only when chatLineBreaks is set', () => {
		expect(
			pluginFns(buildMarkdownPlugins({ chatLineBreaks: true }).remarkPlugins as unknown[])
		).toContain(remarkBreaks);
		expect(
			pluginFns(buildMarkdownPlugins({ chatLineBreaks: false }).remarkPlugins as unknown[])
		).not.toContain(remarkBreaks);
	});

	it('adds remark-math (single-dollar disabled) + promote + rehype-katex for chatMath', () => {
		const { remarkPlugins, rehypePlugins } = buildMarkdownPlugins({ chatMath: true });
		const remark = remarkPlugins as unknown[];
		const fns = pluginFns(remark);
		expect(fns).toContain(remarkMath);
		expect(fns).toContain(remarkPromoteDisplayMath);
		// remark-math configured with singleDollarTextMath: false
		const mathEntry = remark.find((e) => Array.isArray(e) && e[0] === remarkMath) as
			| [unknown, Record<string, unknown>]
			| undefined;
		expect(mathEntry?.[1]).toEqual({ singleDollarTextMath: false });
		// promote runs AFTER remark-math (order matters)
		expect(fns.indexOf(remarkPromoteDisplayMath)).toBeGreaterThan(fns.indexOf(remarkMath));
		expect(pluginFns(rehypePlugins as unknown[])).toContain(rehypeKatex);
	});

	it('adds rehype-raw only when allowRawHtml is set', () => {
		expect(
			pluginFns(buildMarkdownPlugins({ allowRawHtml: true }).rehypePlugins as unknown[])
		).toContain(rehypeRaw);
		expect(buildMarkdownPlugins({ allowRawHtml: false }).rehypePlugins).toBeUndefined();
	});

	describe('file links gating (mirrors chat renderer logic)', () => {
		it('adds remarkFileLinks when indices + cwd present', () => {
			const { remarkPlugins } = buildMarkdownPlugins({
				fileLinks: { indices: { allPaths: new Set(), filenameIndex: new Map() } as never, cwd: '' },
			});
			expect(pluginFns(remarkPlugins as unknown[])).toContain(remarkFileLinks);
		});

		it('adds remarkFileLinks when only projectRoot present (absolute paths)', () => {
			const { remarkPlugins } = buildMarkdownPlugins({
				fileLinks: { projectRoot: '/Users/me/proj' },
			});
			expect(pluginFns(remarkPlugins as unknown[])).toContain(remarkFileLinks);
		});

		it('adds remarkFileLinks when only homeDir present (tilde paths)', () => {
			const { remarkPlugins } = buildMarkdownPlugins({ fileLinks: { homeDir: '/Users/me' } });
			expect(pluginFns(remarkPlugins as unknown[])).toContain(remarkFileLinks);
		});

		it('does NOT add remarkFileLinks when nothing actionable is provided', () => {
			expect(
				pluginFns(buildMarkdownPlugins({ fileLinks: {} }).remarkPlugins as unknown[])
			).not.toContain(remarkFileLinks);
			expect(
				pluginFns(
					buildMarkdownPlugins({ fileLinks: { indices: null, cwd: '' } }).remarkPlugins as unknown[]
				)
			).not.toContain(remarkFileLinks);
			expect(pluginFns(buildMarkdownPlugins().remarkPlugins as unknown[])).not.toContain(
				remarkFileLinks
			);
		});
	});

	describe('mention chips gating', () => {
		it('is absent by default', () => {
			expect(pluginFns(buildMarkdownPlugins().remarkPlugins as unknown[])).not.toContain(
				remarkMentionChips
			);
		});

		it('adds remarkMentionChips when mentionChips is set', () => {
			expect(
				pluginFns(buildMarkdownPlugins({ mentionChips: true }).remarkPlugins as unknown[])
			).toContain(remarkMentionChips);
		});

		it('runs remarkMentionChips BEFORE remarkFileLinks (claims @paths first)', () => {
			const fns = pluginFns(
				buildMarkdownPlugins({
					mentionChips: true,
					fileLinks: { projectRoot: '/Users/me/proj' },
				}).remarkPlugins as unknown[]
			);
			expect(fns.indexOf(remarkMentionChips)).toBeGreaterThanOrEqual(0);
			expect(fns.indexOf(remarkMentionChips)).toBeLessThan(fns.indexOf(remarkFileLinks));
		});
	});

	it('appends extra remark/rehype plugins after the standard stack', () => {
		const extraRemark = () => {};
		const extraRehype = () => {};
		const { remarkPlugins, rehypePlugins } = buildMarkdownPlugins({
			allowRawHtml: true,
			extraRemarkPlugins: [extraRemark],
			extraRehypePlugins: [extraRehype],
		});
		const remarkFnsList = pluginFns(remarkPlugins as unknown[]);
		expect(remarkFnsList[remarkFnsList.length - 1]).toBe(extraRemark);
		const rehypeFnsList = pluginFns(rehypePlugins as unknown[]);
		expect(rehypeFnsList).toContain(extraRehype);
	});
});
