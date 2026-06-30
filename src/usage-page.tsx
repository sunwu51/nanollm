import type { UsageDayCell } from "./usage.js";

export type UsageRangeMode = "7d" | "30d" | "year";

export interface UsagePagePayload {
  refreshedAt: number;
  start: string;
  end: string;
  selectedYear: number | null;
  selectedRange: UsageRangeMode;
  availableYears: number[];
  selectedModel: string | null;
  models: string[];
  days: UsageDayCell[];
  basePath?: string;
}

export const USAGE_STYLE = /* css */ String.raw`
      .usage-scope {
        --usage-panel: var(--panel, rgba(255, 252, 246, 0.92));
        --usage-border: var(--border, #d8cdb8);
        --usage-text: var(--text, #2d2418);
        --usage-muted: var(--muted, #7b6a54);
        --usage-empty: #ebedf0;
        --usage-level-1: #9be9a8;
        --usage-level-2: #40c463;
        --usage-level-3: #30a14e;
        --usage-level-4: #216e39;
        --usage-blue: #0969da;
        --usage-shadow: var(--shadow, 0 18px 48px rgba(74, 53, 26, 0.14));
        color: var(--usage-text);
      }
      .usage-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 150px;
        gap: 24px;
        align-items: start;
      }
      .usage-panel {
        overflow-x: auto;
        background: var(--usage-panel);
        border: 1px solid var(--usage-border);
        border-radius: 18px;
        box-shadow: var(--usage-shadow);
      }
      .usage-header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
        padding: 18px 20px 10px;
      }
      .usage-title {
        margin: 0;
        font-size: 20px;
        font-weight: 500;
        letter-spacing: 0;
      }
      .usage-summary {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
        color: var(--usage-muted);
        font-size: 13px;
        line-height: 1.5;
      }
      .usage-summary strong {
        color: var(--usage-text);
        font-weight: 600;
      }
      .usage-note {
        margin: 2px 0 0;
        color: var(--usage-muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .usage-controls {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        flex-wrap: wrap;
      }
      .usage-select {
        min-height: 32px;
        border: 1px solid var(--usage-border);
        border-radius: 6px;
        background: #fff;
        color: var(--usage-text);
        padding: 4px 28px 4px 10px;
        font: inherit;
        font-size: 13px;
      }
      .usage-heatmap-wrap {
        padding: 8px 20px 16px;
        min-width: 870px;
      }
      .usage-months {
        display: grid;
        grid-template-columns: repeat(53, 13px);
        gap: 3px;
        margin-left: 32px;
        height: 20px;
        color: var(--usage-text);
        font-size: 12px;
      }
      .usage-month {
        grid-column: var(--week) / span 4;
      }
      .usage-grid-row {
        display: grid;
        grid-template-columns: 26px auto;
        gap: 6px;
        align-items: start;
      }
      .usage-weekdays {
        display: grid;
        grid-template-rows: repeat(7, 13px);
        gap: 3px;
        color: var(--usage-text);
        font-size: 12px;
        line-height: 13px;
      }
      .usage-weekday {
        height: 13px;
      }
      .usage-weekday.dim {
        color: transparent;
      }
      .usage-heatmap {
        display: grid;
        grid-template-columns: repeat(53, 13px);
        grid-template-rows: repeat(7, 13px);
        grid-auto-flow: column;
        gap: 3px;
      }
      .usage-cell {
        width: 13px;
        height: 13px;
        border: 0;
        border-radius: 3px;
        padding: 0;
        background: var(--usage-empty);
      }
      .usage-cell[data-level="1"] { background: var(--usage-level-1); }
      .usage-cell[data-level="2"] { background: var(--usage-level-2); }
      .usage-cell[data-level="3"] { background: var(--usage-level-3); }
      .usage-cell[data-level="4"] { background: var(--usage-level-4); }
      .usage-cell:hover,
      .usage-cell:focus-visible {
        outline: 1px solid rgba(27, 31, 36, 0.45);
        outline-offset: 1px;
      }
      .usage-legend {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 4px;
        margin: 12px 32px 2px 0;
        color: var(--usage-muted);
        font-size: 12px;
      }
      .usage-legend .usage-cell {
        pointer-events: none;
      }
      .usage-years {
        display: grid;
        gap: 8px;
      }
      .usage-year-link {
        display: block;
        border-radius: 6px;
        padding: 10px 14px;
        color: var(--usage-muted);
        text-decoration: none;
        font-size: 14px;
      }
      .usage-year-link:hover {
        color: var(--usage-text);
        background: rgba(208, 215, 222, 0.35);
      }
      .usage-year-link.active {
        background: var(--usage-blue);
        color: #fff;
        font-weight: 600;
      }
      .usage-tooltip {
        position: fixed;
        z-index: 1000;
        min-width: 240px;
        max-width: 300px;
        padding: 12px 14px;
        border-radius: 8px;
        background: rgba(36, 41, 47, 0.96);
        color: #fff;
        box-shadow: 0 16px 36px rgba(31, 35, 40, 0.24);
        pointer-events: none;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 0.12s ease, transform 0.12s ease;
      }
      .usage-tooltip.visible {
        opacity: 1;
        transform: translateY(0);
      }
      .usage-tooltip-title {
        margin: 0 0 10px;
        font-size: 13px;
        font-weight: 700;
      }
      .usage-tooltip-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 6px 12px;
        margin: 0;
        font-size: 12px;
      }
      .usage-tooltip-grid dt {
        color: rgba(255, 255, 255, 0.68);
      }
      .usage-tooltip-grid dd {
        margin: 0;
        text-align: right;
      }
      @media (max-width: 900px) {
        .usage-layout { grid-template-columns: 1fr; }
        .usage-years {
          display: flex;
          overflow-x: auto;
        }
        .usage-year-link {
          min-width: 82px;
          text-align: center;
        }
        .usage-header {
          flex-direction: column;
        }
        .usage-controls {
          justify-content: flex-start;
        }
      }
      @media (max-width: 640px) {
        .usage-panel {
          border-radius: 14px;
        }
      }
`;

