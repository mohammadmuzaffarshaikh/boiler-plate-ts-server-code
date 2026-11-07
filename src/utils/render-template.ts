import Handlebars from "handlebars";

/**
 * Handlebars rendering for notification templates.
 *
 * This is deliberately NOT the sibling api repo's `compileTemplate`, which
 * is three lines long and contains the worst bug in that codebase:
 *
 *     try { return Handlebars.compile(str)(ctx); }
 *     catch (err) { logger.error(...); return ""; }
 *
 * A typo'd `{{resetLnk}}` there produces an empty string, a log line nobody
 * reads, and a customer receiving a blank email that looks like a delivery
 * fault. Worse, Handlebars does not even throw for a missing variable by
 * default — it renders nothing and succeeds — so the common case never
 * reaches that catch at all. The scar is visible at the call site: the api
 * repo passes the same reset URL twice, as `resetPasswordUrl` AND as
 * `resetLink`, because nobody could tell which name the stored template
 * actually used.
 *
 * Three things are different here.
 *
 * 1. MISSING VARIABLES ARE AN ERROR, not an empty string. The variables a
 *    template prints are read out of its parsed AST and checked against the
 *    context before anything renders, so the failure names the template and
 *    the variable instead of arriving as a blank message.
 *
 * 2. PRINTED AND TESTED ARE DIFFERENT. `{{orderNumber}}` must exist —
 *    something is going to be printed where it stands. `{{#if trackingUrl}}`
 *    need not: asking whether an optional value is present is the entire
 *    point of the conditional. Handlebars' own `strict: true` cannot make
 *    this distinction — it throws on both — which is why the check is here
 *    and not a compiler flag.
 *
 * 3. ESCAPING FOLLOWS THE DESTINATION. HTML bodies escape; subject lines and
 *    plaintext do not. Rendering a subject through the HTML compiler is how
 *    "Tom & Jerry Ltd" arrives in an inbox as "Tom &amp; Jerry Ltd" — the
 *    api repo compiles the subject with the same escaping compiler as the
 *    body and has exactly that bug waiting in it.
 *
 * No template is loaded, stored or named here: this module renders a string
 * it is handed. Where templates live is todo/sugestion-5.md.
 */

/** What the output is going into, which decides HTML escaping. */
export type RenderMode = "html" | "text";

/**
 * The variables a template refers to, split by whether it prints them.
 *
 * `printed` is the contract a caller must satisfy. `tested` is everything
 * else the template looks at — `if`/`unless` subjects, helper arguments —
 * which may legitimately be absent.
 */
export interface TemplateVariables {
  printed: string[];
  tested: string[];
}

/** Thrown when a template cannot be rendered. Never returns a partial result. */
export class TemplateRenderError extends Error {
  /** Variables the template prints that the context did not supply. */
  public readonly missing: string[];

  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = "TemplateRenderError";
    this.missing = missing;

    Object.setPrototypeOf(this, TemplateRenderError.prototype);
  }
}

/**
 * Compiled templates, keyed by mode and source.
 *
 * Compiling is the expensive half of rendering and templates are reused
 * across every message of a kind, so caching is worth it — but the sources
 * come from the database and change when an admin edits one, so the cache
 * is keyed by the source text itself rather than by a template id. An edit
 * simply misses and compiles once.
 *
 * Bounded, because an unbounded `Map` keyed by caller-supplied strings is a
 * memory leak with a nice name. Eviction is oldest-first, which `Map`
 * gives for free by preserving insertion order.
 */
const compiledCache = new Map<string, HandlebarsTemplateDelegate>();
const MAX_CACHED_TEMPLATES = 200;

/**
 * Extracted variables, cached beside the compiled templates.
 *
 * `renderTemplate` needs these on every call, and parsing is the expensive
 * half — without this, caching the compiled template saved almost nothing,
 * because every render re-parsed the same source into a fresh AST and walked
 * it again. That is invisible on one send and very visible on a queue
 * working through an order batch.
 */
const variablesCache = new Map<string, TemplateVariables>();

const compile = (
  source: string,
  mode: RenderMode,
): HandlebarsTemplateDelegate => {
  const cacheKey = `${mode}\u0000${source}`;
  const cached = compiledCache.get(cacheKey);
  if (cached) return cached;

  let compiled: HandlebarsTemplateDelegate;
  try {
    compiled = Handlebars.compile(source, {
      // `noEscape` for text: a subject line is not HTML, and escaping it
      // turns every & into &amp; in the inbox.
      noEscape: mode === "text",
    });
  } catch (err) {
    // A syntax error — an unclosed block, a stray `{{`. Always the
    // template author's mistake, and the Handlebars message is genuinely
    // useful, so it is kept rather than flattened.
    throw new TemplateRenderError(
      `Template failed to compile: ${(err as Error).message}`,
    );
  }

  remember(compiledCache, cacheKey, compiled);

  return compiled;
};

