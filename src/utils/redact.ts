/**
 * Partially mask an email address for a log line.
 *
 * Keeps enough to recognise an address you already know — the first
 * character and the domain — and not enough to harvest one you do not.
 * `charlotte@shop.example` becomes `c***@shop.example`. The domain stays
 * because it is what makes a log useful when a whole tenant stops receiving
 * mail, and it is not the identifying half.
 *
 * Anything without an `@` is masked wholesale rather than returned as-is:
 * the fallback for an unexpected shape has to be more private, not less.
 */
export const redactEmail = (address: string): string => {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";

  return `${address[0]}***${address.slice(at)}`;
};

/**
 * Strip the password out of a connection string before it reaches the logs.
 *
 * Managed Postgres and Redis both hand you credentials inline in the URL, and
 * logs travel further than the people who write them expect — into aggregators,
 * tickets, screenshots and pasted terminal output.
 *
 * @param url - A connection string, possibly carrying `user:password@`.
 * @param label - Used in the fallback when the string will not parse, so the
 *                log still says which setting was wrong.
 */
export const redactUrlPassword = (url: string, label = "URL"): string => {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return `<un-parseable ${label}>`;
  }
};

/**
 * Query-string parameters whose value is a credential rather than a detail.
 *
 * Matched case-insensitively against the whole parameter name, so `token`
 * covers `token` but not `tokenType`, and the list stays something a reader
 * can audit. Add to it when a new secret-carrying parameter appears; do not
 * reach for a substring match, which starts masking `next_page_token` and
 * ends with logs nobody can debug from.
 */
const SECRET_QUERY_PARAMS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "code",
  "secret",
  "password",
  "api_key",
  "apikey",
  "signature",
]);

/**
 * Mask credential-carrying query parameters before a URL reaches the logs.
 *
 * The reset flow used to take its token as `?token=<jwt>`, which put a live
 * account-takeover credential into morgan's `:url`, into `errorHandler`'s
 * `originalUrl`, and from there into stdout and the log aggregator — plus the
 * access log of every proxy and CDN in front of this API. That particular
 * parameter has moved into the request body, where none of that happens.
 *
 * This exists so the *next* one cannot repeat it. It is a backstop, not the
 * control: a secret still does not belong in a URL, because this function
 * only protects the logs this process writes and nothing upstream of it.
 *
 * The path is never touched, and the parameter *names* survive — a log line
 * has to stay useful enough to tell a malformed request from a rejected one.
 *
 * @param url - A request URL, typically `req.originalUrl`. May be relative.
 */
export const redactUrl = (url: string): string => {
  const split = url.indexOf("?");
  if (split === -1) return url;

  const path = url.slice(0, split);
  // Parsed with URLSearchParams rather than a regular expression so that
  // encoding, repeated keys and empty values are handled by something that
  // already knows the grammar.
  const params = new URLSearchParams(url.slice(split + 1));

  let masked = false;
  for (const key of [...params.keys()]) {
    if (!SECRET_QUERY_PARAMS.has(key.toLowerCase())) continue;
    params.set(key, "***");
    masked = true;
  }

  // Re-serialising rewrites escaping even when nothing matched, which would
  // make a log line differ from the URL the client actually sent. Only pay
  // that cost when there was something to hide.
  return masked ? `${path}?${params.toString()}` : url;
};
