import { useSyncExternalStore } from 'react';
import { Text } from 'react-native';
import { useAccent } from '@/theme/AccentContext';
import type { StreamingStore } from './streaming-store';

/**
 * Displays streaming text with a cursor.
 * Cursor uses accent color from Maestro theme (per decision 5C).
 */
export function StreamingMessage({ store }: { store: StreamingStore }) {
	const text = useSyncExternalStore(store.subscribe, store.get);
	const { accentColor } = useAccent();

	return (
		<Text
			className={
				process.env.EXPO_OS === 'web'
					? 'text-[13px] leading-[1.65] text-foreground'
					: 'text-base leading-[22px] text-foreground'
			}
		>
			{text || '...'}
			<Text style={{ color: accentColor, opacity: 0.7 }}>{'\u258C'}</Text>
		</Text>
	);
}
