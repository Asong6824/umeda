import { getDocument } from 'pdfjs-dist';

/** A transient, lazy page render. Original bytes remain in the host's existing cache. */
export async function mountPdfPreview(bytes: Uint8Array, canvas: HTMLCanvasElement, pageNumber: number, current: () => boolean) {
  const loading = getDocument({ data: bytes.slice().buffer });
  let pdf: Awaited<typeof loading.promise> | undefined;
  try {
    pdf = await loading.promise;
    if (!current()) { await pdf.destroy(); return () => {}; }
    if (pageNumber > pdf.numPages) throw new Error('PREVIEW_PAGE_OUT_OF_RANGE');
    const page = await pdf.getPage(Math.max(1, pageNumber));
    const viewport = page.getViewport({ scale: 1 });
    const scaled = page.getViewport({ scale: 560 / viewport.width });
    canvas.width = Math.ceil(scaled.width); canvas.height = Math.ceil(scaled.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PREVIEW_CANVAS_UNAVAILABLE');
    const render = page.render({ canvas, canvasContext: context, viewport: scaled });
    await render.promise;
    canvas.dataset.previewReady = 'true';
    if (!current()) { await pdf.destroy(); return () => {}; }
    return () => { void pdf!.destroy(); delete canvas.dataset.previewReady; canvas.width = 0; canvas.height = 0; };
  } catch (error) { await (pdf?.destroy() ?? loading.destroy()); throw error; }
}
