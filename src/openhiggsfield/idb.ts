export type Kv = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  /** Delete a key so a wiped scope leaves no readable row behind. */
  remove(key: string): Promise<void>;
};

export type LegacyStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const DB_NAME = "openhiggsfield";
const STORE = "kv";
const VERSION = 1;

export function memoryKv(): Kv {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Connections a transaction currently owns. A wipe must not force-close one of
    these: closing mid-transaction strands the transaction's `oncomplete` and
    the read/write promise never settles (the exact hang this guards). Such a
    connection is closed by its own `settle()` when the transaction ends. */
const busyConnections = new Set<IDBDatabase>();

/** Every connection this module opens while live, so a credential wipe can close
    them and a `deleteDatabase` cannot be blocked by our own cached handle. */
const liveConnections = new Set<IDBDatabase>();

/** Open connections whose `open()` request has not resolved yet.

    `deleteDatabase` can be blocked by a connection that is still opening as
    well as one fully open, and the resolved connection is only added to
    `liveConnections` after `open()` settles. Tracking the in-flight promise
    lets a wipe wait for (and then close) a connection that was mid-open when
    the wipe began, so an open in flight cannot silently keep the database
    alive past the wipe. */
const pendingOpens = new Set<Promise<IDBDatabase>>();

/** Give a freshly opened connection its lifetime handlers: register it as live
    and close it if another context deletes/upgrades the database. A
    `versionchange` we do not act on would hang that other context — exactly the
    blocked-delete path this module has to avoid. A connection a transaction owns
    is NOT closed here; it settles with its transaction. */
function track(db: IDBDatabase): IDBDatabase {
  liveConnections.add(db);
  db.onversionchange = () => {
    if (busyConnections.has(db)) return; // let the active transaction finish
    release(db);
  };
  return db;
}

function release(db: IDBDatabase): void {
  liveConnections.delete(db);
  busyConnections.delete(db);
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

/** Close the cached browser handle and every live OR in-flight connection.

    `deleteDatabase` waits for all open connections to close; a cached,
    mid-transaction, or still-opening connection would stall it. This waits for
    any in-flight `open()` to settle and closes each idle connection, so the
    history database can be removed on logout instead of hanging. A connection
    that currently owns a transaction is LEFT ALONE — it is closed by its own
    transaction's settle path — so a wipe never strands an in-flight read/write.
    Safe to call when no browser (or no database) exists. */
export async function closeHistoryDatabase(): Promise<void> {
  // The cached `Kv` is a thin wrapper with no close hook; dropping the
  // reference lets it be collected. The actual connections this module opened
  // are tracked in `liveConnections` and closed individually.
  browser = undefined;
  // Wait for any open() currently in flight, then close whatever it returned,
  // so a connection that was half-open at the moment of the wipe cannot keep
  // the database alive.
  const pending = [...pendingOpens];
  if (pending.length > 0) {
    const settled = await Promise.allSettled(pending);
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        const db = outcome.value;
        // Only close it if its transaction already finished; otherwise the
        // transaction owns it and will close it on settle.
        if (!busyConnections.has(db)) release(db);
      }
    }
  }
  for (const db of [...liveConnections]) {
    if (busyConnections.has(db)) continue; // owned by an in-flight transaction
    release(db);
  }
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const opened = open();
  pendingOpens.add(opened);
  return opened.then(
    (db) => {
      track(db);
      return new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, mode);
        } catch (error) {
          // The connection was closed between open() resolving and here (a
          // concurrent wipe). This is a real, reportable failure, not a hang.
          pendingOpens.delete(opened);
          release(db);
          reject(error);
          return;
        }
        // This connection now owns a transaction: a wipe must not close it
        // until the transaction settles.
        busyConnections.add(db);
        const req = run(tx.objectStore(STORE));
        // The connection stays registered as in-flight until its transaction
        // settles, so a wipe that runs in between does not close it out from
        // under an active transaction (which would strand `oncomplete`).
        const settle = () => {
          pendingOpens.delete(opened);
          release(db);
        };
        tx.oncomplete = () => {
          settle();
          resolve(req.result);
        };
        tx.onabort = () => {
          settle();
          reject(tx.error ?? req.error);
        };
        tx.onerror = () => {
          settle();
          reject(tx.error ?? req.error);
        };
      });
    },
    (error) => {
      pendingOpens.delete(opened);
      throw error;
    },
  );
}

