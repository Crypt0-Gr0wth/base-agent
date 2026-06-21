import { decode, encode } from "@toon-format/toon";

// Serialize a tool result as TOON (token-oriented object notation) so the model
// sees a compact tabular block instead of repeated JSON keys: a uniform array of
// N objects collapses to one `[N]{field1,field2}:` header plus comma-separated
// rows, cutting input tokens ~30-50% on list-shaped results. Non-uniform or
// nested shapes degrade to an indented key/value form (still smaller than JSON).
// Falls back to JSON on any encoding error so an odd shape never breaks a tool.
export function toToolText(data: unknown): string {
  let toon: string | null = null;
  try {
    toon = encode(data);
  } catch {
    toon = null;
  }
  let json: string | null = null;
  try {
    const j = JSON.stringify(data);
    json = typeof j === "string" ? j : null;
  } catch {
    json = null;
  }
  // TOON only helps for flat uniform arrays (it collapses repeated keys into one
  // header). Deeply-nested shapes can encode *larger* than JSON, so we emit TOON
  // only when it's actually shorter — the swap can never increase token usage.
  if (toon !== null && json !== null) return toon.length < json.length ? toon : json;
  if (json !== null) return json;
  if (toon !== null) return toon;
  return String(data);
}

// Same idea starting from a raw JSON string (an upstream API response we don't
// project): parse then TOON-encode. If parsing fails, return the text unchanged.
export function toonifyJson(text: string): string {
  try {
    return toToolText(JSON.parse(text));
  } catch {
    return text;
  }
}

// Decode tool-result content that may be either JSON (legacy / fallback) or TOON
// (what toToolText / toonifyJson now emit). Internal backend consumers that need
// the structured value should use this instead of a bare JSON.parse. Tries JSON
// first, then TOON; throws if neither parses, matching the old JSON.parse contract.
export function parseToolContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return decode(content);
  }
}
