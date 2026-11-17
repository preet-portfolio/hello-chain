"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createConfig, http, injected, WagmiProvider, type Transport } from "wagmi";
import { activeChain } from "@/lib/chain";

// Browser wallets only: the generic injected connector plus whatever wallets announce themselves
// through EIP-6963 discovery (on by default). No WalletConnect, no vendor SDKs.
const wagmiConfig = createConfig({
  chains: [activeChain],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  // activeChain is one of two chains chosen at build time, so key the one transport by its id.
  transports: { [activeChain.id]: http(process.env.NEXT_PUBLIC_RPC_URL || undefined) } as Record<
    typeof activeChain.id,
    Transport
  >,
  ssr: true,
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