/**
 * Insert into a bounded cache, evicting oldest-first.
 *
 * `Map` preserves insertion order, so the first key is the oldest. An
 * unbounded `Map` keyed by caller-supplied strings is a memory leak with a
 * nice name — template sources come from the database and change whenever
 * somebody edits one.
 */
function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= MAX_CACHED_TEMPLATES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

/** Drop every cached template. For tests, and for a cache-busting admin action. */
export const clearTemplateCache = (): void => {
  compiledCache.clear();
  variablesCache.clear();
};

/**
 * Built-in block helpers. Their names appear in the AST exactly where a
 * variable would, so without this list `{{#if x}}` would report a missing
 * variable called `if`.
 */
const BUILTIN_HELPERS = new Set([
  "if",
  "unless",
  "each",
  "with",
  "log",
  "lookup",
  "blockHelperMissing",
  "helperMissing",
]);

/**
 * Read the variable names out of a template's AST.
 *
 * Parsing rather than running a regex over the source: a regex cannot tell
 * `{{name}}` from `{{! {{name}} }}` inside a comment, from a literal in a
 * subexpression, or from `{{#each items}}{{name}}{{/each}}` where `name` is
 * a property of a loop item and not a top-level variable at all.
 *
 * Only the FIRST path segment is collected — `{{user.firstName}}` yields
 * `user` — because that is the key a caller actually has to provide.
 *
 * Exported because the template module will need it: it is what turns a
 * stored body into a declared variable contract, and what a preview
 * endpoint uses to work out which example values to ask for.
 */
export const extractTemplateVariables = (
  source: string,
): TemplateVariables => {
  const cached = variablesCache.get(source);
  if (cached) return cached;

  let ast: hbs.AST.Program;
  try {
    ast = Handlebars.parse(source);
  } catch (err) {
    throw new TemplateRenderError(
      `Template failed to parse: ${(err as Error).message}`,
    );
  }

  const printed = new Set<string>();
  const tested = new Set<string>();

  /**
   * Names bound by an enclosing block, which are NOT caller-supplied.
   * Inside `{{#each items}}`, `{{this.sku}}` and any bare name resolve
   * against the current item, so requiring the caller to pass them would
   * be wrong. `{{#with}}` and block params (`{{#each xs as |x|}}`) do the
   * same thing.
   */
  const addPath = (
    node: hbs.AST.PathExpression,
    into: Set<string>,
    scoped: boolean,
  ): void => {
    // `@index`, `@key`, `@first` — supplied by the helper, never by us.
    if (node.data) return;
    // `{{this}}` / `{{.}}` and any `{{../x}}` reference something relative
    // to a block, not a top-level key.
    if (node.depth > 0) return;
    if (scoped) return;

    const first = node.parts[0];
    if (!first) return;
    if (BUILTIN_HELPERS.has(first)) return;

    into.add(first);
  };

  const walkExpression = (
    node: hbs.AST.Expression,
    into: Set<string>,
    scoped: boolean,
  ): void => {
    if (node.type === "PathExpression") {
      addPath(node as hbs.AST.PathExpression, into, scoped);
      return;
    }

    if (node.type === "SubExpression") {
      const sub = node as hbs.AST.SubExpression;
      // The path of a subexpression is the helper being called, so only its
      // arguments are variables. They inherit the caller's bucket:
      // `{{#each (sortBy items "name")}}` still needs `items` to exist.
      for (const param of sub.params) walkExpression(param, into, scoped);
      for (const pair of sub.hash?.pairs ?? []) {
        walkExpression(pair.value, into, scoped);
      }
    }
  };

  const walkProgram = (program: hbs.AST.Program, scoped: boolean): void => {
    for (const statement of program.body) {
      switch (statement.type) {
        case "MustacheStatement": {
          const mustache = statement as hbs.AST.MustacheStatement;
          // With no params this is a plain `{{x}}` — something is printed
          // here, so `x` has to exist. With params it is a helper call
          // (`{{formatDate createdAt}}`) and the path is the helper name.
          if (mustache.params.length === 0 && !mustache.hash?.pairs?.length) {
            if (mustache.path.type === "PathExpression") {
              addPath(mustache.path as hbs.AST.PathExpression, printed, scoped);
            }
          } else {
            for (const param of mustache.params) {
              walkExpression(param, tested, scoped);
            }
            for (const pair of mustache.hash?.pairs ?? []) {
              walkExpression(pair.value, tested, scoped);
            }
          }
          break;
        }

        case "BlockStatement": {
          const block = statement as hbs.AST.BlockStatement;
          const helper = block.path.parts[0] ?? "";

          // `each` and `with` CONSUME their argument — a template that
          // loops over `items` needs `items`, and without it Handlebars
          // renders nothing at all and reports no error, which is the
          // silent-blank failure this module exists to stop. `if` and
          // `unless` merely ask whether a value is there, which is the one
          // case where absence is a legitimate answer.
          const changesScope = helper === "each" || helper === "with";
          const paramsRequired = changesScope;

          for (const param of block.params) {
            walkExpression(param, paramsRequired ? printed : tested, scoped);
          }
          for (const pair of block.hash?.pairs ?? []) {
            walkExpression(pair.value, tested, scoped);
          }

          // Everything inside `each` or `with` resolves against whatever the
          // block put in scope, so names in there are not ours to supply.

          if (block.program) {
            walkProgram(block.program, scoped || changesScope);
          }
          if (block.inverse) {
            // The `{{else}}` branch of an `each` runs precisely when there
            // was nothing to iterate, so it is evaluated against the OUTER
            // context — not the item scope its sibling branch gets. Marking
            // it scoped would stop requiring the variables it prints, which
            // is the silent blank this module exists to prevent, hiding in
            // the branch nobody tests.
            walkProgram(block.inverse, scoped);
          }
          break;
        }

        // Partials are not registered in this codebase. If they ever are,
        // their variables cannot be resolved without the partial's own
        // source, so they are recorded as tested rather than required.
        case "PartialStatement":
        case "PartialBlockStatement": {
          const partial = statement as hbs.AST.PartialStatement;
          for (const param of partial.params) {
            walkExpression(param, tested, scoped);
          }
          break;
        }

        default:
          break;
      }
    }
  };

  walkProgram(ast, false);

  // A name that is printed somewhere is required, even if it is also
  // tested elsewhere — `{{#if name}}{{name}}{{/if}}` is a conditional
  // around a print, and the print is what decides.
  for (const name of printed) tested.delete(name);

  const result: TemplateVariables = {
    printed: [...printed],
    tested: [...tested],
  };
  remember(variablesCache, source, result);

  return result;
};

