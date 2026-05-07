import { PdfArray, PdfDict, PdfName, PdfNumber, type PdfRef } from './object'
import { PdfWriter } from './writer'

/**
 * High-level builder. Holds the writer + the page-tree refs and emits the
 * final bytes when `save()` is called.
 *
 * Intentionally minimal — adding features (images, fonts, text) layers on top
 * by `addPage`-equivalents that compose the right resources/contents into a
 * page dict. Each page is one PDF page; we don't optimize across pages.
 */
export class PdfDoc {
  private readonly writer = new PdfWriter()
  private readonly pagesRef: PdfRef
  private readonly pageRefs: PdfRef[] = []

  constructor() {
    this.pagesRef = this.writer.alloc()
  }

  /**
   * Add an empty page of the given size (PDF points). Returns the page ref so
   * later layers (image / text) can attach `Resources` / `Contents` to it.
   */
  addPage(width: number, height: number): PdfRef {
    const pageRef = this.writer.add(
      new PdfDict({
        Type: new PdfName('Page'),
        Parent: this.pagesRef,
        MediaBox: new PdfArray([
          new PdfNumber(0),
          new PdfNumber(0),
          new PdfNumber(width),
          new PdfNumber(height),
        ]),
        Resources: new PdfDict({}),
      }),
    )
    this.pageRefs.push(pageRef)
    return pageRef
  }

  save(): Uint8Array {
    const catalogRef = this.writer.add(
      new PdfDict({ Type: new PdfName('Catalog'), Pages: this.pagesRef }),
    )
    this.writer.assign(
      this.pagesRef,
      new PdfDict({
        Type: new PdfName('Pages'),
        Kids: new PdfArray(this.pageRefs),
        Count: new PdfNumber(this.pageRefs.length),
      }),
    )
    return this.writer.serialize(catalogRef)
  }
}
