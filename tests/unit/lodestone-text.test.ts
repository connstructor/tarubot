/** Lodestone text normalization yields plain display text; HTML encoding belongs to each renderer. */
import { expect, test } from "bun:test";
import { display } from "../../src/infrastructure/lodestone/client.js";

test("parser markup is removed completely while line breaks survive", () => {
  expect(display("line one<br>line two<BR/>three<br />four")).toBe(
    "line one\nline two\nthree\nfour",
  );
  expect(display('<span class="x">Taru</span> <a href="/lodestone/">Taru</a>')).toBe("Taru Taru");
  // Nested or split fragments cannot reassemble into a tag after removal.
  const fragments = {
    "<scr<script>ipt>alert(1)": "ipt>alert(1)",
    "<<script>script>x": "script>x",
    "<<b>b>x</b>": "b>x",
    "<!<!-- c -->-->": "-->",
  };
  for (const [input, output] of Object.entries(fragments)) {
    expect(display(input)).toBe(output);
    expect(display(input)).not.toMatch(/<[^>]*>/u);
  }
});

test("encoded brackets decode to literal text that renderers must still escape", () => {
  // Lodestone serializes typed brackets as entities; decoding makes them characters, not markup.
  expect(display("Hi &lt;script&gt;alert(1)&lt;/script&gt;")).toBe("Hi <script>alert(1)</script>");
  expect(display("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  expect(display("  Élise O&#39;Brien  ")).toBe("Élise O'Brien");
});

test("unterminated brackets remain text and non-string fields are rejected", () => {
  expect(display("a < b")).toBe("a < b");
  expect(display("<img src=x onerror=alert(1)")).toBe("<img src=x onerror=alert(1)");
  expect(() => display(null)).toThrow("Missing display text.");
});
