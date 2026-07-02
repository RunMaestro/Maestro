import React from 'react';
import { View, StyleSheet } from 'react-native';

export function BlurViewRawBackdrop({ tint = 'default', intensity = 50, ...props }) {
	return <View style={StyleSheet.absoluteFill} {...props} />;
}
