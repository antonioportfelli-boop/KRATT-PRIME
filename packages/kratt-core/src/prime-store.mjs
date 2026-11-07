/** PrimeStore v1: append-only, hash-chained local journal. No cloud sync or encryption claim. */
import { open, readFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
const digest = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value);
const validKey = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
export class PrimeStore {
  #path; #tail = Promise.resolve(); #sequence = 0; #head = "0".repeat(64); #ids = new Set(); #loaded = false;
  constructor({ path }) { if (typeof path !== "string" || !path) throw new TypeError("STORE_PATH_REQUIRED"); this.#path = path; }
  async open() {
    if (this.#loaded) return this;
    await mkdir(dirname(this.#path), { recursive: true });
    let raw; try { raw = await readFile(this.#path, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; raw = ""; }
    let prev = this.#head, seq = 0;
    for (const line of raw.split("\n").filter(Boolean)) {
      let entry; try { entry = JSON.parse(line); } catch { throw new Error("STORE_JOURNAL_CORRUPT"); }
      if (!entry || entry.sequence !== seq + 1 || entry.previousHash !== prev ||
          typeof entry.hash !== "string" || digest(canonical({sequence:entry.sequence,id:entry.id,key:entry.key,value:entry.value,previousHash:entry.previousHash})) !== entry.hash ||
          !validKey(entry.key) || typeof entry.id !== "string") throw new Error("STORE_JOURNAL_INTEGRITY_FAILURE");
      seq = entry.sequence; prev = entry.hash; this.#ids.add(entry.id);
    }
    this.#sequence = seq; this.#head = prev; this.#loaded = true; return this;
  }
  put({ idempotencyKey, key, value }) {
    const task = this.#tail.then(async () => {
      await this.open();
      if (!validKey(idempotencyKey) || !validKey(key)) throw new TypeError("STORE_KEY_INVALID");
      if (this.#ids.has(idempotencyKey)) return Object.freeze({ ok:true, duplicate:true, sequence:null });
      const next = this.#sequence + 1, payload = { sequence:next,id:idempotencyKey,key,value,previousHash:this.#head };
      const entry = { ...payload, hash:digest(canonical(payload)) };
      const file = await open(this.#path, "a", 0o600);
      try { await file.writeFile(canonical(entry) + "\n", "utf8"); await file.sync(); } finally { await file.close(); }
      this.#sequence = next; this.#head = entry.hash; this.#ids.add(idempotencyKey);
      return Object.freeze({ ok:true, duplicate:false, sequence:next, hash:entry.hash });
    });
    this.#tail = task.catch(() => {}); return task;
  }
  async readAll() {
    await this.#tail; await this.open();
    const raw = await readFile(this.#path, "utf8").catch(e => e.code === "ENOENT" ? "" : Promise.reject(e));
    return Object.freeze(raw.split("\n").filter(Boolean).map(line => { const e=JSON.parse(line); return Object.freeze({sequence:e.sequence,id:e.id,key:e.key,value:e.value,hash:e.hash}); }));
  }
  async status() { await this.#tail; await this.open(); return Object.freeze({loaded:true,entries:this.#sequence,headHash:this.#head,encrypted:false,remoteSync:false}); }
}
