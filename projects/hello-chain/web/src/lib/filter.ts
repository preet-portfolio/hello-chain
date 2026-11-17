// Shared abuse filter. Pure: runs identically on the server relayer and in the browser.
// Design goal: obvious abuse never shows; ordinary greetings in any language pass.
// False positives are worse than misses (the owner has an on-chain hide flag as backstop).
import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";

export type AbuseReason = "profanity" | "link" | "contact" | "spam";
export type AbuseResult = { abusive: boolean; reason?: AbuseReason };

// obscenity: leetspeak/confusable/duplicate-char normalisation plus built-in
// whitelist terms that prevent Scunthorpe-style false positives.
const base = englishDataset.build();
const profanity = new RegExpMatcher({
  ...base,
  // Extra innocent words/place names that contain a flagged substring.
  whitelistedTerms: [
    ...(base.whitelistedTerms ?? []),
    "penistone",
    "cockburn",
    "cockermouth",
    "dickens",
    "dickinson",
  ],
  ...englishRecommendedTransformers,
});

// Trade-off (deliberate): obscenity may flag some innocent names (e.g. "Dick") despite extra
// whitelisting. Filtered entries are never shown, so the owner's on-chain hide/unhide flag is
// NOT a remedy for them; we accept occasional false positives on rare words over leaking abuse.

// Zero-width, bidi-control and soft-hyphen characters are used to dodge matching: soft hyphen,
// U+200B-U+200F (zero-width, LRM/RLM), U+202A-U+202E (embeddings/overrides), U+2060, U+2066-U+2069
// (isolates), BOM.
const INVISIBLES = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
// Controls that make text DISPLAY right-to-left: "\u202Emoc.elpmaxe" shows as "example.com".
const RTL_CONTROLS = /[\u202B\u202E\u2067]/;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u;
// Phone-like: leading +, parenthesised area code, 3-3-4 grouping, or a plain run of 10+ digits.
// Dot-only or space-only runs of arbitrary digits (3.14159265, 2026 2027 2028) are NOT phones.
const PHONE = new RegExp(
  [
    "\\+\\d(?:[\\s().-]?\\d){6,}",
    "\\(\\d{2,4}\\)[\\s.-]?\\d{3}[\\s.-]?\\d{3,4}",
    "(?<!\\d)\\d{3}([\\s.-])\\d{3}\\1\\d{4}(?!\\d)",
    "\\d{10,}",
  ].join("|"),
);
// ISO dates (2024-11-17) are 8 digits but not phone numbers.
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const SCHEME = /\b(?:https?|ftp|file|javascript|data|vbscript|mailto|tel|sms):/i;
const WWW = /\bwww\./i;
// Unambiguous TLDs match as bare "word.tld". Ambiguous ones collide with ordinary words
// after a missing space ("Great.So proud", "Hi.In Pune", "Stay safe.Me too"), so they only
// count when followed by "/" (or preceded by www./scheme, handled above). Deliberate miss: bare "evil.co".
const TLDS =
  "com|net|org|io|app|dev|xyz|info|biz|gg|cc|ai|link|site|online|shop|store|top|club|live|cloud|tech|eth|ru|cn|uk";
const AMBIGUOUS_TLDS = "co|me|so|to|in|us|de|sh|tv|ly|gl|sol";
const LABELS = "[\\p{L}\\p{N}][\\p{L}\\p{N}-]*(?:\\.[\\p{L}\\p{N}-]+)*";
// word.tld followed by a non-letter. "Hi.Great work" is NOT flagged because "great" is not a TLD.
const DOMAIN = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])${LABELS}\\.(?:(?:${TLDS})(?![\\p{L}\\p{N}])|(?:${AMBIGUOUS_TLDS})(?=/))`,
  "iu",
);
// 8+ of the same character (code point) in a row.
const REPEAT = /([\s\S])\1{7,}/u;

function check(s: string): AbuseResult {
  if (EMAIL.test(s) || PHONE.test(s.replace(ISO_DATE, " "))) return { abusive: true, reason: "contact" };
  if (SCHEME.test(s) || WWW.test(s) || DOMAIN.test(s)) return { abusive: true, reason: "link" };
  if (profanity.hasMatch(s)) return { abusive: true, reason: "profanity" };
  if (REPEAT.test(s)) return { abusive: true, reason: "spam" };
  return { abusive: false };
}

export function isAbusive(input: string): AbuseResult {
  // NFKC folds fullwidth and other compatibility forms ("ｅｘａｍｐｌｅ．ｃｏｍ") to plain text.
  const normalized = input.normalize("NFKC");
  const s = normalized.replace(INVISIBLES, "");
  const forward = check(s);
  if (forward.abusive || !RTL_CONTROLS.test(normalized)) return forward;
  // A right-to-left override can display reversed text: check what the reader would see too.
  return check([...s].reverse().join(""));
}
