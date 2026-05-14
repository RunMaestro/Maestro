import remarkGfm from 'remark-gfm';

/**
 * Canonical remark plugin stack for GitHub Flavored Markdown.
 * Keep this shared between renderer and web/mobile render paths.
 */
export const REMARK_GFM_PLUGINS = [remarkGfm];
