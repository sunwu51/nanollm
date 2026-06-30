import { renderToString } from "hono/jsx/dom/server";
import type { StatusCell } from "./status.js";
import { USAGE_SCRIPT, USAGE_STYLE, UsageSection, type UsagePagePayload } from "./usage-page.js";

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}


export interface StatusPageModel {
  name: string;
  series: StatusCell[];
}

export interface StatusPageFallbackGroup {
  name: string;
  members: string[];
}

export interface StatusPagePayload {
  availableWindows: number[];
  defaultWindowHours: number;
  refreshedAt: number;
  bucketStarts: number[];
  models: StatusPageModel[];
  fallbackGroups: StatusPageFallbackGroup[];
  usage: UsagePagePayload;
}

const STYLE = /* css */ String.raw`
${USAGE_STYLE}
      :root {
        color-scheme: light;
        --bg: #f5f1e8;
        --panel: rgba(255, 252, 246, 0.92);
        --border: #d8cdb8;
        --text: #2d2418;
        --muted: #7b6a54;
        --empty: #ebe2d2;
        --green: #1f8f4e;
        --lightgreen: #8bcf7d;
        --orange: #df8a2d;
        --red: #cf4b43;
        --shadow: 0 18px 48px rgba(74, 53, 26, 0.14);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(223, 138, 45, 0.12), transparent 28%),
          linear-gradient(180deg, #f7f2e9 0%, var(--bg) 100%);
        color: var(--text);
      }
      .page {
        padding: 20px;
      }
      .usage-top {
        margin-bottom: 18px;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 340px;
        gap: 18px;
        align-items: start;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 18px;
        box-shadow: var(--shadow);
      }
      .health-panel {
        overflow-x: auto;
      }
      h1 {
        margin: 0;
        font-size: 26px;
        letter-spacing: 0.02em;
      }
      .toolbar {
        display: flex;
        justify-content: flex-start;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
        margin: 18px 0 14px;
      }
      .range-buttons {
        display: inline-flex;
        gap: 8px;
        padding: 6px;
        border-radius: 999px;
        background: rgba(216, 205, 184, 0.34);
        border: 1px solid rgba(216, 205, 184, 0.65);
      }
      .range-button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 8px 12px;
        background: transparent;
        color: var(--muted);
        font: inherit;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
      }
      .range-button:hover {
        color: var(--text);
        transform: translateY(-1px);
      }
      .range-button.active {
        background: #fff8ee;
        color: var(--text);
        box-shadow: 0 5px 12px rgba(110, 88, 57, 0.12);
      }
      .range-total {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        min-height: 42px;
        color: var(--muted);
        font-size: 13px;
        white-space: nowrap;
      }
      .total-item {
        display: inline-flex;
        align-items: baseline;
        gap: 4px;
      }
      .total-label {
        color: var(--muted);
      }
      .total-value {
        color: var(--text);
        font-weight: 700;
      }
      .health-legend {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 18px;
        color: var(--muted);
        font-size: 13px;
      }
      .health-legend span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .dot, .cell {
        width: 12px;
        height: 12px;
        border-radius: 3px;
        border: 1px solid rgba(0, 0, 0, 0.08);
      }
      .header, .row {
        display: grid;
        grid-template-columns: 260px 1fr;
        gap: 12px;
        align-items: center;
      }
      .header {
        margin-bottom: 10px;
      }
      .header-label {
        color: var(--muted);
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .tick {
        width: 12px;
        font-size: 10px;
        color: var(--muted);
        writing-mode: vertical-rl;
        transform: rotate(180deg);
        opacity: 0.85;
        min-height: 42px;
      }
      .cells {
        display: grid;
        align-items: center;
        gap: 4px;
        min-width: max-content;
      }
      .row {
        padding: 10px 0;
        border-top: 1px solid rgba(216, 205, 184, 0.55);
      }
      .row:first-of-type {
        border-top: 0;
      }
      .name {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .name-main {
        font-size: 14px;
        font-weight: 700;
      }
      .name-usage {
        color: var(--muted);
        font-size: 11px;
        line-height: 1.35;
      }
      .cell {
        appearance: none;
        padding: 0;
        cursor: pointer;
        transition: transform 0.14s ease, box-shadow 0.14s ease, filter 0.14s ease;
      }
      .cell:hover,
      .cell:focus-visible {
        transform: translateY(-1px) scale(1.12);
        box-shadow: 0 6px 14px rgba(86, 61, 27, 0.18);
        filter: saturate(1.08);
        outline: none;
      }
      .empty { background: var(--empty); }
      .green { background: var(--green); }
      .lightgreen { background: var(--lightgreen); }
      .orange { background: var(--orange); }
      .red { background: var(--red); }
      .tooltip {
        position: fixed;
        z-index: 1000;
        min-width: 220px;
        max-width: 280px;
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(45, 36, 24, 0.96);
        color: #fff8f0;
        box-shadow: 0 18px 48px rgba(19, 13, 8, 0.28);
        border: 1px solid rgba(255, 255, 255, 0.08);
        pointer-events: none;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 0.12s ease, transform 0.12s ease;
      }
      .tooltip.visible {
        opacity: 1;
        transform: translateY(0);
      }
      .tooltip-title {
        margin: 0 0 10px;
        font-size: 13px;
        font-weight: 700;
        color: #fff;
      }
      .tooltip-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 6px 10px;
        font-size: 12px;
      }
      .tooltip-grid dt {
        color: rgba(255, 245, 232, 0.68);
      }
      .tooltip-grid dd {
        margin: 0;
        text-align: right;
        color: #fff8f0;
      }
      .groups-panel {
        position: sticky;
        top: 20px;
      }
      .groups-panel h2 {
        margin: 0;
        font-size: 18px;
      }
      .group-list {
        display: grid;
        gap: 12px;
        margin-top: 16px;
      }
      .group-card {
        border: 1px solid rgba(216, 205, 184, 0.72);
        border-radius: 8px;
        background: rgba(255, 248, 238, 0.72);
        padding: 12px;
      }
      .group-title {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 10px;
        margin-bottom: 10px;
      }
      .group-name {
        min-width: 0;
        overflow-wrap: anywhere;
        font-size: 14px;
        font-weight: 700;
      }
      .group-count {
        flex: 0 0 auto;
        color: var(--muted);
        font-size: 12px;
      }
      .member-list {
        display: grid;
        gap: 7px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .member-item {
        display: grid;
        grid-template-columns: 26px minmax(0, 1fr);
        align-items: center;
        gap: 8px;
        min-height: 28px;
        color: var(--text);
        font-size: 13px;
      }
      .member-rank {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 999px;
        background: rgba(216, 205, 184, 0.5);
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
      }
      .member-name {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .empty-groups {
        margin: 16px 0 0;
        color: var(--muted);
        font-size: 13px;
      }
      @media (max-width: 900px) {
        .layout {
          grid-template-columns: 1fr;
        }
        .groups-panel {
          position: static;
        }
        .header, .row {
          grid-template-columns: 160px 1fr;
        }
        .toolbar {
          align-items: flex-start;
        }
        .range-total {
          flex-wrap: wrap;
          white-space: normal;
        }
      }
      @media (max-width: 640px) {
        .page {
          padding: 12px;
        }
        .panel {
          padding: 14px;
          border-radius: 14px;
        }
        .header, .row {
          grid-template-columns: 130px 1fr;
        }
        .range-buttons {
          width: 100%;
          justify-content: space-between;
        }
        .range-total {
          width: 100%;
        }
      }
`;

