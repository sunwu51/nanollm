import type { StatusCell } from "./status.js";

export interface StatusPageModel {
  name: string;
  series: StatusCell[];
}

export interface StatusPagePayload {
  availableWindows: number[];
  defaultWindowHours: number;
  refreshedAt: number;
  bucketStarts: number[];
  models: StatusPageModel[];
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function renderStatusPage(payload: StatusPagePayload): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>nanollm status</title>
    <style>
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
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 18px;
        overflow-x: auto;
        box-shadow: var(--shadow);
      }
      h1 {
        margin: 0;
        font-size: 26px;
        letter-spacing: 0.02em;
      }
      .meta {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 14px;
      }
      .toolbar {
        display: flex;
        justify-content: space-between;
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
      .range-meta {
        color: var(--muted);
        font-size: 13px;
      }
      .legend {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 18px;
        color: var(--muted);
        font-size: 13px;
      }
      .legend span {
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
        grid-template-columns: 180px 1fr;
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
        word-break: break-all;
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
      @media (max-width: 900px) {
        .header, .row {
          grid-template-columns: 120px 1fr;
        }
        .toolbar {
          align-items: flex-start;
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
          grid-template-columns: 100px 1fr;
        }
        .range-buttons {
          width: 100%;
          justify-content: space-between;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="panel">
        <h1>Model Health</h1>
        <p class="meta">只展示真实模型，按 5 分钟窗口记录到内存，最多保留最近 6 小时。</p>
        <div class="toolbar">
          <div class="range-buttons" id="range-buttons"></div>
          <div class="range-meta" id="range-meta"></div>
        </div>
        <div class="legend">
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
    </main>
    <aside class="tooltip" id="tooltip" aria-hidden="true">
      <p class="tooltip-title" id="tooltip-title"></p>
      <dl class="tooltip-grid" id="tooltip-grid"></dl>
    </aside>
    <script>
      const STATUS_DATA = ${serializeForScript(payload)};
      const TICKS_EL = document.getElementById("ticks");
      const ROWS_EL = document.getElementById("rows");
      const RANGE_META_EL = document.getElementById("range-meta");
      const RANGE_BUTTONS_EL = document.getElementById("range-buttons");
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

      function summarizeSeries(series) {
        return series.reduce((acc, cell) => {
          acc.nonCacheInputTokens += cell.nonCacheInputTokens || 0;
          acc.cacheReadInputTokens += cell.cacheReadInputTokens || 0;
          acc.outputTokens += cell.outputTokens || 0;
          return acc;
        }, {
          nonCacheInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 0,
        });
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
        for (const model of statusData.models) {
          const row = document.createElement("section");
          row.className = "row";
          const visibleSeries = model.series.slice(startIndex).reverse();
          const usageSummary = summarizeSeries(visibleSeries);

          const name = document.createElement("div");
          name.className = "name";
          const main = document.createElement("div");
          main.className = "name-main";
          main.textContent = model.name;
          const usage = document.createElement("div");
          usage.className = "name-usage";
          usage.textContent =
            "Input " + formatToken(usageSummary.nonCacheInputTokens) +
            " | Cache " + formatToken(usageSummary.cacheReadInputTokens) +
            " | Output " + formatToken(usageSummary.outputTokens);
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

        RANGE_META_EL.textContent =
          "当前展示最近 " + hours + " 小时，内存中最多保留最近 6 小时，每 5 秒自动刷新一次。";
        for (const button of RANGE_BUTTONS_EL.querySelectorAll(".range-button")) {
          button.classList.toggle("active", Number(button.dataset.hours) === currentHours);
        }
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
    </script>
  </body>
</html>`;
}
