import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { markupText, nodeText } from "./tools/page-text.js";

/**
 * The fixtures are minified on purpose. Pretty-printed markup hides the bug:
 * the indentation between two tags is a text node, so `textContent` happens
 * to come out separated. Every string below was seen glued in real tool
 * output, and its markup is the shape the page really had.
 */
const body = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document.body;
const read = (html: string) => nodeText(body(html));

describe("the bug: textContent has no layout in it", () => {
  test("cells, list items, definitions and stacked spans all arrive glued", () => {
    const glued = (html: string) => body(html).textContent;
    assert.equal(glued("<table><tr><td>Lucid Air</td><td>Grand Touring</td></tr></table>"), "Lucid AirGrand Touring");
    assert.equal(
      glued("<ul><li>Adaptive ANC</li><li>30-hour battery</li><li>ULT bass mode</li><li>LDAC Hi-Res</li></ul>"),
      "Adaptive ANC30-hour batteryULT bass modeLDAC Hi-Res",
    );
    assert.equal(glued("<dl><dt>Full name</dt><dd>Clube de Regatas do Flamengo</dd></dl>"), "Full nameClube de Regatas do Flamengo");
  });
});

describe("reading a page's text off its DOM", () => {
  test("two cells are two things, and a row is a line", () => {
    const text = read(
      "<table><tr><th>Model</th><th>Trim</th></tr>" +
        "<tr><td>Lucid Air</td><td>Grand Touring</td></tr>" +
        "<tr><td>Chevrolet Silverado EV</td><td>WT Max Range</td></tr></table>",
    );
    assert.equal(text, "Model\tTrim\nLucid Air\tGrand Touring\nChevrolet Silverado EV\tWT Max Range");
  });

  test("an infobox: header cell, data cell, and a line break inside it", () => {
    // Wikipedia's markup for the club's leagues, as served.
    const text = read(
      '<table><tr><th scope="row">Full name</th><td>Clube de Regatas do Flamengo</td></tr>' +
        '<tr><th scope="row">Nicknames</th><td>Rubro-Negro</td></tr>' +
        '<tr><th scope="row">League</th><td><a href="/a">Campeonato Brasileiro Série A</a><br/>' +
        '<a href="/b">Campeonato Carioca</a></td></tr></table>',
    );
    assert.equal(
      text,
      "Full name\tClube de Regatas do Flamengo\nNicknames\tRubro-Negro\n" +
        "League\tCampeonato Brasileiro Série A\nCampeonato Carioca",
    );
  });

  test("a definition list", () => {
    assert.equal(
      read("<dl><dt>Full name</dt><dd>Clube de Regatas do Flamengo</dd><dt>Nicknames</dt><dd>Rubro-Negro</dd></dl>"),
      "Full name\nClube de Regatas do Flamengo\nNicknames\nRubro-Negro",
    );
  });

  test("list items with nothing between them", () => {
    assert.equal(
      read('<ul class="feats"><li>Adaptive ANC</li><li>30-hour battery</li><li>ULT bass mode</li><li>LDAC Hi-Res</li></ul>'),
      "Adaptive ANC\n30-hour battery\nULT bass mode\nLDAC Hi-Res",
    );
  });

  test("two labels a stylesheet stacked: adjacent spans get a space", () => {
    // Where "Lucid AirGrand Touring" really came from: one cell, two spans,
    // and `display:block` in a stylesheet this reader never sees.
    assert.equal(
      read(
        '<table><tr><td class="model"><span class="model-name">Lucid Air</span><span class="model-trim">Grand Touring</span></td>' +
          '<td class="num price">$114,900</td></tr></table>',
      ),
      "Lucid Air Grand Touring\t$114,900",
    );
    assert.equal(
      read('<div><span class="chip">Adaptive ANC</span><span class="chip">30-hour battery</span><span class="chip">LDAC Hi-Res</span></div>'),
      "Adaptive ANC 30-hour battery LDAC Hi-Res",
    );
    assert.equal(read('<p><a href="/">Home</a><a href="/about">About</a></p>'), "Home About");
    // The seam is found through wrappers, not only between bare spans.
    assert.equal(read("<div><span><b>Silverado EV</b></span><span><i>WT Max Range</i></span></div>"), "Silverado EV WT Max Range");
  });

  test("inline markup does not open a word", () => {
    assert.equal(read("<p>The <b>Sam</b>sung Galaxy</p>"), "The Samsung Galaxy");
    assert.equal(read("<p>An i<span>Phone</span> runs mac<em>OS</em>-like software</p>"), "An iPhone runs macOS-like software");
    assert.equal(read("<p>iPhone and macOS and <a href='#'>YouTube</a>'s app</p>"), "iPhone and macOS and YouTube's app");
    assert.equal(read("<p>H<sub>2</sub>O, and <i>mc</i><sup>2</sup></p>"), "H2O, and mc2");
  });

  test("an element of one character is a letter, not a label", () => {
    // A heading animated letter by letter, and a drop cap in its own span.
    assert.equal(read("<h1><span>F</span><span>l</span><span>a</span><span>m</span><span>e</span></h1>"), "Flame");
    assert.equal(read('<p><span class="cap">T</span><span class="rest">he match</span> ended</p>'), "The match ended");
  });

  test("a seam only joins two words, never a figure to its sign", () => {
    assert.equal(
      read('<span class="price"><span class="sym">US$</span><span class="whole">114</span><span class="frac">,900</span></span>'),
      "US$114,900",
    );
  });

  test("highlighted code keeps its tokens together and its lines apart", () => {
    const text = read(
      '<pre><code><span class="k">const</span> <span class="n">total</span><span class="p">=</span>' +
        '<span class="n">price</span><span class="n">Count</span>;\n  return total;</code></pre>',
    );
    assert.equal(text, "const total=priceCount;\n  return total;");
    assert.equal(read('<p>Call <code><span class="n">read</span><span class="n">File</span>()</code> first</p>'), "Call readFile() first");
  });

  test("the source's indentation is not the page's", () => {
    const text = read(`
      <table>
          <tr>
              <td class="rank">   <span>1</span>   </td>
              <td class="model">
                  Lucid Air
              </td>
          </tr>
      </table>`);
    assert.equal(text, "1\tLucid Air");
  });

  test("a block that is all a cell holds does not take the row apart", () => {
    const text = read(
      '<table><tr><td>$114,900</td><td><div class="bar"><span style="width:98%"></span><em>512 mi</em></div></td><td><p>128</p></td></tr>' +
        "<tr><td>$74,600</td><td><div>493 mi</div></td><td><p>68</p></td></tr></table>",
    );
    assert.equal(text, "$114,900\t512 mi\t128\n$74,600\t493 mi\t68");
  });

  test("an empty cell is not a second gap", () => {
    assert.equal(read("<table><tr><td>a</td><td></td><td> </td><td>b</td></tr></table>"), "a\tb");
  });

  test("paragraphs and headings are lines; scripts and styles are not text", () => {
    const text = read(
      "<h2>Results</h2><p>First paragraph.</p><p>Second<br>line.</p><script>alert(1)</script><style>p{color:red}</style><div>Last</div>",
    );
    assert.equal(text, "Results\n\nFirst paragraph.\n\nSecond\nline.\n\nLast");
  });

  test("page furniture is dropped only when asked", () => {
    const html = "<nav><a href='/'>Home</a></nav><main><p>The article.</p></main><footer>Privacy policy</footer>";
    assert.equal(nodeText(body(html), { dropChrome: true }), "The article.");
    assert.match(nodeText(body(html)), /Home/);
  });
});

