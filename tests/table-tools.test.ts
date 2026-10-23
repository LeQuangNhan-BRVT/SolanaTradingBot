import test from "node:test";
import assert from "node:assert/strict";
import { matchesQuery, nextSort, normalizeText, sortRows } from "../src/lib/table-tools";

test("text matching ignores case, Vietnamese accents and word order", () => {
  assert.equal(normalizeText("Đã Trade"), "da trade");
  assert.ok(matchesQuery("form", ["FORMATION", "Formation"]));
  assert.ok(matchesQuery("cho dip", ["meme", "chờ-dip"]));
  assert.ok(matchesQuery("pump fo", ["FORMATION", "Fm7q…pump"]));
  assert.equal(matchesQuery("doge", ["FORMATION", null, undefined]), false);
  assert.ok(matchesQuery("   ", ["anything"]));
});

test("sorting puts missing values last in both directions", () => {
  const rows = [{ v: 3 }, { v: null }, { v: 10 }, { v: 1 }];
  const accessors = { v: (row: { v: number | null }) => row.v };
  assert.deepEqual(sortRows(rows, { key: "v", direction: "desc" }, accessors).map((row) => row.v), [10, 3, 1, null]);
  assert.deepEqual(sortRows(rows, { key: "v", direction: "asc" }, accessors).map((row) => row.v), [1, 3, 10, null]);
  assert.equal(sortRows(rows, null, accessors), rows);
});

test("header clicks cycle descending, ascending, off", () => {
  let sort = nextSort<"a" | "b">(null, "a");
  assert.deepEqual(sort, { key: "a", direction: "desc" });
  sort = nextSort(sort, "a");
  assert.deepEqual(sort, { key: "a", direction: "asc" });
  assert.equal(nextSort(sort, "a"), null);
  assert.deepEqual(nextSort(sort, "b"), { key: "b", direction: "desc" });
});
