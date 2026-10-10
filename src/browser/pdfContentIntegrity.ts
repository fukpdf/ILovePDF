/**
 * Cryptographic guard for page content streams using QPDF JSON v2.
 *
 * The caller must obtain JSON with --json-stream-data=inline and
 * --decode-level=all. Streams that still have a Filter entry are rejected:
 * a hash of encoded bytes is not proof of decoded-content identity.
 *
 * This deliberately compares every page's ordered stream list. It fails closed
 * if QPDF omits a page, content stream, or stream payload.
 */

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type QpdfJson = { qpdf?: JsonValue[] };

export interface PageContentStreamHashes {
  pageCount: number;
  pages: string[][];
}

function objectRef(value: JsonValue | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d+)\s+(\d+)\s+R$/);
  return match ? `obj:${match[1]} ${match[2]} R` : null;
}

function getObject(objects: JsonObject, ref: JsonValue | undefined): JsonObject {
  const key = objectRef(ref);
  if (!key) throw new Error("QPDF JSON contains an invalid or missing indirect reference.");
  const value = objects[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`QPDF JSON is missing referenced object ${key}.`);
  }
  return value as JsonObject;
}

function getValueObject(objects: JsonObject, ref: JsonValue | undefined): JsonObject {
  const wrapped = getObject(objects, ref);
  const value = wrapped.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("QPDF JSON reference does not resolve to a dictionary.");
  }
  return value as JsonObject;
}

