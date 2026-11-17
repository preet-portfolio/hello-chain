// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { HowItWorks } from "@/components/HowItWorks";

afterEach(cleanup);

describe("HowItWorks", () => {
  it("walks through the four steps in order", () => {
    render(<HowItWorks links={[]} />);
    const steps = within(screen.getByRole("list", { name: /four steps/ })).getAllByRole("heading", { level: 3 });
    expect(steps.map((h) => h.textContent)).toEqual([
      "Your passkey seals the message",
      "A relayer pays the fee",
      "The contract checks the seal itself",
      "The feed hears it live",
    ]);
  });

  it("states what the tests prove: the count never goes down and the daily limit holds", () => {
    const { container } = render(<HowItWorks links={[]} />);
    expect(screen.getByRole("heading", { level: 3, name: "Proven, not promised" })).toBeTruthy();
    expect(container.textContent).toContain("The entry count can never go down.");
    expect(container.textContent).toContain("One hello per visitor per day.");
    for (const name of [
      "check_countNeverDecreases",
      "check_cooldownEnforced",
      "invariant_countsMonotonic",
      "invariant_cooldownRespected",
    ])
      expect(within(container).getByText(name)).toBeTruthy();
  });

  it("quotes the measured gas from .gas-snapshot", () => {
    render(<HowItWorks links={[]} />);
    const table = screen.getByRole("table");
    for (const n of ["220,133", "246,383", "513,441"]) expect(within(table).getByText(n)).toBeTruthy();
  });

  it("hides the proof links when none are configured, with no placeholder text", () => {
    const { container } = render(<HowItWorks links={[]} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).not.toMatch(/TBD|coming soon/i);
  });

  it("renders configured links in a new tab", () => {
    render(
      <HowItWorks
        links={[
          { href: "https://sepolia.basescan.org/address/0x1#code", label: "See the verified contract" },
          { href: "https://github.com/me/repo", label: "Read the source code" },
        ]}
      />,
    );
    const contract = screen.getByRole("link", { name: /See the verified contract/ });
    expect(contract.getAttribute("href")).toBe("https://sepolia.basescan.org/address/0x1#code");
    expect(contract.getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("link", { name: /Read the source code/ })).toBeTruthy();
  });

  it("uses an h2 for the section and h3s below it", () => {
    render(<HowItWorks links={[]} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("How it works");
    expect(screen.getAllByRole("heading", { level: 3 }).length).toBe(6);
  });
});
