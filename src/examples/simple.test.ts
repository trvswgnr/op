import { afterEach, describe, expect, test, vi } from "vitest";
import {
  divide,
  sqrt,
  mathComposeProgram,
  parseUser,
  fetchData,
  userProgram,
  DivisionByZeroError,
  NegativeError,
  FetchError,
  HttpError,
  ParseError,
} from "./simple.js";

describe("examples/simple (math)", () => {
  test("divide succeeds when divisor is non-zero", async () => {
    const r = await divide.run(10, 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(5);
  });

  test("divide fails with DivisionByZeroError when b is 0", async () => {
    const r = await divide.run(10, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(DivisionByZeroError);
  });

  test("sqrt succeeds for non-negative input", async () => {
    const r = await sqrt.run(9);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(3);
  });

  test("sqrt fails with NegativeError when n < 0", async () => {
    const r = await sqrt.run(-1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(NegativeError);
      if (r.error instanceof NegativeError) expect(r.error.n).toBe(-1);
    }
  });

  test("mathComposeProgram matches example: divide(10,3) then sqrt(a-4) yields NegativeError", async () => {
    const r = await mathComposeProgram.run();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(NegativeError);
      if (r.error instanceof NegativeError) expect(r.error.n).toBeCloseTo(10 / 3 - 4);
    }
  });
});

describe("examples/simple (fetch + parse)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("parseUser succeeds for valid object with string name", async () => {
    const r = await parseUser.run({ name: "Ada" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ name: "Ada" });
  });

  test("parseUser fails with ParseError when payload is invalid", async () => {
    const r = await parseUser.run({ notName: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ParseError);
      if (r.error instanceof ParseError) expect(r.error.raw).toEqual({ notName: 1 });
    }
  });

  test("fetchData returns JSON body when response is ok", async () => {
    const impl: typeof fetch = async () =>
      new Response(JSON.stringify({ name: "Ada" }), {
        status: 200,
        statusText: "OK",
      });
    vi.stubGlobal("fetch", vi.fn(impl));
    const r = await fetchData.run("https://example.test/api/users/1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ name: "Ada" });
  });

  test("fetchData maps non-ok response to FetchError with HttpError cause", async () => {
    const impl: typeof fetch = async () =>
      new Response(null, { status: 404, statusText: "Not Found" });
    vi.stubGlobal("fetch", vi.fn(impl));
    const r = await fetchData.run("https://example.test/missing");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(FetchError);
      expect(r.error.cause).toBeInstanceOf(HttpError);
      if (r.error.cause instanceof HttpError) {
        expect(r.error.cause.status).toBe(404);
        expect(r.error.cause.statusText).toBe("Not Found");
      }
    }
  });

  test("userProgram composes fetch and parseUser", async () => {
    const impl: typeof fetch = async (url) => {
      expect(String(url)).toBe("/api/users/123");
      return new Response(JSON.stringify({ name: "Ada" }), {
        status: 200,
        statusText: "OK",
      });
    };
    vi.stubGlobal("fetch", vi.fn(impl));
    const r = await userProgram.run("123");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ name: "Ada" });
  });
});