function decodeBase64(value: JsonValue | undefined): Uint8Array {
  if (typeof value !== "string") throw new Error("QPDF JSON omitted decoded page content stream bytes.");
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("QPDF JSON contains invalid base64 stream data.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(bytes: Uint8Array, subtle: SubtleCrypto): Promise<string> {
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashPageContentStreams(
  jsonText: string,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<PageContentStreamHashes> {
  let parsed: QpdfJson;
  try {
    parsed = JSON.parse(jsonText) as QpdfJson;
  } catch {
    throw new Error("QPDF did not return valid JSON for content-stream validation.");
  }
  if (!Array.isArray(parsed.qpdf) || parsed.qpdf.length < 2) {
    throw new Error("QPDF JSON v2 object table is missing.");
  }
  const objects = parsed.qpdf[1];
  if (!objects || typeof objects !== "object" || Array.isArray(objects)) {
    throw new Error("QPDF JSON object table has an invalid shape.");
  }
  const objectTable = objects as JsonObject;
  const trailer = objectTable.trailer;
  if (!trailer || typeof trailer !== "object" || Array.isArray(trailer)) {
    throw new Error("QPDF JSON trailer is missing.");
  }
  const trailerValue = (trailer as JsonObject).value;
  if (!trailerValue || typeof trailerValue !== "object" || Array.isArray(trailerValue)) {
    throw new Error("QPDF JSON trailer dictionary is missing.");
  }
  const rootRef = (trailerValue as JsonObject)["/Root"];
  const catalog = getValueObject(objectTable, rootRef);
  const pagesRef = catalog["/Pages"];
  if (!pagesRef) throw new Error("PDF catalog has no page-tree root.");

  const pages: string[][] = [];
  const visiting = new Set<string>();
  const walkPages = async (nodeRef: JsonValue): Promise<void> => {
    const key = objectRef(nodeRef);
    if (!key || visiting.has(key)) throw new Error("Invalid or cyclic PDF page tree.");
    visiting.add(key);
    const wrapped = getObject(objectTable, nodeRef);
    const nodeValue = wrapped.value;
    if (!nodeValue || typeof nodeValue !== "object" || Array.isArray(nodeValue)) {
      throw new Error("PDF page-tree node is not a dictionary.");
    }
    const dict = nodeValue as JsonObject;
    if (dict["/Type"] === "/Page") {
      const contents = dict["/Contents"];
      let refs: JsonValue[] = [];
      if (contents !== undefined && contents !== null) {
        if (Array.isArray(contents)) {
          refs = contents;
        } else {
          const referencedContents = getObject(objectTable, contents);
          if (referencedContents.stream) {
            refs = [contents];
          } else if (Array.isArray(referencedContents.value)) {
            refs = referencedContents.value;
          } else {
            throw new Error("PDF page Contents reference is neither a stream nor an array.");
          }
        }
      }
      const hashes: string[] = [];
      for (const contentRef of refs) {
        const streamObject = getObject(objectTable, contentRef);
        const stream = streamObject.stream;
        if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
          throw new Error("Page content reference is not a stream object.");
        }
        const streamRecord = stream as JsonObject;
        const streamDict = streamRecord.dict;
        if (!streamDict || typeof streamDict !== "object" || Array.isArray(streamDict)) {
          throw new Error("Page content stream dictionary is missing.");
        }
        if (Object.prototype.hasOwnProperty.call(streamDict, "/Filter") ||
            Object.prototype.hasOwnProperty.call(streamDict, "/DecodeParms")) {
          throw new Error("QPDF did not fully decode a page content stream; refusing to certify it.");
        }
        hashes.push(await sha256(decodeBase64(streamRecord.data), subtle));
      }
      pages.push(hashes);
    } else if (dict["/Type"] === "/Pages") {
      const kids = dict["/Kids"];
      if (!Array.isArray(kids)) throw new Error("PDF page-tree node has no Kids array.");
      for (const kid of kids) await walkPages(kid);
    } else {
      throw new Error("PDF page tree contains an unexpected node type.");
    }
    visiting.delete(key);
  };
  await walkPages(pagesRef);
  if (pages.length === 0) throw new Error("QPDF JSON contains no pages.");
  return { pageCount: pages.length, pages };
}

export function assertPageContentStreamsUnchanged(
  before: PageContentStreamHashes,
  after: PageContentStreamHashes,
): void {
  if (before.pageCount !== after.pageCount || before.pages.length !== after.pages.length) {
    throw new Error("Compression changed the PDF page count.");
  }
  for (let page = 0; page < before.pages.length; page++) {
    const left = before.pages[page];
    const right = after.pages[page];
    if (left.length !== right.length || left.some((hash, i) => hash !== right[i])) {
      throw new Error(`Compression changed decoded page content streams on page ${page + 1}.`);
    }
  }
}


/**
 * Select only the catalog/page-tree objects and page-content streams for the
 * second QPDF JSON pass. This keeps large embedded image payloads out of the
 * integrity report while still including every object needed to resolve page
 * order and /Contents arrays.
 */
export function selectPageContentObjects(jsonText: string): string[] {
  let parsed: QpdfJson;
  try {
    parsed = JSON.parse(jsonText) as QpdfJson;
  } catch {
    throw new Error("QPDF did not return valid JSON while discovering content streams.");
  }
  if (!Array.isArray(parsed.qpdf) || parsed.qpdf.length < 2) {
    throw new Error("QPDF JSON v2 object table is missing.");
  }
  const rawObjects = parsed.qpdf[1];
  if (!rawObjects || typeof rawObjects !== "object" || Array.isArray(rawObjects)) {
    throw new Error("QPDF JSON object table has an invalid shape.");
  }
  const objects = rawObjects as JsonObject;
  const trailer = objects.trailer;
  if (!trailer || typeof trailer !== "object" || Array.isArray(trailer)) {
    throw new Error("QPDF JSON trailer is missing.");
  }
  const trailerValue = (trailer as JsonObject).value;
  if (!trailerValue || typeof trailerValue !== "object" || Array.isArray(trailerValue)) {
    throw new Error("QPDF JSON trailer dictionary is missing.");
  }

  const selected = new Set<string>(["trailer"]);
  const addRef = (ref: JsonValue | undefined): string => {
    const key = objectRef(ref);
    if (!key) throw new Error("QPDF JSON contains an invalid indirect reference.");
    selected.add(key);
    return key;
  };
  const visiting = new Set<string>();
  const walk = (ref: JsonValue): void => {
    const key = addRef(ref);
    if (visiting.has(key)) throw new Error("Invalid or cyclic PDF page tree.");
    visiting.add(key);
    const wrapped = getObject(objects, ref);
    const rawValue = wrapped.value;
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      throw new Error("PDF page-tree node is not a dictionary.");
    }
    const dict = rawValue as JsonObject;
    if (dict["/Type"] === "/Page") {
      const contents = dict["/Contents"];
      if (contents !== undefined && contents !== null) {
        if (Array.isArray(contents)) {
          for (const item of contents) addContent(item);
        } else {
          addContent(contents);
        }
      }
    } else if (dict["/Type"] === "/Pages") {
      const kids = dict["/Kids"];
      if (!Array.isArray(kids)) throw new Error("PDF page-tree node has no Kids array.");
      for (const kid of kids) walk(kid);
    } else {
      throw new Error("PDF page tree contains an unexpected node type.");
    }
    visiting.delete(key);
  };
  const addContent = (ref: JsonValue): void => {
    const key = addRef(ref);
    const wrapped = getObject(objects, ref);
    if (wrapped.stream) return;
    if (Array.isArray(wrapped.value)) {
      for (const child of wrapped.value) addContent(child);
      return;
    }
    throw new Error("Page Contents reference is neither a stream nor an array.");
  };

  const rootRef = (trailerValue as JsonObject)["/Root"];
  const catalogKey = addRef(rootRef);
  const catalogObject = getObject(objects, rootRef);
  const catalogValue = catalogObject.value;
  if (!catalogValue || typeof catalogValue !== "object" || Array.isArray(catalogValue)) {
    throw new Error("PDF catalog dictionary is missing.");
  }
  const pagesRef = (catalogValue as JsonObject)["/Pages"];
  if (!pagesRef) throw new Error("PDF catalog has no page-tree root.");
  walk(pagesRef);

  return Array.from(selected, key => {
    if (key === "trailer") return key;
    const match = key.match(/^obj:(\d+)\s+(\d+)\s+R$/);
    if (!match) throw new Error("Invalid QPDF object selector.");
    return `${match[1]},${match[2]}`;
  });
}


function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as JsonObject;
    return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}


