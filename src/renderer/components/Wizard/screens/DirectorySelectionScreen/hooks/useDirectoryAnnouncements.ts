import { useCallback, useState } from 'react';
import type { DirectoryAnnouncementState } from '../types';

export function useDirectoryAnnouncements(): DirectoryAnnouncementState {
	const [announcement, setAnnouncement] = useState('');
	const [announcementKey, setAnnouncementKey] = useState(0);

	const announce = useCallback((message: string) => {
		setAnnouncement(message);
		setAnnouncementKey((prev) => prev + 1);
	}, []);

	return { announcement, announcementKey, announce };
}
