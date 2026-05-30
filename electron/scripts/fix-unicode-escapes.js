// One-off cleanup: dashboard.html had \uXXXX escape sequences in static HTML
// contexts where the browser doesn't unescape them — user saw literal
// "Nh\u00F3m" instead of "Nhóm". Convert all to proper Unicode chars.
// Also undoes a previous bad pass that left stray backslashes before chars.
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, '..', 'ui', 'dashboard.html');
let src = fs.readFileSync(filePath, 'utf-8');
const beforeLen = src.length;

// Pass 1: convert \uXXXX (with single backslash) → actual char (only for non-control chars)
src = src.replace(/\\u([0-9A-Fa-f]{4})/g, (m, hex) => {
  const code = parseInt(hex, 16);
  if (code < 0x20) return m;
  return String.fromCharCode(code);
});

// Pass 2: remove any stray single backslashes remaining BEFORE Vietnamese chars.
// Example: "Nh\óm" → "Nhóm".
src = src.replace(/\\([\u00A0-\uFFFF])/g, '$1');

fs.writeFileSync(filePath, src, 'utf-8');
console.log(`Rewrote ${filePath}: ${beforeLen} → ${src.length} bytes`);
