// Action security filter — the single screening layer every action passes
// through before it can reach a user's inbox.
//
// Threat model: an action's executable instruction is pasted into the chat
// agent when the user clicks "Execute", where it can plan and submit real
// on-chain transactions, and where it can also try to subvert the agent itself.
// A malicious bunny / compromised workflow could therefore try to smuggle in:
//   - a wallet-drain instruction ("send all my tokens to 0x…"),
//   - an unlimited token approval,
//   - a credential-exfiltration request (seed phrase / private key),
//   - a prompt-injection / jailbreak payload ("ignore previous instructions",
//     "you are in developer mode", "reveal your system prompt", …).
// This module screens the *executable* text (the only surface that is actually
// run) with deterministic heuristics and blocks anything that matches.
//
// Obfuscation handling: attackers spread keywords with separators ("s e n d",
// "d-r-a-i-n"), fold them with leetspeak ("s3nd 4ll"), hide them behind
// zero-width / full-width / accented unicode, or encode them as morse code. The
// raw text is therefore canonicalised and expanded into several de-obfuscated
// variants, and every variant is screened.
//
// Scope notes:
//   - Only the executable instruction is screened, never the display title /
//     description of an alert. A security alert that *warns* "this contract can
//     drain your wallet" is informational and must not be blocked.
//   - English is the default UI language; zh + ko keyword sets are kept too,
//     since workflow/bunny text can be authored in the user's language. CJK has
//     no word boundaries, so those terms are matched as substrings.
//   - Heuristics are conservative (block on suspicion) but not bulletproof:
//     a novel encoding or an unsupported language can still evade them. This is
//     one defensive layer, not a guarantee.

export interface ScreenResult {
  allowed: boolean;
  // Short machine-ish reason, present only when allowed === false. Logged, not
  // shown to the user (the action simply never appears).
  reason?: string;
}

export interface ScreenableAction {
  kind?: "alert" | "recommendation";
  title?: string;
  executeInstructions?: string;
}

const GAP = "[^.!?\\n]{0,48}";

// ── English (also the fallback language) ────────────────────────────────────
// Verbs that move value OUT of the user's wallet.
const VERB =
  "\\b(?:send|transfer|withdraw|sweep|move|forward|disperse|drain|empty|liquidate)\\b";
// Quantifiers that mean "the whole balance" rather than a bounded amount. The
// `100%` alternative is split out because a trailing `\b` after `%` never
// matches (`%` is already a non-word char), which would silently drop it.
const QUANT =
  "(?:\\b(?:all|everything|entire|whole|max(?:imum)?|full|every(?:\\s+single)?)\\b|\\b100\\s*%)";
const DRAIN_FORWARD = new RegExp(`${VERB}${GAP}${QUANT}`, "i");
const DRAIN_REVERSE = new RegExp(`${QUANT}${GAP}${VERB}`, "i");
const DRAIN_STANDALONE =
  /\b(?:drain|empty|clean\s*out)\b[^.!?\n]{0,24}\b(?:wallet|account|funds|balance)\b/i;

const APPROVE = "\\b(?:approve|approval|allowance)\\b";
const UNLIMITED =
  "(?:\\b(?:unlimited|infinite|unbounded|max(?:imum)?)\\b|\\buint\\s*256\\b|2\\s*\\*\\*?\\s*256)";
const APPROVAL_FWD = new RegExp(`${APPROVE}${GAP}${UNLIMITED}`, "i");
const APPROVAL_REV = new RegExp(`${UNLIMITED}${GAP}${APPROVE}`, "i");
const APPROVE_FOR_ALL = /set[\s_-]*approval[\s_-]*for[\s_-]*all/i;

const CREDENTIAL_EXFIL =
  /\b(?:private\s*key|seed\s*phrase|secret\s*recovery\s*phrase|recovery\s*phrase|mnemonic|secret\s*key|export\s+(?:the\s+)?wallet|reveal\s+(?:the\s+)?(?:key|seed))\b/i;

