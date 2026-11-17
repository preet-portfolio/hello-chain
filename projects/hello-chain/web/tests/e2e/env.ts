// Ports and environment for the E2E stack. Separate from the dev stack (anvil :8545, next dev :3000).
export const E2E_RPC_PORT = 8546;
export const E2E_WEB_PORT = 3100;

const rpc = `http://127.0.0.1:${E2E_RPC_PORT}`;

export const E2E_ENV = {
  NEXT_PUBLIC_CHAIN_ID: "31337",
  NEXT_PUBLIC_RPC_URL: rpc,
  NEXT_PUBLIC_RP_ID: "localhost",
  RPC_URL: rpc,
  // Anvil's well-known dev key #9 (funded on every fresh anvil). Public test key, local only.
  RELAYER_PRIVATE_KEY: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  // `next start` is production: without a trusted proxy header the relay fails closed (503).
  // The tests act as that proxy and set x-real-ip on relay requests.
  TRUSTED_PROXY_HEADER: "x-real-ip",
  UPSTASH_REDIS_REST_URL: "",
  UPSTASH_REDIS_REST_TOKEN: "",
} as const;
