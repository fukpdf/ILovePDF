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
