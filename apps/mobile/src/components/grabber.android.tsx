import { Icon } from '@/components/icon';
import { Minus } from 'lucide-react-native';
import { View } from 'react-native';

export function AndroidGrabber() {
	return (
		<View className="items-center pt-2 pb-1">
			<Icon icon={Minus} strokeWidth={4} className="w-8 h-8 text-muted-foreground" />
		</View>
	);
}