describe("reading markup without a parser", () => {
  test("blocks, cells and list items are separated", () => {
    assert.equal(
      markupText("<table><tr><td>Lucid Air</td><td>Grand Touring</td></tr><tr><td>Silverado EV</td><td>WT Max Range</td></tr></table>"),
      "Lucid Air\tGrand Touring\nSilverado EV\tWT Max Range",
    );
    assert.equal(markupText("<ul><li>Adaptive ANC</li><li>30-hour battery</li></ul>"), "Adaptive ANC\n30-hour battery");
    assert.equal(markupText("<dl><dt>Full name</dt><dd>Clube de Regatas do Flamengo</dd></dl>"), "Full name\nClube de Regatas do Flamengo");
    assert.equal(markupText("<p>One</p><p>Two<br/>Three</p>"), "One\n\nTwo\nThree");
  });

  test("a tag between two pieces of text is nothing; two tags together are a space", () => {
    assert.equal(markupText("The <b>Sam</b>sung Galaxy, H<sub>2</sub>O"), "The Samsung Galaxy, H2O");
    assert.equal(markupText('<span class="a">Lucid Air</span><span class="b">Grand Touring</span>'), "Lucid Air Grand Touring");
  });

  test("the source's tabs and newlines do not become separators", () => {
    assert.equal(markupText("<div>\n\t<span>Lucid\n\t\tAir</span>\n</div>"), "Lucid Air");
  });
});