const SCRIPT = String.raw`
      const STATUS_DATA = __INITIAL_PAYLOAD__;
      ${USAGE_SCRIPT.replace("const USAGE_DATA = __INITIAL_USAGE_PAYLOAD__;", "const USAGE_DATA = STATUS_DATA.usage;")}
      const TICKS_EL = document.getElementById("ticks");
      const ROWS_EL = document.getElementById("rows");
      const RANGE_BUTTONS_EL = document.getElementById("range-buttons");
      const RANGE_TOTAL_EL = document.getElementById("range-total");
      const GROUPS_EL = document.getElementById("groups");
      const TOOLTIP_EL = document.getElementById("tooltip");
      const TOOLTIP_TITLE_EL = document.getElementById("tooltip-title");
      const TOOLTIP_GRID_EL = document.getElementById("tooltip-grid");
      const BUCKETS_PER_HOUR = 12;
      const REFRESH_INTERVAL_MS = 5000;
      const FORMATTER = new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      let currentHours = STATUS_DATA.defaultWindowHours;
      let statusData = STATUS_DATA;

      function formatBucket(bucketStart) {
        return FORMATTER.format(new Date(bucketStart));
      }

      function formatTick(bucketStart, index, total) {
        const date = new Date(bucketStart);
        if (index === 0 || index === total - 1 || date.getMinutes() === 0) {
          return FORMATTER.format(date).slice(5);
        }
        return "";
      }

      function formatMetric(value) {
        return typeof value === "number" && Number.isFinite(value) ? Math.round(value) + "ms" : "-";
      }

      function formatToken(value) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0K";
        const k = value / 1000;
        return k >= 100 ? Math.round(k) + "K" : k.toFixed(1) + "K";
      }

      function formatTokenM(value) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0M";
        const m = value / 1000000;
        if (m >= 100) return Math.round(m) + "M";
        if (m >= 10) return m.toFixed(1) + "M";
        return m.toFixed(2) + "M";
      }

      function formatSpeed(tokensPerSec) {
        if (typeof tokensPerSec !== "number" || !Number.isFinite(tokensPerSec) || tokensPerSec <= 0) return "-";
        if (tokensPerSec >= 100) return Math.round(tokensPerSec) + " tok/s";
        if (tokensPerSec >= 10) return tokensPerSec.toFixed(1) + " tok/s";
        return tokensPerSec.toFixed(2) + " tok/s";
      }

      function formatRate(cell) {
        return cell.totalRequests === 0 ? "-" : cell.successRate.toFixed(1) + "%";
      }

      function getTone(cell) {
        if (cell.totalRequests === 0) return "empty";
        if (cell.successRate >= 100) return "green";
        if (cell.successRate >= 80) return "lightgreen";
        if (cell.successRate >= 50) return "orange";
        return "red";
      }

      function updateTooltipContent(modelName, cell) {
        TOOLTIP_TITLE_EL.textContent = modelName + " @ " + formatBucket(cell.bucketStart);
        TOOLTIP_GRID_EL.textContent = "";
        const entries = [
          ["总请求", String(cell.totalRequests)],
          ["成功", String(cell.successRequests)],
          ["成功率", formatRate(cell)],
          ["平均首包", formatMetric(cell.avgTtfbMs)],
          ["平均总耗时", formatMetric(cell.avgDurationMs)],
          ["Input", formatToken(cell.nonCacheInputTokens)],
          ["Cache", formatToken(cell.cacheReadInputTokens)],
          ["Output", formatToken(cell.outputTokens)],
          ["平均速度", formatSpeed(cell.avgTokenSpeed)],
        ];
        for (const [label, value] of entries) {
          const dt = document.createElement("dt");
          dt.textContent = label;
          const dd = document.createElement("dd");
          dd.textContent = value;
          TOOLTIP_GRID_EL.appendChild(dt);
          TOOLTIP_GRID_EL.appendChild(dd);
        }
      }

      function positionTooltip(clientX, clientY) {
        const padding = 16;
        const rect = TOOLTIP_EL.getBoundingClientRect();
        let left = clientX + 16;
        let top = clientY + 18;
        if (left + rect.width > window.innerWidth - padding) {
          left = clientX - rect.width - 16;
        }
        if (top + rect.height > window.innerHeight - padding) {
          top = window.innerHeight - rect.height - padding;
        }
        if (left < padding) left = padding;
        if (top < padding) top = padding;
        TOOLTIP_EL.style.left = left + "px";
        TOOLTIP_EL.style.top = top + "px";
      }

      function hideTooltip() {
        TOOLTIP_EL.classList.remove("visible");
        TOOLTIP_EL.setAttribute("aria-hidden", "true");
      }

      function showTooltip(modelName, cell, clientX, clientY) {
        updateTooltipContent(modelName, cell);
        TOOLTIP_EL.classList.add("visible");
        TOOLTIP_EL.setAttribute("aria-hidden", "false");
        positionTooltip(clientX, clientY);
      }

      function buildCell(modelName, cell) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cell " + getTone(cell);
        button.setAttribute("aria-label", modelName + " " + formatBucket(cell.bucketStart));
        button.addEventListener("pointerenter", (event) => showTooltip(modelName, cell, event.clientX, event.clientY));
        button.addEventListener("pointermove", (event) => positionTooltip(event.clientX, event.clientY));
        button.addEventListener("pointerleave", hideTooltip);
        button.addEventListener("focus", () => showTooltip(modelName, cell, window.innerWidth / 2, 88));
        button.addEventListener("blur", hideTooltip);
        return button;
      }

      function renderFallbackGroups() {
        GROUPS_EL.textContent = "";
        if (!statusData.fallbackGroups || statusData.fallbackGroups.length === 0) {
          const empty = document.createElement("p");
          empty.className = "empty-groups";
          empty.textContent = "未配置 fallback 分组";
          GROUPS_EL.appendChild(empty);
          return;
        }

        for (const group of statusData.fallbackGroups) {
          const card = document.createElement("section");
          card.className = "group-card";

          const title = document.createElement("div");
          title.className = "group-title";
          const name = document.createElement("div");
          name.className = "group-name";
          name.textContent = group.name;
          const count = document.createElement("div");
          count.className = "group-count";
          count.textContent = String(group.members.length) + " models";
          title.appendChild(name);
          title.appendChild(count);

          const members = document.createElement("ol");
          members.className = "member-list";
          group.members.forEach((member, index) => {
            const item = document.createElement("li");
            item.className = "member-item";
            const rank = document.createElement("span");
            rank.className = "member-rank";
            rank.textContent = String(index + 1);
            const memberName = document.createElement("span");
            memberName.className = "member-name";
            memberName.textContent = member;
            item.appendChild(rank);
            item.appendChild(memberName);
            members.appendChild(item);
          });

          card.appendChild(title);
          card.appendChild(members);
          GROUPS_EL.appendChild(card);
        }
      }

      function summarizeSeries(series) {
        return series.reduce((acc, cell) => {
          acc.nonCacheInputTokens += cell.nonCacheInputTokens || 0;
          acc.cacheReadInputTokens += cell.cacheReadInputTokens || 0;
          acc.outputTokens += cell.outputTokens || 0;
          acc.totalStreamMs += cell.totalStreamMs || 0;
          return acc;
        }, {
          nonCacheInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 0,
          totalStreamMs: 0,
        });
      }

      function renderRangeTotal(summary) {
        RANGE_TOTAL_EL.textContent = "";
        const entries = [
          ["Input", formatTokenM(summary.nonCacheInputTokens)],
          ["Cache", formatTokenM(summary.cacheReadInputTokens)],
          ["Output", formatTokenM(summary.outputTokens)],
        ];
        for (const [label, value] of entries) {
          const item = document.createElement("span");
          item.className = "total-item";
          const labelEl = document.createElement("span");
          labelEl.className = "total-label";
          labelEl.textContent = label;
          const valueEl = document.createElement("span");
          valueEl.className = "total-value";
          valueEl.textContent = value;
          item.appendChild(labelEl);
          item.appendChild(valueEl);
          RANGE_TOTAL_EL.appendChild(item);
        }
      }

      function render(hours) {
        currentHours = hours;
        const visibleCount = Math.min(statusData.bucketStarts.length, Math.max(1, hours * BUCKETS_PER_HOUR));
        const startIndex = Math.max(0, statusData.bucketStarts.length - visibleCount);
        const visibleBuckets = statusData.bucketStarts.slice(startIndex).reverse();

        TICKS_EL.style.gridTemplateColumns = "repeat(" + visibleBuckets.length + ", 12px)";
        TICKS_EL.textContent = "";
        visibleBuckets.forEach((bucketStart, index) => {
          const tick = document.createElement("div");
          tick.className = "tick";
          tick.textContent = formatTick(bucketStart, index, visibleBuckets.length);
          TICKS_EL.appendChild(tick);
        });

        ROWS_EL.textContent = "";
        const rangeTotal = {
          nonCacheInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 0,
        };
        for (const model of statusData.models) {
          const row = document.createElement("section");
          row.className = "row";
          const visibleSeries = model.series.slice(startIndex).reverse();
          const usageSummary = summarizeSeries(visibleSeries);
          rangeTotal.nonCacheInputTokens += usageSummary.nonCacheInputTokens;
          rangeTotal.cacheReadInputTokens += usageSummary.cacheReadInputTokens;
          rangeTotal.outputTokens += usageSummary.outputTokens;

          const name = document.createElement("div");
          name.className = "name";
          const main = document.createElement("div");
          main.className = "name-main";
          main.textContent = model.name;
          const usage = document.createElement("div");
          usage.className = "name-usage";
          const aggregateSpeed = usageSummary.totalStreamMs > 0
            ? usageSummary.outputTokens / (usageSummary.totalStreamMs / 1000)
            : null;
          usage.textContent =
            "Input " + formatToken(usageSummary.nonCacheInputTokens) +
            " | Cache " + formatToken(usageSummary.cacheReadInputTokens) +
            " | Output " + formatToken(usageSummary.outputTokens) +
            " | " + formatSpeed(aggregateSpeed);
          name.appendChild(main);
          name.appendChild(usage);

          const cells = document.createElement("div");
          cells.className = "cells";
          cells.style.gridTemplateColumns = "repeat(" + visibleBuckets.length + ", 12px)";
          for (const cell of visibleSeries) {
            cells.appendChild(buildCell(model.name, cell));
          }

          row.appendChild(name);
          row.appendChild(cells);
          ROWS_EL.appendChild(row);
        }

        for (const button of RANGE_BUTTONS_EL.querySelectorAll(".range-button")) {
          button.classList.toggle("active", Number(button.dataset.hours) === currentHours);
        }
        renderRangeTotal(rangeTotal);
        renderFallbackGroups();
      }

      async function refreshStatus() {
        try {
          const response = await fetch("/status/data", { cache: "no-store" });
          if (!response.ok) return;
          statusData = await response.json();
          render(currentHours);
        } catch {}
      }

      statusData.availableWindows.forEach((hours) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "range-button";
        button.dataset.hours = String(hours);
        button.textContent = hours + "h";
        button.addEventListener("click", () => render(hours));
        RANGE_BUTTONS_EL.appendChild(button);
      });

      render(currentHours);
      setInterval(refreshStatus, REFRESH_INTERVAL_MS);
`;

