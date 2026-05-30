// Quick HTML → PDF converter using Electron's bundled Chromium.
// Usage (from electron/ dir): npx electron scripts/html-to-pdf.js <in.html> <out.pdf>

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const [, , inputHtml, outputPdf] = process.argv;
if (!inputHtml || !outputPdf) {
  console.error('Usage: electron html-to-pdf.js <in.html> <out.pdf>');
  process.exit(1);
}

const absIn = path.resolve(inputHtml);
const absOut = path.resolve(outputPdf);

if (!fs.existsSync(absIn)) {
  console.error('Input not found:', absIn);
  process.exit(1);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false, contextIsolation: true },
  });
  try {
    await win.loadFile(absIn);
    // Let fonts and layout settle
    await new Promise(r => setTimeout(r, 1500));
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'default' },
      preferCSSPageSize: true,
    });
    fs.writeFileSync(absOut, pdf);
    console.log('PDF written:', absOut, '(', pdf.length, 'bytes )');
  } catch (e) {
    console.error('Failed:', e?.message || e);
    app.exit(1);
    return;
  }
  app.quit();
});
