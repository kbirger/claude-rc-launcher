// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { sanitizeMarkdownHtml } from "./sanitize";

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("sanitizeMarkdownHtml (second layer, fed raw hostile HTML)", () => {
  const HOSTILE = [
    "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<svg onload=alert(1)>", "<iframe src=javascript:alert(1)></iframe>",
    "<a href=\"javascript:alert(1)\">x</a>", "<a href=\"JaVaScRiPt:alert(1)\">x</a>", "<a href=\"java&#115;cript:alert(1)\">x</a>",
    "<a href=\"data:text/html,<script>alert(1)</script>\">x</a>", "<a href=\"vbscript:msgbox(1)\">x</a>", "<a href=\"/relative\">x</a>",
    "<a href=\"https://ok.example\" onclick=\"alert(1)\" style=\"x:y\" class=\"c\" id=\"i\" data-x=\"1\">x</a>",
    "<p style=\"background:url(https://evil.example)\" class=\"hljs-keyword\">x</p>", "<form action=x><input name=a><button formaction=javascript:alert(1)>b</button></form>",
    "<style>*{x:y}</style>", "<meta http-equiv=refresh content=\"0;url=https://evil.example\">", "<base href=\"https://evil.example/\">",
    "<math><mi xlink:href=\"data:x,<script>alert(1)</script>\"></mi></math>", "<object data=\"javascript:alert(1)\"></object>", "<embed src=\"javascript:alert(1)\">",
    "<details open ontoggle=alert(1)><summary>s</summary>t</details>", "<input type=checkbox checked disabled>", "<video src=x onerror=alert(1)></video>",
    "<a href=\"data:text/html,hi\">x</a>", "<a href=\"https://ok.example\" onclick=\"https:alert(1)\" style=\"https://x\">x</a>", "<a href=\"https://ok.example\" onmouseover=\"mailto:1;alert(1)\" onfocus=\"http:alert(1)\">x</a>",
    "<svg><style><img src onerror=alert(1)>", "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">", "<math><mtext><table><mglyph><style><img src onerror=alert(1)>",
    "<a href=\"jav&#x09;ascript:alert(1)\">x</a>", "<a href=\"\u2028javascript:alert(1)\">x</a>", "<a href=\"&#x01;javascript:alert(1)\">x</a>",
    "<form><math><mtext></form><form><mglyph><svg><mtext><textarea><path id=\"</textarea><img onerror=alert(1) src>\">",
    "<a href=\"https://ok.example\" target=\"_self\" rel=\"opener\">x</a>", "<table><tr><td align=\"left\" onclick=\"alert(1)\">x</td></tr></table>",
  ];
  for (const [i, html] of HOSTILE.entries()) {
    test(`payload ${i}`, () => {
      const out = doc(sanitizeMarkdownHtml(html));
      for (const el of Array.from(out.body.querySelectorAll("*"))) {
        const tag = el.tagName.toLowerCase();
        expect(["script", "img", "svg", "math", "iframe", "form", "input", "button", "style", "meta", "base", "object", "embed", "video", "details", "summary"]).not.toContain(tag);
        for (const a of Array.from(el.attributes)) {
          expect(a.name.startsWith("on")).toBe(false);
          expect(["style", "class", "id", "src", "srcdoc", "formaction"]).not.toContain(a.name);
          expect(a.name.startsWith("data-")).toBe(false);
        }
        if (tag === "a") {
          expect(el.getAttribute("href") ?? "https://ok.example").toMatch(/^(https?:|mailto:)/i);
          expect(el.getAttribute("target")).toBe("_blank");
          expect(el.getAttribute("rel")).toBe("noopener noreferrer nofollow");
        }
      }
    });
  }
  test("keeps the allowed tags and adds target and rel to links", () => {
    const out = doc(sanitizeMarkdownHtml("<h1>t</h1><p><a href=\"https://ok.example/x\" title=\"T\">l</a></p><table><tbody><tr><td align=\"right\" class=\"x\">c</td></tr></tbody></table>"));
    expect(out.querySelector("h1")?.textContent).toBe("t");
    const a = out.querySelector("a")!;
    expect([a.getAttribute("href"), a.getAttribute("title"), a.getAttribute("target"), a.getAttribute("rel")]).toEqual(["https://ok.example/x", "T", "_blank", "noopener noreferrer nofollow"]);
    expect(out.querySelector("td")?.textContent).toBe("c");
    expect(out.querySelector("td")?.hasAttribute("align")).toBe(false);
  });
  test("keeps mailto links", () => {
    expect(doc(sanitizeMarkdownHtml("<a href=\"mailto:a@b.example\">m</a>")).querySelector("a")?.getAttribute("href")).toBe("mailto:a@b.example");
  });
});

describe("class rule (never in markdown)", () => {
  const classes = (html: string) => Array.from(doc(html).body.querySelectorAll("*")).map((e) => e.getAttribute("class"));
  test("the markdown sanitizer never keeps class", () => {
    expect(classes(sanitizeMarkdownHtml('<p class="keyword">a</p><code class="hljs">b</code><a class="x" href="https://ok.example">c</a>'))).toEqual([null, null, null]);
  });
});

describe("href and title only on links; links need an href", () => {
  test("href and title are removed from other elements", () => {
    const out = doc(sanitizeMarkdownHtml('<p title="t" href="https://x.example">a</p><td title="t" href="https://x.example">b</td><a title="T" href="https://x.example">c</a>'));
    for (const e of Array.from(out.body.querySelectorAll("p,td"))) expect(Array.from(e.attributes).map((a) => a.name)).toEqual([]);
    expect(out.querySelector("a")?.getAttribute("title")).toBe("T");
  });
  test("a link whose href was removed becomes its children", () => {
    const out = doc(sanitizeMarkdownHtml('<p><a href="javascript:1">one <b>two</b> <em>three</em></a> <a>bare</a> <a href="data:text/html,hi">d</a></p>'));
    expect(out.querySelector("a")).toBeNull();
    expect(out.body.textContent).toBe("one two three bare d");
    expect(out.querySelector("em")?.textContent).toBe("three");
  });
});