function StatusPage({ payload }: { payload: StatusPagePayload }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>nanollm status</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
    <main class="page">
      <div class="usage-top">
        <UsageSection payload={{ ...payload.usage, basePath: "/status" }} />
      </div>
      <div class="layout">
        <section class="panel health-panel">
          <h1>Model Health</h1>
          <div class="toolbar">
            <div class="range-buttons" id="range-buttons"></div>
            <div class="range-total" id="range-total" aria-label="当前时间范围总用量"></div>
          </div>
          <div class="health-legend">
            <span><i class="dot green"></i>100%</span>
            <span><i class="dot lightgreen"></i>80%+</span>
            <span><i class="dot orange"></i>50%+</span>
            <span><i class="dot red"></i>&lt;50%</span>
            <span><i class="dot empty"></i>无数据</span>
          </div>
          <div class="header">
            <div class="header-label">Models</div>
            <div class="cells" id="ticks"></div>
          </div>
          <div id="rows"></div>
        </section>
        <aside class="panel groups-panel">
          <h2>Fallback Groups</h2>
          <div class="group-list" id="groups"></div>
        </aside>
      </div>
    </main>
    <aside class="tooltip" id="tooltip" aria-hidden="true">
      <p class="tooltip-title" id="tooltip-title"></p>
      <dl class="tooltip-grid" id="tooltip-grid"></dl>
    </aside>
        <script
          dangerouslySetInnerHTML={{
            __html: SCRIPT.replace("__INITIAL_PAYLOAD__", serializeForScript(payload)),
          }}
        />
      </body>
    </html>
  );
}

export function renderStatusPage(payload: StatusPagePayload): string {
  return "<!doctype html>" + renderToString(<StatusPage payload={payload} />);
}
