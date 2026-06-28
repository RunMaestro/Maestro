import * as WebBrowser from 'expo-web-browser';
import React, { useCallback, useMemo } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { FileText } from 'lucide-react-native';
import { useCSSVariable } from 'uniwind';
import { useToast } from '@/lib/ToastContext';
import { useAccent } from '@/theme/AccentContext';
import Markdown from './markdown';

const VAR_NAMES = [
	'--app-foreground',
	'--app-muted-foreground',
	'--app-border',
	'--app-secondary',
	'--app-muted',
	'--app-accent',
	// Tailwind blue
	'--color-blue-400',
] as const;

/**
 * Wiki-link pre-pass per decision 12C.
 * Matches [[some-file.md]] and rewrites to [some-file.md](maestro://file/some-file.md)
 * so the standard mdast link node picks it up. Runs BEFORE mdast parsing.
 */
function preprocessWikiLinks(md: string): string {
	// Match [[anything except ]]] - capture the inner text
	return md.replace(/\[\[([^\]]+)\]\]/g, (_, text) => {
		const encoded = encodeURIComponent(text);
		return `[${text}](maestro://file/${encoded})`;
	});
}

/**
 * Convert single newlines to hard breaks (two trailing spaces) so they render
 * the same way they appear during streaming. Skips fenced code blocks.
 */
function preserveNewlines(md: string): string {
	return md.replace(/(```[\s\S]*?```)|(\n)/g, (match, codeBlock) => (codeBlock ? match : '  \n'));
}

