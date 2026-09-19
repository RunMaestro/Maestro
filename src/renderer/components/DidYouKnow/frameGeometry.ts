/**
 * Geometry measured from the alpha channel of did-you-know-frame.png, valid
 * only for that exact file. If the asset is ever recropped or replaced,
 * re-measure these values from the new alpha channel; never adjust them by eye.
 * APERTURE_INSET values are percentages of the full frame image dimensions.
 * Any bundled screenshot must be cropped to APERTURE_ASPECT.
 * Phase 07 adds a test that re-derives the geometry from the PNG so a silent
 * asset swap fails loudly.
 */
export const FRAME_ASPECT = 1280 / 750;

export const APERTURE_INSET = {
	left: 14.375,
	top: 24.267,
	right: 14.297,
	bottom: 24.533,
};

export const APERTURE_ASPECT = 2.3776;
