// Deterministic, friendly display name for an anonymous visitor id.

const ADJECTIVES = [
  "Amber", "Brave", "Breezy", "Bright", "Calm", "Cheery", "Clever", "Cosy",
  "Curious", "Dapper", "Eager", "Gentle", "Glad", "Golden", "Happy", "Jolly",
  "Kind", "Lively", "Lucky", "Merry", "Mellow", "Nimble", "Peppy", "Plucky",
  "Polite", "Quiet", "Radiant", "Sunny", "Swift", "Tidy", "Warm", "Witty",
] as const;

const ANIMALS = [
  "Otter", "Panda", "Heron", "Falcon", "Koala", "Lynx", "Fox", "Gecko",
  "Dolphin", "Hedgehog", "Badger", "Robin", "Finch", "Puffin", "Quokka", "Llama",
  "Beaver", "Sparrow", "Turtle", "Penguin", "Rabbit", "Squirrel", "Owl", "Seal",
  "Ibis", "Newt", "Moose", "Wombat", "Zebra", "Alpaca", "Crane", "Marmot",
] as const;

export function friendlyHandle(visitorId: `0x${string}`): string {
  const hex = visitorId.slice(2).toLowerCase().replace(/[^0-9a-f]/g, "");
  const last4 = hex.slice(-4).padStart(4, "0");
  // Words come from the low-order bytes just before the suffix. Wallet/direct ids are
  // left-zero-padded addresses, so the leading bytes carry no entropy; passkey ids are hashes
  // and spread well anywhere.
  const head = parseInt(hex.slice(-12, -4).padStart(8, "0"), 16);
  const adjective = ADJECTIVES[head % ADJECTIVES.length];
  const animal = ANIMALS[Math.floor(head / ADJECTIVES.length) % ANIMALS.length];
  return `${adjective} ${animal} #${last4}`;
}
