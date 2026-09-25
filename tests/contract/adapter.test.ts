/** Scripted parse results test semantic validation and actual request cancellation. */
import { expect, test } from "bun:test";
import {
  character,
  company as companyIdentity,
  count,
  Lodestone,
  page,
} from "../../src/infrastructure/lodestone/client.js";
import type { ParseResponse } from "../../src/infrastructure/lodestone/protocol.js";

const fcId = "9232097761132958152";
const company = {
  ID: fcId,
  Name: "Woven Souls",
  Tag: "Souls",
  World: "Diabolos",
  DC: "Crystal",
  ActiveMemberCount: "2",
};
const identity = (id: string) => ({
  // Entity decoding must preserve the canonical apostrophe and Unicode name.
  ID: id,
  Name: "Élise O&#39;Brien",
  World: "Diabolos",
  DC: "Crystal",
});
test("normalization preserves Unicode and distinguishes unknown, invalid and explicit empty data", () => {
  expect(character(identity("123")).name).toBe("Élise O'Brien");
  expect(count("0")).toBe(0);
  for (const value of [null, undefined, "", -1, "0garbage", "1,23", NaN])
    expect(() => count(value)).toThrow();
  const empty = {
    List: [],
    Pagination: { Page: null, PageTotal: null, PageNext: null, PagePrev: null },
  };
  expect(page(empty, 1, 0)).toEqual({ members: [], total: 1 });
  expect(() => page(empty, 1)).toThrow();
  expect(() => character({ ...identity("123"), ID: Number(fcId) })).toThrow();
  expect(() => character(identity("123"), "456")).toThrow();
});
test("a malformed ID in parsed output is an unreadable Lodestone response, not user input", () => {
  // id()'s input failure advises the user to pick a suggestion; parsed data is never theirs, so
  // it must present as 'Unexpected Lodestone page' (invalid_response, warn level) instead.
  const { ID: _omitted, ...nameless } = identity("123");
  const pager = { Page: 1, PageTotal: 1, PageNext: null, PagePrev: 0 };
  expect(() => page({ List: [nameless], Pagination: pager }, 1)).toThrow(
    expect.objectContaining({ code: "invalid_response" }),
  );
  expect(() => companyIdentity({ ...company, ID: null }, fcId)).toThrow(
    expect.objectContaining({ code: "invalid_response" }),
  );
  expect(() => character({ ...identity("123"), FreeCompany: { ID: "12 34" } }, "123")).toThrow(
    expect.objectContaining({ code: "invalid_response" }),
  );
});
test("roster acquisition checks distinct IDs, page progression, and boundary counts", async () => {
  // Each mode changes a different completeness invariant while keeping valid parse results.
  let mode: "valid" | "duplicate" | "changing" = "valid";
  let metadataCalls = 0;
  const adapter = new Lodestone({
    run: async (input): Promise<ParseResponse> => {
      if (input.operation === "fc") {
        metadataCalls++;
        return {
          ok: true,
          data: {
            ...company,
            ActiveMemberCount: mode === "changing" && metadataCalls % 2 === 0 ? "3" : "2",
          },
        };
      }
      if (input.operation === "members")
        return {
          ok: true,
          data: {
            List: [identity(input.page === 1 || mode === "duplicate" ? "123" : "456")],
            Pagination: {
              Page: input.page,
              PageTotal: 2,
              PageNext: input.page === 1 ? 2 : null,
              PagePrev: input.page === 1 ? null : 1,
            },
          },
        };
      return { ok: false, code: "invalid_response", retryAfter: 0 };
    },
  });
  try {
    expect((await adapter.roster(fcId)).members.map((member) => member.id)).toEqual(["123", "456"]);
    mode = "duplicate";
    await expect(adapter.roster(fcId)).rejects.toMatchObject({ code: "incomplete" });
    mode = "changing";
    metadataCalls = 0;
    await expect(adapter.roster(fcId)).rejects.toMatchObject({ code: "incomplete" });
  } finally {
    adapter.stop();
  }
});
test("shutdown cancels an outstanding request", async () => {
  // The scripted parse ends only when its signal aborts, as the runner's fetch and worker do.
  const adapter = new Lodestone({
    run: (_input, signal) =>
      new Promise<ParseResponse>((resolve) => {
        signal.addEventListener(
          "abort",
          () => resolve({ ok: false, code: "unavailable", retryAfter: 0 }),
          { once: true },
        );
      }),
  });
  const pending = adapter.company(fcId);
  setTimeout(() => adapter.stop(), 20);
  await expect(pending).rejects.toMatchObject({ code: "unavailable" });
});
