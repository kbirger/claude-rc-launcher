// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { MARKDOWN_LIMIT } from "./viewkind";
import { sanitizeMarkdownHtml } from "./sanitize";
import { blockWeights, weightOfWord } from "./layoutweight";
import { MAX_BLOCK_WEIGHT, MAX_BRACKETS, MAX_ELEMENTS, MAX_HEAVY_WEIGHT, MAX_LEVEL, MAX_TOTAL_WEIGHT, MAX_RUN_COST, mdForTests, markdownToHtmlForTests, markdownToHtmlGuarded, renderMarkdown, renderMarkdownResult, safeHref } from "./markdown";
import { formatText } from "./formatted";

const TAGS = new Set(["a", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "del", "table", "thead", "tbody", "tr", "th", "td"]);
const ATTRS: Record<string, string[]> = { a: ["href", "title", "target", "rel"], th: ["align"], td: ["align"] };

/** Reads the HTML as a browser would and lists every problem. `final` is false for the output of layer 1 alone, which has no target and rel yet. */
function problems(html: string, final: boolean): string[] {
  const out: string[] = [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (!TAGS.has(tag)) out.push(`tag ${tag}`);
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith("on")) out.push(`handler ${a.name}`);
      if (a.name === "style") out.push("style");
      if (a.name === "src") out.push("src");
      if (!(ATTRS[tag] ?? []).includes(a.name)) out.push(`attribute ${tag}.${a.name}`);
      if (!final && (a.name === "target" || a.name === "rel")) out.push(`attribute ${tag}.${a.name} before layer 2`);
    }
    if (tag === "a") {
      const raw = el.getAttribute("href");
      // Every link, in both layers, must have a good href: layer 2 turns a link without one into its text.
      if (!/^(https?:|mailto:)/i.test(raw ?? "")) out.push(`href ${raw}`);
      if (final && (el.getAttribute("target") !== "_blank" || el.getAttribute("rel") !== "noopener noreferrer nofollow")) out.push("link target or rel");
    }
  }
  return out;
}