export interface RenderOptions {
  /** HTML escaping on (`"html"`) or off (`"text"`). Defaults to `"html"`. */
  mode?: RenderMode;
  /**
   * Names the template may print without the context supplying them. They
   * render as an empty string.
   *
   * This is the escape hatch for a genuinely optional value, and it has to
   * be stated rather than inferred — the whole point of the check is that
   * silence is not consent. Once templates carry a declared variable
   * contract (todo/sugestion-5.md), this is where its optional entries go.
   */
  optional?: readonly string[];
  /** Named in the error message, so a failure says which template broke. */
  label?: string;
}

/**
 * Render a template source against a context.
 *
 * @throws {TemplateRenderError} if it does not compile, if it prints a
 * variable the context does not supply, or if a helper throws.
 */
export const renderTemplate = (
  source: string,
  context: Record<string, unknown> = {},
  options: RenderOptions = {},
): string => {
  const { mode = "html", optional = [], label } = options;
  const where = label ? ` in template "${label}"` : "";

  const { printed } = extractTemplateVariables(source);
  const optionalSet = new Set(optional);

  // `in` rather than a truthiness test: a supplied `0`, `false` or `""` is
  // an answer, and treating it as missing would refuse to render a template
  // whose context is entirely correct.
  const missing = printed.filter(
    (name) => !optionalSet.has(name) && !(name in context),
  );

  if (missing.length > 0) {
    throw new TemplateRenderError(
      `Missing template variable${missing.length === 1 ? "" : "s"}${where}: ` +
        `${missing.join(", ")}. Supplied: ${Object.keys(context).join(", ") || "nothing"}.`,
      missing,
    );
  }

  // Declared-optional names are passed explicitly as "" so that a future
  // move to Handlebars' own strict mode does not change behaviour here.
  const resolved: Record<string, unknown> = { ...context };
  for (const name of optional) {
    if (!(name in resolved)) resolved[name] = "";
  }

  try {
    return compile(source, mode)(resolved);
  } catch (err) {
    if (err instanceof TemplateRenderError) throw err;
    throw new TemplateRenderError(
      `Template failed to render${where}: ${(err as Error).message}`,
    );
  }
};

/** Render for an HTML body — escaping on. */
export const renderHtml = (
  source: string,
  context?: Record<string, unknown>,
  options?: Omit<RenderOptions, "mode">,
): string => renderTemplate(source, context, { ...options, mode: "html" });

/**
 * Render for a subject line or a plaintext body — escaping off.
 *
 * Subjects are the reason this exists separately. A subject is a header
 * value, not markup: `&`, `<` and `'` belong in it verbatim.
 */
export const renderText = (
  source: string,
  context?: Record<string, unknown>,
  options?: Omit<RenderOptions, "mode">,
): string => renderTemplate(source, context, { ...options, mode: "text" });
