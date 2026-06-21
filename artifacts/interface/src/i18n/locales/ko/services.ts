export default {
  description:
    "bunnyOS가 호출할 수 있는 프로토콜과 api를 켜고 끄세요. 활성화된 것은 매 턴 에이전트에 노출되고, 비활성화된 것은 숨겨집니다. 행을 클릭하면 탭에서 열립니다.",
  mcpSection: "mcp",
  bunnyosImplementation: "bunny 코어",
  optionalSection: "bunny 옵션",
  loadingServices: "서비스 불러오는 중…",
  off: "꺼짐",
  toolCount: "도구 {count}개",
  notAuthorized: "권한 없음",
  offline: "오프라인",
  toggleAria: "{label} 토글",
  toggleFailed: "{id} 토글 실패",
  "telegram.section": "알림",
  "telegram.label": "텔레그램 푸시",
  "telegram.toggleAria": "텔레그램 푸시 토글",
  "telegram.help":
    "@BotFather로 봇을 만들어 bot token을 아래에 붙여넣고, 텔레그램에서 봇을 열어 아무 메시지나 보내세요. 감지를 누르면 chat id가 자동으로 채워집니다. 그런 다음 저장하세요.",
  "telegram.botTokenPlaceholder": "bot token (@BotFather에서)",
  "telegram.botTokenSavedPlaceholder": "bot token 저장됨 — 새로 붙여넣으면 교체됩니다",
  "telegram.chatIdPlaceholder": "내 chat id (감지 클릭)",
  "telegram.detect": "감지",
  "telegram.detected": "chat id 감지됨",
  "telegram.detectFailed": "감지 실패 — token을 붙여넣고, 먼저 봇에게 메시지를 보낸 뒤 다시 시도하세요",
  "telegram.save": "저장",
  "telegram.test": "테스트",
  "telegram.saved": "텔레그램 저장됨",
  "telegram.saveFailed": "텔레그램 업데이트 실패",
  "telegram.invalidInput": "잘못된 bot token 또는 chat id",
  "telegram.testSent": "테스트 메시지 전송됨",
  "telegram.testFailed": "테스트 실패 — token, chat id, 봇 대화 시작 여부를 확인하세요",
  setApi: "api 설정",
  poweredByBunnyDs: "bunnyDS 제공",
  "security.section": "보안",
  "security.label": "액션 보안",
  "security.always": "항상 켜짐",
  "security.help":
    "모든 액션은 받은 편지함에 도달하기 전에 검사됩니다. 항상 켜져 있으며 끌 수 없습니다.",
  "security.howTitle": "작동 방식",
  "security.step.screen":
    "모든 액션을 검사합니다 — 내 에이전트에서 온 것이든 버니에서 온 것이든 — 받은 편지함에 표시되기 전에.",
  "security.step.deobfuscate":
    "먼저 난독화를 해제합니다 (유니코드 트릭, 숨은 문자, 띄어쓰기, 리트스피크, 모스 부호까지) 위장된 공격도 잡아냅니다.",
  "security.step.drain":
    "지갑 탈취를 차단합니다 — 전체 잔액을 타인에게 전송하거나 스왑하는 동작.",
  "security.step.approval":
    "계약이 자금을 마음대로 사용하게 만드는 무제한·무상한 토큰 승인을 차단합니다.",
  "security.step.exfil":
    "개인 키, 시드 문구, 세션을 유출하려는 시도를 차단합니다.",
  "security.step.injection":
    "액션에 숨겨진 프롬프트 인젝션과 탈옥 명령을 차단합니다.",
  "security.footer":
    "규칙에 걸리는 것은 조용히 폐기되며 사용자에게 전달되지 않습니다.",
} as const;
