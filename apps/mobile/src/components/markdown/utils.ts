import type { Node, Parent } from 'mdast';
import type { Extension } from 'mdast-util-from-markdown';
import { Platform, StyleSheet, type TextStyle, type ViewStyle } from 'react-native';
import type { StyleMap } from './types';

const defaultStyles: StyleMap = {
	root: {},
	heading1: {
		fontSize: 48,
		fontWeight: 'bold',
	},
	heading2: {
		fontSize: 36,
		fontWeight: '600',
	},
	heading3: {
		fontSize: 32,
		fontWeight: '600',
	},
	heading4: {
		fontSize: 28,
		fontWeight: '600',
	},
	heading5: {
		fontSize: 24,
		fontWeight: '600',
	},
	heading6: {
		fontSize: 20,
		fontWeight: '600',
	},
	paragraph: {
		marginVertical: 8,
		flexWrap: 'wrap',
		flexDirection: 'row',
		alignItems: 'flex-start',
		justifyContent: 'flex-start',
		width: '100%',
	},
	strong: {
		fontWeight: 'bold',
	},
	emphasis: {
		fontStyle: 'italic',
	},
	text: {},
	thematicBreak: {
		flex: 1,
		height: 1,
		backgroundColor: '#0000006c',
		marginVertical: 8,
	},
	blockquote: {
		backgroundColor: '#f5f5f5',
		borderColor: '#3840ba',
		borderLeftWidth: 4,
		paddingHorizontal: 5,
		marginVertical: 8,
	},
	codeContainer: {
		backgroundColor: '#f0f0f0',
		padding: 8,
		borderRadius: 4,
		marginVertical: 4,
	},
	codeText: {
		color: '#1c1c1c',
		fontSize: 14,
		...Platform.select({
			ios: {
				fontFamily: 'ui-monospace',
			},
			android: {
				fontFamily: 'monospace',
			},
		}),
	},
	inlineCode: {
		...Platform.select({
			ios: {
				fontFamily: 'ui-monospace',
			},
			android: {
				fontFamily: 'monospace',
			},
		}),
		backgroundColor: '#f0f0f0',
	},
	link: {
		transform: [{ translateY: 2 }],
		fontSize: 16,
		color: '#1e90ff',
		textDecorationLine: 'underline',
	},
	image: {
		width: '100%',
		height: 300,
		aspectRatio: 1,
		resizeMode: 'cover',
		backgroundColor: '#f0f0f0',
		overflow: 'hidden',
	},
	list: {
		flex: 1,
	},
	listItem: {
		flexDirection: 'row',
		alignItems: 'baseline',
		justifyContent: 'flex-start',
		gap: 8,
	},
	listBullet: {
		fontSize: 16,
		fontWeight: '900',
	},
	listItemContent: {
		flex: 1,
		flexWrap: 'wrap',
	},
	delete: {
		textDecorationLine: 'line-through',
	},
	// Table styles
	table: {
		marginVertical: 8,
		borderWidth: 1,
		borderColor: '#ddd',
		borderRadius: 4,
		overflow: 'hidden',
	},
	tableRow: {
		flexDirection: 'row',
		borderBottomWidth: 1,
		borderBottomColor: '#ddd',
	},
	tableHeaderRow: {
		backgroundColor: '#f5f5f5',
	},
	tableCell: {
		flex: 1,
		padding: 8,
		borderRightWidth: 1,
		borderRightColor: '#ddd',
	},
	tableHeaderCell: {
		backgroundColor: '#f5f5f5',
	},
	tableCellText: {
		fontSize: 14,
	},
	tableHeaderCellText: {
		fontWeight: '600',
	},
};

// Remove text-only style props for View-safe styles
type TextOnlyProps = Omit<TextStyle, keyof ViewStyle>;

function removeTextStyleProps<T extends ViewStyle | TextStyle>(style: T): ViewStyle {
	const textOnlyKeys: (keyof TextOnlyProps)[] = [
		'color',
		'fontFamily',
		'fontSize',
		'fontStyle',
		'fontWeight',
		'letterSpacing',
		'lineHeight',
		'textAlign',
		'textDecorationLine',
		'textDecorationStyle',
		'textDecorationColor',
		'textShadowColor',
		'textShadowOffset',
		'textShadowRadius',
		'textTransform',
		'includeFontPadding',
		'textAlignVertical',
		'fontVariant',
		'writingDirection',
	];
	const result = { ...style };
	textOnlyKeys.forEach((key) => {
		delete (result as any)[key];
	});
	return result as ViewStyle;
}

export function getMergedStyles(styles: StyleMap | null = null, merge = false): StyleMap {
	const output: Record<string, any> = {};

	const allKeys = new Set([...Object.keys(defaultStyles), ...(styles ? Object.keys(styles) : [])]);

	for (const key of allKeys) {
		const base = StyleSheet.flatten(defaultStyles[key] as any) ?? {};
		const custom = StyleSheet.flatten(styles?.[key] as any) ?? {};

		const final = merge ? { ...base, ...custom } : styles?.[key] ? custom : base;

		output[key] = final;
		output[`_VIEW_SAFE_${key}`] = removeTextStyleProps(final as any);
	}

	return StyleSheet.create(output);
}

// Generate unique keys for nodes based on position
function getKey(node: Node): string {
	const { start, end } = node.position ?? {};
	if (start && end) {
		return `${node.type}-${start.line}:${start.column}-${end.line}:${end.column}`;
	}
	return `${node.type}-${Math.random().toString(16).slice(2, 8)}`;
}

function addKeysRecursively(node: Node): void {
	if (node.position) {
		node.key = getKey(node);
	}
	if ('children' in node && Array.isArray((node as Parent).children)) {
		for (const child of (node as Parent).children) {
			addKeysRecursively(child);
		}
	}
}

export function getKeyFromMarkdown(): Extension {
	return {
		transforms: [
			(tree) => {
				addKeysRecursively(tree);
			},
		],
	};
}

// Resolve link and image references
import type { Definition, Root, RootContent } from 'mdast';

function normalizeIdentifier(id: string): string {
	return id.trim().toLowerCase();
}

const transform = (node: RootContent | Root, definitions: Map<string, Definition>): void => {
	if (node.type === 'linkReference' || node.type === 'imageReference') {
		const def = definitions.get(normalizeIdentifier(node.identifier));
		if (!def) return;

		if (node.type === 'linkReference') {
			const linkNode: any = node;
			linkNode.type = 'link';
			linkNode.url = def.url;
			linkNode.title = def.title ?? null;
		}

		if (node.type === 'imageReference') {
			const imageNode: any = node;
			imageNode.type = 'image';
			imageNode.url = def.url;
			imageNode.title = def.title ?? null;
		}
	}

	if ('children' in node && Array.isArray(node.children)) {
		for (const child of node.children) {
			transform(child, definitions);
		}
	}
};

export function resolveReference(): Extension {
	return {
		transforms: [
			(tree) => {
				const definitions = new Map<string, Definition>();
				const definitionIndices: number[] = [];

				for (const node of tree.children) {
					if (node.type === 'definition') {
						definitions.set(normalizeIdentifier(node.identifier), node);
						definitionIndices.push(tree.children.indexOf(node));
					}
				}

				if (definitions.size === 0) return;

				transform(tree, definitions);

				for (const index of definitionIndices.reverse()) {
					tree.children.splice(index, 1);
				}
			},
		],
	};
}
