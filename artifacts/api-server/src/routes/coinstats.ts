import { Router, type IRouter } from "express";
import { callCoinstatsTool, coinstatsStatus } from "../lib/coinstats";
import { take } from "../lib/rate-limit";
import { getCurrentUserId, getCurrentUserWallet } from "../lib/user";
import { isProtocolEnabled } from "../lib/settings";

// Native read-only surface for the main page, powered by CoinStats. The active
// wallet's NFT holdings are projected into typed JSON here, gated behind the
// coinstats protocol toggle + its connection status (bunnyDS gateway or a
// per-user CoinStats key).
const router: IRouter = Router();

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

function firstNum(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const n = num(o[k]);
    if (n !== null) return n;
  }
  return null;
}

// CoinStats list endpoints variously wrap rows in `result`, `data`, or return a
// bare array. Normalize all of them to a flat array.
function listOf(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    for (const k of ["result", "data", "assets"]) {
      if (Array.isArray(o[k])) return o[k] as unknown[];
    }
  }
  return [];
}

function coinstatsAvailable(): boolean {
  return isProtocolEnabled("coinstats") && coinstatsStatus().connected;
}

interface NftView {
  id: string | null;
  name: string | null;
  collection: string | null;
  collectionLogo: string | null;
  imageUrl: string | null;
  floorPrice: number | null;
  floorPriceCurrency: string | null;
}

function projectNft(raw: unknown): NftView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const image = str(
    o,
    "imageUrl",
    "imgUrl",
    "imageUrlV2",
    "image",
    "previewUrl",
    "animationUrl",
  );
  const name = str(o, "name", "title", "tokenName");
  const collection = str(o, "collectionName", "collection", "collectionId");
  if (!image && !name && !collection) return null;
  return {
    id: str(o, "id", "tokenId", "_id"),
    name,
    collection,
    collectionLogo: str(o, "collectionLogo", "collectionImage"),
    imageUrl: image,
    floorPrice: firstNum(o, "floorPrice", "estimatedValue", "price"),
    floorPriceCurrency: str(o, "floorPriceCurrency", "currency"),
  };
}

// GET /api/coinstats/nfts — NFT assets held by the active user's Base wallet.
// Returns enabled=false (200) when coinstats is off, needsWallet=true (200)
// when no wallet is connected yet.
router.get("/coinstats/nfts", async (req, res): Promise<void> => {
  if (!coinstatsAvailable()) {
    res.json({ enabled: false, needsWallet: false, items: [] });
    return;
  }
  const wallet = await getCurrentUserWallet();
  if (!wallet) {
    res.json({ enabled: true, needsWallet: true, items: [] });
    return;
  }
  const rate = take(getCurrentUserId(), "security");
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    res.status(429).json({ error: "rate limited" });
    return;
  }
  const out = await callCoinstatsTool("coinstats_nfts_by_wallet", {
    address: wallet,
    limit: 12,
  });
  if (out.isError) {
    res.status(502).json({ error: out.content });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.content);
  } catch {
    res.status(502).json({ error: "failed to parse coinstats response" });
    return;
  }
  const items = listOf(parsed)
    .map(projectNft)
    .filter((n): n is NftView => n !== null);
  res.json({ enabled: true, needsWallet: false, wallet, items });
});

export default router;
