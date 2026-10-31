import { describe, expect, it } from "vitest";
import { IngestError } from "../../src/ingest/types.js";
import { children, parseXml, stringAt, text } from "../../src/ingest/xml.js";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("parseXml", () => {
  it("parses elements and decodes built-in and numeric entities", () => {
    const parsed = parseXml(
      encode('<?xml version="1.0"?><root><name>A &amp; B &#65; &#x42;</name></root>'),
      "test.xml",
    );
    expect(stringAt(parsed.root, "name")).toBe("A & B A B");
  });

  it("rejects declarations that can expand entities", () => {
    expect(() => parseXml(encode('<!DOCTYPE root [<!ENTITY x "y">]><root/>'), "test.xml")).toThrow(
      /DOCTYPE or ENTITY/,
    );
    expect(() => parseXml(encode('<!ENTITY x "y"><root/>'), "test.xml")).toThrow(
      /DOCTYPE or ENTITY/,
    );
  });

  it("rejects unsupported named entities", () => {
    expect(() => parseXml(encode("<root>&nbsp;</root>"), "test.xml")).toThrow(/unsupported entity/);
  });

  it("rejects invalid character references", () => {
    expect(() => parseXml(encode("<root>&#0;</root>"), "test.xml")).toThrow(/invalid character/);
    expect(() => parseXml(encode("<root>&#xD800;</root>"), "test.xml")).toThrow(
      /invalid character/,
    );
  });

  it("rejects NUL bytes, invalid UTF-8 and malformed XML", () => {
    expect(() => parseXml(encode("<root>\0</root>"), "test.xml")).toThrow(/NUL/);
    expect(() => parseXml(new Uint8Array([0xff, 0xfe, 0xfd]), "test.xml")).toThrow(/UTF-8/);
    expect(() => parseXml(encode("<root><a></root>"), "test.xml")).toThrow(IngestError);
    expect(() => parseXml(encode("<root><a></root>"), "test.xml")).toThrow(/well-formed/);
  });

  it("does not parse text as numbers or booleans", () => {
    const parsed = parseXml(
      encode("<root><port>5432</port><enabled>Y</enabled></root>"),
      "test.xml",
    );
    expect(stringAt(parsed.root, "port")).toBe("5432");
    expect(stringAt(parsed.root, "enabled")).toBe("Y");
  });

  it("keeps repeated element order", () => {
    const parsed = parseXml(encode("<root><step>a</step><step>b</step></root>"), "test.xml");
    const steps = (parsed.root as { step: unknown[] }).step;
    expect(steps.map((step) => text(step))).toEqual(["a", "b"]);
    const attributed = parseXml(
      encode('<root><step id="1">a</step><step id="2">b</step></root>'),
      "test.xml",
    );
    expect(children(attributed.root, "step").map((step) => text(step))).toEqual(["a", "b"]);
  });
});
