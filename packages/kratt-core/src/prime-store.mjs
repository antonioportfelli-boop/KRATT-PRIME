/** PrimeStore v1: append-only, hash-chained local journal. No cloud sync or encryption claim. */
import { open, readFile, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
const digest = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value);
const validKey = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

function verifyJournal(raw) {
  let previous = "0".repeat(64), sequence = 0;
  const ids = new Set(), entries = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    let entry;
    try { entry = JSON.parse(line); } catch { throw new Error("STORE_JOURNAL_CORRUPT"); }
    const payload = entry && { sequence:entry.sequence,id:entry.id,key:entry.key,value:entry.value,previousHash:entry.previousHash };
    if (!entry || entry.sequence !== sequence + 1 || entry.previousHash !== previous ||
        typeof entry.hash !== "string" || !/^[0-9a-f]{64}$/.test(entry.hash) ||
        digest(canonical(payload)) !== entry.hash || !validKey(entry.key) || !validKey(entry.id) ||
        ids.has(entry.id)) throw new Error("STORE_JOURNAL_INTEGRITY_FAILURE");
    sequence = entry.sequence;
    previous = entry.hash;
    ids.add(entry.id);
    entries.push(entry);
  }
  return { sequence, head:previous, ids, entries };
}

export class PrimeStore {
  #path; #tail = Promise.resolve(); #sequence = 0; #head = "0".repeat(64); #ids = new Set(); #loaded = false;
  constructor({ path }) { if (typeof path !== "string" || !path) throw new TypeError("STORE_PATH_REQUIRED"); this.#path = path; }
  async open() {
    if (this.#loaded) return this;
    let raw; try { raw = await readFile(this.#path, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; raw = ""; }
    const verified = verifyJournal(raw);
    this.#sequence = verified.sequence; this.#head = verified.head; this.#ids = verified.ids; this.#loaded = true; return this;
  }
  async #readVerifiedEntries() {
    const raw = await readFile(this.#path, "utf8").catch(e => e.code === "ENOENT" ? "" : Promise.reject(e));
    const verified = verifyJournal(raw);
    if (verified.sequence !== this.#sequence || verified.head !== this.#head) throw new Error("STORE_JOURNAL_CHANGED");
    return verified.entries;
  }
  put({ idempotencyKey, key, value }) {
    const task = this.#tail.then(async () => {
      await this.open();
      if (!validKey(idempotencyKey) || !validKey(key)) throw new TypeError("STORE_KEY_INVALID");
      await mkdir(dirname(this.#path), { recursive: true });
      const lockPath = `${this.#path}.writer-lock`;
      let lock;
      try { lock = await open(lockPath, "wx", 0o600); }
      catch (error) {
        if (error?.code === "EEXIST") throw new Error("STORE_WRITER_LOCKED");
        throw error;
      }
      try {
        await lock.writeFile(canonical({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n", "utf8");
        await lock.sync();
        await this.#readVerifiedEntries();
        if (this.#ids.has(idempotencyKey)) return Object.freeze({ ok:true, duplicate:true, sequence:null });
        const next = this.#sequence + 1, payload = { sequence:next,id:idempotencyKey,key,value,previousHash:this.#head };
        const entry = { ...payload, hash:digest(canonical(payload)) };
        const file = await open(this.#path, "a", 0o600);
        try { await file.writeFile(canonical(entry) + "\n", "utf8"); await file.sync(); } finally { await file.close(); }
        this.#sequence = next; this.#head = entry.hash; this.#ids.add(idempotencyKey);
        return Object.freeze({ ok:true, duplicate:false, sequence:next, hash:entry.hash });
      } finally {
        try { await lock.close(); }
        finally { await unlink(lockPath); }
      }
    });
    this.#tail = task.catch(() => {}); return task;
  }
  async readAll() {
    await this.#tail; await this.open();
    const entries = await this.#readVerifiedEntries();
    return Object.freeze(entries.map(e => Object.freeze({sequence:e.sequence,id:e.id,key:e.key,value:e.value,hash:e.hash})));
  }
  async verify() {
    const entries = await this.readAll();
    return Object.freeze({ok:true,count:entries.length,headHash:this.#head});
  }
  async status() {
    await this.verify();
    return Object.freeze({loaded:true,entries:this.#sequence,headHash:this.#head,encrypted:false,remoteSync:false});
  }
}


