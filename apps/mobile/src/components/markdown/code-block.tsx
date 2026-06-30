import transform, { type StyleTuple } from 'css-to-react-native';
import React, { memo, useCallback, useMemo, type CSSProperties, type ReactNode } from 'react';
import {
	Platform,
	ScrollView,
	StyleSheet,
	Text,
	useColorScheme,
	View,
	type TextStyle,
} from 'react-native';
import SyntaxHighlighter from 'react-syntax-highlighter';
import { githubGist, irBlack } from 'react-syntax-highlighter/dist/esm/styles/hljs';

type HighlighterStyleSheet = { [key: string]: TextStyle };
type ReactStyle = { [key: string]: CSSProperties };

interface RendererNode {
	children?: RendererNode[];
	properties?: {
		className?: string[];
	};
	tagName?: string;
	value?: string;
}

const ALLOWED_STYLE_PROPERTIES: Record<string, boolean> = {
	color: true,
	background: true,
	backgroundColor: true,
	fontWeight: true,
	fontStyle: true,
};

const cleanStyle = (style: CSSProperties) => {
	const styles = Object.entries(style)
		.filter(([key]) => ALLOWED_STYLE_PROPERTIES[key])
		.map<StyleTuple>(([key, value]) => [key, String(value)]);
	return transform(styles);
};

const getRNStylesFromHljsStyle = (hljsStyle: ReactStyle): HighlighterStyleSheet => {
	return Object.fromEntries(
		Object.entries(hljsStyle).map(([className, style]) => [className, cleanStyle(style)])
	);
};

function trimNewlines(string: string): string {
	let start = 0;
	let end = string.length;
	while (start < end && (string[start] === '\r' || string[start] === '\n')) {
		start++;
	}
	while (end > start && (string[end - 1] === '\r' || string[end - 1] === '\n')) {
		end--;
	}
	return start > 0 || end < string.length ? string.slice(start, end) : string;
}

// Pre-compute stylesheets for both themes
const darkStylesheet = getRNStylesFromHljsStyle(irBlack as ReactStyle);
const lightStylesheet = getRNStylesFromHljsStyle(githubGist as ReactStyle);

interface CodeBlockProps {
	code: string;
	language?: string;
}

export const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
	const colorScheme = useColorScheme();
	const isDark = colorScheme === 'dark';

	const stylesheet = isDark ? darkStylesheet : lightStylesheet;

	const baseStyle = useMemo(
		() =>
			StyleSheet.flatten([
				styles.text,
				{ color: stylesheet.hljs?.color || (isDark ? '#f8f8f2' : '#333') },
			]),
		[stylesheet, isDark]
	);

	const containerStyle = useMemo(
		() => [styles.container, { backgroundColor: isDark ? '#1a1a1a' : '#f6f8fa' }],
		[isDark]
	);

	const getStylesForNode = useCallback(
		(node: RendererNode): TextStyle[] => {
			const classes: string[] = node.properties?.className ?? [];
			return classes.map((c: string) => stylesheet[c]).filter((c) => !!c) as TextStyle[];
		},
		[stylesheet]
	);

	const renderNodeChildren = useCallback(
		(nodes: RendererNode[], keyPrefix = 'row'): ReactNode[] => {
			return nodes.reduce<ReactNode[]>((acc, node, index) => {
				const keyPrefixWithIndex = `${keyPrefix}_${index}`;
				if (node.children) {
					const nodeStyles = getStylesForNode(node);
					const textStyles = nodeStyles.length > 0 ? nodeStyles : undefined;
					acc.push(
						<Text style={textStyles} key={keyPrefixWithIndex}>
							{renderNodeChildren(node.children, `${keyPrefixWithIndex}_child`)}
						</Text>
					);
				}
				if (node.value) {
					acc.push(trimNewlines(String(node.value)));
				}
				return acc;
			}, []);
		},
		[getStylesForNode]
	);

	const renderer = useCallback(
		(props: any) => {
			const { rows } = props;
			return (
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					contentContainerStyle={styles.scrollContent}
				>
					<View style={styles.codeContent}>
						{rows.map((row: RendererNode, index: number) => (
							<Text key={`row_${index}`} style={baseStyle}>
								{renderNodeChildren(row.children || [], `row_${index}`)}
							</Text>
						))}
					</View>
				</ScrollView>
			);
		},
		[renderNodeChildren, baseStyle]
	);

	return (
		<View style={containerStyle}>
			<SyntaxHighlighter
				renderer={renderer}
				CodeTag={View as any}
				PreTag={View as any}
				style={undefined}
				customStyle={{ backgroundColor: 'transparent' }}
				language={language || 'typescript'}
			>
				{code}
			</SyntaxHighlighter>
		</View>
	);
});

const styles = StyleSheet.create({
	container: {
		borderRadius: 8,
		marginVertical: 4,
		overflow: 'hidden',
	},
	scrollContent: {
		minWidth: '100%',
	},
	codeContent: {
		padding: 12,
	},
	text: {
		fontSize: 14,
		lineHeight: 20,
		fontFamily: Platform.select({ ios: 'monospace-ui', default: 'monospace' }),
	},
});