export function ChatMarkdown({ children }: { children: string }) {
	const { showToast } = useToast();
	const { accentColor } = useAccent();
	const [text, text2, border, bg2, bg3, fill3, _link] = useCSSVariable(
		VAR_NAMES as unknown as string[]
	) as string[];

	// Use accent color from Maestro theme for links (per decision 5C)
	const linkColor = accentColor;
	// Wiki-link color matches the accent
	const wikiLinkColor = accentColor;

	const isWeb = process.env.EXPO_OS === 'web';
	const baseFontSize = isWeb ? 13 : 16;
	const baseLineHeight = isWeb ? 21.5 : 22;

	// Only overrides; defaults from utils.ts are merged automatically
	// Heading sizes: scaled for mobile readability (base 16pt)
	const markdownStyles = {
		heading1: {
			fontSize: 24,
			lineHeight: 32,
			fontWeight: 'bold' as const,
			color: text,
			marginVertical: 12,
		},
		heading2: {
			fontSize: 20,
			lineHeight: 28,
			fontWeight: '600' as const,
			color: text,
			marginVertical: 10,
		},
		heading3: {
			fontSize: 18,
			lineHeight: 26,
			fontWeight: '600' as const,
			color: text,
			marginVertical: 8,
		},
		heading4: {
			fontSize: 16,
			lineHeight: 24,
			fontWeight: '600' as const,
			color: text,
			marginVertical: 6,
		},
		heading5: {
			fontSize: 14,
			lineHeight: 22,
			fontWeight: '600' as const,
			color: text,
			marginVertical: 4,
		},
		heading6: {
			fontSize: 12,
			lineHeight: 20,
			fontWeight: '600' as const,
			color: text,
			marginVertical: 4,
		},
		paragraph: { fontSize: baseFontSize, lineHeight: baseLineHeight, marginVertical: 8 },
		text: { color: text, fontSize: baseFontSize, lineHeight: baseLineHeight },
		thematicBreak: { backgroundColor: border },
		blockquote: { backgroundColor: bg3, borderColor: border, paddingHorizontal: 8 },
		codeContainer: { backgroundColor: fill3, padding: 12, borderRadius: 8 },
		codeText: {
			fontSize: isWeb ? 12 : 14,
			color: text,
			fontFamily: Platform.select({ ios: 'ui-monospace', default: 'monospace' }),
		},
		inlineCode: {
			fontFamily: Platform.select({ ios: 'ui-monospace', default: 'monospace' }),
			paddingHorizontal: 4,
			fontSize: isWeb ? 12 : 15,
			color: text,
			overflow: 'hidden' as const,
			borderRadius: 4,
			backgroundColor: fill3,
		},
		link: { fontSize: baseFontSize, color: linkColor },
		image: { height: 200, aspectRatio: 16 / 9, backgroundColor: fill3, borderRadius: 8 },
		listBullet: { color: text2, fontVariant: ['tabular-nums' as const], marginRight: 8 },
		table: { borderColor: border, borderRadius: 8 },
		tableRow: { borderBottomColor: border },
		tableHeaderRow: { backgroundColor: bg2 },
		tableCell: { padding: 10, borderRightColor: border },
		tableHeaderCell: { backgroundColor: bg2 },
		tableCellText: { color: text },
		tableHeaderCellText: { color: text },
	};

	// Handle link press with wiki-link detection
	const handleLinkPress = useCallback(
		(url: string) => {
			// Wiki-link: maestro://file/<encoded-filename>
			if (url.startsWith('maestro://file/')) {
				showToast({
					message: 'File preview not available in mobile app',
					color: 'theme',
					duration: 2500,
				});
				return;
			}

			// Regular link handling
			if (process.env.EXPO_OS === 'web') {
				Linking.openURL(url);
			} else {
				WebBrowser.openBrowserAsync(url, {
					presentationStyle: WebBrowser.WebBrowserPresentationStyle.AUTOMATIC,
				});
			}
		},
		[showToast]
	);

	// Apply wiki-link pre-pass before other preprocessing
	const processedMarkdown = preserveNewlines(preprocessWikiLinks(children));

	return (
		<Markdown
			styles={markdownStyles}
			onLinkPress={handleLinkPress}
			renderRules={{
				listItem: ({ node, styles, children, extras }) => (
					<View key={node.key} style={styles.listItem as any}>
						{extras?.customListStyleType ? (
							extras.customListStyleType
						) : (
							<Text
								style={[
									styles.listBullet as any,
									extras?.ordered ? fullStyles.orderedBullet : fullStyles.unorderedBullet,
								]}
							>
								{extras?.listStyleType}
							</Text>
						)}
						<View style={styles.listItemContent as any}>{children}</View>
					</View>
				),
				// Wiki-link renderer: detect maestro://file/ URLs and style distinctly
				link: ({ node, styles, children, extras }) => {
					const isWikiLink = node.url?.startsWith('maestro://file/');
					// `extras.onPress` is `handleLinkPress`, which fully handles the link
					// (wiki toast or WebBrowser/Linking) and returns void. Returning after
					// it runs avoids falling through to `Linking.openURL` - which otherwise
					// opens regular links twice and tries the unsupported `maestro://file/`
					// URL after the wiki toast.
					const onPress = () => {
						if (extras?.onPress) {
							extras.onPress(node.url);
							return;
						}
						Linking.openURL(node.url);
					};

					if (isWikiLink) {
						// Wiki-links render with file icon and accent color
						// Using View wrapper for icon + text since RN Text doesn't support icon children well
						return (
							<View key={node.key} style={wikiLinkStyles.container}>
								<FileText size={14} color={wikiLinkColor} strokeWidth={2} />
								<Text
									onPress={onPress}
									style={[
										styles.link as any,
										{ color: wikiLinkColor, textDecorationLine: 'none', marginLeft: 4 },
									]}
								>
									{children}
								</Text>
							</View>
						);
					}

					return (
						<Text key={node.key} onPress={onPress} style={styles.link as any}>
							{children}
						</Text>
					);
				},
			}}
			markdown={processedMarkdown}
		/>
	);
}

const fullStyles = StyleSheet.create({
	orderedBullet: {
		fontFamily: Platform.select({ ios: 'ui-monospace', default: 'monospace' }),
		fontWeight: 'normal',
	},
	unorderedBullet: {
		fontSize: 18,
		fontWeight: '900',
	},
});

// Wiki-link specific styles per decision 12C
const wikiLinkStyles = StyleSheet.create({
	container: {
		flexDirection: 'row',
		alignItems: 'center',
	},
});
