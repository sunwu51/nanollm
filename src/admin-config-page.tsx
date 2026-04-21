import { renderToString } from "hono/jsx/dom/server";
function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

const STYLE = /* css */ String.raw`
      :root {
        color-scheme: light;
        --bg: #f1ede4;
        --panel: rgba(255, 252, 247, 0.95);
        --border: #d7cdbc;
        --text: #2f271d;
        --muted: #726451;
        --accent: #8f5b33;
        --accent-soft: rgba(143, 91, 51, 0.12);
        --accent-strong: #6f4728;
        --success: #2b9360;
        --success-soft: rgba(43, 147, 96, 0.12);
        --warning: #c67a24;
        --warning-soft: rgba(198, 122, 36, 0.12);
        --danger: #bf4c3b;
        --danger-soft: rgba(191, 76, 59, 0.12);
        --shadow: 0 18px 44px rgba(67, 48, 23, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(143, 91, 51, 0.12), transparent 24%),
          linear-gradient(180deg, #f8f4ec 0%, var(--bg) 100%);
      }
      .page {
        max-width: 1240px;
        margin: 0 auto;
        padding: 24px;
      }
      .stack {
        display: grid;
        gap: 16px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 22px;
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
        font-size: 20px;
        margin-bottom: 14px;
      }
      h3 {
        font-size: 16px;
      }
      .meta {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.55;
      }
      .toolbar {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 12px;
        padding: 11px 16px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        background: var(--accent);
        color: #fff9f1;
      }
      button:hover {
        background: var(--accent-strong);
      }
      button.secondary {
        background: transparent;
        color: var(--accent);
        border: 1px solid rgba(143, 91, 51, 0.24);
      }
      button.secondary:hover {
        color: var(--accent-strong);
        border-color: rgba(143, 91, 51, 0.42);
      }
      button.ghost {
        background: rgba(84, 67, 47, 0.05);
        color: var(--muted);
      }
      button.ghost:hover {
        background: rgba(84, 67, 47, 0.1);
        color: var(--text);
      }
      button.danger {
        background: transparent;
        color: var(--danger);
        border: 1px solid rgba(191, 76, 59, 0.24);
      }
      button:disabled {
        opacity: 0.6;
        cursor: wait;
      }
      .status-row {
        display: grid;
        gap: 12px;
      }
      .pills {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .pill {
        padding: 8px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
      }
      .pill.neutral {
        background: var(--accent-soft);
        color: var(--accent);
      }
      .pill.success {
        background: var(--success-soft);
        color: var(--success);
      }
      .pill.warning {
        background: var(--warning-soft);
        color: var(--warning);
      }
      .pill.error {
        background: var(--danger-soft);
        color: var(--danger);
      }
      .status {
        min-height: 22px;
        font-size: 13px;
        color: var(--muted);
      }
      .status.success { color: var(--success); }
      .status.warn { color: var(--warning); }
      .status.error { color: var(--danger); }
      .note-box,
      .error-box {
        border-radius: 16px;
        padding: 14px 16px;
        font-size: 13px;
        line-height: 1.6;
      }
      .note-box {
        background: rgba(84, 67, 47, 0.05);
        color: var(--muted);
      }
      .error-box {
        background: var(--danger-soft);
        color: var(--danger);
      }
      .quick-links {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .quick-link {
        display: grid;
        gap: 6px;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid rgba(143, 91, 51, 0.16);
        background: rgba(255, 251, 244, 0.88);
        color: inherit;
        text-decoration: none;
        transition: transform 140ms ease, border-color 140ms ease, background-color 140ms ease;
      }
      .quick-link:hover {
        transform: translateY(-1px);
        border-color: rgba(143, 91, 51, 0.32);
        background: rgba(255, 248, 239, 0.96);
      }
      .quick-link-title {
        font-size: 14px;
        font-weight: 700;
        color: var(--accent-strong);
      }
      .quick-link-desc {
        font-size: 13px;
        line-height: 1.5;
        color: var(--muted);
      }
      .field-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
      }
      .field-grid.two {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .field {
        display: grid;
        gap: 6px;
      }
      .field.span-2 {
        grid-column: span 2;
      }
      .field.span-3 {
        grid-column: span 3;
      }
      label {
        font-size: 13px;
        font-weight: 600;
        color: var(--muted);
      }
      input,
      select,
      textarea {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 11px 12px;
        font: inherit;
        background: #fffdf9;
        color: var(--text);
      }
      input[type="number"] {
        appearance: textfield;
      }
      .helper {
        font-size: 12px;
        color: var(--muted);
        line-height: 1.5;
      }
      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 14px;
        flex-wrap: wrap;
      }
      .card-list {
        display: grid;
        gap: 14px;
      }
      .card {
        border: 1px solid rgba(143, 91, 51, 0.18);
        background: rgba(255, 251, 244, 0.88);
        border-radius: 18px;
        padding: 16px;
        display: grid;
        gap: 14px;
      }
      .card.compact {
        gap: 10px;
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .card-title {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .card-toggle {
        display: grid;
        gap: 6px;
        min-width: 280px;
        flex: 1;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        text-align: left;
      }
      .card-toggle:hover {
        background: transparent;
      }
      .card-toggle-top {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .card-chevron {
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: rgba(143, 91, 51, 0.1);
        color: var(--accent);
        font-size: 14px;
        flex: 0 0 auto;
      }
      .card-summary {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }
      .card-body[hidden] {
        display: none;
      }
      .member-list {
        display: grid;
        gap: 10px;
      }
      .member-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        padding: 8px 10px;
        border-radius: 14px;
        border: 1px solid rgba(143, 91, 51, 0.12);
        background: rgba(255, 253, 249, 0.8);
      }
      .member-row.drag-over {
        border-color: rgba(143, 91, 51, 0.4);
        background: rgba(143, 91, 51, 0.08);
      }
      .drag-handle {
        width: 38px;
        min-width: 38px;
        padding: 8px 0;
        border-radius: 10px;
        background: rgba(143, 91, 51, 0.08);
        color: var(--accent);
        cursor: grab;
      }
      .drag-handle:active {
        cursor: grabbing;
      }
      .member-actions {
        display: inline-flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      code {
        font-family: "Consolas", "SFMono-Regular", "Menlo", monospace;
        font-size: 12px;
      }
      @media (max-width: 960px) {
        .quick-links,
        .field-grid,
        .field-grid.two {
          grid-template-columns: 1fr;
        }
        .field.span-2,
        .field.span-3 {
          grid-column: span 1;
        }
      }
`;

