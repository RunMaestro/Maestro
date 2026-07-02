import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { useCSSVariable } from 'uniwind';

export function useSystemBackgroundColor() {
	const color = useCSSVariable('--app-background');
	useEffect(() => {
		SystemUI.setBackgroundColorAsync(color as unknown as string);
	}, [color]);
}
