import { Feed } from "@/components/Feed";
import { GuestbookProvider } from "@/components/GuestbookProvider";
import { Hero } from "@/components/Hero";
import { HowItWorks } from "@/components/HowItWorks";
import { SignCard } from "@/components/SignCard";
import { Providers } from "./providers";

export default function Home() {
  return (
    <main className="w-full flex-1 overflow-x-clip px-5 pb-24 sm:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <Providers>
          <GuestbookProvider>
            <Hero />
            {/* Pushes its optimistic entry into the feed through GuestbookProvider. */}
            <SignCard />
            <h2 className="mb-5 font-display text-[1.75rem] leading-tight tracking-tight">Latest hellos</h2>
            <Feed />
          </GuestbookProvider>
        </Providers>
      </div>
      {/* The case study runs wider so the four steps can sit in a row on desktop. */}
      <div className="mx-auto mt-24 w-full max-w-5xl">
        <HowItWorks />
      </div>
      <footer className="mx-auto mt-20 w-full max-w-5xl border-t border-line pt-6 text-xs text-muted">
        Hello, Chain — every hello here lives on a public blockchain. Built as a portfolio project.
      </footer>
    </main>
  );
}
