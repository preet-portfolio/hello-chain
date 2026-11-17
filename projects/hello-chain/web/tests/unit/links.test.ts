import { describe, expect, it } from "vitest";
import { caseStudyLinks, safeHttpUrl } from "@/lib/links";

describe("safeHttpUrl", () => {
  it("accepts http(s) URLs and trims whitespace", () => {
    expect(safeHttpUrl(" https://sepolia.basescan.org/address/0xabc ")).toBe("https://sepolia.basescan.org/address/0xabc");
    expect(safeHttpUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
  });
  it("rejects empty, missing, relative and non-http values", () => {
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl("   ")).toBeNull();
    expect(safeHttpUrl("TBD")).toBeNull();
    expect(safeHttpUrl("/relative")).toBeNull();
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("ftp://example.com")).toBeNull();
  });
});

describe("caseStudyLinks", () => {
  it("lists only the links that are configured, contract first", () => {
    expect(caseStudyLinks({})).toEqual([]);
    expect(caseStudyLinks({ source: "https://github.com/me/repo" })).toEqual([
      { href: "https://github.com/me/repo", label: "Read the source code" },
    ]);
    expect(
      caseStudyLinks({ contract: "https://sepolia.basescan.org/address/0x1", source: "https://github.com/me/repo" }).map(
        (l) => l.label,
      ),
    ).toEqual(["See the verified contract", "Read the source code"]);
  });
});
