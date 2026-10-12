import { AsyncLocalStorage } from "node:async_hooks";

export type Lang = "zh" | "en";

export const LANG_COOKIE = "nanollm_lang";
const LANG_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

// Chinese only when the browser's most preferred language is Chinese; everything else falls back to English.
function langFromAcceptLanguage(header: string | undefined): Lang {
  let best: { tag: string; q: number } | undefined;
  for (const part of (header ?? "").split(",")) {
    const [rawTag, ...params] = part.trim().split(";");
    const tag = rawTag.trim().toLowerCase();
    if (!tag || tag === "*") continue;
    const qParam = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0) continue;
    if (!best || q > best.q) best = { tag, q };
  }
  return best && (best.tag === "zh" || best.tag.startsWith("zh-")) ? "zh" : "en";
}

/** The language chosen with the page switch wins; without one, follow the browser. */
export function resolveLang(cookieHeader: string | undefined, acceptLanguage: string | undefined): Lang {
  const chosen = readCookie(cookieHeader, LANG_COOKIE);
  if (chosen === "zh" || chosen === "en") return chosen;
  return langFromAcceptLanguage(acceptLanguage);
}

const requestLang = new AsyncLocalStorage<Lang>();

/** Runs a web UI request so that server messages created while handling it use the page language. */
export function runWithLang<T>(lang: Lang, callback: () => T): T {
  return requestLang.run(lang, callback);
}

/**
 * Picks the message for the language of the current web UI request.
 * Outside one (startup, scheduled runs, logs) it stays Chinese, as before the UI had a language option.
 */
export function localize(zh: string, en: string): string {
  return requestLang.getStore() === "en" ? en : zh;
}

export function htmlLang(lang: Lang): string {
  return lang === "zh" ? "zh-CN" : "en";
}

const CORNER_STYLE = `<style>
.page-corner{position:fixed;top:16px;right:16px;z-index:100;display:flex;gap:8px;align-items:center}
.page-corner.scrolls{position:absolute}
.page-corner .back-admin{position:static}
.lang-switch{display:inline-flex;padding:3px;border-radius:999px;border:1px solid rgba(140,90,47,.28);background:rgba(255,250,242,.95);box-shadow:0 6px 18px rgba(58,43,24,.12)}
.lang-switch button{appearance:none;border:0;margin:0;padding:5px 10px;border-radius:999px;background:transparent;color:#8c5a2f;font:inherit;font-size:12px;font-weight:700;cursor:pointer;width:auto}
.lang-switch button[aria-pressed="true"]{background:#8c5a2f;color:#fff9f1;cursor:default}
</style>`;

// Inline handlers keep each page down to its own single <script>.
function renderLangSwitch(lang: Lang): string {
  const option = (value: Lang, label: string) => value === lang
    ? `<button type="button" aria-pressed="true" disabled>${label}</button>`
    : `<button type="button" aria-pressed="false" onclick="document.cookie='${LANG_COOKIE}=${value}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE}; SameSite=Lax';location.reload()">${label}</button>`;
  return `<div class="lang-switch" role="group" aria-label="Language">${option("zh", "中文")}${option("en", "EN")}</div>`;
}

/**
 * Adds the top-right corner (optional "← Admin" link and the language switch) to a rendered page.
 * The page keeps its own `.back-admin` look; the corner only takes over its positioning.
 * The corner stays pinned while scrolling unless `scrolls` is set, for pages whose panels have buttons along that edge.
 */
export function withPageCorner(html: string, lang: Lang, options: { backToAdmin?: boolean; scrolls?: boolean } = {}): string {
  const back = options.backToAdmin ? `<a class="back-admin" href="/admin">← Admin</a>` : "";
  const className = options.scrolls ? "page-corner scrolls" : "page-corner";
  return html
    .replace("</head>", `${CORNER_STYLE}</head>`)
    .replace(/<body([^>]*)>/, `<body$1><div class="${className}">${back}${renderLangSwitch(lang)}</div>`);
}