const SCRIPT = /* js */ String.raw`
      const INITIAL_PAYLOAD = __INITIAL_PAYLOAD__;
      const PROVIDERS = ["openai-chat", "openai-responses", "anthropic"];
      let saving = false;
      let dirty = false;
      let localIdCounter = 0;
      let pendingFocusTarget = null;
      let draggedMember = null;

      function nextId(prefix) {
        localIdCounter += 1;
        return prefix + "-" + localIdCounter;
      }

      function clone(value) {
        return JSON.parse(JSON.stringify(value));
      }

      function hydrateForm(form) {
        return {
          rootExtras: form.rootExtras || {},
          serverExtras: form.serverExtras || {},
          recordExtras: form.recordExtras || {},
          server: {
            port: form.server?.port ?? "",
            ttfb_timeout: form.server?.ttfb_timeout ?? "",
          },
          record: {
            max_size: form.record?.max_size ?? "",
          },
          models: (form.models || []).map((model) => ({
            ...model,
            _id: nextId("model"),
            _expanded: false,
            extras: model.extras || {},
          })),
          fallbackGroups: (form.fallbackGroups || []).map((group) => ({
            ...group,
            _id: nextId("fallback"),
            members: (group.members || []).map((member) => ({
              _id: nextId("member"),
              value: member,
            })),
          })),
        };
      }

      let currentSnapshot = INITIAL_PAYLOAD;
      let formState = hydrateForm(INITIAL_PAYLOAD.form);

      const statusEl = document.getElementById("save-status");
      const saveButton = document.getElementById("save-button");
      const refreshButton = document.getElementById("refresh-button");
      const resetButton = document.getElementById("reset-button");
      const pillsEl = document.getElementById("summary-pills");
      const errorBoxEl = document.getElementById("error-box");
      const errorTextEl = document.getElementById("error-text");
      const modelsContainer = document.getElementById("models-container");
      const fallbackContainer = document.getElementById("fallback-container");
      const globalFieldsEl = document.getElementById("global-fields");
      const snapshotMetaEl = document.getElementById("snapshot-meta");

      function setStatus(kind, text) {
        statusEl.className = "status" + (kind ? " " + kind : "");
        statusEl.textContent = text || "";
      }

      function focusPendingTarget() {
        if (!pendingFocusTarget) return;
        const target = document.querySelector("[data-focus-id=\"" + pendingFocusTarget + "\"]");
        if (!target) return;
        pendingFocusTarget = null;
        requestAnimationFrame(() => {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.focus({ preventScroll: true });
        });
      }

      function setSaving(nextSaving) {
        saving = nextSaving;
        saveButton.disabled = nextSaving;
        refreshButton.disabled = nextSaving;
        resetButton.disabled = nextSaving;
      }

      function markDirty(nextDirty) {
        dirty = nextDirty;
      }

      function moveArrayItem(items, fromIndex, toIndex) {
        if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length || fromIndex === toIndex) {
          return;
        }
        const [item] = items.splice(fromIndex, 1);
        items.splice(toIndex, 0, item);
      }

      function dehydrateForm() {
        return {
          rootExtras: formState.rootExtras || {},
          serverExtras: formState.serverExtras || {},
          recordExtras: formState.recordExtras || {},
          server: { ...formState.server },
          record: { ...formState.record },
          models: formState.models.map(({ _id, _expanded, ...model }) => ({
            ...model,
            extras: model.extras || {},
          })),
          fallbackGroups: formState.fallbackGroups.map(({ _id, members, ...group }) => ({
            ...group,
            members: members.map((member) => member.value),
          })),
        };
      }

      function getModelNameOptions() {
        return formState.models
          .map((model) => (model.name || "").trim())
          .filter(Boolean);
      }

      function getDuplicateMembers(group) {
        const counts = new Map();
        for (const member of group.members) {
          const value = (member.value || "").trim();
          if (!value) continue;
          counts.set(value, (counts.get(value) || 0) + 1);
        }
        return Array.from(counts.entries())
          .filter(([, count]) => count > 1)
          .map(([value]) => value);
      }

      function renderSnapshotMeta() {
        snapshotMetaEl.textContent =
          "version " + currentSnapshot.version +
          " · config " + currentSnapshot.configPath +
          " · 当前运行 port " + currentSnapshot.effectiveConfig.port;

        pillsEl.textContent = "";
        const pills = [
          { label: "models " + formState.models.length, kind: "success" },
          { label: "fallback groups " + formState.fallbackGroups.length, kind: "neutral" },
          { label: "port 修改需重启", kind: "warning" },
        ];
        if (currentSnapshot.lastError) {
          pills.push({ label: "最近一次加载失败", kind: "error" });
        }
        for (const pill of pills) {
          const el = document.createElement("div");
          el.className = "pill " + pill.kind;
          el.textContent = pill.label;
          pillsEl.appendChild(el);
        }

        if (currentSnapshot.lastError) {
          errorBoxEl.hidden = false;
          errorTextEl.textContent = currentSnapshot.lastError.message + " (" + currentSnapshot.lastError.source + ")";
        } else {
          errorBoxEl.hidden = true;
          errorTextEl.textContent = "";
        }
      }

      function bindField(container, labelText, options) {
        const field = document.createElement("div");
        field.className = "field" + (options.spanClass ? " " + options.spanClass : "");
        const label = document.createElement("label");
        label.textContent = labelText;
        let control;
        if (options.type === "select") {
          control = document.createElement("select");
          for (const value of options.options) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            control.appendChild(option);
          }
          control.value = options.value ?? "";
        } else {
          control = document.createElement("input");
          control.type = options.type || "text";
          control.value = options.value ?? "";
          if (options.placeholder) control.placeholder = options.placeholder;
          if (options.min) control.min = options.min;
          if (options.step) control.step = options.step;
        }
        if (options.attributes) {
          for (const [key, value] of Object.entries(options.attributes)) {
            if (value !== undefined && value !== null) {
              control.setAttribute(key, String(value));
            }
          }
        }
        control.addEventListener("input", (event) => {
          options.onInput(event.target.value);
        });
        if (options.type === "select") {
          control.addEventListener("change", (event) => {
            options.onInput(event.target.value);
          });
        }
        field.appendChild(label);
        field.appendChild(control);
        if (options.helper) {
          const helper = document.createElement("div");
          helper.className = "helper";
          helper.textContent = options.helper;
          field.appendChild(helper);
        }
        container.appendChild(field);
      }

      function renderGlobalFields() {
        globalFieldsEl.textContent = "";
        bindField(globalFieldsEl, "server.ttfb_timeout", {
          type: "number",
          min: "1",
          step: "1",
          value: formState.server.ttfb_timeout,
          helper: "正整数，单位毫秒。保存后新请求立即生效。",
          onInput(value) {
            formState.server.ttfb_timeout = value;
            markDirty(true);
          },
        });
        bindField(globalFieldsEl, "record.max_size", {
          type: "number",
          min: "1",
          step: "1",
          value: formState.record.max_size,
          helper: "正整数。保存后会在线调整采样记录上限。",
          onInput(value) {
            formState.record.max_size = value;
            markDirty(true);
          },
        });
      }

      function createActionButton(label, className, onClick) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.className = className;
        button.addEventListener("click", onClick);
        return button;
      }

      function formatExtrasDetail(extras) {
        const entries = Object.entries(extras || {});
        if (entries.length === 0) return "";
        return entries
          .map(([key, value]) => key + ": " + (typeof value === "string" ? value : JSON.stringify(value)))
          .join("\n");
      }

      function buildModelSummary(model) {
        const provider = model.provider || "未选供应商";
        const upstreamModel = model.model || "未填上游模型名";
        const baseUrl = model.base_url || "未填 base_url";
        return provider + " · " + upstreamModel + " · " + baseUrl;
      }

      function renderModels() {
        modelsContainer.textContent = "";
        if (formState.models.length === 0) {
          const empty = document.createElement("div");
          empty.className = "note-box";
          empty.textContent = "还没有模型，点击“添加模型”开始配置。";
          modelsContainer.appendChild(empty);
          return;
        }

        formState.models.forEach((model, index) => {
          const card = document.createElement("section");
          card.className = "card" + (model._expanded ? "" : " compact");

          const head = document.createElement("div");
          head.className = "card-head";
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "card-toggle";
          toggle.addEventListener("click", () => {
            model._expanded = !model._expanded;
            renderAll();
          });

          const toggleTop = document.createElement("div");
          toggleTop.className = "card-toggle-top";
          const chevron = document.createElement("span");
          chevron.className = "card-chevron";
          chevron.textContent = model._expanded ? "▾" : "▸";
          toggleTop.appendChild(chevron);

          const title = document.createElement("div");
          title.className = "card-title";
          const h3 = document.createElement("h3");
          h3.textContent = model.name?.trim() || "未命名模型 " + (index + 1);
          title.appendChild(h3);
          if (model.extras && Object.keys(model.extras).length > 0) {
            const badge = document.createElement("div");
            badge.className = "pill neutral";
            badge.textContent = "保留高级字段";
            badge.title = formatExtrasDetail(model.extras);
            title.appendChild(badge);
          }
          toggleTop.appendChild(title);
          toggle.appendChild(toggleTop);

          const summary = document.createElement("div");
          summary.className = "card-summary";
          summary.textContent = buildModelSummary(model);
          toggle.appendChild(summary);

          head.appendChild(toggle);
          head.appendChild(
            createActionButton("删除模型", "danger", () => {
              formState.models = formState.models.filter((item) => item._id !== model._id);
              formState.fallbackGroups.forEach((group) => {
                group.members = group.members.filter((member) => member.value !== model.name);
              });
              markDirty(true);
              renderAll();
            }),
          );
          card.appendChild(head);

          const body = document.createElement("div");
          body.className = "card-body";
          body.hidden = !model._expanded;

          const grid = document.createElement("div");
          grid.className = "field-grid two";
          bindField(grid, "name", {
            value: model.name,
            attributes: { "data-focus-id": "model-name-" + model._id },
            onInput(value) {
              const previousName = model.name;
              model.name = value;
              if (previousName !== value) {
                formState.fallbackGroups.forEach((group) => {
                  group.members.forEach((member) => {
                    if (member.value === previousName) member.value = value;
                  });
                });
              }
              markDirty(true);
              pendingFocusTarget = "model-name-" + model._id;
              renderAll();
            },
          });
          bindField(grid, "provider", {
            type: "select",
            options: PROVIDERS,
            value: model.provider || PROVIDERS[0],
            onInput(value) {
              model.provider = value;
              markDirty(true);
            },
          });
          bindField(grid, "base_url", {
            value: model.base_url,
            placeholder: "https://example.com/v1",
            onInput(value) {
              model.base_url = value;
              markDirty(true);
            },
          });
          bindField(grid, "model", {
            value: model.model,
            placeholder: "上游真实模型名",
            onInput(value) {
              model.model = value;
              markDirty(true);
            },
          });
          bindField(grid, "api_key", {
            spanClass: "span-2",
            value: model.api_key,
            placeholder: "支持直接填 key 或 \${ENV_VAR}",
            onInput(value) {
              model.api_key = value;
              markDirty(true);
            },
          });
          body.appendChild(grid);

          if (model.extras && Object.keys(model.extras).length > 0) {
            const helper = document.createElement("div");
            helper.className = "helper";
            helper.textContent = "这个模型还有未在表单中展开的高级字段，保存时会自动保留。";
            body.appendChild(helper);
          }

          card.appendChild(body);

          modelsContainer.appendChild(card);
        });
      }

      function renderFallbackGroups() {
        fallbackContainer.textContent = "";
        if (formState.fallbackGroups.length === 0) {
          const empty = document.createElement("div");
          empty.className = "note-box";
          empty.textContent = "还没有 fallback 分组，点击“添加分组”后可以为分组选择模型列表。";
          fallbackContainer.appendChild(empty);
          return;
        }

        const options = getModelNameOptions();

        formState.fallbackGroups.forEach((group, index) => {
          const card = document.createElement("section");
          card.className = "card";
          const duplicateMembers = getDuplicateMembers(group);

          const head = document.createElement("div");
          head.className = "card-head";
          const title = document.createElement("div");
          title.className = "card-title";
          const h3 = document.createElement("h3");
          h3.textContent = group.name?.trim() || "未命名分组 " + (index + 1);
          title.appendChild(h3);
          head.appendChild(title);
          head.appendChild(
            createActionButton("删除分组", "danger", () => {
              formState.fallbackGroups = formState.fallbackGroups.filter((item) => item._id !== group._id);
              markDirty(true);
              renderAll();
            }),
          );
          card.appendChild(head);

          const grid = document.createElement("div");
          grid.className = "field-grid";
          bindField(grid, "group name", {
            spanClass: "span-3",
            value: group.name,
            attributes: { "data-focus-id": "fallback-name-" + group._id },
            placeholder: "例如 gpt-5.4",
            onInput(value) {
              group.name = value;
              markDirty(true);
              pendingFocusTarget = "fallback-name-" + group._id;
              renderAll();
            },
          });
          card.appendChild(grid);

          const membersWrap = document.createElement("div");
          membersWrap.className = "member-list";
          if (duplicateMembers.length > 0) {
            const helper = document.createElement("div");
            helper.className = "error-box";
            helper.textContent = "当前分组存在重复模型名：" + duplicateMembers.join(", ") + "。保存时会被拦截。";
            membersWrap.appendChild(helper);
          }
          if (group.members.length === 0) {
            const helper = document.createElement("div");
            helper.className = "helper";
            helper.textContent = "当前分组还没有成员。";
            membersWrap.appendChild(helper);
          }

          group.members.forEach((member, memberIndex) => {
            const row = document.createElement("div");
            row.className = "member-row";
            row.draggable = true;
            row.addEventListener("dragstart", (event) => {
              draggedMember = { groupId: group._id, memberId: member._id };
              row.classList.add("dragging");
              if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", member._id);
              }
            });
            row.addEventListener("dragend", () => {
              draggedMember = null;
              row.classList.remove("dragging");
              membersWrap.querySelectorAll(".member-row.drag-over").forEach((element) => {
                element.classList.remove("drag-over");
              });
            });
            row.addEventListener("dragover", (event) => {
              if (!draggedMember || draggedMember.groupId !== group._id || draggedMember.memberId === member._id) return;
              event.preventDefault();
              row.classList.add("drag-over");
            });
            row.addEventListener("dragleave", () => {
              row.classList.remove("drag-over");
            });
            row.addEventListener("drop", (event) => {
              if (!draggedMember || draggedMember.groupId !== group._id) return;
              event.preventDefault();
              row.classList.remove("drag-over");
              const fromIndex = group.members.findIndex((item) => item._id === draggedMember.memberId);
              const toIndex = group.members.findIndex((item) => item._id === member._id);
              if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
              moveArrayItem(group.members, fromIndex, toIndex);
              markDirty(true);
              renderAll();
            });

            const handle = createActionButton("⋮⋮", "ghost drag-handle", () => {});
            handle.title = "拖拽排序";
            handle.setAttribute("aria-label", "拖拽排序");
            row.appendChild(handle);

            const select = document.createElement("select");
            const blank = document.createElement("option");
            blank.value = "";
            blank.textContent = options.length === 0 ? "请先添加模型" : "选择模型";
            select.appendChild(blank);
            const selectedElsewhere = new Set(
              group.members
                .filter((item) => item._id !== member._id)
                .map((item) => item.value)
                .filter(Boolean),
            );
            for (const optionValue of options) {
              if (selectedElsewhere.has(optionValue) && optionValue !== member.value) continue;
              const option = document.createElement("option");
              option.value = optionValue;
              option.textContent = optionValue;
              select.appendChild(option);
            }
            select.value = member.value || "";
            select.setAttribute("data-focus-id", "fallback-member-" + member._id);
            select.addEventListener("change", (event) => {
              member.value = event.target.value;
              markDirty(true);
              pendingFocusTarget = "fallback-member-" + member._id;
              renderAll();
            });

            const actions = document.createElement("div");
            actions.className = "member-actions";
            actions.appendChild(
              createActionButton("上移", "ghost", () => {
                if (memberIndex === 0) return;
                moveArrayItem(group.members, memberIndex, memberIndex - 1);
                markDirty(true);
                pendingFocusTarget = "fallback-member-" + member._id;
                renderAll();
              }),
            );
            actions.appendChild(
              createActionButton("下移", "ghost", () => {
                if (memberIndex === group.members.length - 1) return;
                moveArrayItem(group.members, memberIndex, memberIndex + 1);
                markDirty(true);
                pendingFocusTarget = "fallback-member-" + member._id;
                renderAll();
              }),
            );
            actions.appendChild(createActionButton("删除", "ghost", () => {
              group.members = group.members.filter((item) => item._id !== member._id);
              markDirty(true);
              renderAll();
            }));

            row.appendChild(select);
            row.appendChild(actions);
            membersWrap.appendChild(row);
          });

          card.appendChild(membersWrap);

          card.appendChild(
            createActionButton("添加模型到分组", "secondary", () => {
              const memberId = nextId("member");
              const used = new Set(group.members.map((item) => item.value).filter(Boolean));
              const nextValue = options.find((option) => !used.has(option)) || "";
              group.members.push({ _id: memberId, value: nextValue });
              markDirty(true);
              pendingFocusTarget = "fallback-member-" + memberId;
              renderAll();
            }),
          );

          fallbackContainer.appendChild(card);
        });
      }

      function renderAll() {
        renderSnapshotMeta();
        renderGlobalFields();
        renderModels();
        renderFallbackGroups();
        focusPendingTarget();
      }

      async function refreshFromServer() {
        const response = await fetch("/admin/config/data", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "刷新配置失败");
        }
        currentSnapshot = payload;
        formState = hydrateForm(payload.form);
        markDirty(false);
        renderAll();
        return payload;
      }

      async function saveConfig() {
        setSaving(true);
        setStatus("warn", "正在保存并应用配置...");
        try {
          const response = await fetch("/admin/config/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              config: dehydrateForm(),
              baseVersion: currentSnapshot.version,
            }),
          });
          const payload = await response.json();
          if (!response.ok) {
            if (payload.currentSnapshot) {
              currentSnapshot = payload.currentSnapshot;
              if (response.status === 409) {
                formState = hydrateForm(payload.currentSnapshot.form);
              }
              renderAll();
            }
            if (response.status === 409) {
              setStatus("error", "保存失败：配置已被外部更新，请先刷新页面上的内容。");
              return;
            }
            setStatus("error", payload.error || "保存失败");
            return;
          }

          currentSnapshot = payload.snapshot;
          formState = hydrateForm(payload.snapshot.form);
          markDirty(false);
          renderAll();
          if (payload.requiresRestartFields.length > 0) {
            setStatus("warn", "保存成功。除 port 外的配置已立即生效；port 变更需要重启服务。");
          } else {
            setStatus("success", "保存成功，配置已立即生效。");
          }
        } catch (error) {
          setStatus("error", error instanceof Error ? error.message : "保存失败");
        } finally {
          setSaving(false);
        }
      }

      document.getElementById("add-model-button").addEventListener("click", () => {
        const id = nextId("model");
        formState.models.push({
          _id: id,
          _expanded: true,
          name: "",
          provider: "openai-chat",
          base_url: "",
          api_key: "",
          model: "",
          extras: {},
        });
        pendingFocusTarget = "model-name-" + id;
        markDirty(true);
        renderAll();
      });

      document.getElementById("add-fallback-button").addEventListener("click", () => {
        const id = nextId("fallback");
        formState.fallbackGroups.push({
          _id: id,
          name: "",
          members: [],
        });
        pendingFocusTarget = "fallback-name-" + id;
        markDirty(true);
        renderAll();
      });

      saveButton.addEventListener("click", () => {
        saveConfig().catch((error) => {
          setSaving(false);
          setStatus("error", error instanceof Error ? error.message : "保存失败");
        });
      });

      refreshButton.addEventListener("click", () => {
        refreshFromServer()
          .then(() => setStatus("success", "已从服务端刷新到最新配置。"))
          .catch((error) => setStatus("error", error instanceof Error ? error.message : "刷新失败"));
      });

      resetButton.addEventListener("click", () => {
        formState = hydrateForm(currentSnapshot.form);
        markDirty(false);
        renderAll();
        setStatus("", "已恢复到当前服务端配置。");
      });

      renderAll();
`;

