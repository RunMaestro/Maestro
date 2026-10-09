/**
 * remarkMentionChips - a remark plugin that turns `@file` and `@agent`
 * mentions in rendered messages into chip-styled links, mirroring the live
 * input overlay so a mention looks identical typed vs. read back.
 *
 * Shape follows `remarkFileLinks`: a `text`-node visitor that splices the
 * matched spans out into `link` nodes carrying `data-*` hProperties. The chip
 * itself is rendered by `MarkdownLink`, which detects `data-mention-kind` and
 * hands off to `RenderedMentionChip`.
 *
 * Reuse of existing routing (no new callbacks needed):
 *   - `@file`  -> `maestro-file://<path>` + `data-maestro-file`, so the existing
 *     MarkdownLink file-open path opens a preview tab on click.
 *   - `@agent` -> resolved to a live agent + `maestro://` jump inside the chip.
 *
 * A bare `@word` only chips as an agent when it names a live agent/group (the
 * roster is read from the session store at transform time); path-like bodies
 * chip as files. Rendered transcripts don't exclude the "current" agent, so any
 * mentioned agent/group chips.
 *
 * Exclusions match `remarkFileLinks`: only `text` nodes are visited, so fenced
 * code blocks (`code`) and inline code (`inlineCode`) are never touched, and
 * text already inside a `link` is skipped.
 */

import { visit } from 'unist-util-visit';
import type { Root, Text, Link } from 'mdast';
import { tokenizeMentions } from '../../shared/mentionPatterns';
import { useSessionStore } from '../stores/sessionStore';
import { buildKnownMentionNameSet } from '../hooks/input/useAgentMentionCompletion';

export function remarkMentionChips() {
	return (tree: Root) => {
		// Resolve the mentionable roster once per render pass. Read imperatively
		// (not via a hook) so the plugin stays a plain remark transform.
		const { sessions, groups } = useSessionStore.getState();
		const knownMentionNames = buildKnownMentionNameSet(sessions, groups, undefined);

		visit(tree, 'text', (node: Text, index, parent) => {
			if (!parent || index === undefined) return;
			// Skip text inside link nodes - the link visitor owns those.
			if (parent.type === 'link') return;

			const segments = tokenizeMentions(node.value, knownMentionNames);
			// Nothing but plain text -> leave the node untouched.
			if (!segments.some((s) => s.kind !== 'text')) return;

			const replacements: (Text | Link)[] = [];
			for (const seg of segments) {
				if (seg.kind === 'text') {
					replacements.push({ type: 'text', value: seg.value });
					continue;
				}
				if (seg.kind === 'file') {
					replacements.push({
						type: 'link',
						url: `maestro-file://${seg.path}`,
						data: {
							hProperties: {
								'data-maestro-file': seg.path,
								'data-mention-kind': 'file',
								'data-mention-ext': seg.extension,
							},
						},
						children: [{ type: 'text', value: seg.path }],
					});
					continue;
				}
				// agent
				replacements.push({
					type: 'link',
					// URL is inert: the chip resolves + jumps in RenderedMentionChip.
					url: '',
					data: {
						hProperties: {
							'data-mention-kind': 'agent',
							'data-mention-name': seg.name,
						},
					},
					children: [{ type: 'text', value: seg.value }],
				});
			}

			parent.children.splice(index, 1, ...replacements);
			return index + replacements.length;
		});
	};
}

export default remarkMentionChips;
