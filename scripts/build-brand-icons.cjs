const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const directory = path.resolve(__dirname, "../static/brand");
  const source = fs.readFileSync(
    path.join(directory, "sanyu-mark.svg"),
    "utf8",
  );
  const browser = await chromium.launch({
    ...(process.env.UI_BROWSER_PATH
      ? { executablePath: process.env.UI_BROWSER_PATH }
      : {}),
    headless: true,
  });
  const assets = [
    [16, "sanyu-16.png"],
    [32, "sanyu-32.png"],
    [64, "sanyu-64.png"],
    [180, "apple-touch-icon.png"],
    [192, "icon-192.png"],
    [512, "icon-512.png"],
  ];
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const [size, filename] of assets) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<html><head><style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style></head><body>${source}</body></html>`,
      );
      await page.screenshot({
        path: path.join(directory, filename),
        omitBackground: true,
      });
    }
    const frames = assets.slice(0, 3).map(([size, filename]) => ({
      size,
      bytes: fs.readFileSync(path.join(directory, filename)),
    }));
    const header = Buffer.alloc(6 + 16 * frames.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(frames.length, 4);
    let offset = header.length;
    frames.forEach(({ size, bytes }, i) => {
      const entry = 6 + 16 * i;
      header[entry] = header[entry + 1] = size;
      header.writeUInt16LE(1, entry + 4);
      header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(bytes.length, entry + 8);
      header.writeUInt32LE(offset, entry + 12);
      offset += bytes.length;
    });
    fs.writeFileSync(
      path.join(directory, "favicon.ico"),
      Buffer.concat([header, ...frames.map((frame) => frame.bytes)]),
    );
    console.log(
      "Built six PNG sizes and a 16/32/64px ICO from the SVG master.",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
