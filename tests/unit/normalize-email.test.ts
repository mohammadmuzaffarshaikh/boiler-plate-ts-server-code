import { normalizeEmail } from "../../src/utils/normalize-email";

/**
 * One mailbox has one stored form.
 *
 * `users.email` is a case-sensitive unique index, so without this
 * `Ada@Shop.example` and `ada@shop.example` are two accounts for one inbox:
 * the second registration succeeds, the owner cannot log in with the casing
 * they remember, and `forgot-password` answers its generic 200 having found
 * nobody. The specs below are as much about what is NOT folded as what is.
 */
describe("normalizeEmail", () => {
  it("lowercases the domain", () => {
    expect(normalizeEmail("ada@Shop.Example")).toBe("ada@shop.example");
  });

  it("lowercases the local part too", () => {
    // RFC 5321 §2.4 leaves local-part case sensitivity to the receiving
    // host, and no provider in practice treats `Ada@` and `ada@` as
    // different mailboxes. Honouring the letter of the RFC is what produced
    // the duplicate accounts.
    expect(normalizeEmail("Ada.Lovelace@shop.example")).toBe(
      "ada.lovelace@shop.example",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeEmail("  ada@shop.example \n")).toBe("ada@shop.example");
  });

  it("is idempotent", () => {
    // It runs at both the write and the lookup, and in `isEmailTakenUser`
    // again under them, so folding twice must not differ from folding once.
    const once = normalizeEmail("Ada@Shop.Example");
    expect(normalizeEmail(once)).toBe(once);
  });

  it("keeps a plus-addressed suffix", () => {
    // `ada+shop@` is how people separate their own sign-ups, and at most
    // providers it is deliverable but distinct. Stripping it would merge
    // accounts that are genuinely different.
    expect(normalizeEmail("Ada+Shop@Example.com")).toBe(
      "ada+shop@example.com",
    );
  });

  it("keeps dots in the local part", () => {
    // Gmail ignores them; almost nothing else does. `a.b@example.com` and
    // `ab@example.com` are one mailbox at Google and two anywhere else, so
    // folding them here would be wrong for every other domain.
    expect(normalizeEmail("A.B@Example.com")).toBe("a.b@example.com");
  });

  it("does not try to repair an address that is not one", () => {
    // Shape is Joi's job, at the edge. This only folds.
    expect(normalizeEmail("NOT AN EMAIL")).toBe("not an email");
    expect(normalizeEmail("")).toBe("");
  });
});
