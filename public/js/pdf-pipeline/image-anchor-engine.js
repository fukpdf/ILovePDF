// image-anchor-engine.js — PDF Image Extraction & DOCX Anchoring
// Phase 6 of PDF→Word Fidelity Pipeline
// Extracts raster images from PDF.js operator lists and anchors them in DOCX
// as inline DrawingML elements with correct aspect ratios.
(function () {
  'use strict';
  window.PDFPipeline = window.PDFPipeline || {};

  // PDF.js operator codes for image paint operations
  const OPS_PAINT_IMAGE = 85;   // paintImageXObject
  const OPS_PAINT_IMAGE_REPEAT = 88; // paintImageXObjectRepeat

  /**
   * Extract raster images from a single PDF.js page.
   * Returns an array of image descriptors:
   *   { dataUrl, width, height, aspectRatio, name, index }
   *
   * @param {Object} page     - PDF.js page object (page.getOperatorList(), page.objs)
   * @param {number} minSize  - minimum image dimension in px to include (default: 24)
   */
  async function extractPageImages(page, minSize) {
    minSize = minSize || 24;
    const images = [];

    try {
      const opList = await page.getOperatorList();

      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        if (fn !== OPS_PAINT_IMAGE && fn !== OPS_PAINT_IMAGE_REPEAT) continue;

        const imgName = opList.argsArray[i][0];
        if (!imgName) continue;

        // Resolve image object — try page-local objs first, then common objs
        let imgObj = null;
        try { imgObj = page.objs.get(imgName); }       catch (_) {}
        if (!imgObj || !imgObj.data) {
          try { imgObj = page.commonObjs.get(imgName); } catch (_) {}
        }
        if (!imgObj || !imgObj.data) continue;
        if (imgObj.width < minSize || imgObj.height < minSize) continue;

        // Prevent duplicates by name
        if (images.some(im => im.name === imgName)) continue;

        const dataUrl = _imgObjToDataUrl(imgObj);
        if (!dataUrl) continue;

        images.push({
          dataUrl,
          width:       imgObj.width,
          height:      imgObj.height,
          aspectRatio: imgObj.width / Math.max(1, imgObj.height),
          name:        imgName,
          index:       images.length,
        });
      }
    } catch (e) {
      if (window.PDF_FIDELITY_DEBUG) console.warn('[ImageAnchor] extractPageImages error:', e.message);
    }

    return images;
  }

  /**
   * Convert a PDF.js image object to a PNG data URL.
   * Handles RGBA (4 ch), RGB (3 ch), and Grayscale (1 ch) data.
   */
  function _imgObjToDataUrl(imgObj) {
    try {
      const { width, height, data } = imgObj;
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      const ctx     = canvas.getContext('2d');
      const imgData = ctx.createImageData(width, height);
      const dst     = imgData.data;
      const src     = data;
      const pixels  = width * height;

      if (src.length === pixels * 4) {
        dst.set(src);
      } else if (src.length === pixels * 3) {
        for (let p = 0; p < pixels; p++) {
          dst[p * 4]     = src[p * 3];
          dst[p * 4 + 1] = src[p * 3 + 1];
          dst[p * 4 + 2] = src[p * 3 + 2];
          dst[p * 4 + 3] = 255;
        }
      } else if (src.length === pixels) {
        for (let p = 0; p < pixels; p++) {
          dst[p * 4] = dst[p * 4 + 1] = dst[p * 4 + 2] = src[p];
          dst[p * 4 + 3] = 255;
        }
      } else {
        return null; // Unknown colour space
      }

      ctx.putImageData(imgData, 0, 0);
      const url = canvas.toDataURL('image/png', 0.9);
      // Clean up
      canvas.width = 0; canvas.height = 0;
      return url;
    } catch (_) {
      return null;
    }
  }

  /**
   * Convert a data URL + rId into a relationship descriptor for DOCX packaging.
   * Returns { rId, fileName, base64, mimeType, relXml }
   */
  function prepareImageRelationship(dataUrl, rIdNum) {
    const isPng  = dataUrl.startsWith('data:image/png');
    const ext    = isPng ? 'png' : 'jpg';
    const mime   = isPng ? 'image/png' : 'image/jpeg';
    const base64 = dataUrl.split(',')[1] || '';
    const rId    = `rId${rIdNum}`;
    return {
      rId,
      fileName: `image${rIdNum}.${ext}`,
      base64,
      mimeType: mime,
      relXml:  `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${rIdNum}.${ext}"/>`,
    };
  }

  /**
   * Build the OOXML paragraph containing an inline DrawingML image.
   *
   * @param {number} rIdNum      - relationship ID number (e.g. 5)
   * @param {number} widthPx     - original image pixel width
   * @param {number} heightPx    - original image pixel height
   * @param {number} maxWidthEmu - maximum width in EMU (default: 5400000 ≈ 4.25")
   * @param {string} label       - accessibility description
   */
  function buildImageXml(rIdNum, widthPx, heightPx, maxWidthEmu, label) {
    const MAX_W = maxWidthEmu || 5400000; // ~4.25 inches
    const ar    = (widthPx && heightPx) ? widthPx / heightPx : 4 / 3;
    const cx    = Math.min(MAX_W, Math.round(widthPx * 9525)); // 1px ≈ 9525 EMU at 96dpi
    const cy    = Math.round(cx / ar);
    const desc  = (label || 'image').replace(/[^a-zA-Z0-9 _-]/g, '');
    const rId   = `rId${rIdNum}`;

    return (
      `<w:p>` +
      `<w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/></w:pPr>` +
      `<w:r><w:rPr/>` +
      `<w:drawing>` +
      `<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${rIdNum}" name="${desc}"/>` +
      `<wp:cNvGraphicFramePr>` +
      `<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>` +
      `</wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr><pic:cNvPr id="${rIdNum}" name="${desc}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill>` +
      `<a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
      `<a:stretch><a:fillRect/></a:stretch>` +
      `</pic:blipFill>` +
      `<pic:spPr>` +
      `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `</pic:spPr>` +
      `</pic:pic>` +
      `</a:graphicData>` +
      `</a:graphic>` +
      `</wp:inline>` +
      `</w:drawing>` +
      `</w:r></w:p>`
    );
  }

  window.PDFPipeline.ImageAnchor = { extractPageImages, prepareImageRelationship, buildImageXml };

  if (window.PDF_FIDELITY_DEBUG) {
    console.log('[ImageAnchor] v1.0 loaded');
  }
})();
