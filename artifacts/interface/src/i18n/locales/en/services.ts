export default {
  description:
    "toggle which protocols + apis bunnyOS can call. enabled ones are advertised to the agent on every turn; disabled ones are hidden. click a row to open it in a tab.",
  mcpSection: "mcp",
  bunnyosImplementation: "bunny core",
  optionalSection: "bunny optional",
  loadingServices: "loading services…",
  off: "off",
  toolCount: "{count} tools",
  notAuthorized: "not authorized",
  offline: "offline",
  toggleAria: "toggle {label}",
  toggleFailed: "Failed to toggle {id}",
  "telegram.section": "notifications",
  "telegram.label": "telegram push",
  "telegram.toggleAria": "toggle telegram push",
  "telegram.help":
    "create a bot with @BotFather, paste the bot token below, then open your bot in telegram and send it any message. click detect to fill in your chat id automatically, then save.",
  "telegram.botTokenPlaceholder": "bot token (from @BotFather)",
  "telegram.botTokenSavedPlaceholder": "bot token saved — paste a new one to replace",
  "telegram.chatIdPlaceholder": "your chat id (click detect)",
  "telegram.detect": "detect",
  "telegram.detected": "chat id detected",
  "telegram.detectFailed":
    "couldn't detect — paste your token, send your bot a message first, then try again",
  "telegram.save": "save",
  "telegram.test": "test",
  "telegram.saved": "telegram saved",
  "telegram.saveFailed": "failed to update telegram",
  "telegram.invalidInput": "invalid bot token or chat id",
  "telegram.testSent": "test message sent",
  "telegram.testFailed":
    "test failed — check your token, chat id, and that you started the bot",
  setApi: "set api",
  poweredByBunnyDs: "powered by bunnyDS",
  "security.section": "security",
  "security.label": "action security",
  "security.always": "always on",
  "security.help":
    "every action is screened before it reaches your inbox. always on, can't be turned off.",
  "security.howTitle": "how it works",
  "security.step.screen":
    "screens every action — from your own agent and from bunnies — before it shows up in your inbox.",
  "security.step.deobfuscate":
    "de-obfuscates first (unicode tricks, hidden characters, spacing, leetspeak, even morse) so disguised attacks still get caught.",
  "security.step.drain":
    "blocks wallet drains — transfers or swaps that move your whole balance to someone else.",
  "security.step.approval":
    "blocks unlimited / unbounded token approvals that would let a contract spend your funds freely.",
  "security.step.exfil":
    "blocks attempts to leak your private key, seed phrase, or session.",
  "security.step.injection":
    "blocks prompt-injection and jailbreak instructions hidden inside an action.",
  "security.footer":
    "anything that trips a rule is dropped silently and never reaches you.",
} as const;