// Prompt-injection / jailbreak attempts aimed at the chat agent. These phrases
// essentially never occur in a legitimate DeFi action instruction, so matching
// them is safe. Each requires an object word so bare "override gas" etc. pass.
const INJECTION: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.!?\n]{0,40}\b(?:previous|prior|above|earlier|all|any|the)?\b[^.!?\n]{0,20}\b(?:instruction|instructions|prompt|prompts|context|rule|rules|guard(?:rail)?s?|restriction|restrictions|safety|security|filter|filters)\b/i,
  /\b(?:system|developer|admin)\b[^.!?\n]{0,12}\b(?:prompt|message|mode|instruction|instructions|override)\b/i,
  /\b(?:reveal|show|print|repeat|expose|leak|dump)\b[^.!?\n]{0,24}\b(?:system\s*)?(?:prompt|instructions|guidelines|rules)\b/i,
  /\b(?:jailbreak|jailbroken)\b/i,
  /\bdo\s*anything\s*now\b|\bDAN\s*mode\b/i,
  /\byou\s+are\s+(?:now\s+)?(?:a\s+|an\s+|in\s+)?(?:developer\s*mode|dan|jailbroken|unrestricted|unfiltered|free\s+from)\b/i,
  /\bact\s+as\b[^.!?\n]{0,24}\b(?:unrestricted|unfiltered|jailbroken|no\s+(?:rules|limits|restrictions)|evil|malicious)\b/i,
  /\bpretend\b[^.!?\n]{0,24}\b(?:no\s+(?:rules|limits|restrictions|filter)|unrestricted|jailbroken)\b/i,
  /<\/?\s*(?:system|instructions?|prompt)\s*>/i,
  /\[\s*(?:system|inst|instructions?)\s*\]/i,
  /\bnew\s+(?:system\s+)?(?:instructions?|prompt|rules)\s*:/i,
];

// ── CJK keyword sets (Chinese + Korean) ─────────────────────────────────────
// CJK scripts have no word boundaries, so each intent is detected as the
// co-occurrence of an outbound-move term and a whole-balance term (any order),
// plus standalone credential / unlimited-approval / injection markers.
const CJK = {
  move: ["转账", "转给", "转移", "转出", "发送", "提现", "提走", "打给", "打款", "전송", "보내", "송금", "출금", "이체", "옮기"],
  all: ["所有", "全部", "整个", "一切", "清空", "전부", "모두", "모든", "전액", "전체"],
  drainStandalone: ["清空钱包", "清空账户", "지갑 비우", "지갑을 비우"],
  approve: ["授权", "批准", "승인", "허용"],
  unlimited: ["无限", "无限制", "无上限", "最大额度", "무제한", "무한", "최대"],
  credential: ["私钥", "助记词", "种子短语", "种子词", "恢复短语", "导出钱包", "개인키", "시드 문구", "시드문구", "니모닉", "복구 문구", "복구문구", "지갑 내보내기"],
  injection: ["忽略之前", "忽略以上", "无视指令", "无视之前", "忽略所有指令", "系统提示", "系统提示词", "越狱", "开发者模式", "이전 지시", "지시 무시", "시스템 프롬프트", "탈옥", "개발자 모드"],
};

function anyIncludes(text: string, terms: string[]): boolean {
  return terms.some((t) => text.includes(t));
}

function cjkDrain(text: string): boolean {
  if (anyIncludes(text, CJK.drainStandalone)) return true;
  return anyIncludes(text, CJK.move) && anyIncludes(text, CJK.all);
}

function cjkApproval(text: string): boolean {
  return anyIncludes(text, CJK.approve) && anyIncludes(text, CJK.unlimited);
}

// ── De-obfuscation ──────────────────────────────────────────────────────────

// Strip zero-width / soft-hyphen chars, fold full-width and accented unicode to
// their plain ASCII form, lower-case.
function canonical(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // combining diacritics
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "") // zero-width / soft hyphen
    .normalize("NFKC")
    .toLowerCase();
}

// Remove every non-alphanumeric separator (punctuation, symbols) but NOT spaces,
// folding intra-word obfuscation like "a.p.p.r.o.v.e" / "d-r-a-i-n" / "s:e:n:d"
// back to plain words while keeping the spaces that separate real words
// ("approve unlimited" survives). \p{L}/\p{N} keep CJK and digits intact.
function stripPunct(s: string): string {
  return s.replace(/[^\p{L}\p{N}\s]+/gu, "");
}