function AdminConfigPage({ payload }: { payload: Record<string, unknown> }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>nanollm config admin</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        <main class="page">
          <div class="stack">
            <section class="panel">
              <div class="section-header">
                <div>
                  <h1>Config Admin</h1>
                  <p class="meta">通过表单编辑服务配置、模型和 fallback 分组。保存后会自动校验并写回 <code>config.yaml</code>。</p>
                </div>
                <div class="toolbar">
                  <button id="save-button" type="button">保存并应用</button>
                  <button id="refresh-button" class="secondary" type="button">从服务端刷新</button>
                  <button id="reset-button" class="ghost" type="button">撤销未保存修改</button>
                </div>
              </div>
              <div class="status-row">
                <div class="pills" id="summary-pills"></div>
                <div class="status" id="save-status"></div>
                <div class="note-box" id="snapshot-meta"></div>
                <div class="note-box">当前页面只展开常用字段。已有模型上的未展开高级字段会在保存时自动保留；API Key 输入框也支持 {"${ENV_VAR}"} 这种占位写法；当前运行端口只展示、不提供页面编辑。</div>
                <div class="error-box" id="error-box" hidden>
                  <div id="error-text"></div>
                </div>
                <div class="quick-links">
                  <a class="quick-link" href="/status">
                    <div class="quick-link-title">/status</div>
                    <div class="quick-link-desc">查看当前各个模型调用状况。</div>
                  </a>
                  <a class="quick-link" href="/record">
                    <div class="quick-link-title">/record</div>
                    <div class="quick-link-desc">查看采样记录。</div>
                  </a>
                </div>
              </div>
            </section>

            <section class="panel">
              <h2>Global Settings</h2>
              <div class="field-grid" id="global-fields"></div>
            </section>

            <section class="panel">
              <div class="section-header">
                <div>
                  <h2>Models</h2>
                  <p class="meta">每个模型都可以单独编辑名称、供应商、上游地址、API Key 和真实模型名。</p>
                </div>
                <button id="add-model-button" class="secondary" type="button">添加模型</button>
              </div>
              <div class="card-list" id="models-container"></div>
            </section>

            <section class="panel">
              <div class="section-header">
                <div>
                  <h2>Fallback</h2>
                  <p class="meta">为分组命名后，从上面已经配置过的模型里选择成员。</p>
                </div>
                <button id="add-fallback-button" class="secondary" type="button">添加分组</button>
              </div>
              <div class="card-list" id="fallback-container"></div>
            </section>
          </div>
        </main>
        <script
          dangerouslySetInnerHTML={{
            __html: SCRIPT.replace("__INITIAL_PAYLOAD__", serializeForScript(payload)),
          }}
        />
      </body>
    </html>
  );
}

export function renderAdminConfigPage(payload: Record<string, unknown>): string {
  return "<!doctype html>" + renderToString(<AdminConfigPage payload={payload} />);
}
