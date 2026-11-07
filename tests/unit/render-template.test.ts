import Handlebars from "handlebars";
import {
  TemplateRenderError,
  clearTemplateCache,
  extractTemplateVariables,
  renderHtml,
  renderTemplate,
  renderText,
} from "../../src/utils/render-template";

/**
 * The rendering layer, with no template store behind it.
 *
 * Most of these exist because the sibling api repo gets them wrong: a
 * missing variable renders blank there, and a subject line is escaped as
 * though it were HTML. Both are silent, both reach the customer, and
 * neither shows up in a log.
 */

afterEach(() => clearTemplateCache());

describe("extractTemplateVariables", () => {
  it("separates what is printed from what is only tested", () => {
    const { printed, tested } = extractTemplateVariables(
      "Hi {{firstName}}{{#if trackingUrl}} — track it{{/if}}",
    );

    expect(printed).toEqual(["firstName"]);
    expect(tested).toEqual(["trackingUrl"]);
  });

  it("counts a name as printed when it is both tested and printed", () => {
    // `{{#if x}}{{x}}{{/if}}` is a conditional around a print. The print
    // decides: if the branch is taken, the value has to be there.
    const { printed, tested } = extractTemplateVariables(
      "{{#if company}}{{company}}{{/if}}",
    );

    expect(printed).toEqual(["company"]);
    expect(tested).toEqual([]);
  });

  it("reduces a dotted path to the key the caller must supply", () => {
    expect(extractTemplateVariables("{{user.profile.firstName}}").printed).toEqual([
      "user",
    ]);
  });

  it("does not require names that a block puts in scope", () => {
    // `sku` and `qty` are properties of a loop item, not context keys.
    // Requiring them would make every `{{#each}}` template unrenderable.
    const { printed } = extractTemplateVariables(
      "{{#each items}}{{sku}} x{{qty}}{{/each}}",
    );

    expect(printed).toEqual(["items"]);
  });

  it("ignores @data, parent paths and built-in helper names", () => {
    const { printed } = extractTemplateVariables(
      "{{#each rows}}{{@index}} {{../heading}} {{this}}{{/each}}",
    );

    expect(printed).toEqual(["rows"]);
    expect(printed).not.toContain("if");
    expect(printed).not.toContain("each");
  });

  it("does not see variables inside a comment", () => {
    // The reason this parses the AST instead of running a regex.
    expect(extractTemplateVariables("{{! {{ghost}} }}real").printed).toEqual([]);
  });

  it("throws a TemplateRenderError on a syntax error, not a raw Handlebars one", () => {
    expect(() => extractTemplateVariables("{{#if x}}never closed")).toThrow(
      TemplateRenderError,
    );
  });
});

