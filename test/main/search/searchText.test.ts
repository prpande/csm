// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  fold,
  identifierParts,
  searchTextOf,
  tokenize,
} from "../../../src/search/searchText";

describe("fold", () => {
  test("strips diacritics, lowercases, applies compatibility forms", () => {
    expect(fold("Café ÑANDÚ")).toBe("cafe nandu");
    expect(fold("ﬁle ＡＢＣ")).toBe("file abc");
  });
});

describe("tokenize", () => {
  test("splits on punctuation and underscore like unicode61", () => {
    expect(
      tokenize("rate-limit sessionStore.ts node:sqlite snake_case 50%").map(
        (t) => t.text,
      ),
    ).toEqual([
      "rate",
      "limit",
      "sessionStore",
      "ts",
      "node",
      "sqlite",
      "snake",
      "case",
      "50",
    ]);
  });

  test("offsets index the original string", () => {
    expect(tokenize("a  bc")[1]).toEqual({ text: "bc", start: 3, end: 5 });
  });

  test("pure punctuation yields no tokens", () => {
    expect(tokenize(`"*:-%`)).toEqual([]);
  });
});

describe("identifierParts", () => {
  test.each([
    ["getUserName", ["get", "user", "name"]],
    ["HTTPServer", ["http", "server"]],
    ["sessionStore", ["session", "store"]],
    ["lowercase", []],
    ["v2", []],
    ["ABC", []],
  ])("%s", (token, parts) => {
    expect(identifierParts(token)).toEqual(parts);
  });
});

describe("searchTextOf", () => {
  test("adds one expansion line per distinct identifier", () => {
    expect(searchTextOf("Call getUserName then getUserName")).toBe(
      "call getusername then getusername\nget user name",
    );
  });

  test("plain text is just folded", () => {
    expect(searchTextOf("Plain Wörds")).toBe("plain words");
  });
});
