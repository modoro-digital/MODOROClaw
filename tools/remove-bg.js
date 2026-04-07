// Remove white background from mascot logo
// Usage: node tools/remove-bg.js <input.png> <output.png>
const sharp = require('sharp');
const [,, input, output] = process.argv;
if (!input || !output) { console.log('Usage: node remove-bg.js input.png output.png'); process.exit(1); }

sharp(input)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })
  .then(({ data, info }) => {
    const { width, height, channels } = info;
    // Replace near-white pixels with transparent
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i], g = data[i+1], b = data[i+2];
      if (r > 240 && g > 240 && b > 240) {
        data[i+3] = 0; // set alpha to 0
      }
    }
    return sharp(data, { raw: { width, height, channels } }).png().toFile(output);
  })
  .then(() => console.log('Done:', output));
