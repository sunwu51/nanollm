function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function renderRecordPage(summary: {
  enabled: boolean;
  capturedCount: number;
  limit: number;
  sessionStartedAt?: number;
  recentKeys?: Array<{ key: string; requestId: string; path: string; createdAt: number }>;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>nanollm record</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f2efe7;
        --panel: rgba(255, 252, 247, 0.95);
        --border: #d8cfc1;
        --text: #2f271d;
        --muted: #736553;
        --accent: #8c5a2f;
        --accent-soft: rgba(140, 90, 47, 0.12);
        --shadow: 0 18px 46px rgba(58, 43, 24, 0.12);
        --danger: #be4a38;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top right, rgba(140, 90, 47, 0.12), transparent 24%),
          linear-gradient(180deg, #f7f4ec 0%, var(--bg) 100%);
      }
      .page {
        max-width: 1180px;
        margin: 0 auto;
        padding: 24px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 20px;
        box-shadow: var(--shadow);
      }
      h1, h2, h3 {
        margin: 0;
      }
      h1 {
        font-size: 30px;
      }
      h2 {
        font-size: 18px;
        margin-bottom: 12px;
      }
      h3 {
        font-size: 15px;
        margin-bottom: 10px;
      }
      .meta {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 14px;
      }
      .toolbar {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        align-items: end;
        margin-top: 18px;
      }
      label {
        display: block;
        margin-bottom: 6px;
        font-size: 13px;
        color: var(--muted);
      }
      input {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px 14px;
        font: inherit;
        background: #fffdf9;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 12px;
        padding: 12px 16px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        background: var(--accent);
        color: #fffaf3;
      }
      button.secondary {
        background: transparent;
        color: var(--accent);
        border: 1px solid rgba(140, 90, 47, 0.28);
      }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .summary {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 14px;
      }
      .pill {
        padding: 8px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
      }
      .danger {
        color: var(--danger);
      }
      .content {
        margin-top: 20px;
        display: grid;
        gap: 14px;
      }
      .recent {
        margin-top: 12px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .recent-key {
        appearance: none;
        border: 1px solid rgba(140, 90, 47, 0.18);
        background: #fffaf2;
        color: var(--accent);
        padding: 8px 10px;
        border-radius: 10px;
        font: inherit;
        cursor: pointer;
        text-align: left;
      }
      .recent-key small {
        display: block;
        color: var(--muted);
        font-size: 11px;
        margin-top: 3px;
      }
      .section {
        border: 1px solid rgba(216, 207, 193, 0.82);
        border-radius: 16px;
        padding: 16px;
        background: rgba(255, 255, 255, 0.58);
      }
      .kv {
        display: grid;
        grid-template-columns: 180px 1fr;
        gap: 8px 12px;
        font-size: 14px;
      }
      .kv dt {
        color: var(--muted);
      }
      .kv dd {
        margin: 0;
        word-break: break-word;
      }
      .stack {
        display: grid;
        gap: 12px;
      }
      .attempt {
        border: 1px solid rgba(140, 90, 47, 0.16);
        border-radius: 14px;
        padding: 14px;
        background: rgba(255, 251, 245, 0.78);
      }
      .subgrid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .box {
        border: 1px solid rgba(216, 207, 193, 0.82);
        border-radius: 12px;
        padding: 12px;
        background: #fffdfa;
        min-width: 0;
      }
      .json-tree details {
        margin-left: 14px;
      }
      .json-tree summary {
        cursor: pointer;
        color: var(--accent);
      }
      .json-tree .entry {
        margin: 4px 0;
        line-height: 1.5;
        word-break: break-word;
      }
      .json-tree .key {
        color: #8a4f1d;
      }
      .json-tree .string {
        color: #0b6f51;
      }
      .json-tree .number {
        color: #2f5cb8;
      }
      .json-tree .boolean,
      .json-tree .null {
        color: #8c3d8c;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
        font-size: 12px;
        line-height: 1.45;
      }
      .empty {
        color: var(--muted);
        font-style: italic;
      }
      @media (max-width: 840px) {
        .toolbar {
          grid-template-columns: 1fr;
        }
        .subgrid {
          grid-template-columns: 1fr;
        }
        .kv {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="panel">
        <h1>Request Record</h1>
        <p class="meta">输入完整 requestId 或前 6 位，页面会调用查询接口并展示本轮采样缓存里的请求详情。</p>
        <div class="toolbar">
          <div>
            <label for="request-id">requestId</label>
            <input id="request-id" name="requestId" placeholder="例如 6dfae2a6-888c-4b1d-942f-9c56143f61bb 或 6dfae2" />
          </div>
          <div class="actions">
            <button id="query-button" type="button">查询</button>
            <button id="start-button" class="secondary" type="button">开始采样</button>
            <button id="stop-button" class="secondary" type="button">停止采样</button>
          </div>
        </div>
        <div class="summary" id="summary"></div>
        <div class="recent" id="recent"></div>
        <div class="content" id="content">
          <section class="section empty">还没有加载记录。</section>
        </div>
      </section>
    </main>
    <script>
      const INITIAL_SUMMARY = ${serializeForScript(summary)};
      const summaryEl = document.getElementById("summary");
      const recentEl = document.getElementById("recent");
      const contentEl = document.getElementById("content");
      const requestIdInput = document.getElementById("request-id");

      function normalizeRequestIdInput(value) {
        return value
          .trim()
          .replace(/^.*requestId=/i, "")
          .replace(/^[\\[\\("'\s]+/, "")
          .replace(/[\\]\\)"'\s,]+$/, "");
      }

      function setSummary(summary) {
        summaryEl.textContent = "";
        const items = [
          ["采样状态", summary.enabled ? "开启" : "关闭"],
          ["已采样", String(summary.capturedCount)],
          ["上限", String(summary.limit)],
          ["开始时间", summary.sessionStartedAt ? new Date(summary.sessionStartedAt).toLocaleString("zh-CN") : "-"],
        ];
        for (const [label, value] of items) {
          const pill = document.createElement("div");
          pill.className = "pill";
          pill.textContent = label + "：" + value;
          summaryEl.appendChild(pill);
        }

        recentEl.textContent = "";
        if (!summary.recentKeys || summary.recentKeys.length === 0) {
          return;
        }
        summary.recentKeys.forEach((item) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "recent-key";
          button.innerHTML =
            item.key +
            "<small>" +
            item.path +
            " · " +
            new Date(item.createdAt).toLocaleTimeString("zh-CN") +
            "</small>";
          button.addEventListener("click", () => {
            requestIdInput.value = item.requestId;
            queryRecord().catch((error) => renderError(error instanceof Error ? error.message : "查询失败"));
          });
          recentEl.appendChild(button);
        });
      }

      function createSection(title) {
        const section = document.createElement("section");
        section.className = "section";
        const heading = document.createElement("h2");
        heading.textContent = title;
        section.appendChild(heading);
        return section;
      }

      function appendKV(section, pairs) {
        const dl = document.createElement("dl");
        dl.className = "kv";
        for (const [key, value] of pairs) {
          const dt = document.createElement("dt");
          dt.textContent = key;
          const dd = document.createElement("dd");
          dd.textContent = value == null || value === "" ? "-" : String(value);
          dl.appendChild(dt);
          dl.appendChild(dd);
        }
        section.appendChild(dl);
      }

      function createValueNode(value, depth = 0) {
        if (value === null) {
          const span = document.createElement("span");
          span.className = "null";
          span.textContent = "null";
          return span;
        }

        if (Array.isArray(value)) {
          const details = document.createElement("details");
          details.open = depth < 1;
          const summary = document.createElement("summary");
          summary.textContent = "Array(" + value.length + ")";
          details.appendChild(summary);
          const body = document.createElement("div");
          value.forEach((item, index) => {
            const entry = document.createElement("div");
            entry.className = "entry";
            const key = document.createElement("span");
            key.className = "key";
            key.textContent = index + ": ";
            entry.appendChild(key);
            entry.appendChild(createValueNode(item, depth + 1));
            body.appendChild(entry);
          });
          details.appendChild(body);
          return details;
        }

        if (typeof value === "object") {
          const entries = Object.entries(value);
          const details = document.createElement("details");
          details.open = depth < 1;
          const summary = document.createElement("summary");
          summary.textContent = "Object{" + entries.length + "}";
          details.appendChild(summary);
          const body = document.createElement("div");
          for (const [keyName, childValue] of entries) {
            const entry = document.createElement("div");
            entry.className = "entry";
            const key = document.createElement("span");
            key.className = "key";
            key.textContent = keyName + ": ";
            entry.appendChild(key);
            entry.appendChild(createValueNode(childValue, depth + 1));
            body.appendChild(entry);
          }
          details.appendChild(body);
          return details;
        }

        const span = document.createElement("span");
        if (typeof value === "string") {
          span.className = "string";
          span.textContent = JSON.stringify(value);
          return span;
        }
        if (typeof value === "number") {
          span.className = "number";
          span.textContent = String(value);
          return span;
        }
        if (typeof value === "boolean") {
          span.className = "boolean";
          span.textContent = String(value);
          return span;
        }
        span.textContent = String(value);
        return span;
      }

      function appendBodyBox(parent, title, value) {
        const box = document.createElement("div");
        box.className = "box";
        const heading = document.createElement("h3");
        heading.textContent = title;
        box.appendChild(heading);
        if (value == null || value === "") {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "无内容";
          box.appendChild(empty);
        } else if (typeof value === "string") {
          const pre = document.createElement("pre");
          pre.textContent = value;
          box.appendChild(pre);
        } else {
          const tree = document.createElement("div");
          tree.className = "json-tree";
          tree.appendChild(createValueNode(value));
          box.appendChild(tree);
        }
        parent.appendChild(box);
      }

      function renderRecord(record) {
        contentEl.textContent = "";

        const baseSection = createSection("基本信息");
        appendKV(baseSection, [
          ["requestId", record.requestId],
          ["key", record.key],
          ["path", record.clientRequest?.path],
          ["stream", record.stream],
          ["createdAt", record.createdAt ? new Date(record.createdAt).toLocaleString("zh-CN") : "-"],
          ["error", record.error?.message ?? ""],
        ]);
        contentEl.appendChild(baseSection);

        const requestSection = createSection("Client Request");
        const requestGrid = document.createElement("div");
        requestGrid.className = "subgrid";
        appendBodyBox(requestGrid, "Headers", record.clientRequest?.headers);
        appendBodyBox(requestGrid, "Body", record.clientRequest?.body);
        requestSection.appendChild(requestGrid);
        contentEl.appendChild(requestSection);

        const attemptsSection = createSection("Attempts");
        const attemptsStack = document.createElement("div");
        attemptsStack.className = "stack";
        if (!record.attempts?.length) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "没有记录到上游请求。";
          attemptsStack.appendChild(empty);
        } else {
          record.attempts.forEach((attempt) => {
            const card = document.createElement("div");
            card.className = "attempt";
            const title = document.createElement("h3");
            title.textContent = "#" + attempt.index + " " + attempt.modelName + " (" + attempt.provider + ")";
            card.appendChild(title);
            appendKV(card, [
              ["url", attempt.url],
              ["status", attempt.response?.status],
              ["error", attempt.error?.message ?? ""],
            ]);
            const grid = document.createElement("div");
            grid.className = "subgrid";
            appendBodyBox(grid, "Upstream Request Headers", attempt.request?.headers);
            appendBodyBox(grid, "Upstream Request Body", attempt.request?.body);
            appendBodyBox(grid, "Upstream Response Headers", attempt.response?.headers);
            appendBodyBox(grid, "Upstream Response Body", attempt.response?.body);
            if (attempt.error?.upstream !== undefined) {
              appendBodyBox(grid, "Upstream Error Body", attempt.error.upstream);
            }
            card.appendChild(grid);
            attemptsStack.appendChild(card);
          });
        }
        attemptsSection.appendChild(attemptsStack);
        contentEl.appendChild(attemptsSection);

        const responseSection = createSection("Client Response");
        appendKV(responseSection, [
          ["status", record.clientResponse?.status],
          ["truncated", record.clientResponse?.truncated ? "yes" : "no"],
        ]);
        const responseGrid = document.createElement("div");
        responseGrid.className = "subgrid";
        appendBodyBox(responseGrid, "Headers", record.clientResponse?.headers);
        appendBodyBox(responseGrid, "Body", record.clientResponse?.body);
        responseSection.appendChild(responseGrid);
        contentEl.appendChild(responseSection);
      }

      function renderError(message) {
        contentEl.textContent = "";
        const section = document.createElement("section");
        section.className = "section";
        const text = document.createElement("div");
        text.className = "danger";
        text.textContent = message;
        section.appendChild(text);
        contentEl.appendChild(section);
      }

      async function refreshSummary() {
        const response = await fetch("/record/summary", { cache: "no-store" });
        if (!response.ok) return;
        setSummary(await response.json());
      }

      async function queryRecord() {
        const requestId = normalizeRequestIdInput(requestIdInput.value);
        if (!requestId) {
          renderError("请先输入 requestId。");
          return;
        }
        requestIdInput.value = requestId;
        const response = await fetch("/record/" + encodeURIComponent(requestId), { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) {
          if (payload.summary) {
            setSummary(payload.summary);
          }
          renderError(payload.error || "查询失败");
          return;
        }
        if (payload.summary) {
          setSummary(payload.summary);
        }
        renderRecord(payload.record);
        history.replaceState(null, "", "/record?requestId=" + encodeURIComponent(requestId));
      }

      async function controlRecord(action) {
        const response = await fetch("/record/" + action, { method: "POST" });
        const payload = await response.json();
        setSummary(payload);
        if (action === "start") {
          contentEl.innerHTML = '<section class="section empty">新的采样会话已开始，等待请求进入。</section>';
        }
      }

      document.getElementById("query-button").addEventListener("click", () => {
        queryRecord().catch((error) => renderError(error instanceof Error ? error.message : "查询失败"));
      });
      document.getElementById("start-button").addEventListener("click", () => {
        controlRecord("start").catch((error) => renderError(error instanceof Error ? error.message : "开始采样失败"));
      });
      document.getElementById("stop-button").addEventListener("click", () => {
        controlRecord("stop").catch((error) => renderError(error instanceof Error ? error.message : "停止采样失败"));
      });

      setSummary(INITIAL_SUMMARY);

      const params = new URLSearchParams(window.location.search);
      const preset = params.get("requestId");
      if (preset) {
        requestIdInput.value = preset;
        queryRecord().catch((error) => renderError(error instanceof Error ? error.message : "查询失败"));
      }
    </script>
  </body>
</html>`;
}
