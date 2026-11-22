import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, canonicalDigest, sha256Hex } from "../src/canonical-json.mjs";

test("canonical JSON sorts object keys recursively but preserves array order", () => {
  const left = { z: 1, a: { y: true, b: "x" }, list: [2, 1] };
  const right = { list: [2, 1], a: { b: "x", y: true }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalDigest(left), canonicalDigest(right));
  assert.notEqual(canonicalDigest(left), canonicalDigest({ ...right, list: [1, 2] }));
});

test("normalizes negative zero and rejects non-finite numbers", () => {
  assert.equal(canonicalJson(-0), "0");
  assert.throws(() => canonicalJson(Number.NaN), /NON_FINITE_NUMBER/);
  assert.throws(() => canonicalJson(Infinity), /NON_FINITE_NUMBER/);
});

test("rejects sparse arrays and arrays carrying extra properties", () => {
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => canonicalJson(sparse), /SPARSE_ARRAY/);
  const extra = [1];
  extra.note = "not JSON";
  assert.throws(() => canonicalJson(extra), /ARRAY_PROPERTIES_INVALID/);
});

test("rejects getters, setters, symbols and non-enumerable properties", () => {
  const getter = {};
  Object.defineProperty(getter, "x", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => canonicalJson(getter), /OBJECT_ACCESSOR_REJECTED/);
  const setter = {};
  Object.defineProperty(setter, "x", { enumerable: true, set(value) {} });
  assert.throws(() => canonicalJson(setter), /OBJECT_ACCESSOR_REJECTED/);
  assert.throws(() => canonicalJson({ [Symbol("hidden")]: true }), /SYMBOL_KEY_REJECTED/);
  const hidden = {};
  Object.defineProperty(hidden, "secret", { value: "x", enumerable: false });
  assert.throws(() => canonicalJson(hidden), /OBJECT_ACCESSOR_REJECTED/);
});

test("rejects cycles, class instances, undefined and unsupported primitives", () => {
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /CYCLE/);
  assert.throws(() => canonicalJson(new Date()), /OBJECT_PROTOTYPE_INVALID/);
  assert.throws(() => canonicalJson({ value: undefined }), /UNSUPPORTED_VALUE/);
  assert.throws(() => canonicalJson(1n), /UNSUPPORTED_VALUE/);
  assert.equal(sha256Hex("abc").length, 64);
});