// Collapse letters spread one space apart ("s e n d  a l l"). Real word gaps
// are marked by wide gaps (2+ spaces) or " / " | "|", so the text is split on
// those first; only chunks that are entirely single characters are joined,
// leaving ordinary multi-word text untouched.
function collapseSpacedLetters(s: string): string {
  return s
    .split(/\s{2,}|\s*[/|]\s*/)
    .map((chunk) => {
      const toks = chunk.trim().split(/\s+/);
      if (toks.length >= 3 && toks.every((t) => t.length === 1)) {
        return toks.join("");
      }
      return chunk.trim();
    })
    .filter(Boolean)
    .join(" ");
}

// Strip every separator, symbol and space — the last-resort form for text where
// each letter is single-spaced with no word gaps at all. Screened only against
// high-specificity phrase substrings (below) to keep false positives down.
function compact(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, "");
}

// Fold common leetspeak substitutions so "s3nd 4ll" / "appr0ve unl1m1ted" read
// as their plain-text equivalents. Applied as an *extra* variant only, so it
// can add detections but never removes the un-folded checks.
const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  $: "s",
  "@": "a",
  "!": "i",
  "+": "t",
};
function leet(s: string): string {
  return s.replace(/[013457890$@!+]/g, (c) => LEET[c] ?? c);
}

// Morse code: attackers may encode the whole instruction as dots/dashes. If the
// text is essentially nothing but morse symbols, decode it and screen the result.
const MORSE: Record<string, string> = {
  ".-": "a", "-...": "b", "-.-.": "c", "-..": "d", ".": "e", "..-.": "f",
  "--.": "g", "....": "h", "..": "i", ".---": "j", "-.-": "k", ".-..": "l",
  "--": "m", "-.": "n", "---": "o", ".--.": "p", "--.-": "q", ".-.": "r",
  "...": "s", "-": "t", "..-": "u", "...-": "v", ".--": "w", "-..-": "x",
  "-.--": "y", "--..": "z", "-----": "0", ".----": "1", "..---": "2",
  "...--": "3", "....-": "4", ".....": "5", "-....": "6", "--...": "7",
  "---..": "8", "----.": "9",
};
function looksLikeMorse(raw: string): boolean {
  const t = raw.trim();
  return t.length >= 7 && /[.\-]/.test(t) && /^[.\-/\s|]+$/.test(t);
}
function decodeMorse(raw: string): string {
  return raw
    .trim()
    .split(/\s*[/|]\s*|\s{2,}/) // word separators: / | or wide gaps
    .map((word) =>
      word
        .trim()
        .split(/\s+/)
        .map((sym) => MORSE[sym] ?? "")
        .join(""),
    )
    .join(" ")
    .trim();
}

// Build the boundary-preserving variants (screened with the regex rules) and
// the compact variants (screened with phrase substrings only).
function buildVariants(raw: string): { regex: string[]; compact: string[] } {
  const bases = [canonical(raw)];
  if (looksLikeMorse(raw)) {
    const decoded = decodeMorse(raw);
    if (decoded) bases.push(decoded);
  }
  const regex = new Set<string>();
  const flat = new Set<string>();
  for (const base of bases) {
    for (const v of [base, leet(base)]) {
      regex.add(v);
      regex.add(stripPunct(v));
      regex.add(collapseSpacedLetters(v));
      flat.add(compact(v));
    }
  }
  return {
    regex: [...regex].filter(Boolean),
    compact: [...flat].filter(Boolean),
  };
}

