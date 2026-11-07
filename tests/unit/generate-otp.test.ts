import crypto from "node:crypto";
import generateOtp from "../../src/utils/generate-otp";

describe("generateOtp", () => {
  it("is always six digits", () => {
    // 100000..999999 — never five digits, which would break a fixed-width
    // input and leak that the code is shorter than advertised.
    for (let i = 0; i < 200; i++) {
      const { otp } = generateOtp();
      expect(otp).toBeGreaterThanOrEqual(100000);
      expect(otp).toBeLessThanOrEqual(999999);
      expect(String(otp)).toHaveLength(6);
    }
  });

  it("is an integer", () => {
    expect(Number.isInteger(generateOtp().otp)).toBe(true);
  });

  it("expires ten minutes out by default", () => {
    const { otpExpires } = generateOtp();
    const minutes = otpExpires.diff(Date.now(), "minutes", true);

    expect(minutes).toBeGreaterThan(9.5);
    expect(minutes).toBeLessThanOrEqual(10);
  });

  it("honours a custom expiry", () => {
    const minutes = generateOtp(2).otpExpires.diff(Date.now(), "minutes", true);

    expect(minutes).toBeGreaterThan(1.5);
    expect(minutes).toBeLessThanOrEqual(2);
  });

  it("does not return the same code every time", () => {
    // A weak smoke test for randomness, not a statistical one — it exists
    // so a refactor that pinned the seed gets noticed.
    const seen = new Set(
      Array.from({ length: 50 }, () => generateOtp().otp),
    );

    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("the source of randomness", () => {
  /**
   * It was `Math.floor(100000 + Math.random() * 900000)`.
   *
   * `Math.random()` is a non-cryptographic PRNG — V8 uses xorshift128+ and
   * generates in batches of 64 — so observing a few outputs is enough to
   * solve for the internal state and predict every subsequent code, and the
   * ones already in the current batch. For a code that authorises a password
   * reset or proves a mailbox, predictable is forgeable.
   *
   * Nothing calls `generateOtp` yet. That is the reason to fix it rather
   * than a reason not to: this repo is a base that gets copied, so the
   * version sitting here is the version that ends up in the module that does
   * call it.
   */
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("draws from the CSPRNG, not Math.random", () => {
    const randomInt = jest.spyOn(crypto, "randomInt");
    const mathRandom = jest.spyOn(Math, "random");

    generateOtp();

    expect(randomInt).toHaveBeenCalledTimes(1);
    expect(mathRandom).not.toHaveBeenCalled();
  });

  it("asks for the whole six-digit range, top end included", () => {
    // `crypto.randomInt` is exclusive at the top. Passing 999999 would make
    // the largest code unreachable — a small bias, and the kind that
    // survives review because the output still looks right.
    const randomInt = jest.spyOn(crypto, "randomInt");

    generateOtp();

    expect(randomInt).toHaveBeenCalledWith(100000, 1000000);
  });

  it("can actually produce the extremes of the range", () => {
    const randomInt = jest
      .spyOn(crypto, "randomInt")
      .mockReturnValueOnce(100000 as never)
      .mockReturnValueOnce(999999 as never);

    expect(generateOtp().otp).toBe(100000);
    expect(generateOtp().otp).toBe(999999);
    expect(randomInt).toHaveBeenCalledTimes(2);
  });

  it("produces no repeats across a large sample", () => {
    // Not a statistical test of the CSPRNG — that is Node's job. This is a
    // smoke test that the output is not being drawn from a tiny space or a
    // pinned seed: 500 draws from 900000 values should collide rarely.
    const codes = Array.from({ length: 500 }, () => generateOtp().otp);
    const unique = new Set(codes);

    expect(unique.size).toBeGreaterThan(490);
  });
});
