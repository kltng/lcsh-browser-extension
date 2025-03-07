const fs = require('fs');
const path = require('path');

// Create directories if they don't exist
const assetsDir = path.join(__dirname, 'assets');
const distAssetsDir = path.join(__dirname, 'dist', 'assets');

if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

if (!fs.existsSync(distAssetsDir)) {
  fs.mkdirSync(distAssetsDir, { recursive: true });
}

// Simple 1x1 pixel transparent PNG (base64 encoded)
const transparentPixelPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// Create icon files
const iconSizes = [16, 48, 128];

iconSizes.forEach(size => {
  const iconPath = path.join(assetsDir, `icon${size}.png`);
  const distIconPath = path.join(distAssetsDir, `icon${size}.png`);
  
  // Write to assets directory
  fs.writeFileSync(iconPath, transparentPixelPNG);
  console.log(`Created ${iconPath}`);
  
  // Write to dist/assets directory
  fs.writeFileSync(distIconPath, transparentPixelPNG);
  console.log(`Created ${distIconPath}`);
});

console.log('Icon files created successfully!'); 