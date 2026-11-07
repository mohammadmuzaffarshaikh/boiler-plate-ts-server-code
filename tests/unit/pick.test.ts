import pick from "../../src/utils/pick";

/**
 * Used by controllers to take only the query parameters they expect out of
 * a request, so a caller cannot smuggle an extra field into a Prisma filter.
 */
describe("pick", () => {
  it("takes only the named keys", () => {
    expect(pick({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ a: 1, c: 3 });
  });

  it("drops a key that is absent rather than setting it undefined", () => {
    // Load-bearing: a `{ status: undefined }` reaching a Prisma `where`
    // is not the same query as omitting it.
    const result = pick({ a: 1 }, ["a", "missing"]);

    expect(result).toEqual({ a: 1 });
    expect("missing" in result).toBe(false);
  });

  it("drops a key whose value is explicitly undefined", () => {
    expect(pick({ a: undefined, b: 2 }, ["a", "b"])).toEqual({ b: 2 });
  });

  it("keeps falsy values that are not undefined", () => {
    // `page=0`, `status=""` and `active=false` are all answers, not absences.
    expect(pick({ a: 0, b: "", c: false, d: null }, ["a", "b", "c", "d"])).toEqual(
      { a: 0, b: "", c: false, d: null },
    );
  });

  it("returns an empty object when nothing matches", () => {
    expect(pick({ a: 1 }, ["x", "y"])).toEqual({});
    expect(pick({ a: 1 }, [])).toEqual({});
  });

  it("reads a nested key with dot notation and rebuilds the shape", () => {
    expect(pick({ user: { id: 1, secret: "x" } }, ["user.id"])).toEqual({
      user: { id: 1 },
    });
  });

  it("does not invent an intermediate object for a missing nested key", () => {
    expect(pick({ user: { id: 1 } }, ["user.missing"])).toEqual({});
  });

  it("maps over an array of objects", () => {
    expect(pick([{ a: 1, b: 2 }, { a: 3, b: 4 }], ["a"])).toEqual([
      { a: 1 },
      { a: 3 },
    ]);
  });
});