export const USAGE_SCRIPT = String.raw`
      const USAGE_DATA = __INITIAL_USAGE_PAYLOAD__;
      const USAGE_HEATMAP_EL = document.getElementById("usage-heatmap");
      const USAGE_MONTHS_EL = document.getElementById("usage-months");
      const USAGE_SUMMARY_EL = document.getElementById("usage-summary");
      const USAGE_RANGE_EL = document.getElementById("usage-range");
      const USAGE_METRIC_EL = document.getElementById("usage-metric");
      const USAGE_MODEL_EL = document.getElementById("usage-model");
      const USAGE_TOOLTIP_EL = document.getElementById("usage-tooltip");
      const USAGE_TOOLTIP_TITLE_EL = document.getElementById("usage-tooltip-title");
      const USAGE_TOOLTIP_GRID_EL = document.getElementById("usage-tooltip-grid");
      const USAGE_MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short" });
      const USAGE_DAY_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
      });
      let currentUsageMetric = "totalTokens";

      function parseUsageDay(day) {
        const parts = day.split("-").map(Number);
        return new Date(parts[0], parts[1] - 1, parts[2]);
      }

      function formatUsageCompact(value) {
        if (!Number.isFinite(value) || value <= 0) return "0";
        if (value >= 1000000000) return (value / 1000000000).toFixed(value >= 10000000000 ? 0 : 1) + "B";
        if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 0 : 1) + "M";
        if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + "K";
        return String(Math.round(value));
      }

      function formatUsageFull(value) {
        return new Intl.NumberFormat("en-US").format(Math.round(value || 0));
      }

      function getUsageMetricValue(day) {
        return Number(day[currentUsageMetric] || 0);
      }

      function getUsageMetricLabel() {
        if (currentUsageMetric === "totalRequests") return "requests";
        if (currentUsageMetric === "outputTokens") return "output tokens";
        return "tokens";
      }

      function getUsageThresholds(values) {
        const positive = values.filter((value) => value > 0).sort((a, b) => a - b);
        if (positive.length === 0) return [1, 2, 3, 4];
        const pick = (ratio) => positive[Math.min(positive.length - 1, Math.floor((positive.length - 1) * ratio))];
        return [pick(0.25), pick(0.5), pick(0.75), pick(0.9)];
      }

      function getUsageLevel(value, thresholds) {
        if (value <= 0) return 0;
        if (value <= thresholds[0]) return 1;
        if (value <= thresholds[1]) return 2;
        if (value <= thresholds[2]) return 3;
        return 4;
      }

      function renderUsageSummary() {
        const totalRequests = USAGE_DATA.days.reduce((sum, day) => sum + (day.totalRequests || 0), 0);
        const totalTokens = USAGE_DATA.days.reduce((sum, day) => sum + (day.totalTokens || 0), 0);
        const inputTokens = USAGE_DATA.days.reduce((sum, day) => sum + (day.nonCacheInputTokens || 0), 0);
        const cachedTokens = USAGE_DATA.days.reduce((sum, day) => sum + (day.cacheReadInputTokens || 0), 0);
        const outputTokens = USAGE_DATA.days.reduce((sum, day) => sum + (day.outputTokens || 0), 0);
        USAGE_SUMMARY_EL.innerHTML =
          "<span><strong>" + formatUsageCompact(totalRequests) + "</strong> Requests</span>" +
          "<span><strong>" + formatUsageCompact(totalTokens) + "</strong> Tokens</span>" +
          "<span><strong>" + formatUsageCompact(inputTokens) + "</strong> Input</span>" +
          "<span><strong>" + formatUsageCompact(cachedTokens) + "</strong> Cached</span>" +
          "<span><strong>" + formatUsageCompact(outputTokens) + "</strong> Output</span>";
      }

      function renderUsageMonths(cells) {
        USAGE_MONTHS_EL.textContent = "";
        const seen = new Set();
        for (const item of cells) {
          const date = parseUsageDay(item.day);
          if (date.getDate() > 7) continue;
          const month = date.getMonth();
          const key = date.getFullYear() + "-" + month;
          if (seen.has(key)) continue;
          seen.add(key);
          const label = document.createElement("div");
          label.className = "usage-month";
          label.style.setProperty("--week", String(item.week + 1));
          label.textContent = USAGE_MONTH_FORMATTER.format(date);
          USAGE_MONTHS_EL.appendChild(label);
        }
      }

      function updateUsageTooltipContent(day) {
        const value = getUsageMetricValue(day);
        USAGE_TOOLTIP_TITLE_EL.textContent = formatUsageFull(value) + " " + getUsageMetricLabel() + " on " + USAGE_DAY_FORMATTER.format(parseUsageDay(day.day));
        USAGE_TOOLTIP_GRID_EL.textContent = "";
        const entries = [
          ["Requests", formatUsageFull(day.totalRequests)],
          ["Success", formatUsageFull(day.successRequests)],
          ["Failed", formatUsageFull(day.failureRequests)],
          ["Input", formatUsageFull(day.nonCacheInputTokens)],
          ["Cached", formatUsageFull(day.cacheReadInputTokens)],
          ["Output", formatUsageFull(day.outputTokens)],
          ["Tokens", formatUsageFull(day.totalTokens)],
        ];
        for (const [label, valueText] of entries) {
          const dt = document.createElement("dt");
          dt.textContent = label;
          const dd = document.createElement("dd");
          dd.textContent = valueText;
          USAGE_TOOLTIP_GRID_EL.appendChild(dt);
          USAGE_TOOLTIP_GRID_EL.appendChild(dd);
        }
      }

      function positionUsageTooltip(clientX, clientY) {
        const padding = 16;
        const rect = USAGE_TOOLTIP_EL.getBoundingClientRect();
        let left = clientX + 14;
        let top = clientY + 18;
        if (left + rect.width > window.innerWidth - padding) {
          left = clientX - rect.width - 14;
        }
        if (top + rect.height > window.innerHeight - padding) {
          top = window.innerHeight - rect.height - padding;
        }
        if (left < padding) left = padding;
        if (top < padding) top = padding;
        USAGE_TOOLTIP_EL.style.left = left + "px";
        USAGE_TOOLTIP_EL.style.top = top + "px";
      }

      function showUsageTooltip(day, clientX, clientY) {
        updateUsageTooltipContent(day);
        USAGE_TOOLTIP_EL.classList.add("visible");
        USAGE_TOOLTIP_EL.setAttribute("aria-hidden", "false");
        positionUsageTooltip(clientX, clientY);
      }

      function hideUsageTooltip() {
        USAGE_TOOLTIP_EL.classList.remove("visible");
        USAGE_TOOLTIP_EL.setAttribute("aria-hidden", "true");
      }

      function toUsageDay(date) {
        return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
      }

      function buildUsageCalendarCells() {
        const start = parseUsageDay(USAGE_DATA.start);
        const leading = start.getDay();
        const cells = [];
        for (let index = 0; index < leading; index += 1) {
          const date = new Date(start);
          date.setDate(start.getDate() - leading + index);
          cells.push({ day: toUsageDay(date), emptyPadding: true });
        }
        for (const day of USAGE_DATA.days) {
          cells.push(day);
        }
        while (cells.length % 7 !== 0) {
          const last = parseUsageDay(cells[cells.length - 1].day);
          last.setDate(last.getDate() + 1);
          cells.push({ day: toUsageDay(last), emptyPadding: true });
        }
        return cells.map((cell, index) => ({ ...cell, week: Math.floor(index / 7), weekday: index % 7 }));
      }

      function renderUsageHeatmap() {
        const cells = buildUsageCalendarCells();
        const thresholds = getUsageThresholds(USAGE_DATA.days.map(getUsageMetricValue));
        const weekCount = Math.ceil(cells.length / 7);
        USAGE_HEATMAP_EL.textContent = "";
        USAGE_HEATMAP_EL.style.gridTemplateColumns = "repeat(" + weekCount + ", 13px)";
        USAGE_MONTHS_EL.style.gridTemplateColumns = "repeat(" + weekCount + ", 13px)";
        renderUsageMonths(cells);

        for (const day of cells) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "usage-cell";
          button.dataset.level = day.emptyPadding ? "0" : String(getUsageLevel(getUsageMetricValue(day), thresholds));
          button.setAttribute("aria-label", day.day);
          if (day.emptyPadding) {
            button.disabled = true;
          } else {
            button.addEventListener("pointerenter", (event) => showUsageTooltip(day, event.clientX, event.clientY));
            button.addEventListener("pointermove", (event) => positionUsageTooltip(event.clientX, event.clientY));
            button.addEventListener("pointerleave", hideUsageTooltip);
            button.addEventListener("focus", () => showUsageTooltip(day, window.innerWidth / 2, 88));
            button.addEventListener("blur", hideUsageTooltip);
          }
          USAGE_HEATMAP_EL.appendChild(button);
        }
      }

      function updateUsageQuery(next) {
        const url = new URL(window.location.href);
        Object.entries(next).forEach(([key, value]) => {
          if (value == null || value === "") url.searchParams.delete(key);
          else url.searchParams.set(key, String(value));
        });
        window.location.href = url.toString();
      }

      USAGE_RANGE_EL.addEventListener("change", () => {
        const range = USAGE_RANGE_EL.value;
        updateUsageQuery({ range, year: range === "year" ? USAGE_DATA.selectedYear || new Date().getFullYear() : null });
      });

      USAGE_METRIC_EL.addEventListener("change", () => {
        currentUsageMetric = USAGE_METRIC_EL.value;
        renderUsageHeatmap();
      });

      USAGE_MODEL_EL.addEventListener("change", () => {
        updateUsageQuery({ model: USAGE_MODEL_EL.value || null });
      });

      currentUsageMetric = USAGE_METRIC_EL.value;
      renderUsageSummary();
      renderUsageHeatmap();
`;

