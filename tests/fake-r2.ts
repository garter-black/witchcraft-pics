// Corrected fake R2 with REAL documented conditional-write semantics.
// Official reference: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
//   put(key, value, {onlyIf:{etagMatches}}) -> R2Object on success,
//                                            null when the precondition fails.
// A failed conditional write writes NOTHING. There is no success boolean.
// The earlier mock returned {success:false} on failure, which inverted the
// claim CAS and would have passed a broken implementation, so this fake
// deliberately returns null and leaves the stored object untouched.
import { createHash } from "node:crypto";

type Rec = { body: Buffer; etag?: string; contentType?: string; customMetadata?: Record<string, string> };

export function fakeR2(seed: Record<string, string> = {}) {
  const store = new Map<string, Rec>();
  let n = 0;
  for (const [k, v] of Object.entries(seed)) {
    const body = Buffer.from(v, "utf8");
    store.set(k, { body, etag: etagOf(body), contentType: "application/json" });
  }

  function etagOf(body: Buffer) {
    return '"' + createHash("sha256").update(body).digest("hex").slice(0, 20) + '"';
  }

  const api = {
    store,
    /** test helper: force a specific etag for a stored object */
    poison(key: string) {
      const rec = store.get(key);
      if (rec) rec.etag = '"stale"';
    },
    /** test helper: remove the version tag, so exclusivity cannot be proven */
    stripEtag(key: string) {
      const rec = store.get(key);
      if (rec) (rec as { etag?: string }).etag = undefined as any;
    },
    bytes(key: string): Buffer | null {
      return store.get(key)?.body ?? null;
    },
    async get(key: string) {
      const rec = store.get(key);
      if (!rec) return null;
      const snapshot = rec;
      return {
        etag: snapshot.etag,
        key,
        size: snapshot.body.byteLength,
        httpMetadata: { contentType: snapshot.contentType },
        customMetadata: snapshot.customMetadata,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(snapshot.body));
            controller.close();
          },
        }),
        async arrayBuffer() {
          const copy = Buffer.from(snapshot.body);
          return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
        },
        async text() {
          return snapshot.body.toString("utf8");
        },
        async json<T>() {
          return JSON.parse(snapshot.body.toString("utf8")) as T;
        },
      };
    },
    async put(key: string, value: unknown, opts?: any) {
      const onlyIf = opts?.onlyIf;
      if (onlyIf) {
        // Real R2: a failed precondition writes nothing and returns null.
        if (store.get(key)?.etag !== onlyIf.etagMatches) return null;
      }
      const body = Buffer.isBuffer(value)
        ? Buffer.from(value)
        : value instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(value))
          : Buffer.from(String(value), "utf8");
      n += 1;
      const etag = etagOf(Buffer.concat([body, Buffer.from(String(n))]));
      store.set(key, {
        body,
        etag,
        contentType: opts?.httpMetadata?.contentType,
        customMetadata: { ...(opts?.customMetadata ?? {}), contentType: String(opts?.httpMetadata?.contentType ?? "") },
      });
      // Success returns the object, not a status wrapper.
      return { key, etag, size: body.byteLength };
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix, limit, cursor }: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).sort();
      const start = cursor ? keys.indexOf(cursor) + 1 : 0;
      const page = keys.slice(start, start + (limit ?? 1000));
      return { objects: page.map((key) => ({ key })), truncated: start + page.length < keys.length };
    },
  };
  return api;
}

/** A real PNG header followed by filler: enough bytes to be a genuine image
    signature, not a hand-waved fixture. */
export function pngBytes(pad = 64): Uint8Array {
  const header = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out = new Uint8Array(header.length + pad);
  out.set(header, 0);
  for (let i = header.length; i < out.length; i++) out[i] = (i * 7) % 251;
  return out;
}

/** A real ISO-BMFF header (....ftypmp42) followed by filler. */
export function mp4Bytes(pad = 64): Uint8Array {
  const out = new Uint8Array(pad + 12);
  const head = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32];
  out.set(head, 0);
  for (let i = 12; i < out.length; i++) out[i] = (i * 13) % 249;
  return out;
}
