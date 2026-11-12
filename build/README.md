# Build Assets

Place your application icons in this directory:

- **icon.icns** - macOS app icon (512x512 or 1024x1024)
- **icon.ico** - Windows app icon (256x256)
- **icon.png** - Linux window icon and source image (1024x1024)
- **icons/** - Linux icon set (one PNG per standard size)

Linux packages read `icons/`, not `icon.png`. The AppImage and deb/rpm targets
install every size in `icons/` as `usr/share/icons/hicolor/<size>/apps/maestro.png`.
Desktop environments find the entry through the standard hicolor sizes.

Do not put a 1024x1024 icon in `icons/`. The hicolor theme does not declare that
size. GNOME then ignores the icon and shows a generic placeholder.

The set contains these sizes: 16, 22, 24, 32, 48, 64, 128, 192, 256, 512.
Keep 512 as the largest size.

## Generate the icons

Run this command from the repository root:

The command uses ImageMagick 7 (`magick`). Ubuntu 22.04 and 24.04 ship
ImageMagick 6, which provides `convert` instead. Select the command for your
version:

```bash
IM=magick    # ImageMagick 7
# IM=convert # ImageMagick 6

mkdir -p build/icons
for size in 16 22 24 32 48 64 128 192 256 512; do
  "$IM" build/icon.png -resize "${size}x${size}" "build/icons/${size}x${size}.png"
done
```

## Other platforms

You can generate these from a single source PNG using tools like:

- https://www.electronforge.io/guides/create-and-add-icons
- https://icon.kitchen/
- ImageMagick

Example using ImageMagick:

```bash
# Generate macOS icon
png2icns icon.icns icon.png

# Generate Windows icon
convert icon.png -define icon:auto-resize=256,128,96,64,48,32,16 icon.ico
```