export function idbKv(): Kv {
  return {
    get<T>(key: string) {
      return request("readonly", (store) => store.get(key)) as Promise<T | undefined>;
    },
    async set(key, value) {
      await request("readwrite", (store) => store.put(value, key));
    },
    async remove(key) {
      await request("readwrite", (store) => store.delete(key));
    },
  };
}

let browser: Kv | undefined;

export function defaultKv(): Kv {
  if (typeof indexedDB === "undefined") return memoryKv();
  browser ??= idbKv();
  return browser;
}

export function browserLegacy(): LegacyStore | undefined {
  if (typeof localStorage === "undefined") return undefined;
  return localStorage;
}

/* ---------- reliable record removal + honest database deletion ----------

   A whole-database `deleteDatabase` can be BLOCKED by another tab and never
   complete. The reliable guarantee is the removal of the history RECORD on its
   own: we open a connection we control, delete the single key in a readwrite
   transaction, await its `oncomplete`, and close. That removes the readable row
   regardless of whether another context holds the database open. The whole
   database deletion then runs as a secondary, best-effort step and its result
   is REPORTED, never assumed. */

export type DatabaseDeleteResult = {
  /** True only when the deleteDatabase request actually completed. */
  deleted: boolean;
  /** True when another context held the database open and the delete was
      blocked. `deleted` is false here; the record removal is what guarantees
      the readable row is gone. */
  blocked: boolean;
};

/** Delete a single record from the history store in a transaction this module
    owns and closes, resolving only after the transaction commits.

    Resolves true when the record was removed (or when the store/database is
    absent, which is not a readable row) and rejects only on a real failure so
    the caller can report it rather than hide it. */
export async function removeHistoryRecord(key: string): Promise<boolean> {
  if (typeof indexedDB === "undefined") return true;
  const opened = open();
  pendingOpens.add(opened);
  let db: IDBDatabase;
  try {
    db = await opened;
  } finally {
    pendingOpens.delete(opened);
  }
  try {
    track(db);
    // A database that never got its store created has no readable row; that is
    // "nothing to remove", not a failure to remove one.
    if (!db.objectStoreNames.contains(STORE)) return true;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("the history delete aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("the history delete failed"));
    });
    return true;
  } finally {
    release(db);
  }
}

/** Every record key currently in the history-only kv store, in a transaction
    this module owns and closes. Used by a wipe to find EVERY sensitive row
    (including per-principal `history.v1.p_*` records) so the removal is
    exhaustive even when whole-database deletion is blocked. Returns [] when the
    store or database is absent. */
export async function listHistoryKeys(): Promise<string[]> {
  if (typeof indexedDB === "undefined") return [];
  const opened = open();
  pendingOpens.add(opened);
  let db: IDBDatabase;
  try {
    db = await opened;
  } finally {
    pendingOpens.delete(opened);
  }
  try {
    track(db);
    if (!db.objectStoreNames.contains(STORE)) return [];
    return await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      tx.oncomplete = () => resolve((req.result as IDBValidKey[]).map((k) => String(k)));
      tx.onabort = () => reject(tx.error ?? new Error("the key listing aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("the key listing failed"));
    });
  } finally {
    release(db);
  }
}

/** Request whole-database deletion and resolve with what actually happened: a
    `blocked` result is reported as blocked, never as a completed delete. */
export function deleteDatabaseReliably(name: string): Promise<DatabaseDeleteResult> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve({ deleted: true, blocked: false });
      return;
    }
    let done = false;
    const finish = (result: DatabaseDeleteResult) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch {
      // Could not even request the delete: it did not complete.
      finish({ deleted: false, blocked: false });
      return;
    }
    request.onsuccess = () => finish({ deleted: true, blocked: false });
    request.onerror = () => finish({ deleted: false, blocked: false });
    request.onblocked = () => {
      // Another context still holds the database open. This is a real, honest
      // outcome: the database was NOT deleted. The caller has already removed
      // the readable record, so nothing readable is left behind.
      finish({ deleted: false, blocked: true });
    };
  });
}
