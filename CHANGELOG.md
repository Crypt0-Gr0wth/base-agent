# Changelog

All notable changes to Base Agent are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.4] - 2026-06-21

### Added
- **bunnyDS — managed data & inference gateway** — a managed mode (on by default) that routes market-data lookups and LLM inference through the bunnyOS gateway, so the terminal works with no API keys of your own. It authenticates per wallet (a gateway session token minted by signing a nonce with your Base account) and meters usage against a USDC allowance you grant on Base — the agent builds the `approve` call and execution is approved in the Base app, so no private key ever touches the system. Turn it off to fall back to your own keys (BYO / open-source mode).
- **Telegram bot** — connect a Telegram bot to chat with the agent and receive alerts from Telegram, with one-tap Base sign-in via a login link and inline price / technical-analysis charts rendered server-side. Configurable per user.
- **Pluggable inference providers** — choose your LLM provider — bunnyDS (managed), OpenRouter, Venice, Surplus, or EconomyOS — each with its own key and model catalog, selectable from settings.
- **New market-data providers** — Zerion (dashboard-grade wallet/portfolio data), GMGN (token data and contract-security signals), and CoinStats (wallet/portfolio, crypto news, and NFTs). Each works through bunnyDS or your own key.
- **Portfolio tab** — wallet holdings, positions, PnL, and history, powered by the new providers.
- **On-chain swaps via Definitive Flash** — intent-based, non-custodial DEX execution on Base; the agent fetches a quote and builds the approve / permit / order signing payloads, executed through your Base account.
- **bunny exchange** — a friend.tech-style "keys" market for bunnies, settled in the OS token on Base (read + calldata only; execution approved in the Base app).
- **Object storage** — file upload and storage for the agent (e.g. images), with per-object access-control policies.
- **Litepaper** — a `/litepaper` page in the interface.
- **Light / dark theme** — a theme switcher across the interface, remembered per browser.
- Expanded English / Korean / Chinese coverage for the new surfaces.

### Changed
- **Token security** is now sourced from GMGN's contract-security signals (honeypot, trading taxes, blacklist, ownership-renounced, and verified/open-source status), surfaced as token-report enrichment. It requires GMGN access (bunnyDS or a user-supplied GMGN key).
- **Database schema** — added `api_cache`, `app_meta`, `bunny_recommendation_executions`, `telegram_login_tokens`, and `telegram_updates` tables, plus new `user_settings` columns for the managed gateway, inference providers, additional data providers, and Telegram. Apply with `pnpm --filter @workspace/db run push`.
- Read-only provider responses are now served from a durable database cache to cut repeat upstream calls.
- Regenerated the OpenAPI spec and the generated zod / React Query clients.

### Removed
- The standalone GoPlus Labs token-security integration (token security is now provided via GMGN).

## [0.3.0] - 2026-06-05

### Added
- **Perpetuals trading** — a new Perps tab covering perps markets on [Avantis](https://avantisfi.com), with live prices, market listings, and your open positions. The agent gains a matching set of Avantis tools to open and manage positions (execution is still approved in the Base app).
- **Technical analysis** — a streaming TA panel for perps markets, with indicators computed from [Pyth](https://pyth.network) price history; the same analysis is available to the agent as a tool.
- **Multi-language interface** — the UI is fully internationalized with English, Korean, and Chinese, selectable from a language switcher and remembered per user.

### Changed
- **Database schema** — added `user_settings.lang` to persist each user's interface language. Apply with `pnpm --filter @workspace/db run push`.
- Expanded the agent's built-in (native) tools with the new perps and technical-analysis capabilities.

## [0.2.0] - 2026-06-01

### Added
- **Token Explorer** — search any token for live market data and on-chain activity, with GoPlus security/risk signals, exportable as a formatted PDF report.
- **GoPlus Labs token security** — token risk checks (honeypot, taxes, ownership, and more) surfaced to the agent and in the Token Explorer. No API key required.
- **CoinGecko integration** — a single market-data source covering CEX quotes, listings and metadata plus on-chain DEX pairs (via the GeckoTerminal proxy). Uses a free per-user CoinGecko Demo key.
- **PDF reports** — export token research as a formatted PDF.
- **Native actions** — a starter pack of actions shipped in code and seeded per user; workflows now distinguish `native` (code-owned) from `custom` (user-authored).
- **Token references on alerts/recommendations** — action rows now carry the tokens they mention (symbol + contract address), surfaced in the UI as "tokens mentioned".

### Changed
- **Replaced CoinMarketCap with CoinGecko** as the market-data provider; the consolidated CoinGecko library also absorbs the former DexScreener and GeckoTerminal usage. Legacy tool names are migrated automatically on server start.
- **Database schema** — added `actions.tokens` and `workflows.source`; renamed `user_settings.cmc_api_key` → `coingecko_api_key`. Apply with `pnpm --filter @workspace/db run push`.
- Regenerated the OpenAPI spec and the generated zod / React Query clients.

### Removed
- The CoinMarketCap integration (superseded by CoinGecko).

### Fixed
- **Local development now matches the README out of the box** — the API server defaults to port `3000` and the interface to `5173`, the Vite dev server proxies `/api` → `:3000`, and the repo-root `.env` is auto-loaded (via Node `--env-file` / `process.loadEnvFile`). `cp .env.example .env` followed by the documented dev commands now works without manually exporting variables.

## [0.1.0] - 2026-05-29

### Added
- Initial public release — the first open-source [Base](https://base.org) agent, built on [Base MCP](https://mcp.base.org). Self-hostable and AGPL-3.0 licensed.
- Four core systems: autonomous **action scanners** (alerts and one-click recommendations), a tabbed **terminal UI**, markdown-based **memory**, and a native **MCP & tooling** layer.
- First-party tool sources: Base account MCP, Moralis, CoinMarketCap, DeFi Llama, Bankr, and Morpho.
- Security model: no private keys on the system (execution is approved in the Base app); stored API keys and wallet tokens encrypted at rest (AES-256-GCM), with HMAC-signed sessions.

[Unreleased]: https://github.com/bunnyos/base-agent/compare/v0.5.4...HEAD
[0.5.4]: https://github.com/bunnyos/base-agent/compare/v0.3.0...v0.5.4
[0.3.0]: https://github.com/bunnyos/base-agent/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/bunnyos/base-agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bunnyos/base-agent/releases/tag/v0.1.0
