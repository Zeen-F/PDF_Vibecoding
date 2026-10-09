import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pdfAssetPaths } from '../shared/pdf-assets.mjs';

process.once('message', async ({ filePath, data, page: pageNumber, width }) => {
  let task, page, canvas, result;
  try {
    const source = data === undefined
      ? (typeof filePath === 'string' && path.isAbsolute(filePath) ? { url: pathToFileURL(filePath).href } : null)
      : (data instanceof Uint8Array ? { data: new Uint8Array(data) } : null);
    if (!source || !Number.isSafeInteger(pageNumber) || pageNumber < 1
      || !Number.isSafeInteger(width) || width < 600 || width > 1600) throw new Error('Invalid page request');
    let getDocument, createCanvas;
    try {
      ({ getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'));
      ({ createCanvas } = await import('@napi-rs/canvas'));
    } catch {
      result = { ok: false, status: 503 };
      return;
    }
    task = getDocument({
      ...source, disableStream: true, disableAutoFetch: true,
      isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
      ...pdfAssetPaths, cMapPacked: true, stopAtErrors: true, verbosity: 0,
    });
    const pdf = await task.promise;
    page = await pdf.getPage(pageNumber);
    const natural = page.getViewport({ scale: 1 });
    if (![natural.width, natural.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid page dimensions');
    const viewport = page.getViewport({ scale: Math.min(width / natural.width, 2400 / natural.height) });
    canvas = createCanvas(Math.max(1, Math.min(width, Math.ceil(viewport.width))), Math.max(1, Math.min(2400, Math.ceil(viewport.height))));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)' }).promise;
    const png = await canvas.encode('png');
    result = { ok: true, width: canvas.width, height: canvas.height, image: png.toString('base64') };
  } catch {
    result = { ok: false, status: 422 };
  } finally {
    page?.cleanup();
    if (task) await task.destroy().catch(() => {});
    if (canvas) { canvas.width = 1; canvas.height = 1; }
    if (process.connected) process.send(result || { ok: false, status: 422 }, () => process.disconnect());
  }
});