const PAYLOADS: Record<string, string> = {
  script: "<script>alert(1)</script>",
  scriptInline: "text <script>alert(1)</script> text",
  scriptUpper: "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
  onerrorImg: "<img src=x onerror=alert(1)>",
  onloadSvg: "<svg onload=alert(1)>",
  onclickAttr: "<a href=\"https://ok.example\" onclick=\"alert(1)\">x</a>",
  onmouseover: "<p onmouseover=alert(1)>hover</p>",
  inlineLink: "[x](javascript:alert(1))",
  inlineLinkCase: "[x](JaVaScRiPt:alert(1))",
  inlineLinkSpace: "[x](  javascript:alert(1))",
  inlineLinkAngle: "[x](<javascript:alert(1)>)",
  inlineLinkEntity: "[x](java&#115;cript:alert(1))",
  inlineLinkEntityHex: "[x](&#x6A;avascript:alert(1))",
  inlineLinkEntityColon: "[x](javascript&colon;alert(1))",
  inlineLinkPercent: "[x](javascript%3Aalert(1))",
  inlineLinkTab: "[x](java\tscript:alert(1))",
  inlineLinkNewline: "[x](java\nscript:alert(1))",
  inlineLinkControl: "[x](\u0001javascript:alert(1))",
  inlineLinkNul: "[x](java\u0000script:alert(1))",
  dataLink: "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  dataLinkUpper: "[x](DATA:text/html,<script>alert(1)</script>)",
  vbscript: "[x](vbscript:msgbox(1))",
  vbscriptMixed: "[x](VbScRiPt:msgbox(1))",
  fileLink: "[x](file:///etc/passwd)",
  relativeLink: "[x](../secret.md)",
  protocolRelative: "[x](//evil.example/x)",
  refLink: "[x][1]\n\n[1]: javascript:alert(1)",
  refLinkCollapsed: "[x][]\n\n[x]: javascript:alert(1)",
  refLinkShortcut: "[x]\n\n[x]: data:text/html,hi",
  autolink: "<javascript:alert(1)>",
  autolinkMail: "<a@b.example>",
  autolinkBare: "www.evil.example/x and https://ok.example/a_b",
  imgOnerror: "![x](x \"t\" onerror=alert(1))",
  imgJs: "![x](javascript:alert(1))",
  imgRemote: "![tracker](https://evil.example/pixel.png)",
  imgRef: "![x][1]\n\n[1]: https://evil.example/p.png",
  imgData: "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
  svg: "<svg><script>alert(1)</script></svg>",
  svgUse: "<svg><use href=\"data:image/svg+xml,<svg id='x' xmlns='http://www.w3.org/2000/svg'><image href='1' onerror='alert(1)'/></svg>#x\"/></svg>",
  math: "<math><mi//xlink:href=\"data:x,<script>alert(1)</script>\">",
  iframe: "<iframe src=\"javascript:alert(1)\"></iframe>",
  iframeSrcdoc: "<iframe srcdoc=\"<script>alert(1)</script>\"></iframe>",
  object: "<object data=\"javascript:alert(1)\"></object><embed src=\"javascript:alert(1)\">",
  form: "<form action=\"https://evil.example\"><input name=p><button>go</button></form>",
  formaction: "<button formaction=\"javascript:alert(1)\">x</button>",
  style: "<style>*{background:url(https://evil.example/t)}</style>",
  styleAttr: "<p style=\"background:url(https://evil.example/t)\">x</p>",
  metaRefresh: "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example\">",
  base: "<base href=\"https://evil.example/\">[x](a)",
  linkTag: "<link rel=stylesheet href=\"https://evil.example/x.css\">",
  htmlComment: "<!-- <script>alert(1)</script> -->",
  htmlCommentBroken: "<!--><script>alert(1)</script>-->",
  cdata: "<![CDATA[<script>alert(1)</script>]]>",
  nestedBroken: "<div><p><b><i>x</div></p></b></i><script>alert(1)",
  nestedBrokenTag: "<scr<script>ipt>alert(1)</scr</script>ipt>",
  unclosed: "<a href=\"https://ok.example\" title=\"x><script>alert(1)</script>",
  details: "<details open ontoggle=alert(1)><summary>s</summary>text</details>",
  mdInHtml: "<div>\n\n**bold** [x](javascript:alert(1))\n\n</div>",
  mdInHtmlInline: "<b>**x**</b> <i>[y](javascript:alert(1))</i>",
  tableHtml: "| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | <script>alert(1)</script> |\n| [x](javascript:alert(1)) | `<b>` |",
  tableAlign: "| a | b |\n|:--|--:|\n| 1 | 2 |",
  footnote: "text[^1]\n\n[^1]: <script>alert(1)</script> [x](javascript:alert(1))",
  taskList: "- [x] <script>alert(1)</script>\n- [ ] [x](javascript:alert(1))",
  headingHtml: "# <img src=x onerror=alert(1)>",
  emphasisHtml: "*<script>alert(1)</script>* __<img src=x onerror=1>__",
  codeBlock: "```<script>alert(1)</script>\n<script>alert(1)</script>\n```",
  codeLang: "```\"><script>alert(1)</script>\nx\n```",
  codeSpan: "`<script>alert(1)</script>`",
  indentedCode: "    <script>alert(1)</script>",
  blockquote: "> <script>alert(1)</script>\n> [x](javascript:alert(1))",
  titleAttr: "[x](https://ok.example \"\" onmouseover=\"alert(1)\")",
  titleQuote: "[x](https://ok.example \"a\\\" onmouseover=\\\"alert(1)\")",
  hrefQuote: "[x](https://ok.example/\"onmouseover=\"alert(1))",
  hrefAngleQuote: "[x](<https://ok.example/\" onmouseover=\"alert(1)>)",
  mailtoLink: "[x](mailto:a@b.example?subject=hi)",
  unicodeColon: "[x](javascript：alert(1))",
  bidi: "[x](‮javascript:alert(1))",
  deepQuote: "> ".repeat(2000) + "x",
  deepList: Array.from({ length: 300 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n"),
  deepBrackets: "[".repeat(5000) + "x](javascript:alert(1))",
  deepEmphasis: "*a ".repeat(5000),
  deepHtml: "<div>".repeat(5000) + "<script>alert(1)</script>",
  deepHtmlInline: "x<b>".repeat(5000) + "<img src=x onerror=1>",
  // Added in Task 3 beyond the plan list.
  x_svgStyleImg: "<svg><style><img src onerror=alert(1)>",
  x_noscriptTitle: "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">",
  x_mathMglyph: "<math><mtext><table><mglyph><style><img src onerror=alert(1)>",
  x_hrefEntityTab: "<a href=\"jav&#x09;ascript:alert(1)\">x</a>",
  x_hrefEntityNewline: "<a href=\"jav&#x0A;ascript:alert(1)\">x</a>",
  x_refDefJs: "[x][ref]\n\n[ref]: javascript:alert(1) \"t\"",
  x_refDefCaseInsensitive: "[Foo Bar]\n\n[foo bar]: JAVASCRIPT:alert(1)",
  x_leadingLineSep: "[x]( javascript:alert(1))",
  x_leadingParaSep: "[x]( javascript:alert(1))",
  x_leadingNbsp: "[x]( javascript:alert(1))",
  x_leadingZwsp: "[x](​javascript:alert(1))",
  x_leadingBom: "[x](﻿javascript:alert(1))",
  x_leadingDel: "[x](\u007fjavascript:alert(1))",
  x_linkTextHtml: "[<img src=x onerror=alert(1)>](https://ok.example)",
  x_linkTextScript: "[<script>alert(1)</script>](https://ok.example)",
  x_linkTextNestedLink: "[[a](javascript:alert(1))](https://ok.example)",
  x_autolinkJsAngle: "<JAVASCRIPT:alert(1)>",
  x_autolinkData: "<data:text/html,<script>alert(1)</script>>",
  x_autolinkQuote: "<https://ok.example/\"onmouseover=\"alert(1)>",
  x_bareUrlJs: "javascript:alert(1) and www.x.example\"onmouseover=\"alert(1)",
  x_bareUrlQuote: "https://ok.example/\"onmouseover=\"alert(1)",
  x_backslashBrackets: "\\[x\\](javascript:alert(1)) \\<script\\>alert(1)\\</script\\>",
  x_backslashParen: "[x](javascript:alert\\(1\\))",
  x_escapedLt: "&lt;script&gt;alert(1)&lt;/script&gt; &#60;script&#62;alert(1)&#60;/script&#62;",
  x_entityScript: "&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;",
  x_longLine: "[x](" + "a".repeat(200000) + ")",
  x_longLineJs: "[x](javascript:" + "a".repeat(200000) + ")",
  x_longTextLine: "<b>".repeat(30000) + "x",
  x_nulInTag: "<scr\u0000ipt>alert(1)</scr\u0000ipt>",
  x_nulInHref: "<a href=\"java\u0000script:alert(1)\">x</a>",
  x_imgTitleHandler: "![a\" onerror=\"alert(1)](https://ok.example/x.png)",
  x_imgAltHtml: "![<script>alert(1)</script>](https://ok.example/x.png)",
  x_imgSrcset: "<img srcset=\"x 1x\" src=x onerror=alert(1)>",
  x_picture: "<picture><source srcset=\"javascript:alert(1)\"><img src=x onerror=alert(1)></picture>",
  x_video: "<video src=x onerror=alert(1)><source onerror=alert(1)></video>",
  x_audio: "<audio src=x onerror=alert(1)></audio>",
  x_tableCellHtml: "| a |\n|---|\n| <svg onload=alert(1)> |",
  x_tableHeaderLink: "| [x](javascript:alert(1)) |\n|---|\n| y |",
  x_xmpPlaintext: "<plaintext><script>alert(1)</script>",
  x_listing: "<xmp><script>alert(1)</script></xmp><listing><img src=x onerror=alert(1)></listing>",
  x_textarea: "<textarea><script>alert(1)</script></textarea><title><img src=x onerror=alert(1)></title>",
  x_isindex: "<isindex action=javascript:alert(1)><marquee onstart=alert(1)>x</marquee>",
  x_bodyOnload: "<body onload=alert(1)><html onmouseover=alert(1)>",
  x_attrBacktick: "<a href=`javascript:alert(1)`>x</a>",
  x_slashAttr: "<a/href=javascript:alert(1)>x</a><img/src=x/onerror=alert(1)>",
  x_scriptInLink: "[x](https://ok.example/<script>alert(1)</script>)",
  x_frameset: "<frameset onload=alert(1)><frame src=javascript:alert(1)></frameset>",
  x_templateTag: "<template><script>alert(1)</script></template>",
  x_dataUrlInTitle: "[x](https://ok.example \"data:text/html,<script>alert(1)</script>\")",
  x_codeFenceTilde: "~~~html\n<script>alert(1)</script>\n~~~",
  x_rawDataHref: "<a href=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">x</a>",
  x_rawDataHrefPlain: "<a href=\"data:text/html,hi\">x</a>",
  x_rawDataHrefUpper: "<a href=\"DATA:text/html,hi\">x</a>",
  // A handler whose value starts with an allowed scheme word is a JavaScript label, so it still runs: "https:alert(1)".
  x_handlerLabelHttps: "<a href=\"https://ok.example\" onclick=\"https:alert(1)\">x</a>",
  x_handlerLabelMailto: "<a href=\"https://ok.example\" onmouseover=\"mailto:1;alert(1)\">x</a>",
  x_handlerLabelOnerror: "<a href=\"https://ok.example\" onerror=\"http:alert(1)\" onfocus=\"https:alert(1)\" autofocus tabindex=1>x</a>",
  x_styleAttrAllowedScheme: "<p style=\"https:x\">x</p><a href=\"https://ok.example\" style=\"https://x\">y</a>",
  x_htmlEntityInRef: "[x]\n\n[x]: <java&#115;cript:alert(1)>",
};

describe("hostile markdown corpus", () => {
  test("has at least 80 payloads", () => {
    expect(Object.keys(PAYLOADS).length).toBeGreaterThanOrEqual(80);
  });
  for (const [name, src] of Object.entries(PAYLOADS)) {
    // Layer 1 alone must already be safe: it is the renderer, with no sanitizer after it.
    test(`${name}: the renderer alone is safe`, () => {
      expect(problems(markdownToHtmlForTests(src), false)).toEqual([]);
    });
    // Both layers: the result is safe, or the render failed and gave undefined (the preview then shows plain text).
    test(`${name}: renderMarkdown is safe`, () => {
      const out = renderMarkdown(src);
      if (out !== undefined) expect(problems(out, true)).toEqual([]);
    });
  }
});

// The preview goes through formatText: a dynamic import of the markdown module, then renderMarkdown. The result must be
// exactly the result of renderMarkdown, for the whole corpus.
describe("formatText equals renderMarkdown for the whole corpus", () => {
  for (const [name, src] of Object.entries(PAYLOADS)) {
    test(name, async () => {
      const expected = renderMarkdown(src);
      const r = await formatText("a.md", src);
      if (r.kind === "markdown") expect(r.html).toBe(expected);
      else expect(expected === undefined || src.length > MARKDOWN_LIMIT).toBe(true);
    });
  }
});

// Layer 2 alone: every payload is fed to the sanitizer as raw HTML, as if layer 1 had let it through unchanged.
// Three payloads are left out: 5000 or 30000 nested raw tags make jsdom and DOMPurify run for many minutes (measured: no
// result after 40 s). Layer 1 turns raw HTML into text, so real input never reaches layer 2 in that form. They still run
// against layer 1 and against both layers above.
const NESTED_RAW_HTML = new Set(["deepHtml", "deepHtmlInline", "x_longTextLine"]);
describe("hostile markdown corpus, second layer alone (layer 1 bypassed)", () => {
  for (const [name, src] of Object.entries(PAYLOADS).filter(([n]) => !NESTED_RAW_HTML.has(n))) {
    test(`${name}: sanitizeMarkdownHtml alone is safe`, () => {
      expect(problems(sanitizeMarkdownHtml(src), true)).toEqual([]);
    });
    test(`${name}: sanitizeMarkdownHtml alone is safe when wrapped in a paragraph`, () => {
      expect(problems(sanitizeMarkdownHtml(`<p>${src}</p>`), true)).toEqual([]);
    });
  }
});

describe("what renders", () => {
  test("a safe link keeps its text and address", () => {
    const a = new DOMParser().parseFromString(renderMarkdown("[hi](https://example.com/a?b=1&c=2)")!, "text/html").querySelector("a")!;
    expect([a.textContent, a.getAttribute("href")]).toEqual(["hi", "https://example.com/a?b=1&c=2"]);
  });
  test("a bad link becomes its plain text", () => {
    const doc = new DOMParser().parseFromString(renderMarkdown("[click me](javascript:alert(1))")!, "text/html");
    expect(doc.querySelector("a")).toBeNull();
    expect(doc.body.textContent).toContain("click me");
  });
  test("raw html shows as text", () => {
    const doc = new DOMParser().parseFromString(renderMarkdown("<script>alert(1)</script>\n\nhi")!, "text/html");
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.body.textContent).toContain("<script>alert(1)</script>");
  });
  test("an image shows as a text link and never as an img", () => {
    const doc = new DOMParser().parseFromString(renderMarkdown("![logo](https://example.com/l.png)")!, "text/html");
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("a")?.textContent).toBe("Image: logo");
  });
  test("task list items show as text marks", () => {
    const text = new DOMParser().parseFromString(renderMarkdown("- [x] done\n- [ ] todo")!, "text/html").body.textContent;
    expect(text).toContain("[x] done");
    expect(text).toContain("[ ] todo");
  });
  test("tables, headings and code blocks render", () => {
    const doc = new DOMParser().parseFromString(renderMarkdown("# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```")!, "text/html");
    expect(doc.querySelector("h1")?.textContent).toBe("T");
    expect(doc.querySelectorAll("td").length).toBe(2);
    expect(doc.querySelector("pre code")?.textContent).toContain("const a = 1;");
    expect(doc.querySelector("pre code")?.hasAttribute("class")).toBe(false);
  });
});