/** Select raw stream objects that must remain byte-identical, excluding page-content
 * streams (checked after decoding) and eligible RGB DCT image streams (the only
 * streams the light engine may re-encode). Object/xref stream containers are storage. */
export function selectProtectedStreamObjects(jsonText: string): string[] {
  let parsed: QpdfJson;
  try { parsed = JSON.parse(jsonText) as QpdfJson; }
  catch { throw new Error("QPDF did not return valid JSON while selecting protected streams."); }
  if (!Array.isArray(parsed.qpdf) || parsed.qpdf.length < 2 || !parsed.qpdf[1] ||
      typeof parsed.qpdf[1] !== "object" || Array.isArray(parsed.qpdf[1])) {
    throw new Error("QPDF JSON object table is missing while selecting protected streams.");
  }
  const objects = parsed.qpdf[1] as JsonObject;
  const trailer = objects.trailer;
  if (!trailer || typeof trailer !== "object" || Array.isArray(trailer)) throw new Error("QPDF trailer is missing.");
  const trailerValue = (trailer as JsonObject).value;
  if (!trailerValue || typeof trailerValue !== "object" || Array.isArray(trailerValue)) throw new Error("QPDF trailer dictionary is missing.");
  const catalog = getValueObject(objects, (trailerValue as JsonObject)["/Root"]);
  const root = catalog["/Pages"];
  if (!root) throw new Error("PDF catalog has no page-tree root.");
  const pageContentRefs = new Set<string>(), visiting = new Set<string>();
  const walkPages = (ref: JsonValue): void => {
    const key = objectRef(ref);
    if (!key || visiting.has(key)) throw new Error("Invalid or cyclic page tree while selecting protected streams.");
    visiting.add(key);
    const wrapped = getObject(objects, ref), value = wrapped.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid page-tree object.");
    const dict = value as JsonObject;
    if (dict["/Type"] === "/Page") {
      const contents = dict["/Contents"];
      if (Array.isArray(contents)) {
        for (const child of contents) { const childKey = objectRef(child); if (!childKey) throw new Error("Invalid page content reference."); pageContentRefs.add(childKey); }
      } else if (contents !== undefined && contents !== null) {
        const contentKey = objectRef(contents);
        if (!contentKey) throw new Error("Invalid page content reference.");
        const contentObject = getObject(objects, contents);
        if (contentObject.stream) pageContentRefs.add(contentKey);
        else if (Array.isArray(contentObject.value)) {
          for (const child of contentObject.value) { const childKey = objectRef(child); if (!childKey) throw new Error("Invalid indirect content-array reference."); pageContentRefs.add(childKey); }
        } else throw new Error("Page Contents reference is neither a stream nor an array.");
      }
    } else if (dict["/Type"] === "/Pages" && Array.isArray(dict["/Kids"])) {
      for (const child of dict["/Kids"] as JsonValue[]) walkPages(child);
    } else throw new Error("Unexpected page-tree node type.");
  };
  walkPages(root);
  const selected: string[] = [];
  for (const [key, entry] of Object.entries(objects)) {
    if (!key.startsWith("obj:") || !entry || typeof entry !== "object" || Array.isArray(entry) || isContainerStream(entry)) continue;
    const stream = (entry as JsonObject).stream;
    if (!stream || typeof stream !== "object" || Array.isArray(stream)) continue;
    if (pageContentRefs.has(key)) continue;
    const dict = (stream as JsonObject).dict;
    if (!dict || typeof dict !== "object" || Array.isArray(dict)) throw new Error(`Stream dictionary missing for ${key}.`);
    if (eligibleReencodedImage(dict as JsonObject)) continue;
    selected.push(key);
  }
  return selected.sort();
}

