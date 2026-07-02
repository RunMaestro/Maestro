'use client';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { BlurViewProps } from 'expo-blur';
import { NativeBlurView } from 'expo-blur/build/NativeBlurModule';

export function BlurViewRawBackdrop({
	tint = 'default',
	intensity = 50,
	blurReductionFactor = 4,
	experimentalBlurMethod = 'none',
	style,
	children,
	...props
}: BlurViewProps) {
	return (
		<NativeBlurView
			tint={tint}
			intensity={intensity}
			blurReductionFactor={blurReductionFactor}
			experimentalBlurMethod={experimentalBlurMethod}
			style={{
				...StyleSheet.absoluteFill,
				overflow: 'hidden',
			}}
			{...props}
		/>
	);
}
