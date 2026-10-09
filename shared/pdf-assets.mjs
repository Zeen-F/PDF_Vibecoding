import { fileURLToPath } from 'node:url';

// PDF.js requires a trailing forward slash, including for Windows filesystem
// paths. Its Node factory reads these as paths, so retain decoded local names
// rather than passing file: URL strings to fs.readFile.
const assetsRoot = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url)).replaceAll('\\', '/');

export const pdfAssetPaths = Object.freeze({
  cMapUrl: `${assetsRoot}cmaps/`,
  standardFontDataUrl: `${assetsRoot}standard_fonts/`,
  wasmUrl: `${assetsRoot}wasm/`,
});