/** Hash raw payloads of protected streams. Page content is verified separately
 * with decoded SHA-256; all non-eligible image/font/form/metadata streams stay raw-identical. */
export async function hashProtectedStreams(jsonText: string, subtle: SubtleCrypto = crypto.subtle): Promise<Record<string, string>> {
  let parsed: QpdfJson;
  try { parsed = JSON.parse(jsonText) as QpdfJson; }
  catch { throw new Error("QPDF did not return valid JSON for protected-stream hashing."); }
  if (!Array.isArray(parsed.qpdf) || parsed.qpdf.length < 2 || !parsed.qpdf[1] ||
      typeof parsed.qpdf[1] !== "object" || Array.isArray(parsed.qpdf[1])) {
    throw new Error("QPDF JSON object table is missing during protected-stream hashing.");
  }
  const objects = parsed.qpdf[1] as JsonObject, hashes: Record<string, string> = {};
  for (const [key, entry] of Object.entries(objects)) {
    if (!key.startsWith("obj:") || !entry || typeof entry !== "object" || Array.isArray(entry) || isContainerStream(entry)) continue;
    const stream = (entry as JsonObject).stream;
    if (!stream || typeof stream !== "object" || Array.isArray(stream)) continue;
    const record = stream as JsonObject;
    const dict = record.dict;
    if (dict && typeof dict === "object" && !Array.isArray(dict) && eligibleReencodedImage(dict as JsonObject)) continue;
    if (typeof record.data !== "string") throw new Error(`QPDF omitted raw bytes for protected stream ${key}.`);
    hashes[key] = await sha256(decodeBase64(record.data), subtle);
  }
  return hashes;
}

export function assertProtectedStreamsUnchanged(before: Record<string, string>, after: Record<string, string>): void {
  const left = Object.keys(before).sort(), right = Object.keys(after).sort();
  if (stableJson(left) !== stableJson(right)) throw new Error("Protected stream object set changed.");
  for (const key of left) if (before[key] !== after[key]) throw new Error(`Protected stream bytes changed for ${key}; original must be preserved.`);
}

function isContainerStream(entry: JsonValue | undefined): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const stream = (entry as JsonObject).stream;
  if (!stream || typeof stream !== "object" || Array.isArray(stream)) return false;
  const dict = (stream as JsonObject).dict;
  if (!dict || typeof dict !== "object" || Array.isArray(dict)) return false;
  const type = (dict as JsonObject)["/Type"];
  return type === "/ObjStm" || type === "/XRef";
}

/**
 * Compare every non-container PDF object dictionary before and after a QPDF
 * structural pass. This covers AcroForm fields, widget annotations, links,
 * outlines, attachments, tagged structure, metadata dictionaries and actions.
 * QPDF is invoked with --stream-data=preserve; page content streams additionally
 * receive decoded SHA-256 verification in hashPageContentStreams.
 */
function eligibleReencodedImage(dict: JsonObject): boolean {
  return dict["/Subtype"] === "/Image" &&
    dict["/Filter"] === "/DCTDecode" &&
    dict["/ColorSpace"] === "/DeviceRGB" &&
    dict["/SMask"] == null && dict["/Mask"] == null &&
    dict["/Decode"] == null && dict["/ImageMask"] == null;
}