describe("safeHref", () => {
  test("keeps http, https and mailto only", () => {
    expect(safeHref("https://a.example/x")).toBe("https://a.example/x");
    expect(safeHref("HTTP://a.example")).toBe("HTTP://a.example");
    expect(safeHref("mailto:a@b.example")).toBe("mailto:a@b.example");
    for (const bad of ["javascript:x", " https://a.example", "//a.example", "/a", "a.html", "data:x", "vbscript:x", "https://a.example/\"x", "https://a.example/<x", "https://a.example/\u0001", "", undefined, null]) {
      expect(safeHref(bad)).toBeUndefined();
    }
  });
});

describe("limits", () => {
  test("a text of MARKDOWN_LIMIT characters renders in a few seconds, or gives undefined", () => {
    const unit = "# t\n\nSome words in a paragraph, with a [link](https://ok.example) and `code`, and more words to fill the line, and more words to fill the line, and more words to fill the line, and more words to fill the line.\n\n- [ ] item **bold**\n\n";
    const big = unit.repeat(Math.ceil(MARKDOWN_LIMIT / unit.length)).slice(0, MARKDOWN_LIMIT);
    const start = performance.now();
    const out = renderMarkdown(big);
    // jsdom is about ten times slower than a browser. The real browser run (task I report) measures the true time.
    expect(performance.now() - start).toBeLessThan(5000);
    expect(out).toBeDefined();
  });
  test("renderMarkdown never throws", () => {
    expect(() => renderMarkdown("\u0000".repeat(1000))).not.toThrow();
  });
});

