import { useState, useCallback, memo } from 'react';
import {
	View,
	Text,
	Linking,
	type ViewStyle,
	type TextStyle,
	type ImageStyle,
	StyleSheet,
} from 'react-native';
import { Image as ExpoImage, type ImageErrorEventData } from 'expo-image';
import { ImageOff } from 'lucide-react-native';
import type { RenderRules, StyleMap } from './types';
import { CodeBlock } from './code-block';

// Helper to safely get styles with proper casting
const getViewStyle = (styles: StyleMap, key: string): ViewStyle | undefined =>
	styles[key] as ViewStyle | undefined;
const getTextStyle = (styles: StyleMap, key: string): TextStyle | undefined =>
	styles[key] as TextStyle | undefined;

// Image component with error placeholder using expo-image
interface MarkdownImageProps {
	url: string;
	alt?: string;
	style?: ImageStyle;
}

const MarkdownImage = memo(function MarkdownImage({ url, alt, style }: MarkdownImageProps) {
	const [hasError, setHasError] = useState(false);

	const handleError = useCallback(
		(event: ImageErrorEventData) => {
			console.warn('Markdown image failed to load:', url, event.error);
			setHasError(true);
		},
		[url]
	);

	if (hasError) {
		return (
			<View style={[imageStyles.placeholder, style]}>
				<ImageOff size={32} color="#9ca3af" />
				{alt && <Text style={imageStyles.placeholderText}>{alt}</Text>}
			</View>
		);
	}

	return (
		<ExpoImage
			source={{ uri: url }}
			style={style}
			contentFit="cover"
			accessibilityLabel={alt}
			alt={alt}
			accessible={Boolean(alt)}
			onError={handleError}
			placeholder={{ blurhash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4' }}
			transition={200}
		/>
	);
});

const imageStyles = StyleSheet.create({
	placeholder: {
		justifyContent: 'center',
		alignItems: 'center',
		backgroundColor: '#f3f4f6',
		borderRadius: 8,
	},
	placeholderText: {
		marginTop: 8,
		fontSize: 12,
		color: '#9ca3af',
		textAlign: 'center',
	},
});

const renderRules: RenderRules = {
	root: ({ node, styles, children }) => (
		<View key={node.key} style={getViewStyle(styles, '_VIEW_SAFE_root')}>
			{children}
		</View>
	),
	paragraph: ({ node, styles, children, parentStack }) => {
		const inListItem = parentStack.some((p) => p.type === 'listItem');
		return (
			<Text
				key={node.key}
				style={[getTextStyle(styles, 'paragraph'), inListItem && { marginVertical: 0 }]}
			>
				{children}
			</Text>
		);
	},
	strong: ({ node, styles, children }) => (
		<Text key={node.key} style={getTextStyle(styles, 'strong')}>
			{children}
		</Text>
	),
	emphasis: ({ node, styles, children }) => (
		<Text key={node.key} style={getTextStyle(styles, 'emphasis')}>
			{children}
		</Text>
	),
	delete: ({ node, styles, children }) => (
		<Text key={node.key} style={getTextStyle(styles, 'delete')}>
			{children}
		</Text>
	),
	text: ({ node, styles }) => (
		<Text key={node.key} style={getTextStyle(styles, 'text')} maxFontSizeMultiplier={1.2}>
			{node.value}
		</Text>
	),
	blockquote: ({ node, styles, children }) => (
		<View key={node.key} style={getViewStyle(styles, '_VIEW_SAFE_blockquote')}>
			{children}
		</View>
	),
	break: ({ node, styles }) => (
		<Text key={node.key} style={getTextStyle(styles, 'text')}>
			{'\n'}
		</Text>
	),
	thematicBreak: ({ node, styles }) => (
		<View key={node.key} style={getViewStyle(styles, `_VIEW_SAFE_${node.type}`)} />
	),
	code: ({ node }) => (
		<CodeBlock key={node.key} code={node.value} language={node.lang || undefined} />
	),
	inlineCode: ({ node, styles }) => (
		<Text key={node.key} style={getTextStyle(styles, node.type)}>
			{node.value}
		</Text>
	),
	image: ({ node, styles }) => (
		<MarkdownImage
			key={node.key}
			url={node.url}
			alt={node.alt || undefined}
			style={styles.image as ImageStyle}
		/>
	),
	link: ({ node, styles, children, extras }) => {
		const onPress = () => extras?.onPress(node.url) || (() => Linking.openURL(node.url));
		return (
			<Text key={node.key} onPress={onPress} style={getTextStyle(styles, 'link')}>
				{children}
			</Text>
		);
	},
	list: ({ node, styles, children }) => (
		<View key={node.key} style={getViewStyle(styles, `_VIEW_SAFE_${node.type}`)}>
			{children}
		</View>
	),
	listItem: ({ node, styles, children, extras }) => (
		<View key={node.key} style={getViewStyle(styles, 'listItem')}>
			{extras?.customListStyleType ? (
				extras.customListStyleType
			) : (
				<Text style={getTextStyle(styles, 'listBullet')}>{extras?.listStyleType}</Text>
			)}
			<View style={getViewStyle(styles, 'listItemContent')}>{children}</View>
		</View>
	),
	table: ({ node, styles, children }) => (
		<View key={node.key} style={getViewStyle(styles, '_VIEW_SAFE_table')}>
			{children}
		</View>
	),
	tableRow: ({ node, styles, children, extras }) => (
		<View
			key={node.key}
			style={[
				getViewStyle(styles, '_VIEW_SAFE_tableRow'),
				extras?.isHeader && getViewStyle(styles, '_VIEW_SAFE_tableHeaderRow'),
			]}
		>
			{children}
		</View>
	),
	tableCell: ({ node, styles, children, extras }) => (
		<View
			key={node.key}
			style={[
				getViewStyle(styles, '_VIEW_SAFE_tableCell'),
				extras?.isHeader && getViewStyle(styles, '_VIEW_SAFE_tableHeaderCell'),
			]}
		>
			<Text
				style={[
					getTextStyle(styles, 'tableCellText'),
					extras?.isHeader && getTextStyle(styles, 'tableHeaderCellText'),
				]}
			>
				{children}
			</Text>
		</View>
	),
	heading: ({ node, styles, children }) => (
		<Text key={node.key} style={getTextStyle(styles, `heading${node.depth}`)}>
			{children}
		</Text>
	),
	// Math nodes (inlineMath, displayMath) fall through as raw text per v1 scope
	// These are not rendered with KaTeX/MathJax - just shown as the raw LaTeX string
	// Cast to RenderRules since inlineMath/math are mdast extensions not in base types
	...({
		inlineMath: ({ node, styles }: { node: any; styles: StyleMap }) => (
			<Text key={node.key} style={getTextStyle(styles, 'inlineCode')}>
				{node.value || ''}
			</Text>
		),
		math: ({ node, styles }: { node: any; styles: StyleMap }) => (
			<Text key={node.key} style={[getTextStyle(styles, 'inlineCode'), { display: 'flex' }]}>
				{node.value || ''}
			</Text>
		),
	} as RenderRules),
	unknown: ({ node, styles }) => {
		// For unknown nodes with a value (like custom extensions), render as text
		// rather than dropping them silently
		const value = (node as any).value;
		if (typeof value === 'string' && value.length > 0) {
			console.warn(`Unknown node type with value: ${node.type}`);
			return (
				<Text key={node.key} style={getTextStyle(styles, 'text')}>
					{value}
				</Text>
			);
		}
		console.warn('Unknown node type encountered', node.type);
		return null;
	},
};

export default renderRules;
