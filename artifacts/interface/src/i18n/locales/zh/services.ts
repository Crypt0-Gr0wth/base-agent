export default {
  description:
    "切换 bunnyOS 可调用的协议与 API。启用的会在每轮对话中提供给 agent；禁用的则隐藏。点击行可在标签页中打开。",
  mcpSection: "MCP",
  bunnyosImplementation: "bunny 核心",
  optionalSection: "bunny 可选",
  loadingServices: "正在加载服务…",
  off: "已关闭",
  toolCount: "{count} 个工具",
  notAuthorized: "未授权",
  offline: "离线",
  toggleAria: "切换 {label}",
  toggleFailed: "切换 {id} 失败",
  "telegram.section": "通知",
  "telegram.label": "telegram 推送",
  "telegram.toggleAria": "切换 telegram 推送",
  "telegram.help":
    "用 @BotFather 创建机器人，把 bot token 粘贴到下方，然后在 telegram 里打开你的机器人发送任意消息。点击检测自动填入你的 chat id，再保存。",
  "telegram.botTokenPlaceholder": "bot token（来自 @BotFather）",
  "telegram.botTokenSavedPlaceholder": "bot token 已保存——粘贴新的可替换",
  "telegram.chatIdPlaceholder": "你的 chat id（点击检测）",
  "telegram.detect": "检测",
  "telegram.detected": "已检测到 chat id",
  "telegram.detectFailed": "无法检测——请粘贴 token，先给机器人发条消息，然后重试",
  "telegram.save": "保存",
  "telegram.test": "测试",
  "telegram.saved": "telegram 已保存",
  "telegram.saveFailed": "更新 telegram 失败",
  "telegram.invalidInput": "无效的 bot token 或 chat id",
  "telegram.testSent": "测试消息已发送",
  "telegram.testFailed": "测试失败——请检查你的 token、chat id，并确认已和机器人开始对话",
  setApi: "设置 api",
  poweredByBunnyDs: "由 bunnyDS 提供",
  "security.section": "安全",
  "security.label": "操作安全",
  "security.always": "始终开启",
  "security.help":
    "每个操作在进入收件箱前都会被审查。始终开启，无法关闭。",
  "security.howTitle": "工作原理",
  "security.step.screen":
    "审查每一个操作——无论来自你自己的 agent 还是来自 bunnies——在它进入收件箱之前。",
  "security.step.deobfuscate":
    "先进行去混淆处理（unicode 伎俩、隐藏字符、空格、leetspeak，甚至摩斯电码），让伪装的攻击也能被识破。",
  "security.step.drain":
    "拦截钱包盗取——把你的全部余额转走或换走给他人的操作。",
  "security.step.approval":
    "拦截无限/无上限的代币授权，这类授权会让合约随意动用你的资金。",
  "security.step.exfil":
    "拦截试图泄露你的私钥、助记词或会话的行为。",
  "security.step.injection":
    "拦截隐藏在操作中的提示注入和越狱指令。",
  "security.footer":
    "任何触发规则的操作都会被静默丢弃，永远不会到达你这里。",
} as const;
