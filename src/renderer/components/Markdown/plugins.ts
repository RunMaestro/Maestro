/**
 * buildMarkdownPlugins - single source of truth for the remark/rehype plugin
 * stack used by every react-markdown rendering surface.
 *
 * Previously each surface (MarkdownRenderer, AutoRun via useAutoRunMarkdown,
 * FilePreview rich tier) assembled its own `useMemo` plugin arrays, which drifted
 * apart over time. This helper centralizes the selection logic so the chat and
 * document paths agree on plugin ordering and gating.
 *
 * Note on ordering: plugin order is preserved exactly as the chat renderer had it
 * (GFM -> frontmatter -> frontmatter table -> breaks -> math/promote -> file links),
 * because remark applies transforms in order and some depend on earlier output
 * (remarkFrontmatterTable requires remarkFrontmatter; remarkPromoteDisplayMath
 * requires remarkMath).
 */

import type { PluggableList } from 'unified';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { svgSanitizeSchema } from './sanitizeSchema';
import { remarkAlert } from './remarkAlert';
import { REMARK_GFM_PLUGINS } from '../../../shared/markdownPlugins';
import { remarkFrontmatterTable } from '../../utils/remarkFrontmatterTable';
import { remarkFileLinks, type buildFileTreeIndices } from '../../utils/remarkFileLinks';
import { remarkPromoteDisplayMath } from '../../../shared/remarkPromoteDisplayMath';

/** Prebuilt file-tree lookup indices (caller memoizes; we do not rebuild here). */
type FileTreeIndices = ReturnType<typeof buildFileTreeIndices>;

export interface MarkdownFileLinkOptions {
	/** Prebuilt file-tree indices for relative-path matching (or null/undefined). */
	indices?: FileTreeIndices | null;
	/** Current working directory for proximity-based relative matching. */
	cwd?: string;
	/** Project root absolute path - converts absolute paths to relative. */
	projectRoot?: string;
	/** Home directory for tilde (`~/...`) expansion. */
	homeDir?: string;
}

export interface BuildMarkdownPluginsOptions {
	/** Parse YAML frontmatter and render it as a table. Default true. */
	frontmatter?: boolean;
	/** Treat single newlines as hard `<br>` line breaks (chat surfaces, #622). */
	chatLineBreaks?: boolean;
	/** Render `$...$` / `$$...$$` as KaTeX math (chat surfaces, #622). */
	chatMath?: boolean;
	/** Allow raw HTML passthrough via rehype-raw (sanitize upstream). */
	allowRawHtml?: boolean;
	/** Transform GitHub `[!NOTE]`-style blockquotes into styled callouts. Default true. */
	alerts?: boolean;
	/** When provided and active, adds the remarkFileLinks transform. */
	fileLinks?: MarkdownFileLinkOptions;
	/** Extra remark plugins appended after the standard stack (e.g. FilePreview's remarkHighlight). */
	extraRemarkPlugins?: PluggableList;
	/** Extra rehype plugins appended after the standard stack (e.g. rehype-slug). */
	extraRehypePlugins?: PluggableList;
}

export interface MarkdownPluginLists {
	remarkPlugins: PluggableList;
	/** `undefined` (not `[]`) when empty, matching react-markdown's expectation. */
	rehypePlugins: PluggableList | undefined;
}

/**
 * Mirror of the chat renderer's gate: link references when we have a populated
 * file tree + cwd (relative paths), OR a projectRoot (absolute paths), OR a
 * homeDir (tilde paths) - even with an empty tree.
 */
function shouldAddFileLinks(fileLinks?: MarkdownFileLinkOptions): boolean {
	if (!fileLinks) return false;
	const { indices, cwd, projectRoot, homeDir } = fileLinks;
	return Boolean((indices && cwd !== undefined) || projectRoot || homeDir);
}

export function buildMarkdownPlugins(
	options: BuildMarkdownPluginsOptions = {}
): MarkdownPluginLists {
	const {
		frontmatter = true,
		chatLineBreaks = false,
		chatMath = false,
		allowRawHtml = false,
		alerts = true,
		fileLinks,
		extraRemarkPlugins,
		extraRehypePlugins,
	} = options;

	const remarkPlugins: PluggableList = [...REMARK_GFM_PLUGINS];

	// GitHub alert callouts run right after GFM (before remark-breaks) so the
	// `[!TYPE]` marker and its body are still in a single text node, which is the
	// shape remarkAlert's matcher expects.
	if (alerts) {
		remarkPlugins.push(remarkAlert);
	}

	if (frontmatter) {
		remarkPlugins.push(remarkFrontmatter, remarkFrontmatterTable);
	}

	// Chat surfaces need single-newline-as-<br> semantics (#622); file/doc preview
	// keeps default CommonMark behavior so paragraph reflow works.
	if (chatLineBreaks) {
		remarkPlugins.push(remarkBreaks);
	}

	// `singleDollarTextMath: false` disables single-dollar inline math so chat
	// content with currency (`$5`), shell variables (`$HOME`), or code snippets
	// isn't reinterpreted as broken math. remarkPromoteDisplayMath runs after
	// remarkMath so a single-line `$$x+y$$` gets the centered block treatment.
	if (chatMath) {
		remarkPlugins.push([remarkMath, { singleDollarTextMath: false }]);
		remarkPlugins.push(remarkPromoteDisplayMath);
	}

	if (shouldAddFileLinks(fileLinks)) {
		remarkPlugins.push([
			remarkFileLinks,
			{
				indices: fileLinks!.indices || undefined,
				cwd: fileLinks!.cwd || '',
				projectRoot: fileLinks!.projectRoot,
				homeDir: fileLinks!.homeDir,
			},
		]);
	}

	if (extraRemarkPlugins) {
		remarkPlugins.push(...extraRemarkPlugins);
	}

	// rehype-raw parses raw HTML into HAST; rehype-sanitize then strips XSS
	// vectors while permitting inline SVG (see svgSanitizeSchema). Order is
	// load-bearing: raw must run first so sanitize inspects real elements, and
	// sanitizing here (post-parse) avoids the raw-string DOMPurify pass that used
	// to corrupt code fences and `<`/`>` operators in ordinary chat text.
	const rehypePlugins: PluggableList = [];
	if (allowRawHtml) {
		rehypePlugins.push(rehypeRaw);
		rehypePlugins.push([rehypeSanitize, svgSanitizeSchema]);
	}
	if (chatMath) rehypePlugins.push(rehypeKatex);
	if (extraRehypePlugins) rehypePlugins.push(...extraRehypePlugins);

	return {
		remarkPlugins,
		rehypePlugins: rehypePlugins.length > 0 ? rehypePlugins : undefined,
	};
}
