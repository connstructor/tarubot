/** Controlled HTTP fixtures test semantic validation and actual request cancellation. */
import { expect, test } from "bun:test";
import {
  character,
  company as companyIdentity,
  count,
  Nodestone,
  page,
} from "../../src/infrastructure/nodestone/client.js";
import { requestSchema } from "../../src/infrastructure/nodestone/protocol.js";

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
test("a malformed ID from the sidecar is an unreadable Lodestone response, not user input", () => {
  // id()'s input failure advises the user to pick a suggestion; sidecar data is never theirs, so
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
  // Each mode changes a different completeness invariant while retaining valid HTTP envelopes.
  let mode: "valid" | "duplicate" | "changing" = "valid";
  let metadataCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const input = requestSchema.parse(await request.json());
      let data: unknown;
      if (input.operation === "fc") {
        metadataCalls++;
        data = {
          ...company,
          ActiveMemberCount: mode === "changing" && metadataCalls % 2 === 0 ? "3" : "2",
        };
      } else if (input.operation === "members")
        data = {
          List: [identity(input.page === 1 || mode === "duplicate" ? "123" : "456")],
          Pagination: {
            Page: input.page,
            PageTotal: 2,
            PageNext: input.page === 1 ? 2 : null,
            PagePrev: input.page === 1 ? null : 1,
          },
        };
      else return Response.json({ ok: false, code: "invalid_response", retryAfter: 0 });
      return Response.json({ ok: true, data });
    },
  });
  const adapter = new Nodestone(`http://localhost:${server.port}`);
  try {
    expect((await adapter.roster(fcId)).members.map((member) => member.id)).toEqual(["123", "456"]);
    mode = "duplicate";
    await expect(adapter.roster(fcId)).rejects.toMatchObject({ code: "incomplete" });
    mode = "changing";
    metadataCalls = 0;
    await expect(adapter.roster(fcId)).rejects.toMatchObject({ code: "incomplete" });
  } finally {
    adapter.stop();
    await server.stop(true);
  }
});
test("shutdown cancels an actual outstanding HTTP request", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await Bun.sleep(200);
      return Response.json({ ok: true, data: company });
    },
  });
  const adapter = new Nodestone(`http://localhost:${server.port}`);
  try {
    const pending = adapter.company(fcId);
    setTimeout(() => adapter.stop(), 20);
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    await server.stop(true);
  }
});