function allowedImageDictionaryChange(leftEntry: JsonValue | undefined, rightEntry: JsonValue | undefined): boolean {
  if (!leftEntry || typeof leftEntry !== "object" || Array.isArray(leftEntry) ||
      !rightEntry || typeof rightEntry !== "object" || Array.isArray(rightEntry)) return false;
  const leftStream = (leftEntry as JsonObject).stream, rightStream = (rightEntry as JsonObject).stream;
  if (!leftStream || typeof leftStream !== "object" || Array.isArray(leftStream) ||
      !rightStream || typeof rightStream !== "object" || Array.isArray(rightStream)) return false;
  const leftDict = (leftStream as JsonObject).dict, rightDict = (rightStream as JsonObject).dict;
  if (!leftDict || typeof leftDict !== "object" || Array.isArray(leftDict) ||
      !rightDict || typeof rightDict !== "object" || Array.isArray(rightDict)) return false;
  const a = leftDict as JsonObject, b = rightDict as JsonObject;
  if (!eligibleReencodedImage(a) || !eligibleReencodedImage(b)) return false;
  const strip = (dict: JsonObject): JsonObject => {
    const copy = { ...dict };
    delete copy["/Width"]; delete copy["/Height"]; delete copy["/Length"];
    return copy;
  };
  return stableJson(strip(a)) === stableJson(strip(b)) &&
    [a["/Width"], a["/Height"], b["/Width"], b["/Height"]].every(v => typeof v === "number" && v > 0) &&
    [a["/Length"], b["/Length"]].every(v => typeof v === "number" && v > 0);
}

export function assertDocumentStructureUnchanged(beforeJson: string, afterJson: string, allowImageStreamChanges = false): void {
  const parse = (text: string): { header: JsonValue; objects: JsonObject; trailer: JsonObject } => {
    let parsed: QpdfJson;
    try {
      parsed = JSON.parse(text) as QpdfJson;
    } catch {
      throw new Error("QPDF returned invalid JSON while checking document structure.");
    }
    if (!Array.isArray(parsed.qpdf) || parsed.qpdf.length < 2 ||
        !parsed.qpdf[0] || typeof parsed.qpdf[0] !== "object" ||
        !parsed.qpdf[1] || typeof parsed.qpdf[1] !== "object" || Array.isArray(parsed.qpdf[1])) {
      throw new Error("QPDF JSON object table is missing during structure validation.");
    }
    const objects = parsed.qpdf[1] as JsonObject;
    const trailerEntry = objects.trailer;
    if (!trailerEntry || typeof trailerEntry !== "object" || Array.isArray(trailerEntry)) {
      throw new Error("QPDF JSON trailer is missing during structure validation.");
    }
    const trailer = (trailerEntry as JsonObject).value;
    if (!trailer || typeof trailer !== "object" || Array.isArray(trailer)) {
      throw new Error("QPDF JSON trailer dictionary is missing during structure validation.");
    }
    return { header: parsed.qpdf[0], objects, trailer: trailer as JsonObject };
  };

  const before = parse(beforeJson);
  const after = parse(afterJson);
  const trailerKeys = ["/Root", "/Info", "/ID", "/Encrypt"];
  for (const key of trailerKeys) {
    if (stableJson(before.trailer[key] ?? null) !== stableJson(after.trailer[key] ?? null)) {
      throw new Error(`Compression changed trailer entry ${key}; the original must be preserved.`);
    }
  }

  const beforeKeys = Object.keys(before.objects).filter(key => key.startsWith("obj:") && !isContainerStream(before.objects[key]));
  const afterKeys = Object.keys(after.objects).filter(key => key.startsWith("obj:") && !isContainerStream(after.objects[key]));
  const afterSet = new Set(afterKeys);
  const beforeSet = new Set(beforeKeys);

  for (const key of beforeKeys) {
    if (!afterSet.has(key)) {
      throw new Error(`Compression removed document structure object ${key}; the original must be preserved.`);
    }
    const left = before.objects[key] as JsonObject;
    const right = after.objects[key] as JsonObject;
    const leftStream = left.stream;
    const rightStream = right.stream;
    if (!!leftStream !== !!rightStream) {
      throw new Error(`Compression changed object kind for ${key}; the original must be preserved.`);
    }
    const leftPayload: JsonValue = leftStream && typeof leftStream === "object" && !Array.isArray(leftStream)
      ? { stream: (leftStream as JsonObject).dict ?? null }
      : { value: left.value ?? null };
    const rightPayload: JsonValue = rightStream && typeof rightStream === "object" && !Array.isArray(rightStream)
      ? { stream: (rightStream as JsonObject).dict ?? null }
      : { value: right.value ?? null };
    if (stableJson(leftPayload) !== stableJson(rightPayload)) {
      if (allowImageStreamChanges && allowedImageDictionaryChange(before.objects[key], after.objects[key])) continue;
      throw new Error(`Compression changed document structure object ${key}; the original must be preserved.`);
    }
  }
  for (const key of afterKeys) {
    if (!beforeSet.has(key)) {
      throw new Error(`Compression introduced unexpected document structure object ${key}; the original must be preserved.`);
    }
  }
}

/**
 * Reject PDF structures that the current lossless structural pass does not
 * explicitly support. The caller must return the original bytes on failure.
 */
