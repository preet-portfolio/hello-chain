// Outbound links for the "How it works" case study. They come from env (filled in after deploy),
// and any link that isn't a real http(s) URL is dropped, so the page never shows a dead link.

export type CaseStudyLink = { href: string; label: string };

/** The URL if it is an absolute http(s) URL, else null (unset, blank, "TBD", javascript:, …). */
export function safeHttpUrl(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? v : null;
  } catch {
    return null;
  }
}

export function caseStudyLinks(env: { contract?: string; source?: string }): CaseStudyLink[] {
  const links: CaseStudyLink[] = [];
  const contract = safeHttpUrl(env.contract);
  const source = safeHttpUrl(env.source);
  if (contract) links.push({ href: contract, label: "See the verified contract" });
  if (source) links.push({ href: source, label: "Read the source code" });
  return links;
}

/** Read at build time: NEXT_PUBLIC_* values are inlined by Next. */
export const configuredLinks = (): CaseStudyLink[] =>
  caseStudyLinks({
    contract: process.env.NEXT_PUBLIC_CONTRACT_EXPLORER_URL,
    source: process.env.NEXT_PUBLIC_SOURCE_URL,
  });
