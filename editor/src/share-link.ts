// Shareable permalinks: encode the current document into the URL hash so a
// single link reopens the editor with the same doc — no server, no storage.
//
// The doc lives in the fragment (after `#`), never the query string, so it is
// never sent to a server. Payload layout after `#doc=`:
//
//   <scheme><base64url>
//     scheme "1" = gzip (default; ~20:1 on real topology docs)
//     scheme "0" = identity (fallback when CompressionStream is unavailable)
//
// The one-char scheme marker lets a reader decode a link regardless of which
// path the writer took, so links stay portable across browsers.

export const HASH_PREFIX = "#doc=";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const hasCompression =
  typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Web Streams is the only built-in gzip. The casts bridge TS 5.7's tightened
// Uint8Array<ArrayBuffer> vs <ArrayBufferLike> generics — the bytes are
// correct at runtime; only the compile-time buffer brand differs.
type ByteTransform = ReadableWritablePair<Uint8Array, Uint8Array>;

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as unknown as BlobPart]).stream() as ReadableStream<Uint8Array>;
}

async function run(bytes: Uint8Array, transform: ByteTransform): Promise<Uint8Array> {
  const out = byteStream(bytes).pipeThrough(transform);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return run(bytes, new CompressionStream("gzip") as unknown as ByteTransform);
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return run(bytes, new DecompressionStream("gzip") as unknown as ByteTransform);
}

/** Encode document text into a hash payload (the part after `#doc=`). */
export async function encodeDoc(text: string): Promise<string> {
  const raw = encoder.encode(text);
  if (hasCompression) return "1" + toBase64Url(await gzip(raw));
  return "0" + toBase64Url(raw);
}

/** Decode a hash payload back into document text. Throws on a malformed payload. */
export async function decodeDoc(payload: string): Promise<string> {
  const scheme = payload[0];
  const body = fromBase64Url(payload.slice(1));
  if (scheme === "1") return decoder.decode(await gunzip(body));
  if (scheme === "0") return decoder.decode(body);
  throw new Error(`unknown share-link scheme "${scheme}"`);
}

/** Extract a doc payload from a location hash, or null when none is present. */
export function docFromHash(hash: string): string | null {
  return hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) : null;
}

/** Build an absolute, shareable URL that reopens the editor with `text` loaded. */
export async function buildShareUrl(
  text: string,
  base: { origin: string; pathname: string },
): Promise<string> {
  return `${base.origin}${base.pathname}${HASH_PREFIX}${await encodeDoc(text)}`;
}
