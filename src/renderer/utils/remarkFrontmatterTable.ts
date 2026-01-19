/**
 * remarkFrontmatterTable - A remark plugin that transforms YAML frontmatter into a GFM table.
 *
 * Requires remark-frontmatter to be used first to parse the frontmatter into a YAML AST node.
 * This plugin then transforms that node into a proper markdown table node (no raw HTML needed).
 *
 * Example input:
 * ---
 * share_note_link: https://example.com
 * share_note_updated: 2025-05-19T13:15:43-05:00
 * ---
 *
 * Output: A GFM table with key/value pairs, wrapped in a paragraph for styling context.
 */

import { visit } from 'unist-util-visit';
import type { Root, Table, TableRow, TableCell, Link, Text, Paragraph, Strong } from 'mdast';

/**
 * Parse simple YAML key-value pairs from frontmatter content.
 * Handles basic YAML syntax (key: value on each line).
 */
function parseYamlKeyValues(yamlContent: string): Array<{ key: string; value: string }> {
	const lines = yamlContent.split('\n');
	const entries: Array<{ key: string; value: string }> = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		// Match key: value pattern
		const colonIndex = trimmed.indexOf(':');
		if (colonIndex > 0) {
			const key = trimmed.substring(0, colonIndex).trim();
			let value = trimmed.substring(colonIndex + 1).trim();

			// Remove surrounding quotes if present
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}

			entries.push({ key, value });
		}
	}

	return entries;
}

/**
 * Check if a value looks like a URL
 */
function isUrl(value: string): boolean {
	return value.startsWith('http://') || value.startsWith('https://');
}

/**
 * Create a table cell with the given content
 */
function createCell(content: (Text | Link | Strong)[]): TableCell {
	return {
		type: 'tableCell',
		children: content,
	};
}

/**
 * Create a table row with the given cells
 */
function createRow(cells: TableCell[]): TableRow {
	return {
		type: 'tableRow',
		children: cells,
	};
}

/**
 * Generate a GFM table node from frontmatter entries
 */
function generateTableNode(entries: Array<{ key: string; value: string }>): Table {
	const rows: TableRow[] = entries.map(({ key, value }) => {
		// Key cell with bold text
		const keyCell = createCell([
			{
				type: 'strong',
				children: [{ type: 'text', value: key }],
			} as Strong,
		]);

		// Value cell - link if URL, otherwise plain text
		let valueCell: TableCell;
		if (isUrl(value)) {
			// Truncate long URLs for display
			const displayUrl = value.length > 50 ? value.substring(0, 47) + '...' : value;
			valueCell = createCell([
				{
					type: 'link',
					url: value,
					title: value,
					children: [{ type: 'text', value: displayUrl }],
				} as Link,
			]);
		} else {
			valueCell = createCell([{ type: 'text', value }]);
		}

		return createRow([keyCell, valueCell]);
	});

	return {
		type: 'table',
		align: ['left', 'left'],
		children: rows,
	};
}

/**
 * The remark plugin - transforms YAML frontmatter nodes into GFM tables
 */
export function remarkFrontmatterTable() {
	return (tree: Root) => {
		visit(tree, 'yaml', (node: any, index, parent) => {
			if (!parent || index === undefined) return;

			const yamlContent = node.value;
			const entries = parseYamlKeyValues(yamlContent);

			if (entries.length === 0) {
				// No valid entries, remove the node entirely
				parent.children.splice(index, 1);
				return index;
			}

			const tableNode = generateTableNode(entries);

			// Wrap in a paragraph with a data attribute for styling (using emphasis as a marker)
			// Actually, just insert the table directly - we'll style it via CSS class on the container
			// Add a small italic text before the table as a visual separator
			const metadataMarker: Paragraph = {
				type: 'paragraph',
				children: [
					{
						type: 'emphasis',
						children: [{ type: 'text', value: 'Document metadata:' }],
					},
				],
			};

			// Replace the YAML node with the marker and table
			parent.children.splice(index, 1, metadataMarker, tableNode);
			return index + 2;
		});
	};
}

export default remarkFrontmatterTable;