describe("the complexity guard", () => {
  test("a text that makes more than MAX_ELEMENTS elements is refused, one just below is rendered", () => {
    expect(markdownToHtmlGuarded("- a\n".repeat(MAX_ELEMENTS / 2 - 100))).toBeDefined();
    expect(markdownToHtmlGuarded("- a\n".repeat(MAX_ELEMENTS))).toBeUndefined();
  });
  test("a text that nests deeper than MAX_LEVEL is refused, one at the limit is rendered", () => {
    expect(markdownToHtmlGuarded("*".repeat(MAX_LEVEL - 2) + "a" + "*".repeat(MAX_LEVEL - 2))).toBeDefined();
    expect(markdownToHtmlGuarded("*".repeat(MAX_LEVEL * 3) + "a" + "*".repeat(MAX_LEVEL * 3))).toBeUndefined();
    expect(markdownToHtmlGuarded("*a ".repeat(MAX_LEVEL * 3) + "a* ".repeat(MAX_LEVEL * 3))).toBeUndefined();
  });
  test("unbroken runs are refused when the sum of their squares is above MAX_RUN_COST", () => {
    const one = Math.floor(Math.sqrt(MAX_RUN_COST));
    expect(markdownToHtmlGuarded("A".repeat(one))).toBeDefined();
    expect(markdownToHtmlGuarded("A".repeat(one + 1))).toBeUndefined();
    expect(markdownToHtmlGuarded("[" + "A".repeat(one) + "](https://a.example)")).toBeUndefined();
    expect(markdownToHtmlGuarded(("A".repeat(1000) + " ").repeat(9))).toBeDefined();
    expect(markdownToHtmlGuarded(("A".repeat(1000) + " ").repeat(11))).toBeUndefined();
    expect(markdownToHtmlGuarded("word ".repeat(10000))).toBeDefined();
  });
  test("an output much longer than the input is refused", () => {
    expect(markdownToHtmlGuarded("\" ".repeat(2500))).toBeDefined();
    expect(markdownToHtmlGuarded("a|b\n-|-\n" + "|\n".repeat(30))).toBeDefined();
  });
  test("the reason is complex for the guard and the page shows the complex note", async () => {
    const hostile = "- a\n".repeat(MAX_ELEMENTS);
    expect(renderMarkdownResult(hostile)).toEqual({ ok: false, reason: "complex" });
    expect(renderMarkdown(hostile)).toBeUndefined();
    const r = await formatText("a.md", hostile);
    expect(r).toEqual({ kind: "plain", note: "This file is too complex to format. Showing plain text." });
  });
  test("a refusal is fast: the guard runs before any rendering", () => {
    const start = performance.now();
    renderMarkdownResult("`\n".repeat(MARKDOWN_LIMIT / 2));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

// What jsdom proves here: the parser and the sanitizer finish these inputs well inside 2 s even in jsdom, which is
// several times slower than a browser. What only a real browser proves: the time from the start of the job to the next
// paint at the size limit with the processor slowed down, and that the page stays responsive. The Chromium run in the task I
// report does that.
describe("inputs that were slow for other parsers render quickly", () => {
  const N = MARKDOWN_LIMIT;
  const INPUTS: Record<string, string> = {
    mixedStarUnderscore: "*a_".repeat(Math.floor(N / 3)),
    underscoreA: "_a".repeat(N / 2),
    stars: "*".repeat(N - 1) + "x",
    quoteSpaced: "> ".repeat(N / 2),
    brackets: "](x".repeat(Math.floor(N / 3)),
    wordUnderscores: ("a" + "_".repeat(299) + "b").repeat(Math.floor(N / 301)),
    full: "*a_".repeat(34133),
    fullUnderscoreA: "_a".repeat(51200),
    fullStars: "*".repeat(102400) + "x",
    fullQuotes: "> ".repeat(51200),
  };
  for (const [name, src] of Object.entries(INPUTS)) {
    test(`${name}: under 2 s`, () => {
      const start = performance.now();
      renderMarkdownResult(src);
      expect(performance.now() - start).toBeLessThan(2000);
    });
  }
});

// Every way markdown-it can make an href goes through the link_open renderer rule, and every way it can make a src goes through
// the image rule. Both check safeHref. The core rule hides the tags of a link that fails the check. These forms must end as
// plain text unless the address starts with http://, https:// or mailto:. They run through layer 1 alone, so layer 2 is not
// what saves them.
describe("every link form ends as plain text unless the address is http, https or mailto", () => {
  const OK = ["[t](https://a.example/x)", "[t](HTTP://A.EXAMPLE)", "[t](mailto:a@b.example)", "<https://a.example>", "<mailto:a@b.example>", "[t][r]\n\n[r]: https://a.example", "[t]\n\n[t]: https://a.example", "![t](https://a.example/i.png)", "![t][r]\n\n[r]: https://a.example/i.png", "[![t](https://a.example/i.png)](https://b.example)"];
  const BAD = [
    "[t](javascript:alert(1))", "[t](JaVaScRiPt:alert(1))", "[t](java&#115;cript:alert(1))", "[t](&#x6A;avascript:alert(1))", "[t](javascript&colon;alert(1))", "[t](javascript&#58;alert(1))",
    "[t](data:text/html,x)", "[t](vbscript:x)", "[t](file:///etc/passwd)", "[t](blob:https://a.example/x)", "[t](//a.example)", "[t](/a)", "[t](a.html)", "[t](#frag)", "[t](?q=1)", "[t](http:a)", "[t](https:/a)",
    "[t]( javascript:x)", "[t](<javascript:x>)", "[t](java\tscript:x)", "[t](\u0001https://a.example)", "[t](https://a.example/\u0001)", "[t](https://a.example/\"x)",
    "<javascript:alert(1)>", "<JAVASCRIPT:alert(1)>", "<data:text/html,x>", "<file:///x>", "<ftp://a.example>", "<a@b.example>x", 
    "[t][r]\n\n[r]: javascript:alert(1)", "[t]\n\n[t]: data:x", "[t][]\n\n[t]: <vbscript:x>", "[t][r]\n\n[r]: //a.example",
    "![t](javascript:alert(1))", "![t][r]\n\n[r]: data:image/svg+xml,x", "![t](x.png)", "![t](/x.png)", "![t](//a.example/x.png)", "![t](file:///x)",
    "[![t](javascript:1)](javascript:2)", "[a [b](javascript:x)](https://c.example)", "www.a.example and https://a.example/b and a@b.example",
  ];
  const hrefs = (html: string) => Array.from(new DOMParser().parseFromString(html, "text/html").querySelectorAll("a")).map((a) => a.getAttribute("href"));
  for (const src of BAD) {
    test(`plain text: ${JSON.stringify(src).slice(0, 60)}`, () => {
      const html = markdownToHtmlForTests(src);
      const d = new DOMParser().parseFromString(html, "text/html");
      expect(d.querySelector("img, [src]")).toBeNull();
      for (const h of hrefs(html)) expect(h).toMatch(/^(https?:\/\/|mailto:)/i);
    });
  }
  test("the plain forms that are bad give no link at all", () => {
    for (const src of BAD.slice(0, 41)) {
      if (src.startsWith("[![") || src.startsWith("[a [b]")) continue;
      if (src.startsWith("<a@b") || src.startsWith("www") || src.includes("\"x") || src.includes("\u0001")) continue; // the encoder makes these safe links: a quote becomes %22
      expect(hrefs(markdownToHtmlForTests(src)), src).toEqual([]);
    }
  });
  test("the good forms are links with the safe address", () => {
    for (const src of OK) expect(hrefs(markdownToHtmlForTests(src)).length, src).toBeGreaterThan(0);
  });
  test("an image never makes img or src, and the text stays", () => {
    const html = markdownToHtmlForTests("![alt text](https://a.example/i.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("Image: alt text");
  });
});

// The layout guard. The guard decision is pure, so jsdom can test it: these tests prove which inputs are refused and which are
// rendered. They do NOT prove the time. The time of every reproduction below was measured in real Chromium with the processor
// slowed 4 times, in the real app (task I report): before the guard each of the refused ones took 1.2 to 28 s.
describe("the layout guard", () => {
  const cp = String.fromCodePoint;
  test("one block of words that are not Latin: refused above MAX_BLOCK_WEIGHT, rendered at it", () => {
    expect(markdownToHtmlGuarded("ア ".repeat(MAX_BLOCK_WEIGHT))).toBeDefined();
    expect(markdownToHtmlGuarded("ア ".repeat(MAX_BLOCK_WEIGHT + 10))).toBeUndefined();
  });
  test("reproduction: a Hebrew letter and a Latin letter in 21,845 words in one paragraph (3.6 s at 4x) is refused", () => {
    expect(markdownToHtmlGuarded("אa ".repeat(21845))).toBeUndefined();
  });
  test("reproduction: a private use character and a Han character in a word, 8,000 words (5.9 to 7.1 s at 4x) is refused", () => {
    const text = Array.from({ length: 8000 }, (_, j) => cp(0xe000 + ((j * 7) % 6000)) + cp(0x4e00 + ((j * 13) % 20000)) + " ").join("");
    expect(markdownToHtmlGuarded(text)).toBeUndefined();
  });
  test("reproduction: 21,000 two-character words of private use and Han (17 s at 4x) is refused", () => {
    const text = Array.from({ length: 21000 }, (_, j) => cp(0xe000 + ((j * 7) % 6000)) + cp(0x4e00 + ((j * 13) % 20000)) + " ").join("");
    expect(markdownToHtmlGuarded(text)).toBeUndefined();
  });
  test("Hebrew with Latin: about 900 words in a block is the limit (weight 9 each)", () => {
    const n = Math.floor(MAX_BLOCK_WEIGHT / weightOfWord("אa"));
    expect(markdownToHtmlGuarded("אa ".repeat(n))).toBeDefined();
    expect(markdownToHtmlGuarded("אa ".repeat(n + 1))).toBeUndefined();
  });
  test("heavy words (private use with Han): refused above MAX_HEAVY_WEIGHT over the whole file, rendered below", () => {
    const word = (j: number) => cp(0xe000 + ((j * 7) % 6000)) + cp(0x4e00 + ((j * 13) % 20000)) + " ";
    expect(markdownToHtmlGuarded(Array.from({ length: MAX_HEAVY_WEIGHT / 8 - 1 }, (_, j) => word(j)).join(""))).toBeDefined();
    expect(markdownToHtmlGuarded(Array.from({ length: MAX_HEAVY_WEIGHT / 8 + 1 }, (_, j) => word(j)).join(""))).toBeUndefined();
  });
  test("many blocks just under the limit add up: the total weight is limited over the whole file", () => {
    const para = "aア ".repeat(Math.floor(MAX_BLOCK_WEIGHT / weightOfWord("aア")) - 10) + "\n\n";
    const blocks = Math.floor(MAX_TOTAL_WEIGHT / blockWeights(para).total);
    expect(markdownToHtmlGuarded(para.repeat(blocks))).toBeDefined();
    expect(markdownToHtmlGuarded(para.repeat(blocks + 2))).toBeUndefined();
  });
  test("a heading, a list item, a table cell, a quote and a link text count as a block each", () => {
    for (const wrap of [(t: string) => "# " + t, (t: string) => "- " + t, (t: string) => "> " + t, (t: string) => "| a |\n|---|\n| " + t + " |", (t: string) => "[" + t + "](https://e.example)"]) {
      expect(markdownToHtmlGuarded(wrap("ア ".repeat(MAX_BLOCK_WEIGHT + 10)))).toBeUndefined();
      expect(markdownToHtmlGuarded(wrap("ア ".repeat(100)))).toBeDefined();
    }
  });
  test("Thai without spaces is refused through the run cost, Chinese without spaces is not", () => {
    expect(markdownToHtmlGuarded("ก".repeat(Math.ceil(Math.sqrt(MAX_RUN_COST)) + 1))).toBeUndefined();
    expect(markdownToHtmlGuarded(Array.from({ length: 60000 }, (_, j) => cp(0x4e00 + ((j * 13) % 20000))).join(""))).toBeDefined();
  });
  test("reproduction: Latin and Han letters alternating in one word of 64,000 characters (2.0 s at 4x) is refused", () => {
    expect(markdownToHtmlGuarded("A你".repeat(32000))).toBeUndefined();
  });
  test("reproduction: kana words separated by the ideographic space, 32,768 of them (23 s at 4x) is refused", () => {
    expect(markdownToHtmlGuarded("ア\u3000".repeat(32768))).toBeUndefined();
  });
  test("reproduction: Latin words separated by the ideographic space, 21,845 of them (14 s at 4x) is refused", () => {
    expect(markdownToHtmlGuarded("ab\u3000".repeat(21845))).toBeUndefined();
  });
  test("reproduction: kana separated by a comma or a dash and no space, 32,768 of them (1.9 to 2.8 s at 4x) is refused", () => {
    for (const sep of [",", "-", "/", "…", "—", "?", ")"]) expect(markdownToHtmlGuarded(("ア" + sep).repeat(32768)), sep).toBeUndefined();
  });
  test("reproduction: a smiling face and a variation selector, 7,000 words of three (1.2 s at 4x) is refused", () => {
    expect(markdownToHtmlGuarded("☺️☺︎☺️☺︎☺️☺︎ ".repeat(5400))).toBeUndefined();
  });
  test("a long Latin run next to one Han character is still a long run", () => {
    expect(markdownToHtmlGuarded("A".repeat(60000) + "你")).toBeUndefined();
  });
  test("more than MAX_BRACKETS openers are refused", () => {
    expect(markdownToHtmlGuarded("[ ".repeat(MAX_BRACKETS))).toBeDefined();
    expect(markdownToHtmlGuarded("[ ".repeat(MAX_BRACKETS + 1))).toBeUndefined();
    expect(markdownToHtmlGuarded("![ ".repeat(MAX_BRACKETS + 1))).toBeUndefined();
  });
  test("normal prose of 60,000 characters in each of eight scripts still renders", () => {
    const prose: Record<string, { words: string[]; sep: string; end: string }> = {
      ko: { words: ["오늘은", "날씨가", "정말", "좋아서", "공원에", "API를", "사용해서", "2024년에", "문서를"], sep: " ", end: ". " },
      ja: { words: ["今日は", "天気が", "とても", "良かったので", "公園に", "APIを", "使って", "文書を"], sep: "", end: "。" },
      zh: { words: ["今天", "天气", "非常", "好", "我们", "去", "公园", "使用", "API", "文档"], sep: "", end: "。" },
      hi: { words: ["आज", "मौसम", "बहुत", "अच्छा", "था", "इसलिए", "हम", "पार्क", "में"], sep: " ", end: "। " },
      ru: { words: ["Сегодня", "была", "очень", "хорошая", "погода", "поэтому", "мы", "пошли"], sep: " ", end: ". " },
      ar: { words: ["اليوم", "كان", "الطقس", "جميلا", "جدا", "لذلك", "ذهبنا", "إلى"], sep: " ", end: ". " },
      th: { words: ["วันนี้", "อากาศ", "ดีมาก", "เราจึง", "ไปที่", "สวนสาธารณะ", "กับเพื่อน"], sep: "", end: " " },
      en: { words: ["Today", "the", "weather", "was", "very", "nice", "so", "we", "went"], sep: " ", end: ". " },
    };
    for (const [lang, v] of Object.entries(prose)) {
      let s = "";
      let k = 0;
      while (s.length < 60000) {
        let p = "";
        for (let i = 0; i < 4; i++) {
          let sentence = "";
          for (let j = 0; j < 12; j++) sentence += (j && v.sep ? v.sep : "") + v.words[k++ % v.words.length];
          p += sentence + v.end;
        }
        s += p.trim() + "\n\n";
      }
      expect(markdownToHtmlGuarded(s), lang).toBeDefined();
    }
  });
});

// The layer 1 pieces that make a link safe, one by one. Each one is tested alone, so removing one of them fails a test even when the
// others would still keep the output safe.
describe("the link rules alone", () => {
  const unsafe = "[t](javascript:alert(1)) and [u](https://a.example)";
  const kids = (src: string) => (mdForTests.parse(src, {}).find((t) => t.type === "inline")?.children ?? []);
  test("the core rule hides the open and the close token of an unsafe link, and only those", () => {
    const k = kids(unsafe);
    const opens = k.filter((t) => t.type === "link_open");
    const closes = k.filter((t) => t.type === "link_close");
    expect(opens.map((t) => t.hidden)).toEqual([true, false]);
    expect(closes.map((t) => t.hidden)).toEqual([true, false]);
  });
  test("the core rule also hides unsafe links inside the children of an image", () => {
    const img = kids("![[a](javascript:x) b](https://y.example/i.png)").find((t) => t.type === "image")!;
    const inner = (img.children ?? []).filter((t) => t.type === "link_open" || t.type === "link_close");
    expect(inner.length).toBe(2);
    expect(inner.every((t) => t.hidden)).toBe(true);
  });
  test("the link renderer rule alone prints nothing for an unsafe address, and the tag for a safe one", () => {
    const rule = mdForTests.renderer.rules.link_open!;
    const state = new mdForTests.core.State("", mdForTests, {});
    const bad = new state.Token("link_open", "a", 1);
    bad.attrSet("href", "javascript:alert(1)");
    expect(rule([bad], 0, mdForTests.options, {}, mdForTests.renderer)).toBe("");
    const good = new state.Token("link_open", "a", 1);
    good.attrSet("href", "https://a.example/x");
    good.attrSet("title", 't"x');
    expect(rule([good], 0, mdForTests.options, {}, mdForTests.renderer)).toBe('<a href="https://a.example/x" title="t&quot;x">');
  });
  test("the image renderer rule alone prints plain text for an unsafe address and never prints the children", () => {
    const rule = mdForTests.renderer.rules.image!;
    const state = new mdForTests.core.State("", mdForTests, {});
    const bad = new state.Token("image", "img", 0);
    bad.attrSet("src", "javascript:alert(1)");
    bad.content = "alt";
    expect(rule([bad], 0, mdForTests.options, {}, mdForTests.renderer)).toBe("Image: alt");
    const link = new state.Token("link_open", "a", 1);
    link.attrSet("href", "https://evil.example");
    const good = new state.Token("image", "img", 0);
    good.attrSet("src", "https://a.example/i.png");
    good.content = "alt";
    good.children = [link];
    expect(rule([good], 0, mdForTests.options, {}, mdForTests.renderer)).toBe('<a href="https://a.example/i.png">Image: alt</a>');
  });
  test("validateLink accepts every address, because the strict check runs after the parse (this pins that design)", () => {
    expect(mdForTests.validateLink("javascript:alert(1)")).toBe(true);
    expect(mdForTests.validateLink("https://a.example")).toBe(true);
    expect(mdForTests.validateLink("data:text/html,x")).toBe(true);
  });
  test("raw HTML is off in the options, even though the renderer rules would also escape it", () => {
    expect(mdForTests.options.html).toBe(false);
    expect(mdForTests.options.linkify).toBe(false);
    expect(mdForTests.options.typographer).toBe(false);
  });
});