describe("renderTemplate", () => {
  it("renders a supplied variable", () => {
    expect(renderTemplate("Hi {{name}}", { name: "Asha" })).toBe("Hi Asha");
  });

  it("THROWS on a missing variable instead of rendering an empty string", () => {
    // The bug this module exists to prevent. Handlebars' own default is to
    // render nothing and succeed, so the api repo's try/catch never fires
    // for the single most common template mistake.
    expect(() => renderTemplate("Hi {{firstName}}", {})).toThrow(
      TemplateRenderError,
    );
  });

  it("names the missing variables, the template and what was supplied", () => {
    let caught: unknown;
    try {
      renderTemplate("{{a}} {{b}} {{c}}", { a: 1 }, { label: "ORDER_SHIPPED" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TemplateRenderError);
    const error = caught as TemplateRenderError;
    expect(error.missing).toEqual(["b", "c"]);
    expect(error.message).toContain("ORDER_SHIPPED");
    expect(error.message).toContain("b, c");
    expect(error.message).toContain("Supplied: a");
  });

  it("accepts a falsy value as supplied", () => {
    // `in`, not truthiness. A zero quantity or an empty note is an answer,
    // and refusing to render it would be refusing a correct context.
    expect(renderTemplate("[{{count}}]", { count: 0 })).toBe("[0]");
    expect(renderTemplate("[{{note}}]", { note: "" })).toBe("[]");
    expect(renderTemplate("[{{flag}}]", { flag: false })).toBe("[false]");
  });

  it("renders a declared-optional variable as empty rather than throwing", () => {
    expect(
      renderTemplate("Hi{{middleName}}!", {}, { optional: ["middleName"] }),
    ).toBe("Hi!");
  });

  it("does not require a variable that is only tested", () => {
    expect(renderTemplate("{{#if extra}}x{{/if}}ok", {})).toBe("ok");
  });

  it("requires the subject of an each, which Handlebars would silently skip", () => {
    // `{{#each items}}` with no `items` renders nothing and reports no
    // error — the same silent blank as a missing `{{variable}}`, which is
    // why `each` and `with` are treated as consuming their argument while
    // `if` and `unless` are not.
    expect(() => renderTemplate("{{#each items}}x{{/each}}", {})).toThrow(
      TemplateRenderError,
    );
  });

  it("wraps a render-time failure rather than letting Handlebars' own escape", () => {
    // An unregistered helper called with arguments throws at render time.
    expect(() =>
      renderTemplate("{{formatDate createdAt}}", { createdAt: "x" }),
    ).toThrow(TemplateRenderError);
  });
});

describe("escaping follows the destination", () => {
  const context = { company: "Tom & Jerry <Ltd>" };

  it("escapes HTML in an html body", () => {
    expect(renderHtml("<p>{{company}}</p>", context)).toBe(
      "<p>Tom &amp; Jerry &lt;Ltd&gt;</p>",
    );
  });

  it("does NOT escape in text mode, which is what subjects need", () => {
    // A subject is a header value, not markup. Rendering it through the
    // HTML compiler is how "Tom & Jerry" reaches an inbox as "Tom &amp;
    // Jerry" — the api repo compiles subject and body with the same
    // escaping compiler and has exactly that waiting in it.
    expect(renderText("Order from {{company}}", context)).toBe(
      "Order from Tom & Jerry <Ltd>",
    );
  });

  it("keeps the two modes separate in the cache", () => {
    // Same source string, two compilers. Keying the cache on the source
    // alone would serve whichever was compiled first and silently escape
    // or un-escape the other.
    const source = "{{company}}";
    expect(renderHtml(source, context)).toBe("Tom &amp; Jerry &lt;Ltd&gt;");
    expect(renderText(source, context)).toBe("Tom & Jerry <Ltd>");
    expect(renderHtml(source, context)).toBe("Tom &amp; Jerry &lt;Ltd&gt;");
  });
});

describe("the else branch of a block", () => {
  it("requires what the else branch of an each prints", () => {
    // `{{else}}` runs precisely when there was nothing to iterate, so it is
    // evaluated against the OUTER context, not the item scope its sibling
    // gets. Treating it as scoped stops requiring the variables it prints —
    // a silent blank hiding in the branch nobody tests.
    const { printed } = extractTemplateVariables(
      "{{#each items}}{{sku}}{{else}}{{emptyMessage}}{{/each}}",
    );

    expect(printed).toEqual(expect.arrayContaining(["items", "emptyMessage"]));
    expect(printed).not.toContain("sku");
  });

  it("throws when the else branch prints something unsupplied", () => {
    expect(() =>
      renderTemplate("{{#each items}}x{{else}}{{emptyMessage}}{{/each}}", {
        items: [],
      }),
    ).toThrow(TemplateRenderError);
  });

  it("renders the else branch when its variable is supplied", () => {
    expect(
      renderText("{{#each items}}x{{else}}{{emptyMessage}}{{/each}}", {
        items: [],
        emptyMessage: "Nothing here",
      }),
    ).toBe("Nothing here");
  });

  it("still treats an if/else body as the outer context", () => {
    const { printed } = extractTemplateVariables(
      "{{#if paid}}{{receiptUrl}}{{else}}{{payUrl}}{{/if}}",
    );

    expect(printed).toEqual(expect.arrayContaining(["receiptUrl", "payUrl"]));
    expect(printed).not.toContain("paid");
  });
});

describe("the compiled-template cache", () => {
  it("re-renders correctly for a changed source", () => {
    // Keyed by source text, not by a template id, so an admin editing a
    // stored template simply misses the cache rather than serving the old
    // body until a restart.
    expect(renderText("v1 {{x}}", { x: 1 })).toBe("v1 1");
    expect(renderText("v2 {{x}}", { x: 1 })).toBe("v2 1");
  });

  it("does not re-parse the source on every render", () => {
    // `renderTemplate` needs the extracted variables on every call, and
    // parsing is the expensive half — caching only the compiled template
    // saved almost nothing while each render rebuilt the AST and walked it
    // again. Invisible on one send, very visible on a queue working
    // through an order batch.
    //
    // The first render parses twice, not once: `extractTemplateVariables`
    // parses for the variable walk, and Handlebars parses again inside
    // `compile`. What matters is that neither repeats.
    const parse = jest.spyOn(Handlebars, "parse");
    try {
      renderText("{{a}} {{b}}", { a: 1, b: 2 });
      const afterFirst = parse.mock.calls.length;

      renderText("{{a}} {{b}}", { a: 3, b: 4 });
      renderText("{{a}} {{b}}", { a: 5, b: 6 });

      expect(parse.mock.calls.length).toBe(afterFirst);
    } finally {
      parse.mockRestore();
    }
  });

  it("re-parses once the cache has been cleared", () => {
    const parse = jest.spyOn(Handlebars, "parse");
    try {
      renderText("{{z}}", { z: 1 });
      const afterFirst = parse.mock.calls.length;

      clearTemplateCache();
      renderText("{{z}}", { z: 1 });

      expect(parse.mock.calls.length).toBeGreaterThan(afterFirst);
    } finally {
      parse.mockRestore();
    }
  });

  it("stays bounded when fed many distinct sources", () => {
    // An unbounded Map keyed by caller-supplied strings is a memory leak.
    // 400 distinct sources against a 200-entry cap: the last one must
    // still render, which is all a caller can observe.
    for (let i = 0; i < 400; i += 1) {
      expect(renderText(`t${i} {{x}}`, { x: i })).toBe(`t${i} ${i}`);
    }
  });
});
