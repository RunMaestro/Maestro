export function addStagedImageIfUnique(
	images: string[],
	imageData: string,
	showFlashNotification?: (message: string) => void
): string[] {
	if (images.includes(imageData)) {
		showFlashNotification?.('Duplicate image ignored');
		return images;
	}

	return [...images, imageData];
}
