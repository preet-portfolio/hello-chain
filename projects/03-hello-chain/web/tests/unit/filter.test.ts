import { describe, expect, it } from "vitest";
import { isAbusive } from "@/lib/filter";

const reason = (s: string) => isAbusive(s).reason;

describe("isAbusive", () => {
  it("blocks links", () => {
    expect(reason("visit evil.com")).toBe("link");
    expect(reason("http://x")).toBe("link");
    expect(reason("https://example.org/a")).toBe("link");
    expect(reason("www.foo")).toBe("link");
    expect(reason("check bit.ly/abc")).toBe("link");
    expect(reason("javascript:alert(1)")).toBe("link");
    expect(reason("go to EVIL.COM")).toBe("link");
  });
  it("blocks contact info", () => {
    expect(reason("mail me bob@example.com")).toBe("contact");
    expect(reason("call +1 555 123 4567")).toBe("contact");
    expect(reason("5551234567")).toBe("contact");
    expect(reason("555-123-4567")).toBe("contact");
    expect(reason("(555) 123 4567")).toBe("contact");
  });
  it("blocks profanity incl. leetspeak", () => {
    expect(isAbusive("you are a fuck").abusive).toBe(true);
    expect(reason("fuck you")).toBe("profanity");
    expect(reason("fuuuck")).toBe("profanity");
    expect(reason("sh1t")).toBe("profanity");
    expect(reason("what a b!tch")).toBe("profanity");
    expect(reason("a$$hole")).toBe("profanity");
    expect(reason("FUCK")).toBe("profanity");
  });
  it("blocks more link and phone forms", () => {
    expect(reason("evil.com/x")).toBe("link");
    expect(reason("www.something.io")).toBe("link");
    expect(reason("see bit.ly/abc")).toBe("link");
    expect(reason("+44 20 7946 0958")).toBe("contact");
    expect(reason("9876543210")).toBe("contact");
    expect(reason("555.123.4567")).toBe("contact");
  });
  it("does not flag missing-space sentences or number-ish text", () => {
    for (const s of ["Great.So proud", "Thanks.To all", "Hi.In Pune", "Stay safe.Me too", "Pi is 3.14159265", "2026 2027 2028", "1.2.3.4.5.6.7", "Call me in 2026"]) {
      expect(isAbusive(s), s).toEqual({ abusive: false });
    }
  });
  it("allows normal greetings", () => {
    for (const s of [
      "Hi from Pune! 👋",
      "Great work on the passkeys",
      "नमस्ते from India",
      "こんにちは、素敵なサイトですね",
      "Привет! Классный проект",
      "مرحبا بالجميع",
      "Hola, ¿qué tal? 🎉",
      "Nice site... love it",
      "Cool. Great work",
      "Born in 1990, still learning!",
      "Room 12345 was great",
      "Version 1.2.3 rocks",
      "Hi.Great work",
      "e.g. this is fine",
      "2024-11-17 was fun",
    ]) {
      expect(isAbusive(s), s).toEqual({ abusive: false });
    }
  });
  it("avoids Scunthorpe-style false positives", () => {
    for (const s of ["Scunthorpe", "class", "assistant", "cocktail", "Hello from Scunthorpe, great class!", "Penistone", "Sussex", "Essex", "Dickens", "grape", "Cockburn", "bassist", "analysis"]) {
      expect(isAbusive(s), s).toEqual({ abusive: false });
    }
  });
  it("blocks repeated spam", () => {
    expect(reason("aaaaaaaaa")).toBe("spam");
    expect(reason("woooooooow")).toBe("spam");
    expect(reason("!!!!!!!!")).toBe("spam");
    expect(reason("😀😀😀😀😀😀😀😀")).toBe("spam");
    expect(isAbusive("aaaaaaa").abusive).toBe(false);
    expect(isAbusive("sooooo good").abusive).toBe(false);
  });
  it("sees through bidi overrides and fullwidth/compatibility forms", () => {
    // RIGHT-TO-LEFT OVERRIDE makes "moc.elpmaxe" display as "example.com".
    expect(reason("\u202Emoc.elpmaxe")).toBe("link");
    expect(reason("hi \u202Emoc.elpmaxe\u202C there")).toBe("link");
    expect(reason("\u2067moc.elpmaxe\u2069")).toBe("link");
    expect(reason("ｅｘａｍｐｌｅ．ｃｏｍ")).toBe("link");
    expect(reason("ｍａｉｌ ｂｏｂ＠ｅｘａｍｐｌｅ．ｃｏｍ")).toBe("contact");
    expect(reason("ｆｕｃｋ")).toBe("profanity");
    // Embedding/override controls are stripped before matching.
    expect(reason("evil\u202A.com")).toBe("link");
    expect(reason("evil\u200E.com")).toBe("link");
  });
  it("keeps right-to-left and fullwidth greetings clean", () => {
    for (const s of ["\u202Eolleh", "مرحبا\u200F بالجميع", "ｈｅｌｌｏ ｆｒｏｍ Ｔｏｋｙｏ！", "Ｈｉ．Ｇｒｅａｔ ｗｏｒｋ"]) {
      expect(isAbusive(s), s).toEqual({ abusive: false });
    }
  });
});
