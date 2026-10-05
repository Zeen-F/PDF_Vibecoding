import {cp,mkdir} from 'node:fs/promises';
for (const name of ['cmaps','standard_fonts','wasm']) {
  await mkdir(new URL('../public/pdf-assets/', import.meta.url), {recursive:true});
  await cp(new URL(`../node_modules/pdfjs-dist/${name}`, import.meta.url),new URL(`../public/pdf-assets/${name}`, import.meta.url),{recursive:true});
}
