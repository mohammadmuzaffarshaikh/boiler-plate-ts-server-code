import config from "../../src/config/config";
import {
  formatAddress,
  getDefaultFrom,
  getResendClient,
  isEmailEnabled,
} from "../../src/config/resend-client";

/**
 * The client itself and the From header it builds. No network: the SDK is
 * constructed but never asked to send anything here.
 */

describe("getResendClient", () => {
  it("returns the same instance every time", () => {
    // A new client per send would rebuild the SDK's internal fetch setup on
    // every message for no reason.
    expect(getResendClient()).toBe(getResendClient());
  });
});

describe("isEmailEnabled", () => {
  const enabled = config.EMAIL.ENABLED;
  afterEach(() => {
    config.EMAIL.ENABLED = enabled;
  });

  it("is read at call time, not captured at import", () => {
    // `email.service` gates on this per send, so capturing it at module
    // load would make the 503 path untestable and need a restart to change.
    config.EMAIL.ENABLED = false;
    expect(isEmailEnabled()).toBe(false);
    config.EMAIL.ENABLED = true;
    expect(isEmailEnabled()).toBe(true);
  });
});

describe("formatAddress", () => {
  it("returns a bare address when there is no display name", () => {
    expect(formatAddress("no-reply@shop.test")).toBe("no-reply@shop.test");
  });

  it("leaves an ordinary name unquoted", () => {
    // Quoting unconditionally is also wrong — some clients show the quotes.
    expect(formatAddress("no-reply@shop.test", "Acme Store")).toBe(
      "Acme Store <no-reply@shop.test>",
    );
  });

  it("quotes a name containing a comma", () => {
    // Unquoted, the comma makes this two recipients as far as the header
    // grammar is concerned.
    expect(formatAddress("no-reply@shop.test", "Acme, Inc")).toBe(
      '"Acme, Inc" <no-reply@shop.test>',
    );
  });

  it("escapes a quote inside the name rather than terminating the header", () => {
    // The api repo builds `"${name}" <${email}>` unconditionally, so a name
    // with a quote in it closes the quoted string early and the rest
    // becomes a syntax error the provider answers with an opaque 422.
    expect(formatAddress("no-reply@shop.test", 'The "Real" Store')).toBe(
      '"The \\"Real\\" Store" <no-reply@shop.test>',
    );
  });

  it("escapes a backslash", () => {
    expect(formatAddress("a@b.test", "back\\slash")).toBe(
      '"back\\\\slash" <a@b.test>',
    );
  });

  it("strips a newline rather than letting it break the header", () => {
    // Header injection: everything after a CR/LF would be read as a new
    // header, and `Bcc:` is the interesting one. The name is configuration
    // today, but a per-template sender is a plausible next step.
    expect(formatAddress("a@b.test", "Acme\r\nBcc: attacker@evil.test")).toBe(
      '"Acme Bcc: attacker@evil.test" <a@b.test>',
    );
  });

  it("strips other control characters", () => {
    expect(formatAddress("a@b.test", "Ac\u0000me\u007f")).toBe(
      "Ac me <a@b.test>",
    );
  });

  it("treats a name that is only whitespace as no name at all", () => {
    // Otherwise it produces a leading space before the angle brackets.
    expect(formatAddress("a@b.test", "   ")).toBe("a@b.test");
  });

  it("quotes names containing other RFC 5322 specials", () => {
    for (const name of ["a@b", "a<b", "a:b", "a;b", "a(b)"]) {
      expect(formatAddress("x@y.test", name)).toBe(
        `"${name}" <x@y.test>`,
      );
    }
  });
});

describe("getDefaultFrom", () => {
  const { FROM_NAME, FROM_ADDRESS } = config.EMAIL;
  afterEach(() => {
    config.EMAIL.FROM_NAME = FROM_NAME;
    config.EMAIL.FROM_ADDRESS = FROM_ADDRESS;
  });

  it("combines the configured name and address", () => {
    config.EMAIL.FROM_NAME = "Acme Store";
    config.EMAIL.FROM_ADDRESS = "no-reply@acme.test";
    expect(getDefaultFrom()).toBe("Acme Store <no-reply@acme.test>");
  });

  it("sends a bare address when no name is configured", () => {
    // EMAIL_FROM_NAME is optional and defaults to "", which must not
    // produce a leading space or an empty pair of quotes.
    config.EMAIL.FROM_NAME = "";
    config.EMAIL.FROM_ADDRESS = "no-reply@acme.test";
    expect(getDefaultFrom()).toBe("no-reply@acme.test");
  });
});