// High-specificity phrase substrings for the fully-collapsed (no word gaps)
// form. Each is distinctive enough that it does not occur inside ordinary
// DeFi instruction words, so substring matching here stays low false-positive.
const COMPACT_PHRASES: { reason: string; phrases: string[] }[] = [
  {
    reason: "credential-exfiltration",
    phrases: [
      "privatekey", "seedphrase", "secretrecoveryphrase", "recoveryphrase",
      "mnemonic", "secretkey", "exportwallet", "exportthewallet",
      "revealkey", "revealseed", "revealyourkey", "revealyourseed",
    ],
  },
  {
    // Verb-anchored or inherently-draining phrases only. Bare quantifier+balance
    // forms ("wholebalance", "allmytokens") are deliberately excluded — without
    // an outbound verb they false-positive on benign balance/holdings checks.
    reason: "wallet-drain",
    phrases: [
      "sendall", "sendeverything", "sendallmy", "transferall",
      "transfereverything", "withdraweverything", "sweepall",
      "drainwallet", "drainaccount", "drainall", "emptywallet",
      "emptyaccount", "liquidateall", "liquidateeverything",
    ],
  },
  {
    reason: "unlimited-approval",
    phrases: [
      "approveunlimited", "unlimitedapproval", "unlimitedallowance",
      "infiniteapproval", "infiniteallowance", "approveinfinite",
      "setapprovalforall", "maxapproval", "approvemax", "maximumapproval",
      "unboundedapproval", "approveallmy", "approvealltokens",
    ],
  },
  {
    reason: "prompt-injection",
    phrases: [
      "ignoreprevious", "ignoreallprevious", "ignoreabove", "ignoreprior",
      "ignoreinstructions", "ignoreallinstructions", "disregardprevious",
      "disregardabove", "disregardall", "forgetprevious", "forgetallprevious",
      "overrideinstructions", "overridesafety", "overridesecurity",
      "bypasssafety", "bypasssecurity", "bypassfilter", "systemprompt",
      "developermode", "jailbreak", "jailbroken", "doanythingnow", "danmode",
      "newinstructions", "newsystemprompt", "priorinstructions",
      "previousinstructions", "revealsystemprompt", "revealprompt",
      "revealinstructions", "printsystemprompt", "showsystemprompt",
    ],
  },
];

// ── Rules ───────────────────────────────────────────────────────────────────

interface Rule {
  reason: string;
  // `s` is one de-obfuscated, lower-cased English variant; `raw` is the
  // original (NFKC) text, used for CJK substring checks.
  test: (s: string, raw: string) => boolean;
}

const RULES: Rule[] = [
  {
    reason: "credential-exfiltration",
    test: (s, raw) => CREDENTIAL_EXFIL.test(s) || anyIncludes(raw, CJK.credential),
  },
  {
    reason: "wallet-drain",
    test: (s, raw) =>
      DRAIN_STANDALONE.test(s) ||
      DRAIN_FORWARD.test(s) ||
      DRAIN_REVERSE.test(s) ||
      cjkDrain(raw),
  },
  {
    reason: "unlimited-approval",
    test: (s, raw) =>
      APPROVAL_FWD.test(s) ||
      APPROVAL_REV.test(s) ||
      APPROVE_FOR_ALL.test(s) ||
      cjkApproval(raw),
  },
  {
    reason: "prompt-injection",
    test: (s, raw) =>
      INJECTION.some((re) => re.test(s)) || anyIncludes(raw, CJK.injection),
  },
];

// The text that will actually be executed if the user clicks "Execute".
// Mirrors how `suggestedPrompt` is derived in lib/actions.ts: a recommendation
// falls back to its title when it carries no explicit instruction; an alert is
// not executable, so only an explicit instruction (rare) is ever screened.
function executableText(action: ScreenableAction): string {
  const instr = action.executeInstructions?.trim();
  if (instr) return instr;
  if (action.kind !== "alert") return action.title?.trim() ?? "";
  return "";
}

// Screen one action against every de-obfuscated variant of the executable
// surface. Returns { allowed: false, reason } on the first matching rule.
export function screenAction(action: ScreenableAction): ScreenResult {
  const raw = executableText(action);
  if (!raw) return { allowed: true };
  const nfkcRaw = raw.normalize("NFKC");
  const { regex, compact: flat } = buildVariants(raw);
  for (const rule of RULES) {
    for (const s of regex) {
      if (rule.test(s, nfkcRaw)) {
        return { allowed: false, reason: rule.reason };
      }
    }
  }
  for (const group of COMPACT_PHRASES) {
    for (const s of flat) {
      if (anyIncludes(s, group.phrases)) {
        return { allowed: false, reason: group.reason };
      }
    }
  }
  return { allowed: true };
}