export function assertCompressionEligible(jsonText: string): void {
  let parsed: QpdfJson;
  try {
    parsed = JSON.parse(jsonText) as QpdfJson;
  } catch {
    throw new Error("QPDF did not return valid JSON during safety preflight.");
  }
  if (!Array.isArray(parsed.qpdf) || parsed.qpdf.length < 2) {
    throw new Error("QPDF JSON v2 object table is missing.");
  }
  const rawObjects = parsed.qpdf[1];
  if (!rawObjects || typeof rawObjects !== "object" || Array.isArray(rawObjects)) {
    throw new Error("QPDF JSON object table has an invalid shape.");
  }
  const objects = rawObjects as JsonObject;
  const trailer = objects.trailer;
  if (!trailer || typeof trailer !== "object" || Array.isArray(trailer)) {
    throw new Error("QPDF JSON trailer is missing.");
  }
  const trailerValue = (trailer as JsonObject).value;
  if (!trailerValue || typeof trailerValue !== "object" || Array.isArray(trailerValue)) {
    throw new Error("QPDF JSON trailer dictionary is missing.");
  }
  const catalog = getValueObject(objects, (trailerValue as JsonObject)["/Root"]);
  // Interactive fields, links, annotations, outlines, attachments, tags and
  // actions may pass only because the later whole-object comparison verifies
  // their dictionaries remain byte-for-byte equivalent at the PDF object level.
  // Permission dictionaries can imply DocMDP/signature restrictions and fail closed.
  const unsafeCatalogKeys = ["/Perms"];
  const foundCatalogKey = unsafeCatalogKeys.find(key => catalog[key] !== undefined && catalog[key] !== null);
  if (foundCatalogKey) {
    throw new Error(`This PDF contains unsupported document structure (${foundCatalogKey}); the original will be preserved.`);
  }
  if ((trailerValue as JsonObject)["/Encrypt"] !== undefined &&
      (trailerValue as JsonObject)["/Encrypt"] !== null) {
    throw new Error("This PDF contains unsupported document structure (/Encrypt); the original will be preserved.");
  }

  // Signatures and XFA dictionaries can be indirect or packed into object
  // streams, so raw-byte marker scans alone cannot safely classify a PDF.
  // Walk parsed dictionary keys throughout the QPDF object table and fail
  // closed before any candidate is written.
  const unsafeNestedKeys = ["/ByteRange", "/XFA", "/SigFlags"];
  const seen = new Set<object>();
  const findUnsafeNestedKey = (value: JsonValue): string | null => {
    if (!value || typeof value !== "object") return null;
    if (seen.has(value as object)) return null;
    seen.add(value as object);
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findUnsafeNestedKey(child);
        if (found) return found;
      }
      return null;
    }
    for (const [key, child] of Object.entries(value)) {
      if (unsafeNestedKeys.includes(key) && child !== null) return key;
      const found = findUnsafeNestedKey(child);
      if (found) return found;
    }
    return null;
  };
  for (const [key, value] of Object.entries(objects)) {
    if (key === "trailer") continue;
    const found = findUnsafeNestedKey(value);
    if (found) {
      throw new Error(`This PDF contains unsupported document structure (${found}); the original will be preserved.`);
    }
  }
  const visited = new Set<string>();
  const walk = (ref: JsonValue): void => {
    const key = objectRef(ref);
    if (!key || visited.has(key)) throw new Error("Invalid or cyclic PDF page tree.");
    visited.add(key);
    const wrapped = getObject(objects, ref);
    const rawValue = wrapped.value;
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      throw new Error("PDF page-tree node is not a dictionary.");
    }
    const dict = rawValue as JsonObject;
    if (dict["/Type"] === "/Page") {
      // /Annots and /AA are allowed only when the full object dictionary
      // comparison after QPDF confirms their references and values did not change.
    } else if (dict["/Type"] === "/Pages") {
      const kids = dict["/Kids"];
      if (!Array.isArray(kids)) throw new Error("PDF page-tree node has no Kids array.");
      for (const kid of kids) walk(kid);
    } else {
      throw new Error("PDF page tree contains an unexpected node type.");
    }
  };
  const rootRef = (trailerValue as JsonObject)["/Root"];
  const catalogObject = getValueObject(objects, rootRef);
  const pagesRef = catalogObject["/Pages"];
  if (!pagesRef) throw new Error("PDF catalog has no page-tree root.");
  walk(pagesRef);
}