export function UsageSection({ payload }: { payload: UsagePagePayload }) {
  const basePath = payload.basePath ?? "/status";
  return (
    <div class="usage-scope">
      <div class="usage-layout">
        <section class="usage-panel">
          <div class="usage-header">
            <div>
              <h1 class="usage-title">Usage in selected time range</h1>
              <p class="usage-note">Persistent usage history requires --storage sqlite; memory mode only shows data from the current process.</p>
              <div class="usage-summary" id="usage-summary" aria-label="usage summary"></div>
            </div>
            <div class="usage-controls">
              <select class="usage-select" id="usage-range" aria-label="Time range">
                <option value="30d" selected={payload.selectedRange === "30d"}>Last 30 days</option>
                <option value="7d" selected={payload.selectedRange === "7d"}>Last 7 days</option>
                <option value="year" selected={payload.selectedRange === "year"}>Selected year</option>
              </select>
              <select class="usage-select" id="usage-metric" aria-label="Metric">
                <option value="totalTokens">Tokens</option>
                <option value="totalRequests">Requests</option>
                <option value="outputTokens">Output</option>
              </select>
              <select class="usage-select" id="usage-model" aria-label="Model">
                <option value="">All models</option>
                {payload.models.map((model) => (
                  <option value={model} selected={payload.selectedModel === model}>{model}</option>
                ))}
              </select>
            </div>
          </div>
          <div class="usage-heatmap-wrap">
            <div class="usage-months" id="usage-months"></div>
            <div class="usage-grid-row">
              <div class="usage-weekdays" aria-hidden="true">
                <div class="usage-weekday dim">Sun</div>
                <div class="usage-weekday">Mon</div>
                <div class="usage-weekday dim">Tue</div>
                <div class="usage-weekday">Wed</div>
                <div class="usage-weekday dim">Thu</div>
                <div class="usage-weekday">Fri</div>
                <div class="usage-weekday dim">Sat</div>
              </div>
              <div class="usage-heatmap" id="usage-heatmap"></div>
            </div>
            <div class="usage-legend" aria-hidden="true">
              <span>Less</span>
              <span class="usage-cell"></span>
              <span class="usage-cell" data-level="1"></span>
              <span class="usage-cell" data-level="2"></span>
              <span class="usage-cell" data-level="3"></span>
              <span class="usage-cell" data-level="4"></span>
              <span>More</span>
            </div>
          </div>
        </section>
        <nav class="usage-years" aria-label="Years">
          {payload.availableYears.map((year) => (
            <a
              class={`usage-year-link${payload.selectedRange === "year" && year === payload.selectedYear ? " active" : ""}`}
              href={`${basePath}?range=year&year=${year}${payload.selectedModel ? `&model=${encodeURIComponent(payload.selectedModel)}` : ""}`}
            >
              {year}
            </a>
          ))}
        </nav>
      </div>
      <aside class="usage-tooltip" id="usage-tooltip" aria-hidden="true">
        <p class="usage-tooltip-title" id="usage-tooltip-title"></p>
        <dl class="usage-tooltip-grid" id="usage-tooltip-grid"></dl>
      </aside>
    </div>
  );
}
