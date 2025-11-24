# Build Assets

Place your application icons in this directory:

- **icon.icns** - macOS app icon (512x512 or 1024x1024)
- **icon.ico** - Windows app icon (256x256)
- **icon.png** - Linux app icon (512x512)

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
