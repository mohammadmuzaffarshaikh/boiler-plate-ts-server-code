import crypto from "node:crypto";
import {
  deriveCodeChallenge,
  generateCodeVerifier,
  isValidCodeChallenge,
  isValidCodeVerifier,
  verifyCodeChallenge,
} from "../../src/utils/pkce";

/**
 * PKCE (RFC 7636), S256 only.
 *
 * The binding that makes an intercepted authorization code useless: the
 * client invents a verifier before it logs in, sends only its hash, and must
 * produce the preimage to redeem the code it gets back.
 */
describe("deriveCodeChallenge", () => {
  it("is base64url(sha256(verifier))", () => {
    const verifier = "a".repeat(43);

    expect(deriveCodeChallenge(verifier)).toBe(
      crypto.createHash("sha256").update(verifier, "ascii").digest("base64url"),
    );
  });

  it("matches the worked example in RFC 7636 appendix B", () => {
    // The one example everybody can check an implementation against. Getting
    // base64 instead of base64url, or padding, fails exactly here.
    expect(
      deriveCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("produces 43 base64url characters with no padding", () => {
    const challenge = deriveCodeChallenge(generateCodeVerifier());

    expect(challenge).toHaveLength(43);
    expect(challenge).not.toContain("=");
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
  });
});

describe("isValidCodeVerifier", () => {
  it("accepts the unreserved set at the RFC's length bounds", () => {
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("A".repeat(128))).toBe(true);
    expect(isValidCodeVerifier(`${"a".repeat(39)}-._~`)).toBe(true);
  });

  it("rejects a verifier shorter than 43 characters", () => {
    // The floor IS the security property, not a formality: 43 base64url
    // characters is 256 bits if the client generated them properly, and a
    // shorter verifier is one a code-holder could search.
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidCodeVerifier("short")).toBe(false);
    expect(isValidCodeVerifier("")).toBe(false);
  });

  it("rejects a verifier longer than 128 characters", () => {
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
  });

  it("rejects characters outside the unreserved set", () => {
    for (const bad of ["+", "/", "=", " ", "!", "%41"]) {
      expect(isValidCodeVerifier(`${"a".repeat(43)}${bad}`)).toBe(false);
    }
  });

  it("rejects a trailing newline", () => {
    // Not because `$` is lenient — in JavaScript, without the `m` flag, it
    // matches only at end of input, so `/^x+$/` already refuses "x\n". (That
    // leniency is Python and Perl; an earlier comment here had it backwards.)
    // The flag is what this pins: add `m` to VERIFIER_PATTERN and "aaa...\n"
    // starts passing — and then the hash is of a different
    // string than the one that passed validation.
    expect(isValidCodeVerifier(`${"a".repeat(43)}\n`)).toBe(false);
  });
});

describe("isValidCodeChallenge", () => {
  it("accepts a real S256 challenge", () => {
    expect(isValidCodeChallenge(deriveCodeChallenge(generateCodeVerifier()))).toBe(
      true,
    );
  });

  it("rejects a challenge whose 43 characters include a newline", () => {
    // The length check passes here — the newline is one of the 43 — so the
    // anchored pattern is the only thing standing between this and a
    // credential-shape decision made on a malformed challenge.
    expect(isValidCodeChallenge(`${"a".repeat(42)}\n`)).toBe(false);
  });

  it("rejects anything that is not 43 base64url characters", () => {
    expect(isValidCodeChallenge("too-short")).toBe(false);
    expect(isValidCodeChallenge("a".repeat(44))).toBe(false);
    expect(isValidCodeChallenge("")).toBe(false);
    // Standard base64 rather than base64url — the commonest wrong answer.
    expect(isValidCodeChallenge(`${"a".repeat(41)}+/`)).toBe(false);
    expect(isValidCodeChallenge(`${"a".repeat(42)}=`)).toBe(false);
  });
});

describe("verifyCodeChallenge", () => {
  it("accepts the verifier that produced the challenge", () => {
    const verifier = generateCodeVerifier();

    expect(verifyCodeChallenge(verifier, deriveCodeChallenge(verifier))).toBe(
      true,
    );
  });

  it("rejects a different verifier", () => {
    const challenge = deriveCodeChallenge(generateCodeVerifier());

    expect(verifyCodeChallenge(generateCodeVerifier(), challenge)).toBe(false);
  });

  it("rejects a verifier that differs by one character", () => {
    const verifier = "a".repeat(43);
    const challenge = deriveCodeChallenge(verifier);

    expect(verifyCodeChallenge(`${"a".repeat(42)}b`, challenge)).toBe(false);
  });

  it("rejects a malformed verifier rather than hashing it", () => {
    // Otherwise a one-character string could be offered against a challenge,
    // and the only thing standing in the way would be luck.
    const challenge = deriveCodeChallenge("a".repeat(43));

    expect(verifyCodeChallenge("a", challenge)).toBe(false);
    expect(verifyCodeChallenge("", challenge)).toBe(false);
  });

  it("returns false instead of throwing on a length mismatch", () => {
    // `crypto.timingSafeEqual` throws when the buffers differ in length, so
    // a challenge of the wrong size must be rejected before it gets there —
    // a 500 here would be a denial of service on the exchange endpoint.
    const verifier = generateCodeVerifier();

    expect(verifyCodeChallenge(verifier, "")).toBe(false);
    expect(verifyCodeChallenge(verifier, "short")).toBe(false);
    expect(verifyCodeChallenge(verifier, "x".repeat(200))).toBe(false);
  });

  it("is not fooled by a challenge that is the verifier itself", () => {
    // i.e. the `plain` method of RFC 7636, which this deliberately does not
    // implement: it makes the challenge and the verifier the same string, so
    // anyone who sees one has the other.
    const verifier = generateCodeVerifier();

    expect(verifyCodeChallenge(verifier, verifier)).toBe(false);
  });
});

describe("generateCodeVerifier", () => {
  it("produces something its own validator accepts", () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidCodeVerifier(generateCodeVerifier())).toBe(true);
    }
  });

  it("is 43 characters — the RFC floor, and 256 bits", () => {
    expect(generateCodeVerifier()).toHaveLength(43);
  });

  it("does not repeat", () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => generateCodeVerifier()),
    );

    expect(seen.size).toBe(200);
  });
});
