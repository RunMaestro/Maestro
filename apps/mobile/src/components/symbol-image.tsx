import { Image as ExpoImage, ImageProps, type ImageStyle } from 'expo-image';
import {
	ArrowUp,
	ChevronDown,
	HelpCircle,
	MessageSquare,
	Plus,
	type LucideIcon,
} from 'lucide-react-native';

import { withUniwind } from 'uniwind';

const Image = withUniwind(ExpoImage);

/**
 * Map of SF Symbol names to Lucide icons for Android/web fallback.
 */
const LUCIDE_FALLBACKS: Record<string, LucideIcon> = {
	'arrow.up': ArrowUp,
	'chevron.down': ChevronDown,
	'bubble.left.and.bubble.right': MessageSquare,
	plus: Plus,
};

type SymbolImageProps = {
	/** SF Symbol name (e.g. "arrow.up", "chevron.down") */
	name: string;
	size?: number;
	tintColor?: string;
	style?: ImageStyle;
	className?: string;
	sfEffect?: ImageProps['sfEffect'];
	transition?: ImageProps['transition'];
};

export function SymbolImage({
	name,
	size = 24,
	tintColor,
	style,
	className,
	sfEffect,
	transition,
}: SymbolImageProps) {
	if (process.env.EXPO_OS === 'ios') {
		return (
			<Image
				sfEffect={sfEffect}
				transition={transition}
				source={`sf:${name}`}
				style={[{ width: size, height: size }, style]}
				tintColor={tintColor}
				className={className}
			/>
		);
	}

	const Icon = LUCIDE_FALLBACKS[name] ?? HelpCircle;
	return <Icon size={size} color={tintColor} style={style as any} />;
}
