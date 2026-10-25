import { renderToString } from "hono/jsx/dom/server";
import { LOGO_DATA_URI } from "./logo.js";
import { htmlLang, withPageCorner, type Lang } from "../core/i18n.js";
function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

const zh = {
  locale: "zh-CN",
  listSeparator: "、",
  period: "。",
  colon: "：",
  inParens: "（{text}）",
  unknown: "未知",
  close: "关闭",
  cancel: "取消",
  modelN: "模型 {n}",
  advancedInvalidJson: "{model} 的高级字段不是有效 JSON：{error}",
  advancedNotObject: "{model} 的高级字段必须是 JSON 对象。",
  advancedReserved: "{model} 的高级字段不能覆盖基础字段：{keys}",
  customProviderMissing: "{model} 尚未选择 custom_provider。",
  runningPort: "当前运行 port",
  portRestart: "port 修改需重启",
  lastLoadFailed: "最近一次加载失败",
  dragToReorder: "拖拽排序",
  advancedFields: "高级字段",
  hideAdvanced: "收起高级字段",
  showAdvanced: "展开高级字段",
  advancedCount: "当前有 {n} 个高级字段，保存时会展开到模型 YAML 中。",
  noAdvanced: "当前没有高级字段。",
  advancedHelper: "输入 JSON 对象。保存时会展开到该模型 YAML 中，不能覆盖 name/provider/base_url/api_key/model/proxy 以及 body_expression/response_expression（请使用上方独立输入框）。",
  timeoutHelper: "正整数，单位毫秒。保存后新请求立即生效。",
  recordMaxHelper: "正整数。保存后会在线调整采样记录上限。",
  noProviders: "还没有自定义供应商，点击“添加供应商”集中配置连接信息。",
  unnamedProvider: "未命名供应商",
  noProtocol: "未选协议",
  noBaseUrl: "未填 base_url",
  signedIn: "已登录",
  notSignedIn: "未登录",
  signIn: "登录",
  signInAgain: "重新登录",
  checkingSignIn: "检查登录状态…",
  checkUsage: "查询用量",
  checking: "查询中…",
  usageQueryFailed: "用量查询失败",
  codexUsage: "Codex 订阅用量",
  unitDays: "天",
  unitHours: "小时",
  unitMinutes: "分钟",
  shortWindow: "短期窗口",
  longWindow: "长期窗口",
  used: "已用",
  resets: "重置",
  resetCount: "5 小时窗口可用重置次数：",
  resetCountUnavailable: "5 小时窗口可用重置次数：未能查询",
  resetWindowButton: "重置当前 5 小时窗口（剩余 {n} 次）",
  resetWindowConfirm: "确定要重置当前 5 小时窗口吗？这会消耗 1 次重置次数。",
  resetting: "重置中…",
  resetFailed: "窗口重置失败",
  resetRequested: "5 小时窗口已请求重置，请重新查询用量确认结果。",
  statusUnknown: "状态未知",
  savingWaitToSignIn: "正在保存配置，请保存完成后再登录。",
  unsavedBeforeSignIn: "页面有未保存的修改，请先保存配置，再登录。登录将使用已保存的供应商代理。",
  providerNameAndSave: "请先填写供应商名称并保存配置。",
  deviceLoginStartFailed: "无法发起设备登录",
  openaiSignInTitle: "OpenAI subscription 登录",
  enterCodeInBrowser: "请在浏览器打开的页面中输入以下验证码：",
  continueChecking: "完成后继续检查",
  deviceLoginFailed: "设备登录失败",
  openaiSignInSuccess: "OpenAI subscription 登录成功。",
  deviceLoginTimeout: "设备登录超时，请重新尝试。",
  modelCount: "{n} 个模型",
  conflictCountSuffix: "（{n} 个冲突）",
  jumpToProviderModels: "跳转到下方 Models 中该供应商的模型",
  providerHasNoModels: "该供应商下还没有模型，可点击“拉取模型”添加",
  fetchModels: "拉取模型",
  providerNameFirst: "请先填写供应商名称。",
  subscriptionNotSaved: "该订阅供应商还没有保存，请先保存配置并完成登录。",
  proxyUnsaved: "该供应商的代理有未保存的修改，拉取模型使用服务端已保存的代理，请先保存配置。",
  baseUrlFirst: "请先填写 base_url。",
  deleteProvider: "删除供应商",
  subscriptionNote: "Base URL 和 API key 由订阅登录自动管理。请先保存供应商及代理配置，再点击登录。",
  apiKeyPlaceholderEnv: "支持直接填 key 或环境变量占位符",
  apiKeyPlaceholder: "支持直接填 key 或 ${ENV_VAR}",
  providerProxyHelper: "可选。引用该供应商的模型调用上游时使用的 HTTP proxy；优先级：模型 proxy > 供应商 proxy > HTTPS_PROXY/HTTP_PROXY（NO_PROXY 中的主机直连）。订阅（OpenAI / Claude）登录、凭证刷新和用量查询也使用此代理；修改后请先保存配置。",
  claudeUsage: "Claude 订阅用量",
  windowFiveHour: "5 小时窗口",
  windowSevenDay: "7 天窗口",
  oauthApps: "OAuth 应用",
  noUsageWindows: "未返回用量窗口数据。",
  extraUsageOn: "额外用量：已开启 · 已用 ",
  extraUsageOff: "额外用量：未开启",
  unlimited: "不限",
  claudeSignInStartFailed: "无法发起 Claude 登录",
  claudeSignInTitle: "Claude subscription 登录",
  claudeSignInSteps: "1. 在新打开的页面中登录 Claude 并点击授权。2. 授权后浏览器会跳转到 callback 页面（{redirectUri}?code=...），复制地址栏中的完整 URL（或页面上显示的 code#state 授权码）粘贴到下方。",
  openAuthorizePage: "未自动打开？点此打开授权页面",
  finishSignIn: "完成登录",
  pasteCallbackUrl: "请粘贴完整的 callback URL。",
  signingIn: "登录中…",
  claudeSignInFailed: "Claude 登录失败",
  claudeSignInSuccess: "Claude subscription 登录成功{detail}。",
  noUpstreamModel: "未填上游模型名",
  noProviderSelected: "未选供应商",
  testModelTitle: "测试模型：",
  unnamedModel: "未命名模型",
  unnamedModelN: "未命名模型 {n}",
  testNote: "使用服务端当前已保存的配置发送一次流式请求",
  testNoteDirty: "；页面上还有未保存的修改，不会参与本次测试。",
  viewSource: "查看源码",
  rawResponse: "原始响应",
  send: "发送",
  modelNameAndSave: "请先填写模型名称并保存配置。",
  requesting: "请求中...",
  upstreamModelLabel: "上游模型",
  success: "成功",
  failedPrefix: "失败：",
  viewRecord: "查看记录",
  replyPreview: "模型回复预览",
  noTextReply: "(未解析到文本回复，请查看原始响应)",
  deleteGroupModelsConfirm: "确定删除供应商 {provider} 下的全部 {n} 个模型配置吗？供应商本身会保留，fallback 分组中对应的成员也会被移除。",
  providerModelSource: "供应商 {provider} / {model}",
  standaloneModelSource: "独立模型 {model}",
  fallbackGroupLabel: "fallback 分组",
  otherFallbackGroups: "其他 fallback 分组",
  conflictsFound: "发现 {n} 个名称冲突，保存前需要调整（点击下方条目可定位到对应模型）：",
  fetchModelsTitle: "拉取模型列表：",
  fetchViaClaude: "使用已保存的 Claude 登录凭证请求 api.anthropic.com/v1/models。",
  fetchViaOpenAI: "使用已保存的 OpenAI 登录凭证请求 Codex 模型目录（chatgpt.com/backend-api/codex/models）。",
  fetchViaForm: "使用当前表单中填写的 base_url / api_key / proxy 请求上游 /models（无需先保存）。",
  fetchNote: "已添加过的模型不可重复选择；不同供应商的同名模型请在添加后自行调整名称，或为供应商勾选“加供应商名后缀”。",
  filterModelIds: "过滤模型 ID",
  selectAll: "全选",
  deselectAll: "取消全选",
  refetch: "重新拉取",
  addModels: "添加模型",
  addModelsCount: "添加模型（{n}）",
  modelsAdded: "已添加 {n} 个模型，保存后生效。",
  modelsAddedConflicts: "其中 {n} 个与已有模型重名（{names}），保存前请调整名称。",
  noModelsYet: "暂无模型。",
  noMatchingModels: "没有匹配的模型。",
  addedSuffix: "（已添加）",
  fetching: "拉取中...",
  fetchModelsFailed: "拉取模型列表失败",
  fetchedCount: "共获取 {n} 个模型。",
  providerBadge: "供应商",
  modelNameConflicts: "{n} 个模型名冲突",
  conflictedModels: "冲突的模型：",
  expandToSeeMarks: "。展开后可看到具体标记。",
  providerNotFound: "未找到该供应商，请检查供应商配置",
  suffixTitle: "勾选后，该供应商下所有模型的名称变为“模型ID-供应商名”，取消勾选则恢复为模型ID。",
  addProviderSuffix: "加供应商名后缀",
  editProvider: "编辑供应商",
  deleteAllModels: "删除全部模型",
  noModels: "还没有模型，点击“添加模型”开始配置。",
  providerModelsHeading: "供应商模型（{n}）",
  standaloneModelsHeading: "独立配置的模型（{n}）",
  nameClash: "与 {others} 重名，请修改名称",
  nameConflict: "名称冲突",
  keepsAdvanced: "保留高级字段",
  test: "测试",
  saveBeforeTest: "模型尚未保存，请先点击“保存并应用”后再测试",
  duplicate: "复刻",
  deleteModel: "删除模型",
  customProviderLabel: "custom_provider（引用上方供应商连接配置）",
  addProviderFirst: "请先添加供应商。",
  upstreamModelPlaceholder: "上游真实模型名",
  modelProxyHelper: "可选。该模型调用上游时使用的 HTTP proxy，优先级最高；留空则依次回退到供应商 proxy、HTTPS_PROXY/HTTP_PROXY（NO_PROXY 中的主机直连）。",
  modelAuthTokenHelper: "可选。客户端用这个 token（Authorization: Bearer 或 x-api-key）只能以该模型名访问它；管理员 token 始终可用。支持 ${ENV_VAR}。",
  groupAuthTokenHelper: "可选。客户端用这个 token 只能以分组名访问该分组（会按顺序回退到所有成员），不能直接访问成员模型；管理员 token 始终可用。支持 ${ENV_VAR}。",
  authTokenPlaceholder: "留空则仅管理员 token 可访问",
  generateToken: "生成",
  bodyExpressionHelper: "可选。JS 表达式，变量 body 为最终上游请求体，需同步返回新的 body；留空表示不改写。",
  responseExpressionHelper: "可选。JS 表达式，变量 response 为上游 JSON/SSE 响应、headers 为只读的上游响应头，需返回新的 response；留空表示不改写。",
  noFallbackGroups: "还没有 fallback 分组，点击“添加分组”后可以为分组选择模型列表。",
  unnamedGroupN: "未命名分组 {n}",
  deleteGroup: "删除分组",
  groupNameClash: "与 {others} 重名，请修改分组名",
  groupNamePlaceholder: "例如 gpt-5.4",
  duplicateMembers: "当前分组存在重复模型名：{names}。保存时会被拦截。",
  noMembers: "当前分组还没有成员。",
  addModelsFirst: "请先添加模型",
  chooseModel: "选择模型",
  moveUp: "上移",
  moveDown: "下移",
  remove: "删除",
  addModelToGroup: "添加模型到分组",
  refreshConfigFailed: "刷新配置失败",
  refreshFailed: "刷新失败",
  saving: "正在保存并应用配置...",
  advancedJsonInvalid: "高级字段 JSON 校验失败",
  saveConflict: "保存失败：配置已被外部更新，请先刷新页面上的内容。",
  saveFailed: "保存失败",
  savedNeedsRestart: "保存成功。除 port 外的配置已立即生效；port 变更需要重启服务。",
  saved: "保存成功，配置已立即生效。",
  refreshed: "已从服务端刷新到最新配置。",
  reverted: "已恢复到当前服务端配置。",
  introBefore: "通过表单编辑服务配置、模型和 fallback 分组。保存后会自动校验并写回 ",
  introAfter: "。",
  saveAndApply: "保存并应用",
  refreshFromServer: "从服务端刷新",
  discardChanges: "撤销未保存修改",
  noteBox: "当前页面只展开常用字段。已有模型上的未展开高级字段会在保存时自动保留；API Key 输入框也支持 ${ENV_VAR} 这种占位写法；当前运行端口只展示、不提供页面编辑。",
  statusDesc: "查看当前各个模型调用状况。",
  recordDesc: "查看采样记录。",
  jobsDesc: "设置 cron、定时测试模型并对比历史作品。",
  providersIntro: "集中配置可供多个模型引用的协议、上游地址和 API Key；供应商名称必须唯一。",
  addProvider: "添加供应商",
  modelsIntro: "模型可以直接配置连接信息，也可以通过 custom_provider 引用上方供应商。",
  addModel: "添加模型",
  fallbackIntro: "为分组命名后，从上面已经配置过的模型里选择成员。",
  addGroup: "添加分组",
};

const MESSAGES: Record<Lang, typeof zh> = {
  zh,
  en: {
    locale: "en-US",
    listSeparator: ", ",
    period: ".",
    colon: ": ",
    inParens: " ({text})",
    unknown: "unknown",
    close: "Close",
    cancel: "Cancel",
    modelN: "Model {n}",
    advancedInvalidJson: "Advanced fields of {model} are not valid JSON: {error}",
    advancedNotObject: "Advanced fields of {model} must be a JSON object.",
    advancedReserved: "Advanced fields of {model} cannot override base fields: {keys}",
    customProviderMissing: "{model} has no custom_provider selected.",
    runningPort: "running port",
    portRestart: "Port changes need a restart",
    lastLoadFailed: "Last load failed",
    dragToReorder: "Drag to reorder",
    advancedFields: "Advanced fields",
    hideAdvanced: "Hide advanced fields",
    showAdvanced: "Show advanced fields",
    advancedCount: "{n} advanced field{s}; they are written into the model's YAML on save.",
    noAdvanced: "No advanced fields.",
    advancedHelper: "Enter a JSON object. It is written into this model's YAML on save and cannot override name/provider/base_url/api_key/model/proxy or body_expression/response_expression (use the dedicated inputs above).",
    timeoutHelper: "A positive integer in milliseconds. Applies to new requests as soon as you save.",
    recordMaxHelper: "A positive integer. Saving adjusts the record limit live.",
    noProviders: "No custom providers yet. Click “Add provider” to set up shared connection settings.",
    unnamedProvider: "Unnamed provider",
    noProtocol: "No protocol selected",
    noBaseUrl: "No base_url",
    signedIn: "Signed in",
    notSignedIn: "Not signed in",
    signIn: "Sign in",
    signInAgain: "Sign in again",
    checkingSignIn: "Checking sign-in status…",
    checkUsage: "Check usage",
    checking: "Checking…",
    usageQueryFailed: "Usage query failed",
    codexUsage: "Codex subscription usage",
    unitDays: "days",
    unitHours: "hours",
    unitMinutes: "min",
    shortWindow: "Short window",
    longWindow: "Long window",
    used: "used",
    resets: "resets",
    resetCount: "5-hour window resets available: ",
    resetCountUnavailable: "5-hour window resets available: could not check",
    resetWindowButton: "Reset the current 5-hour window ({n} left)",
    resetWindowConfirm: "Reset the current 5-hour window? This uses 1 reset.",
    resetting: "Resetting…",
    resetFailed: "Window reset failed",
    resetRequested: "Requested a reset of the 5-hour window. Check usage again to confirm.",
    statusUnknown: "Status unknown",
    savingWaitToSignIn: "Saving the config. Sign in after it finishes.",
    unsavedBeforeSignIn: "The page has unsaved changes. Save the config before signing in; sign-in uses the saved provider proxy.",
    providerNameAndSave: "Enter a provider name and save the config first.",
    deviceLoginStartFailed: "Could not start device sign-in",
    openaiSignInTitle: "OpenAI subscription sign-in",
    enterCodeInBrowser: "Enter this code on the page that opened in your browser:",
    continueChecking: "Continue when done",
    deviceLoginFailed: "Device sign-in failed",
    openaiSignInSuccess: "OpenAI subscription signed in.",
    deviceLoginTimeout: "Device sign-in timed out. Please try again.",
    modelCount: "{n} model{s}",
    conflictCountSuffix: " ({n} conflict{s})",
    jumpToProviderModels: "Jump to this provider's models below",
    providerHasNoModels: "This provider has no models yet. Click “Fetch models” to add some.",
    fetchModels: "Fetch models",
    providerNameFirst: "Enter a provider name first.",
    subscriptionNotSaved: "This subscription provider isn't saved yet. Save the config and sign in first.",
    proxyUnsaved: "This provider's proxy has unsaved changes. Fetching models uses the proxy saved on the server, so save the config first.",
    baseUrlFirst: "Enter base_url first.",
    deleteProvider: "Delete provider",
    subscriptionNote: "Base URL and API key are managed by the subscription sign-in. Save the provider and its proxy first, then click Sign in.",
    apiKeyPlaceholderEnv: "A key or an environment variable placeholder",
    apiKeyPlaceholder: "A key or ${ENV_VAR}",
    providerProxyHelper: "Optional. HTTP proxy used when models that reference this provider call the upstream. Priority: model proxy > provider proxy > HTTPS_PROXY/HTTP_PROXY (hosts in NO_PROXY connect directly). Subscription (OpenAI / Claude) sign-in, credential refresh and usage checks also use this proxy; save the config after changing it.",
    claudeUsage: "Claude subscription usage",
    windowFiveHour: "5-hour window",
    windowSevenDay: "7-day window",
    oauthApps: "OAuth apps",
    noUsageWindows: "No usage window data returned.",
    extraUsageOn: "Extra usage: on · used ",
    extraUsageOff: "Extra usage: off",
    unlimited: "no limit",
    claudeSignInStartFailed: "Could not start Claude sign-in",
    claudeSignInTitle: "Claude subscription sign-in",
    claudeSignInSteps: "1. Sign in to Claude on the page that just opened and click Authorize. 2. The browser then goes to the callback page ({redirectUri}?code=...). Copy the full URL from the address bar (or the code#state shown on the page) and paste it below.",
    openAuthorizePage: "Didn't open? Click here to open the authorization page",
    finishSignIn: "Finish sign-in",
    pasteCallbackUrl: "Paste the full callback URL.",
    signingIn: "Signing in…",
    claudeSignInFailed: "Claude sign-in failed",
    claudeSignInSuccess: "Claude subscription signed in{detail}.",
    noUpstreamModel: "No upstream model",
    noProviderSelected: "No provider selected",
    testModelTitle: "Test model: ",
    unnamedModel: "Unnamed model",
    unnamedModelN: "Unnamed model {n}",
    testNote: "Sends one streaming request using the config currently saved on the server",
    testNoteDirty: "; unsaved changes on this page are not included.",
    viewSource: "View source",
    rawResponse: "Raw response",
    send: "Send",
    modelNameAndSave: "Enter a model name and save the config first.",
    requesting: "Requesting...",
    upstreamModelLabel: "upstream model",
    success: "Success",
    failedPrefix: "Failed: ",
    viewRecord: "View record",
    replyPreview: "Model reply preview",
    noTextReply: "(No text reply parsed; see the raw response)",
    deleteGroupModelsConfirm: "Delete {n} model config{s} under provider {provider}? The provider itself is kept; matching members are also removed from fallback groups.",
    providerModelSource: "provider {provider} / {model}",
    standaloneModelSource: "standalone model {model}",
    fallbackGroupLabel: "fallback group",
    otherFallbackGroups: "other fallback groups",
    conflictsFound: "Found {n} name conflict{s}. Fix them before saving (click an entry below to jump to the model):",
    fetchModelsTitle: "Fetch models: ",
    fetchViaClaude: "Uses the saved Claude sign-in credentials to request api.anthropic.com/v1/models.",
    fetchViaOpenAI: "Uses the saved OpenAI sign-in credentials to request the Codex model catalog (chatgpt.com/backend-api/codex/models).",
    fetchViaForm: "Uses the base_url / api_key / proxy in the form to request the upstream /models (no need to save first).",
    fetchNote: " Models already added can't be selected again. For same-named models from different providers, rename them after adding, or tick “Add provider suffix” on the provider.",
    filterModelIds: "Filter model IDs",
    selectAll: "Select all",
    deselectAll: "Deselect all",
    refetch: "Fetch again",
    addModels: "Add models",
    addModelsCount: "Add models ({n})",
    modelsAdded: "Added {n} model{s}; they take effect after saving.",
    modelsAddedConflicts: " {n} of them clash with existing model names ({names}); rename them before saving.",
    noModelsYet: "No models.",
    noMatchingModels: "No matching models.",
    addedSuffix: " (added)",
    fetching: "Fetching...",
    fetchModelsFailed: "Failed to fetch models",
    fetchedCount: "Fetched {n} model{s}.",
    providerBadge: "Provider",
    modelNameConflicts: "{n} model name conflict{s}",
    conflictedModels: "Conflicting models: ",
    expandToSeeMarks: ". Expand to see the markers.",
    providerNotFound: "Provider not found. Check the provider settings.",
    suffixTitle: "When ticked, every model under this provider is named “modelID-providerName”; untick to go back to the model ID.",
    addProviderSuffix: "Add provider suffix",
    editProvider: "Edit provider",
    deleteAllModels: "Delete all models",
    noModels: "No models yet. Click “Add model” to get started.",
    providerModelsHeading: "Provider models ({n})",
    standaloneModelsHeading: "Standalone models ({n})",
    nameClash: "Same name as {others}; rename it",
    nameConflict: "Name conflict",
    keepsAdvanced: "Keeps advanced fields",
    test: "Test",
    saveBeforeTest: "This model isn't saved yet. Click “Save and apply” before testing.",
    duplicate: "Duplicate",
    deleteModel: "Delete model",
    customProviderLabel: "custom_provider (uses a provider above)",
    addProviderFirst: "Add a provider first.",
    upstreamModelPlaceholder: "Upstream model name",
    modelProxyHelper: "Optional. HTTP proxy for this model's upstream calls, with the highest priority; if empty, falls back to the provider proxy, then HTTPS_PROXY/HTTP_PROXY (hosts in NO_PROXY connect directly).",
    modelAuthTokenHelper: "Optional. Clients sending this token (Authorization: Bearer or x-api-key) can use this model by its name only; the admin token always works. Supports ${ENV_VAR}.",
    groupAuthTokenHelper: "Optional. Clients sending this token can use this group by its name only (falling back through all members), not the member models directly; the admin token always works. Supports ${ENV_VAR}.",
    authTokenPlaceholder: "Empty = admin token only",
    generateToken: "Generate",
    bodyExpressionHelper: "Optional. A JS expression: body is the final upstream request body, and it must synchronously return the new body. Leave empty to keep it unchanged.",
    responseExpressionHelper: "Optional. A JS expression: response is the upstream JSON/SSE response and headers the read-only upstream response headers. It must return the new response. Leave empty to keep it unchanged.",
    noFallbackGroups: "No fallback groups yet. Click “Add group”, then choose its models.",
    unnamedGroupN: "Unnamed group {n}",
    deleteGroup: "Delete group",
    groupNameClash: "Same name as {others}; rename the group",
    groupNamePlaceholder: "e.g. gpt-5.4",
    duplicateMembers: "This group lists the same model more than once: {names}. Saving will be blocked.",
    noMembers: "This group has no members yet.",
    addModelsFirst: "Add models first",
    chooseModel: "Choose a model",
    moveUp: "Move up",
    moveDown: "Move down",
    remove: "Remove",
    addModelToGroup: "Add model to group",
    refreshConfigFailed: "Failed to refresh the config",
    refreshFailed: "Refresh failed",
    saving: "Saving and applying the config...",
    advancedJsonInvalid: "Advanced field JSON is invalid",
    saveConflict: "Save failed: the config was changed elsewhere. Refresh the page content first.",
    saveFailed: "Save failed",
    savedNeedsRestart: "Saved. Everything except port applies now; changing port needs a restart.",
    saved: "Saved. The config applies now.",
    refreshed: "Loaded the latest config from the server.",
    reverted: "Reverted to the config on the server.",
    introBefore: "Edit the service config, models and fallback groups in a form. Saving validates the changes and writes them back to ",
    introAfter: ".",
    saveAndApply: "Save and apply",
    refreshFromServer: "Refresh from server",
    discardChanges: "Discard unsaved changes",
    noteBox: "Only common fields are shown. Hidden advanced fields on existing models are kept on save; the API Key input also accepts placeholders like ${ENV_VAR}; the running port is shown but can't be edited here.",
    statusDesc: "See how each model is doing.",
    recordDesc: "Browse captured request records.",
    jobsDesc: "Set up cron jobs that test models on a schedule and compare past outputs.",
    providersIntro: "Shared protocol, upstream URL and API key settings that models can reference. Provider names must be unique.",
    addProvider: "Add provider",
    modelsIntro: "Models can set their own connection, or reference a provider above through custom_provider.",
    addModel: "Add model",
    fallbackIntro: "Name a group, then pick its members from the models configured above.",
    addGroup: "Add group",
  },
};

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
      button[data-blocked]:disabled {
        cursor: not-allowed;
      }
      .suffix-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        font-weight: 600;
        color: var(--muted);
        cursor: pointer;
        user-select: none;
      }
      .suffix-toggle input {
        width: auto;
        margin: 0;
      }
      .subhead {
        margin-top: 4px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        color: var(--muted);
      }
      .card.group-card {
        border-color: rgba(143, 91, 51, 0.4);
        border-left: 5px solid var(--accent);
        background: linear-gradient(90deg, rgba(143, 91, 51, 0.09), rgba(255, 251, 244, 0.9) 45%);
      }
      .card.group-card > .card-head .card-chevron {
        background: var(--accent);
        color: #fff9f1;
      }
      button.models-link.conflict {
        color: var(--danger);
        background: var(--danger-soft);
      }
      .pill.conflict {
        background: var(--danger);
        color: #fff9f1;
      }
      .card.conflict {
        border-color: var(--danger);
        box-shadow: 0 0 0 1px rgba(191, 76, 59, 0.35);
      }
      .card.group-card.conflict {
        border-color: var(--danger);
        border-left-color: var(--danger);
      }
      input.invalid {
        border-color: var(--danger);
        background: #fff5f3;
      }
      .conflict-banner {
        display: grid;
        gap: 8px;
      }
      .conflict-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .conflict-row button {
        padding: 4px 10px;
        font-size: 12px;
      }
      .pill.kind {
        background: var(--accent);
        color: #fff9f1;
      }
      .group-body .card {
        background: rgba(255, 253, 249, 0.95);
        border-color: rgba(143, 91, 51, 0.14);
      }
      .group-body {
        display: grid;
        gap: 12px;
        padding-left: 12px;
        border-left: 2px solid rgba(143, 91, 51, 0.18);
      }
      .group-body[hidden] {
        display: none;
      }
      .fetch-model-toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .fetch-model-toolbar input {
        flex: 1;
      }
      .fetch-model-list {
        display: grid;
        gap: 2px;
        max-height: 340px;
        overflow: auto;
        padding: 6px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: #fffdf9;
      }
      .fetch-model-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 8px;
        border-radius: 8px;
        font-family: "Consolas", "SFMono-Regular", "Menlo", monospace;
        font-size: 13px;
        font-weight: 400;
        color: var(--text);
        cursor: pointer;
        word-break: break-all;
      }
      .fetch-model-item:hover {
        background: rgba(143, 91, 51, 0.08);
      }
      .fetch-model-item input {
        width: auto;
        margin: 0;
        flex: 0 0 auto;
      }
      .fetch-model-item.added {
        color: var(--muted);
        cursor: default;
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
      textarea.advanced-json {
        min-height: 160px;
        resize: vertical;
        font-family: "Consolas", "SFMono-Regular", "Menlo", monospace;
        font-size: 13px;
        line-height: 1.5;
      }
      .advanced-wrap {
        display: grid;
        gap: 10px;
      }
      .advanced-toggle {
        justify-self: start;
      }
      .helper.error {
        color: var(--danger);
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
      .card-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .card-actions button {
        white-space: nowrap;
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
      .card.dragging {
        opacity: 0.5;
      }
      .card.drag-over {
        border-color: rgba(143, 91, 51, 0.55);
        background: rgba(143, 91, 51, 0.08);
      }
      .card-head .drag-handle {
        align-self: flex-start;
        margin-top: 2px;
      }
      textarea.expression-input {
        min-height: 120px;
        resize: vertical;
        font-family: "Consolas", "SFMono-Regular", "Menlo", monospace;
        font-size: 13px;
        line-height: 1.5;
        tab-size: 2;
        white-space: pre;
      }
      .drag-handle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        font-weight: 700;
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
      dialog.model-test-dialog {
        width: min(720px, calc(100vw - 32px));
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 20px;
        background: var(--panel);
        color: var(--text);
        box-shadow: var(--shadow);
      }
      dialog.model-test-dialog::backdrop {
        background: rgba(47, 39, 29, 0.35);
      }
      .model-test-body {
        display: grid;
        gap: 12px;
      }
      .model-test-body textarea {
        min-height: 90px;
        resize: vertical;
      }
      .model-test-reply,
      .model-test-raw {
        margin: 0;
        padding: 12px 14px;
        border-radius: 12px;
        background: #fffdf9;
        border: 1px solid var(--border);
        font-family: "Consolas", "SFMono-Regular", "Menlo", monospace;
        font-size: 13px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 260px;
        overflow: auto;
      }
      .model-test-preview iframe {
        display: block;
        width: 100%;
        height: min(520px, 60vh);
        border: 1px solid var(--border);
        border-radius: 12px;
        background: white;
      }
      .model-test-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
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
      @media (max-width: 640px) {
        .page {
          padding: 12px;
        }
        .panel {
          padding: 14px;
          border-radius: 18px;
        }
        .card {
          padding: 12px;
        }
        .card-toggle {
          min-width: 0;
          flex-basis: 100%;
        }
        .card-actions {
          flex-basis: 100%;
        }
        .card-actions button {
          padding: 8px 12px;
          font-size: 13px;
        }
        .card-actions .meta {
          flex-basis: 100%;
          margin: 0;
        }
        .group-body {
          padding-left: 8px;
        }
        .member-row {
          grid-template-columns: auto minmax(0, 1fr);
        }
        .member-actions {
          grid-column: 1 / -1;
          justify-content: flex-start;
        }
      }
`;

const SCRIPT = /* js */ String.raw`
      const INITIAL_PAYLOAD = __INITIAL_PAYLOAD__;
      const T = __MESSAGES__;
      // Fills {name} placeholders in a message template; {s} is the English plural suffix for {n}.
      function tr(template, values) {
        return template.replace(/\{(\w+)\}/g, (match, key) => {
          if (key === "s") return values.n === 1 ? "" : "s";
          return key in values ? String(values[key]) : match;
        });
      }
      const MODEL_PROVIDERS = ["openai-chat", "openai-responses", "anthropic", "openai-image"];
      const SUBSCRIPTION_PROVIDERS = ["openai-subscription", "claude-subscription"];
      const PROVIDERS = [...MODEL_PROVIDERS, ...SUBSCRIPTION_PROVIDERS];
      const RESERVED_MODEL_EXTRA_KEYS = new Set(["name", "provider", "custom_provider", "base_url", "api_key", "model", "proxy", "body_expression", "response_expression", "bodyExpression", "responseExpression", "auth_token"]);
      let saving = false;
      let dirty = false;
      let localIdCounter = 0;
      let pendingFocusTarget = null;
      let draggedMember = null;
      let draggedCard = null;
      // Provider names whose grouped model card is expanded; groups are collapsed by default.
      const expandedModelGroups = new Set();
      // Sign-in status lookups per subscription provider ("type:name"), kept across renders so that expanding or
      // collapsing any card does not query every subscription provider again. Cleared when the saved config reloads.
      const subscriptionStatusCache = new Map();

      function subscriptionStatusKey(provider) {
        return provider.provider + ":" + provider.name;
      }

      function loadSubscriptionStatus(provider) {
        const key = subscriptionStatusKey(provider);
        const cached = subscriptionStatusCache.get(key);
        if (cached && !(cached.expiresAt && cached.expiresAt <= Date.now())) return cached.request;
        const entry = { expiresAt: null, request: null };
        entry.request = fetch("/admin/providers/" + encodeURIComponent(provider.name) + "/device-login/status", { cache: "no-store" })
          .then((response) => {
            if (!response.ok) throw new Error(T.statusUnknown);
            return response.json();
          })
          .then((value) => {
            entry.expiresAt = value.authenticated ? value.expiresAt : null;
            return value;
          });
        // Forget failed lookups so the next render retries instead of replaying the error.
        entry.request.catch(() => {
          if (subscriptionStatusCache.get(key) === entry) subscriptionStatusCache.delete(key);
        });
        subscriptionStatusCache.set(key, entry);
        return entry.request;
      }

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
          providers: (form.providers || []).map((provider) => ({
            ...provider,
            proxy: provider.proxy || "",
            _id: nextId("provider"),
            _expanded: false,
            _groupName: provider.name || "",
          })),
          models: (form.models || []).map((model) => ({
            ...model,
            _id: nextId("model"),
            connection_mode: model.connection_mode === "custom" ? "custom" : "direct",
            proxy: model.proxy || "",
            body_expression: model.body_expression || "",
            response_expression: model.response_expression || "",
            auth_token: model.auth_token || "",
            _expanded: false,
            _advancedExpanded: false,
            extras: model.extras || {},
            _advancedJsonText: formatAdvancedJson(model.extras || {}),
            _extrasError: "",
          })),
          fallbackGroups: (form.fallbackGroups || []).map((group) => ({
            ...group,
            auth_token: group.auth_token || "",
            _id: nextId("fallback"),
            _expanded: false,
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
      const providersContainer = document.getElementById("providers-container");
      const modelsContainer = document.getElementById("models-container");
      const fallbackContainer = document.getElementById("fallback-container");
      const globalFieldsEl = document.getElementById("global-fields");
      const snapshotMetaEl = document.getElementById("snapshot-meta");

      function setStatus(kind, text) {
        statusEl.className = "status" + (kind ? " " + kind : "");
        statusEl.textContent = text || "";
      }

      // Re-rendering replaces the focused input, so remember its caret to put it back on the new one.
      function captureFocusedSelection() {
        const active = document.activeElement;
        const focusId = active?.getAttribute?.("data-focus-id");
        if (!focusId) return null;
        try {
          if (typeof active.selectionStart !== "number") return null;
          return { focusId, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection || "none" };
        } catch {
          return null;
        }
      }

      function focusPendingTarget({ scrollToFocus = true, selection = null } = {}) {
        if (!pendingFocusTarget) return;
        const focusId = pendingFocusTarget;
        const target = document.querySelector("[data-focus-id=\"" + focusId + "\"]");
        if (!target) return;
        pendingFocusTarget = null;
        requestAnimationFrame(() => {
          if (scrollToFocus) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
          }
          target.focus({ preventScroll: true });
          if (selection && selection.focusId === focusId && typeof target.setSelectionRange === "function") {
            try {
              target.setSelectionRange(selection.start, selection.end, selection.direction);
            } catch {}
          }
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

      function getModelLabel(model, index) {
        return (model.name || "").trim() || tr(T.modelN, { n: index + 1 });
      }

      function normalizeModelRef(value) {
        return String(value || "").trim();
      }

      function formatAdvancedJson(extras) {
        const value = extras && typeof extras === "object" && !Array.isArray(extras) ? extras : {};
        return JSON.stringify(value, null, 2);
      }

      function parseAdvancedJson(text, modelLabel) {
        const trimmed = (text || "").trim();
        let parsed;
        try {
          parsed = trimmed ? JSON.parse(trimmed) : {};
        } catch (error) {
          throw new Error(tr(T.advancedInvalidJson, { model: modelLabel, error: error instanceof Error ? error.message : String(error) }));
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(tr(T.advancedNotObject, { model: modelLabel }));
        }
        const reservedKeys = Object.keys(parsed).filter((key) => RESERVED_MODEL_EXTRA_KEYS.has(key));
        if (reservedKeys.length > 0) {
          throw new Error(tr(T.advancedReserved, { model: modelLabel, keys: reservedKeys.join(", ") }));
        }
        return parsed;
      }

      function validateAdvancedFields() {
        formState.models.forEach((model, index) => {
          if (model.connection_mode === "custom" && !(model.custom_provider || "").trim()) {
            throw new Error(tr(T.customProviderMissing, { model: getModelLabel(model, index) }));
          }
          const text = model._advancedJsonText ?? formatAdvancedJson(model.extras);
          model.extras = parseAdvancedJson(text, getModelLabel(model, index));
          model._extrasError = "";
        });
      }

      function dehydrateForm() {
        validateAdvancedFields();
        return {
          rootExtras: formState.rootExtras || {},
          serverExtras: formState.serverExtras || {},
          recordExtras: formState.recordExtras || {},
          server: { ...formState.server },
          record: { ...formState.record },
          providers: formState.providers.map(({ _id, _expanded, _groupName, ...provider }) => provider),
          models: formState.models.map(({ _id, _expanded, _advancedExpanded, _advancedJsonText, _extrasError, ...model }) => ({
            ...model,
            custom_provider: model.connection_mode === "custom" ? model.custom_provider : "",
            extras: model.extras || {},
          })),
          fallbackGroups: formState.fallbackGroups.map(({ _id, _expanded, members, ...group }) => ({
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
          " · " + T.runningPort + " " + currentSnapshot.effectiveConfig.port;

        pillsEl.textContent = "";
        const pills = [
          { label: "providers " + formState.providers.length, kind: "neutral" },
          { label: "models " + formState.models.length, kind: "success" },
          { label: "fallback groups " + formState.fallbackGroups.length, kind: "neutral" },
          { label: T.portRestart, kind: "warning" },
        ];
        if (currentSnapshot.lastError) {
          pills.push({ label: T.lastLoadFailed, kind: "error" });
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
        if (options.invalid) control.classList.add("invalid");
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
          helper.className = "helper" + (options.helperError ? " error" : "");
          helper.textContent = options.helper;
          field.appendChild(helper);
        }
        container.appendChild(field);
      }

      // An auth_token input with a button that fills in a random token; target is a model or fallback group draft.
      function bindAuthTokenField(container, target, helper) {
        bindField(container, "auth_token", {
          spanClass: "span-2",
          value: target.auth_token || "",
          placeholder: T.authTokenPlaceholder,
          helper,
          onInput(value) {
            target.auth_token = value;
            markDirty(true);
          },
        });
        const field = container.lastElementChild;
        const button = createActionButton(T.generateToken, "ghost", () => {
          const bytes = new Uint8Array(24);
          crypto.getRandomValues(bytes);
          target.auth_token = "sk-nanollm-" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
          markDirty(true);
          renderAll({ preserveScroll: true, scrollToFocus: false });
        });
        field.insertBefore(button, field.querySelector(".helper"));
      }

      function bindExpressionField(container, model, key, options) {
        const field = document.createElement("div");
        field.className = "field span-2";
        const label = document.createElement("label");
        label.textContent = key;
        const textarea = document.createElement("textarea");
        textarea.className = "expression-input";
        textarea.spellcheck = false;
        textarea.wrap = "off";
        textarea.value = model[key] || "";
        textarea.placeholder = options.placeholder;
        textarea.setAttribute("data-expression-key", key);
        textarea.addEventListener("keydown", (event) => {
          if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
          event.preventDefault();
          textarea.setRangeText("  ", textarea.selectionStart, textarea.selectionEnd, "end");
          textarea.dispatchEvent(new Event("input"));
        });
        textarea.addEventListener("input", (event) => {
          model[key] = event.target.value;
          markDirty(true);
        });
        const helper = document.createElement("div");
        helper.className = "helper";
        helper.textContent = options.helper;
        field.appendChild(label);
        field.appendChild(textarea);
        field.appendChild(helper);
        container.appendChild(field);
      }

      function attachCardDrag(card, head, kind, getList, item) {
        const handle = document.createElement("span");
        handle.className = "drag-handle";
        handle.textContent = "⋮⋮";
        handle.title = T.dragToReorder;
        handle.setAttribute("role", "button");
        handle.setAttribute("aria-label", T.dragToReorder);
        handle.draggable = true;
        handle.addEventListener("dragstart", (event) => {
          draggedCard = { kind, id: item._id };
          card.classList.add("dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item._id);
            event.dataTransfer.setDragImage(card, 24, 24);
          }
        });
        handle.addEventListener("dragend", () => {
          draggedCard = null;
          card.classList.remove("dragging");
          document.querySelectorAll(".card.drag-over").forEach((element) => element.classList.remove("drag-over"));
        });
        card.addEventListener("dragover", (event) => {
          if (!draggedCard || draggedCard.kind !== kind || draggedCard.id === item._id) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          card.classList.add("drag-over");
        });
        card.addEventListener("dragleave", (event) => {
          if (event.relatedTarget && card.contains(event.relatedTarget)) return;
          card.classList.remove("drag-over");
        });
        card.addEventListener("drop", (event) => {
          if (!draggedCard || draggedCard.kind !== kind) return;
          event.preventDefault();
          card.classList.remove("drag-over");
          const list = getList();
          const fromIndex = list.findIndex((entry) => entry._id === draggedCard.id);
          const toIndex = list.findIndex((entry) => entry._id === item._id);
          draggedCard = null;
          if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
          moveArrayItem(list, fromIndex, toIndex);
          markDirty(true);
          renderAll({ preserveScroll: true, scrollToFocus: false });
        });
        head.insertBefore(handle, head.firstChild);
      }

      function bindAdvancedJsonField(container, model, index) {
        const field = document.createElement("div");
        field.className = "field span-2";
        const label = document.createElement("label");
        label.textContent = T.advancedFields;

        const wrap = document.createElement("div");
        wrap.className = "advanced-wrap";

        const toggle = createActionButton(model._advancedExpanded ? T.hideAdvanced : T.showAdvanced, "secondary advanced-toggle", () => {
          model._advancedExpanded = !model._advancedExpanded;
          renderAll({ preserveScroll: true, scrollToFocus: false });
        });
        const count = Object.keys(model.extras || {}).length;
        const summary = document.createElement("div");
        summary.className = "helper";
        summary.textContent = count > 0 ? tr(T.advancedCount, { n: count }) : T.noAdvanced;

        const textarea = document.createElement("textarea");
        textarea.className = "advanced-json";
        textarea.spellcheck = false;
        textarea.value = model._advancedJsonText ?? formatAdvancedJson(model.extras);
        textarea.placeholder = '{\n  "image": false,\n  "headers": {},\n  "body": {}\n}';
        textarea.hidden = !model._advancedExpanded;

        const helper = document.createElement("div");
        helper.className = "helper";
        helper.textContent = T.advancedHelper;
        helper.hidden = !model._advancedExpanded;

        textarea.addEventListener("input", (event) => {
          const value = event.target.value;
          model._advancedJsonText = value;
          try {
            model.extras = parseAdvancedJson(value, getModelLabel(model, index));
            model._extrasError = "";
            helper.className = "helper";
            helper.textContent = T.advancedHelper;
          } catch (error) {
            model._extrasError = error instanceof Error ? error.message : String(error);
            helper.className = "helper error";
            helper.textContent = model._extrasError;
          }
          markDirty(true);
        });

        field.appendChild(label);
        wrap.appendChild(toggle);
        wrap.appendChild(summary);
        wrap.appendChild(textarea);
        wrap.appendChild(helper);
        field.appendChild(wrap);
        container.appendChild(field);
      }

      function renderGlobalFields() {
        globalFieldsEl.textContent = "";
        bindField(globalFieldsEl, "server.ttfb_timeout", {
          type: "number",
          min: "1",
          step: "1",
          value: formState.server.ttfb_timeout,
          helper: T.timeoutHelper,
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
          helper: T.recordMaxHelper,
          onInput(value) {
            formState.record.max_size = value;
            markDirty(true);
          },
        });
      }

      function renderProviders() {
        providersContainer.textContent = "";
        if (formState.providers.length === 0) {
          const empty = document.createElement("div");
          empty.className = "note-box";
          empty.textContent = T.noProviders;
          providersContainer.appendChild(empty);
          return;
        }
        const nameConflicts = getNameConflicts();
        formState.providers.forEach((provider) => {
          const card = document.createElement("section");
          card.className = "card" + (provider._expanded ? "" : " compact");

          const head = document.createElement("div");
          head.className = "card-head";
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "card-toggle";
          toggle.addEventListener("click", () => {
            provider._expanded = !provider._expanded;
            renderAll();
          });
          const toggleTop = document.createElement("div");
          toggleTop.className = "card-toggle-top";
          const chevron = document.createElement("span");
          chevron.className = "card-chevron";
          chevron.textContent = provider._expanded ? "▾" : "▸";
          const title = document.createElement("div");
          title.className = "card-title";
          const h3 = document.createElement("h3");
          h3.textContent = (provider.name || "").trim() || T.unnamedProvider;
          title.appendChild(h3);
          toggleTop.appendChild(chevron);
          toggleTop.appendChild(title);
          toggle.appendChild(toggleTop);
          const summary = document.createElement("div");
          summary.className = "card-summary";
          summary.textContent = SUBSCRIPTION_PROVIDERS.includes(provider.provider)
            ? provider.provider
            : (provider.provider || T.noProtocol) + " · " + (provider.base_url || T.noBaseUrl);
          toggle.appendChild(summary);
          head.appendChild(toggle);

          const actions = document.createElement("div");
          actions.className = "card-actions";
          if (SUBSCRIPTION_PROVIDERS.includes(provider.provider)) {
            const isClaude = provider.provider === "claude-subscription";
            const markAuthenticated = () => {
              // The next render re-reads the new credential's expiry from the server.
              subscriptionStatusCache.delete(subscriptionStatusKey(provider));
              status.textContent = T.signedIn; status.className = "success"; loginButton.textContent = T.signInAgain; usageButton.hidden = false; };
            const status = document.createElement("span");
            status.className = "meta";
            status.textContent = T.checkingSignIn;
            actions.appendChild(status);
            const usageButton = createActionButton(T.checkUsage, "secondary", async () => {
              usageButton.disabled = true;
              usageButton.textContent = T.checking;
              try {
                const response = await fetch("/admin/providers/" + encodeURIComponent(provider.name) + "/usage", { cache: "no-store" });
                const text = await response.text();
                let payload; try { payload = JSON.parse(text); } catch { payload = { error: text.slice(0, 240) }; }
                if (!response.ok) throw new Error(payload.error || T.usageQueryFailed);
                if (isClaude) { showClaudeUsageDialog(payload); return; }
                const dialog = document.createElement("dialog");
                const panel = document.createElement("div");
                panel.style.minWidth = "420px";
                const heading = document.createElement("h3"); heading.textContent = T.codexUsage;
                const plan = document.createElement("p"); plan.className = "meta"; plan.textContent = "Plan: " + (payload.plan_type || "unknown");
                panel.append(heading, plan);
                const formatDuration = (seconds) => seconds >= 86400 ? Math.round(seconds / 86400) + " " + T.unitDays : seconds >= 3600 ? Math.round(seconds / 3600) + " " + T.unitHours : Math.round(seconds / 60) + " " + T.unitMinutes;
                const formatReset = (windowData) => {
                  const timestamp = Number(windowData?.reset_at) * 1000 || Date.now() + Number(windowData?.reset_after_seconds || 0) * 1000;
                  return timestamp ? new Date(timestamp).toLocaleString(T.locale) : T.unknown;
                };
                const limits = [{ name: "Codex", value: payload.rate_limit }].concat((payload.additional_rate_limits || []).map((item) => ({ name: item.limit_name || item.metered_feature, value: item.rate_limit })));
                limits.forEach((limit) => {
                  const title = document.createElement("h4"); title.textContent = limit.name;
                  panel.appendChild(title);
                  [[T.shortWindow, limit.value?.primary_window], [T.longWindow, limit.value?.secondary_window]].forEach(([label, value]) => {
                    if (!value) return;
                    const row = document.createElement("p");
                    const duration = Number(value.limit_window_seconds) > 0 ? " · " + formatDuration(Number(value.limit_window_seconds)) : "";
                    row.textContent = label + duration + " · " + T.used + " " + (Number.isFinite(Number(value.used_percent)) ? Number(value.used_percent) + "%" : T.unknown) + " · " + T.resets + " " + formatReset(value);
                    panel.appendChild(row);
                  });
                });
                const resetCredits = payload.rate_limit_reset_credits || {};
                const rawResetCount = resetCredits.available_count ?? resetCredits.availableCount;
                const resetCount = Number(rawResetCount);
                const resetCountRow = document.createElement("p");
                resetCountRow.className = "meta";
                resetCountRow.textContent = Number.isFinite(resetCount)
                  ? T.resetCount + resetCount
                  : T.resetCountUnavailable;
                panel.appendChild(resetCountRow);
                if (resetCount > 0) {
                  const resetButton = document.createElement("button");
                  resetButton.type = "button";
                  resetButton.className = "danger";
                  resetButton.textContent = tr(T.resetWindowButton, { n: resetCount });
                  resetButton.addEventListener("click", async () => {
                    if (!window.confirm(T.resetWindowConfirm)) return;
                    resetButton.disabled = true;
                    resetButton.textContent = T.resetting;
                    try {
                      const resetResponse = await fetch("/admin/providers/" + encodeURIComponent(provider.name) + "/usage/reset", { method: "POST" });
                      const resetText = await resetResponse.text();
                      let resetPayload; try { resetPayload = JSON.parse(resetText); } catch { resetPayload = { error: resetText.slice(0, 240) }; }
                      if (!resetResponse.ok) throw new Error(resetPayload.error || T.resetFailed);
                      dialog.close();
                      window.alert(T.resetRequested);
                      usageButton.click();
                    } catch (error) {
                      resetButton.disabled = false;
                      resetButton.textContent = tr(T.resetWindowButton, { n: resetCount });
                      window.alert(error instanceof Error ? error.message : String(error));
                    }
                  });
                  panel.appendChild(resetButton);
                }
                const close = document.createElement("button"); close.type = "button"; close.textContent = T.close; close.addEventListener("click", () => dialog.close());
                panel.appendChild(close); dialog.appendChild(panel); document.body.appendChild(dialog); dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal();
              } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
              finally { usageButton.disabled = false; usageButton.textContent = T.checkUsage; }
            });
            usageButton.hidden = true;
            loadSubscriptionStatus(provider)
              .then((value) => {
                status.textContent = value.authenticated ? T.signedIn : T.notSignedIn;
                status.className = value.authenticated ? "success" : "meta";
                loginButton.textContent = value.authenticated ? T.signInAgain : T.signIn;
                usageButton.hidden = !value.authenticated;
              })
              .catch(() => { status.textContent = T.statusUnknown; });
            const loginButton = createActionButton(T.signIn, "secondary", async () => {
              if (saving) { window.alert(T.savingWaitToSignIn); return; }
              if (dirty) { window.alert(T.unsavedBeforeSignIn); return; }
              const name = (provider.name || "").trim();
              if (!name) { window.alert(T.providerNameAndSave); return; }
              if (isClaude) { await runClaudeLogin(name, markAuthenticated); return; }
              try {
                const start = await fetch("/admin/providers/" + encodeURIComponent(name) + "/device-login", { method: "POST" });
                const startText = await start.text();
                let payload; try { payload = JSON.parse(startText); } catch { payload = { error: startText.slice(0, 240) }; }
                if (!start.ok) throw new Error(payload.error || T.deviceLoginStartFailed);
                const link = payload.verificationUriComplete || payload.verificationUri;
                window.open(link, "_blank", "noopener");
                const dialog = document.createElement("dialog");
                dialog.innerHTML = "<form method=dialog style='min-width:360px'><h3>" + T.openaiSignInTitle + "</h3><p>" + T.enterCodeInBrowser + "</p><input readonly value='" + String(payload.userCode).replace(/'/g, "&#39;") + "' style='width:100%;font-size:22px;letter-spacing:2px;text-align:center'><p><button value='ok' type='submit'>" + T.continueChecking + "</button></p></form>";
                document.body.appendChild(dialog); dialog.showModal();
                await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
                dialog.remove();
                for (let attempt = 0; attempt < 60; attempt += 1) {
                  const poll = await fetch("/admin/providers/" + encodeURIComponent(name) + "/device-login/" + encodeURIComponent(payload.sessionId) + "/poll", { method: "POST" });
                  const pollText = await poll.text();
                  let result; try { result = JSON.parse(pollText); } catch { result = { error: pollText.slice(0, 240) }; }
                  if (!poll.ok) throw new Error(result.error || T.deviceLoginFailed);
                  if (result.status === "authenticated") { markAuthenticated(); window.alert(T.openaiSignInSuccess); return; }
                  await new Promise((resolve) => setTimeout(resolve, Math.max(2000, Number(result.retryAfter || payload.interval || 5) * 1000)));
                }
                throw new Error(T.deviceLoginTimeout);
              } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
            });
            actions.appendChild(loginButton);
            actions.appendChild(usageButton);
          }
          const providerModels = getGroupModels((provider.name || "").trim());
          const conflictedCount = providerModels.filter((model) => nameConflicts.has(normalizeModelRef(model.name))).length;
          const modelsLink = createActionButton(
            (conflictedCount > 0 ? "⚠ " : "") + tr(T.modelCount, { n: providerModels.length }) + (conflictedCount > 0 ? tr(T.conflictCountSuffix, { n: conflictedCount }) : ""),
            "ghost models-link" + (conflictedCount > 0 ? " conflict" : ""),
            () => locateModelGroup((provider.name || "").trim()),
          );
          modelsLink.title = providerModels.length > 0 ? T.jumpToProviderModels : T.providerHasNoModels;
          modelsLink.disabled = providerModels.length === 0;
          actions.appendChild(modelsLink);
          actions.appendChild(createActionButton(T.fetchModels, "secondary", () => {
            if (!(provider.name || "").trim()) { window.alert(T.providerNameFirst); return; }
            if (SUBSCRIPTION_PROVIDERS.includes(provider.provider)) {
              // Only this provider's saved entry matters (credentials and proxy come from the server); other unsaved edits do not.
              const saved = (currentSnapshot.effectiveConfig?.providers || []).find((item) => item.name === provider.name && item.provider === provider.provider);
              if (!saved) { window.alert(T.subscriptionNotSaved); return; }
              if ((saved.proxy || "") !== (provider.proxy || "").trim()) { window.alert(T.proxyUnsaved); return; }
            } else if (!(provider.base_url || "").trim()) { window.alert(T.baseUrlFirst); return; }
            openFetchModelsDialog(provider);
          }));
          actions.appendChild(createActionButton(T.deleteProvider, "danger", () => {
            formState.providers = formState.providers.filter((item) => item._id !== provider._id);
            markDirty(true);
            renderAll();
          }));
          head.appendChild(actions);
          attachCardDrag(card, head, "provider", () => formState.providers, provider);
          card.appendChild(head);

          const body = document.createElement("div");
          body.className = "card-body";
          body.hidden = !provider._expanded;
          const grid = document.createElement("div");
          grid.className = "field-grid two";
          bindField(grid, "name", { value: provider.name, attributes: { "data-focus-id": "provider-name-" + provider._id }, onInput(value) {
            provider.name = value;
            // Models follow the group this provider owns (_groupName), not the transient input text, so intermediate
            // keystrokes that are empty or collide with another provider's name (e.g. "oa" while typing "oa2") never
            // move or unbind models.
            const nextName = value;
            const takenByOther = formState.providers.some((item) => item !== provider && (item.name === nextName || item._groupName === nextName));
            if (nextName.trim() && !takenByOther && nextName !== provider._groupName) {
              const previousName = provider._groupName;
              if (previousName) {
                formState.models.forEach((model) => {
                  if (model.connection_mode === "custom" && model.custom_provider === previousName) {
                    const wasSuffixed = isSuffixedName(model, previousName);
                    model.custom_provider = nextName;
                    if (wasSuffixed) renameModelRef(model, getSuffixedName(model, nextName));
                  }
                });
                if (expandedModelGroups.delete(previousName)) expandedModelGroups.add(nextName);
              }
              provider._groupName = nextName;
            }
            markDirty(true);
          } });
          bindField(grid, "provider", { type: "select", options: PROVIDERS, value: provider.provider || PROVIDERS[0], onInput(value) { provider.provider = value; if (SUBSCRIPTION_PROVIDERS.includes(value)) { provider.base_url = ""; provider.api_key = ""; } markDirty(true); renderAll(); } });
          if (SUBSCRIPTION_PROVIDERS.includes(provider.provider)) {
            const note = document.createElement("div"); note.className = "helper"; note.textContent = T.subscriptionNote; grid.appendChild(note);
          } else {
            bindField(grid, "base_url", { value: provider.base_url, placeholder: "https://example.com/v1", onInput(value) { provider.base_url = value; markDirty(true); } });
            bindField(grid, "api_key", { value: provider.api_key, placeholder: T.apiKeyPlaceholderEnv, onInput(value) { provider.api_key = value; markDirty(true); } });
          }
          bindField(grid, "proxy", {
            spanClass: "span-2",
            value: provider.proxy || "",
            placeholder: "http://127.0.0.1:7890",
            helper: T.providerProxyHelper,
            onInput(value) { provider.proxy = value; markDirty(true); },
          });
          body.appendChild(grid);
          card.appendChild(body);
          providersContainer.appendChild(card);
        });
      }

      function readJsonResponse(text) {
        try { return JSON.parse(text); } catch { return { error: String(text || "").slice(0, 240) }; }
      }

      function showClaudeUsageDialog(payload) {
        const dialog = document.createElement("dialog");
        const panel = document.createElement("div");
        panel.style.minWidth = "420px";
        const heading = document.createElement("h3"); heading.textContent = T.claudeUsage;
        const plan = document.createElement("p"); plan.className = "meta";
        plan.textContent = "Plan: " + (payload.subscription_type || "unknown") + (payload.rate_limit_tier ? " · " + payload.rate_limit_tier : "") + (payload.email ? " · " + payload.email : "");
        panel.append(heading, plan);
        const labels = { five_hour: T.windowFiveHour, seven_day: T.windowSevenDay, seven_day_opus: T.windowSevenDay + " · Opus", seven_day_sonnet: T.windowSevenDay + " · Sonnet", seven_day_oauth_apps: T.windowSevenDay + " · " + T.oauthApps };
        const order = Object.keys(labels);
        const rank = (key) => order.indexOf(key) < 0 ? order.length : order.indexOf(key);
        const entries = Object.entries(payload)
          .filter(([key, value]) => key !== "extra_usage" && value && typeof value === "object" && !Array.isArray(value) && "utilization" in value)
          .sort(([a], [b]) => rank(a) - rank(b));
        entries.forEach(([key, value]) => {
          const row = document.createElement("p");
          const used = Number(value.utilization);
          const resetAt = value.resets_at ? new Date(value.resets_at) : null;
          const usedText = value.utilization !== null && Number.isFinite(used) ? Math.round(used * 10) / 10 + "%" : T.unknown;
          const resetText = resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt.toLocaleString(T.locale) : T.unknown;
          row.textContent = (labels[key] || key.replace(/_/g, " ")) + " · " + T.used + " " + usedText + " · " + T.resets + " " + resetText;
          panel.appendChild(row);
        });
        if (entries.length === 0) {
          const empty = document.createElement("p"); empty.className = "meta"; empty.textContent = T.noUsageWindows;
          panel.appendChild(empty);
        }
        const extra = payload.extra_usage;
        if (extra && typeof extra === "object") {
          const row = document.createElement("p"); row.className = "meta";
          const extraPercent = extra.utilization !== null && Number.isFinite(Number(extra.utilization)) ? tr(T.inParens, { text: Number(extra.utilization) + "%" }) : "";
          row.textContent = extra.is_enabled
            ? T.extraUsageOn + (extra.used_credits ?? T.unknown) + " / " + (extra.monthly_limit ?? T.unlimited) + extraPercent
            : T.extraUsageOff;
          panel.appendChild(row);
        }
        const close = document.createElement("button"); close.type = "button"; close.textContent = T.close; close.addEventListener("click", () => dialog.close());
        panel.appendChild(close); dialog.appendChild(panel); document.body.appendChild(dialog);
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        dialog.showModal();
      }

      async function runClaudeLogin(name, onAuthenticated) {
        let payload;
        try {
          const start = await fetch("/admin/providers/" + encodeURIComponent(name) + "/claude-login", { method: "POST" });
          payload = readJsonResponse(await start.text());
          if (!start.ok) throw new Error(payload.error || T.claudeSignInStartFailed);
        } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); return; }
        window.open(payload.authorizeUrl, "_blank", "noopener");
        const dialog = document.createElement("dialog");
        const panel = document.createElement("div");
        panel.style.minWidth = "480px";
        panel.style.maxWidth = "640px";
        const heading = document.createElement("h3"); heading.textContent = T.claudeSignInTitle;
        const steps = document.createElement("p");
        steps.textContent = tr(T.claudeSignInSteps, { redirectUri: payload.redirectUri });
        const link = document.createElement("a"); link.href = payload.authorizeUrl; link.target = "_blank"; link.rel = "noopener"; link.textContent = T.openAuthorizePage;
        const input = document.createElement("textarea"); input.rows = 4; input.style.width = "100%"; input.placeholder = payload.redirectUri + "?code=...&state=...";
        const error = document.createElement("p"); error.className = "error"; error.style.color = "#b42318"; error.hidden = true;
        const actions = document.createElement("p");
        const submit = document.createElement("button"); submit.type = "button"; submit.textContent = T.finishSignIn;
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary"; cancel.textContent = T.cancel;
        actions.append(submit, " ", cancel);
        panel.append(heading, steps, link, input, error, actions);
        dialog.appendChild(panel); document.body.appendChild(dialog);
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        cancel.addEventListener("click", () => dialog.close());
        submit.addEventListener("click", async () => {
          const callback = input.value.trim();
          if (!callback) { error.textContent = T.pasteCallbackUrl; error.hidden = false; return; }
          submit.disabled = true; submit.textContent = T.signingIn; error.hidden = true;
          try {
            const response = await fetch("/admin/providers/" + encodeURIComponent(name) + "/claude-login/" + encodeURIComponent(payload.sessionId) + "/complete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ callback }),
            });
            const result = readJsonResponse(await response.text());
            if (!response.ok) throw new Error(result.error || T.claudeSignInFailed);
            dialog.close();
            onAuthenticated();
            window.alert(tr(T.claudeSignInSuccess, { detail: (result.email ? T.colon + result.email : "") + (result.subscriptionType ? tr(T.inParens, { text: result.subscriptionType }) : "") }));
          } catch (err) {
            error.textContent = err instanceof Error ? err.message : String(err);
            error.hidden = false;
            submit.disabled = false; submit.textContent = T.finishSignIn;
          }
        });
        dialog.showModal();
        input.focus();
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
        if (model.connection_mode === "custom" && model.custom_provider) {
          return "custom provider · " + model.custom_provider + " · " + (model.model || T.noUpstreamModel);
        }
        const provider = model.provider || T.noProviderSelected;
        const upstreamModel = model.model || T.noUpstreamModel;
        const baseUrl = model.base_url || T.noBaseUrl;
        return provider + " · " + upstreamModel + " · " + baseUrl;
      }

      function getEffectiveModelProvider(model) {
        if (model.connection_mode !== "custom") return model.provider;
        const provider = formState.providers.find((item) => item.name === model.custom_provider);
        if (provider?.provider === "openai-subscription") return "openai-responses";
        if (provider?.provider === "claude-subscription") return "anthropic";
        return provider?.provider;
      }

      function getModelTestPreview(text) {
        let content = String(text || "").trim();
        const fenced = content.match(/^\x60{3}(?:html|svg|xml)?[ \t]*\r?\n([\s\S]*?)\r?\n?\x60{3}\s*$/i);
        if (fenced) content = fenced[1].trim();
        content = content.replace(/^<\?xml\b[\s\S]*?\?>\s*/i, "");
        const start = content.replace(/^(?:<!--[\s\S]*?-->\s*)*/, "");
        return /^(?:<!doctype\s+html\b|<(?:html|head|body|svg|div|main|section|article|style|h[1-6]|p|table|canvas)\b)/i.test(start) ? content : null;
      }

      function openModelTestDialog(model) {
        const name = (model.name || "").trim();
        const dialog = document.createElement("dialog");
        dialog.className = "model-test-dialog";
        const body = document.createElement("div");
        body.className = "model-test-body";

        const heading = document.createElement("h3");
        heading.textContent = T.testModelTitle + (name || T.unnamedModel);
        body.appendChild(heading);

        const note = document.createElement("div");
        note.className = "helper";
        note.textContent = T.testNote + (dirty ? T.testNoteDirty : T.period);
        body.appendChild(note);

        const input = document.createElement("textarea");
        input.value = "Reply with only ok.";
        body.appendChild(input);

        const presets = document.createElement("div");
        presets.className = "model-test-actions";
        presets.appendChild(createActionButton("only ok", "secondary", () => {
          input.value = "Reply with only ok.";
          input.focus();
        }));
        presets.appendChild(createActionButton("pelican", "secondary", () => {
          input.value = "Generate an SVG animation embedded in HTML of a pelican riding a bicycle. Return only the code, with no explanation.";
          input.focus();
        }));
        body.appendChild(presets);

        const status = document.createElement("div");
        status.className = "status";
        body.appendChild(status);

        const reply = document.createElement("pre");
        reply.className = "model-test-reply";
        reply.hidden = true;
        body.appendChild(reply);

        const preview = document.createElement("div");
        preview.className = "model-test-preview";
        preview.hidden = true;
        body.appendChild(preview);

        const sourceWrap = document.createElement("details");
        sourceWrap.hidden = true;
        const sourceSummary = document.createElement("summary");
        sourceSummary.textContent = T.viewSource;
        const source = document.createElement("pre");
        source.className = "model-test-raw";
        sourceWrap.append(sourceSummary, source);
        body.appendChild(sourceWrap);

        const rawWrap = document.createElement("details");
        rawWrap.hidden = true;
        const rawSummary = document.createElement("summary");
        rawSummary.textContent = T.rawResponse;
        const raw = document.createElement("pre");
        raw.className = "model-test-raw";
        rawWrap.append(rawSummary, raw);
        body.appendChild(rawWrap);

        const actions = document.createElement("div");
        actions.className = "model-test-actions";
        const closeButton = createActionButton(T.close, "ghost", () => dialog.close());
        const sendButton = createActionButton(T.send, "", async () => {
          if (!name) { status.className = "status error"; status.textContent = T.modelNameAndSave; return; }
          sendButton.disabled = true;
          status.className = "status warn";
          status.textContent = T.requesting;
          reply.hidden = true;
          preview.hidden = true;
          preview.replaceChildren();
          sourceWrap.hidden = true;
          sourceWrap.open = false;
          source.textContent = "";
          rawWrap.hidden = true;
          try {
            const response = await fetch("/admin/models/" + encodeURIComponent(name) + "/test", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: input.value }),
            });
            const text = await response.text();
            let payload; try { payload = JSON.parse(text); } catch { payload = { error: text.slice(0, 240) }; }
            const meta = [
              payload.status ? "HTTP " + payload.status : "",
              typeof payload.durationMs === "number" ? payload.durationMs + "ms" : "",
              payload.upstreamModel ? T.upstreamModelLabel + " " + payload.upstreamModel : "",
            ].filter(Boolean).join(" · ");
            status.textContent = "";
            status.className = "status " + (payload.ok ? "success" : "error");
            status.appendChild(document.createTextNode((payload.ok ? T.success : T.failedPrefix + (typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error))) + (meta ? " · " + meta : "")));
            if (payload.requestId) {
              status.appendChild(document.createTextNode(" · "));
              const link = document.createElement("a");
              link.href = "/record?requestId=" + encodeURIComponent(payload.requestId);
              link.target = "_blank";
              link.rel = "noopener";
              link.textContent = T.viewRecord;
              status.appendChild(link);
            }
            if (payload.ok) {
              const markup = getModelTestPreview(payload.reply);
              if (markup !== null) {
                const frame = document.createElement("iframe");
                frame.title = T.replyPreview;
                // Allow local interactive demos without access to the admin origin or network.
                frame.setAttribute("sandbox", "allow-scripts");
                frame.referrerPolicy = "no-referrer";
                frame.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; base-uri \'none\'; form-action \'none\';"><meta name="viewport" content="width=device-width, initial-scale=1">' + markup;
                preview.appendChild(frame);
                preview.hidden = false;
                source.textContent = payload.reply;
                sourceWrap.hidden = false;
              } else {
                reply.hidden = false;
                reply.textContent = payload.reply || T.noTextReply;
              }
            }
            if (payload.raw) {
              rawWrap.hidden = false;
              rawWrap.open = !payload.ok || !payload.reply;
              raw.textContent = payload.raw;
            }
          } catch (error) {
            status.className = "status error";
            status.textContent = error instanceof Error ? error.message : String(error);
          } finally {
            sendButton.disabled = false;
          }
        });
        actions.append(closeButton, sendButton);
        body.appendChild(actions);

        dialog.appendChild(body);
        document.body.appendChild(dialog);
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        dialog.showModal();
        input.focus();
        input.select();
      }

      function isModelSaved(model) {
        const name = (model.name || "").trim();
        if (!name) return false;
        return (currentSnapshot.effectiveConfig?.models || []).some((item) => item.name === name);
      }

      function getModelGroupKey(model) {
        return model.connection_mode === "custom" && (model.custom_provider || "").trim() ? model.custom_provider : "";
      }

      function getGroupModels(providerName) {
        return formState.models.filter((model) => getModelGroupKey(model) === providerName);
      }

      function getSuffixedName(model, providerName) {
        return (model.model || "").trim() + "-" + providerName;
      }

      function isSuffixedName(model, providerName) {
        return Boolean((model.model || "").trim()) && model.name === getSuffixedName(model, providerName);
      }

      // The suffix option is derived from the model names, so it needs no extra config field.
      function isGroupSuffixed(providerName) {
        const members = getGroupModels(providerName);
        return members.length > 0 && members.every((model) => isSuffixedName(model, providerName));
      }

      function renameModelRef(model, nextName) {
        const previousRef = normalizeModelRef(model.name);
        model.name = nextName;
        if (!previousRef || previousRef === nextName) return;
        formState.fallbackGroups.forEach((group) => {
          group.members.forEach((member) => {
            if (normalizeModelRef(member.value) === previousRef) member.value = nextName;
          });
        });
      }

      function setGroupSuffix(providerName, enabled) {
        getGroupModels(providerName).forEach((model) => {
          const base = (model.model || "").trim();
          if (!base) return;
          renameModelRef(model, enabled ? getSuffixedName(model, providerName) : base);
        });
        markDirty(true);
        renderAll({ preserveScroll: true, scrollToFocus: false });
      }

      function deleteGroupModels(providerName) {
        const members = getGroupModels(providerName);
        if (members.length === 0) return;
        if (!window.confirm(tr(T.deleteGroupModelsConfirm, { provider: providerName, n: members.length }))) return;
        const removedIds = new Set(members.map((model) => model._id));
        formState.models = formState.models.filter((model) => !removedIds.has(model._id));
        const remainingNames = new Set(formState.models.map((model) => normalizeModelRef(model.name)));
        const removedNames = new Set(members.map((model) => normalizeModelRef(model.name)).filter((name) => !remainingNames.has(name)));
        formState.fallbackGroups.forEach((group) => {
          group.members = group.members.filter((member) => !removedNames.has(normalizeModelRef(member.value)));
        });
        expandedModelGroups.delete(providerName);
        markDirty(true);
        renderAll({ preserveScroll: true, scrollToFocus: false });
      }

      function describeModelSource(model) {
        const groupKey = getModelGroupKey(model);
        const upstream = (model.model || "").trim() || T.noUpstreamModel;
        return groupKey ? tr(T.providerModelSource, { provider: groupKey, model: upstream }) : tr(T.standaloneModelSource, { model: upstream });
      }

      // Public names must be unique across models and fallback groups. Returns name -> [{ label, model }] for clashing names.
      function getNameConflicts() {
        const byName = new Map();
        const add = (name, source) => {
          if (!name) return;
          if (!byName.has(name)) byName.set(name, []);
          byName.get(name).push(source);
        };
        formState.models.forEach((model) => add(normalizeModelRef(model.name), { label: describeModelSource(model), model }));
        formState.fallbackGroups.forEach((group) => add(normalizeModelRef(group.name), { label: T.fallbackGroupLabel, model: null }));
        return new Map(Array.from(byName.entries()).filter(([, sources]) => sources.length > 1));
      }

      function describeOtherSources(sources, self) {
        return sources.filter((source) => source.model !== self).map((source) => source.label).join(T.listSeparator);
      }

      function describeOtherSourcesForGroup(sources) {
        const labels = sources.filter((source) => source.model).map((source) => source.label);
        if (sources.filter((source) => !source.model).length > 1) labels.push(T.otherFallbackGroups);
        return labels.join(T.listSeparator);
      }

      function scrollToElement(selector) {
        requestAnimationFrame(() => {
          const target = document.querySelector(selector);
          if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }

      function locateModelGroup(providerName) {
        if (!providerName) return;
        expandedModelGroups.add(providerName);
        renderAll({ preserveScroll: true, scrollToFocus: false });
        scrollToElement("[data-model-group=\"" + providerName.replace(/["\\]/g, "\\$&") + "\"]");
      }

      function locateProvider(provider) {
        provider._expanded = true;
        pendingFocusTarget = "provider-name-" + provider._id;
        renderAll();
      }

      function locateModel(model) {
        const groupKey = getModelGroupKey(model);
        if (groupKey) expandedModelGroups.add(groupKey);
        model._expanded = true;
        pendingFocusTarget = "model-name-" + model._id;
        renderAll();
      }

      function buildConflictBanner(conflicts) {
        const box = document.createElement("div");
        box.className = "error-box conflict-banner";
        const title = document.createElement("div");
        title.textContent = "⚠ " + tr(T.conflictsFound, { n: conflicts.size });
        box.appendChild(title);
        conflicts.forEach((sources, name) => {
          const row = document.createElement("div");
          row.className = "conflict-row";
          const label = document.createElement("code");
          label.textContent = name;
          row.appendChild(label);
          sources.forEach((source) => {
            if (source.model) {
              row.appendChild(createActionButton(source.label, "ghost", () => locateModel(source.model)));
            } else {
              const text = document.createElement("span");
              text.className = "helper";
              text.textContent = source.label;
              row.appendChild(text);
            }
          });
          box.appendChild(row);
        });
        return box;
      }

      function openFetchModelsDialog(provider) {
        const providerName = (provider.name || "").trim();
        const dialog = document.createElement("dialog");
        dialog.className = "model-test-dialog";
        const body = document.createElement("div");
        body.className = "model-test-body";

        const heading = document.createElement("h3");
        heading.textContent = T.fetchModelsTitle + providerName;
        body.appendChild(heading);

        const note = document.createElement("div");
        note.className = "helper";
        const isSubscription = SUBSCRIPTION_PROVIDERS.includes(provider.provider);
        note.textContent = (isSubscription
          ? (provider.provider === "claude-subscription"
              ? T.fetchViaClaude
              : T.fetchViaOpenAI)
          : T.fetchViaForm) +
          T.fetchNote;
        body.appendChild(note);

        const status = document.createElement("div");
        status.className = "status";
        body.appendChild(status);

        const toolbar = document.createElement("div");
        toolbar.className = "fetch-model-toolbar";
        const filter = document.createElement("input");
        filter.type = "search";
        filter.placeholder = T.filterModelIds;
        const selectAllButton = createActionButton(T.selectAll, "secondary", () => {
          const targets = selectableVisibleIds();
          const allSelected = targets.length > 0 && targets.every((id) => selected.has(id));
          targets.forEach((id) => (allSelected ? selected.delete(id) : selected.add(id)));
          renderList();
        });
        toolbar.append(filter, selectAllButton);
        body.appendChild(toolbar);

        const list = document.createElement("div");
        list.className = "fetch-model-list";
        body.appendChild(list);

        const actions = document.createElement("div");
        actions.className = "model-test-actions";
        const closeButton = createActionButton(T.close, "ghost", () => dialog.close());
        const reloadButton = createActionButton(T.refetch, "secondary", () => load());
        const addButton = createActionButton(T.addModels, "", () => {
          const addedModels = getAddedModelIds();
          const ids = allIds.filter((id) => selected.has(id) && !addedModels.has(id));
          if (ids.length === 0) return;
          const suffixed = isGroupSuffixed(providerName);
          ids.forEach((id) => {
            formState.models.push({
              _id: nextId("model"),
              _expanded: false,
              name: suffixed ? id + "-" + providerName : id,
              provider: provider.provider === "claude-subscription" ? "anthropic" : provider.provider === "openai-subscription" ? "openai-responses" : provider.provider,
              connection_mode: "custom",
              custom_provider: providerName,
              base_url: "",
              api_key: "",
              model: id,
              proxy: "",
              body_expression: "",
              response_expression: "",
              extras: {},
              _advancedExpanded: false,
              _advancedJsonText: "{}",
              _extrasError: "",
            });
          });
          expandedModelGroups.add(providerName);
          const duplicates = getNameConflicts();
          const conflicts = formState.models
            .filter((model) => getModelGroupKey(model) === providerName && duplicates.has(normalizeModelRef(model.name)))
            .map((model) => normalizeModelRef(model.name));
          markDirty(true);
          dialog.close();
          renderAll({ preserveScroll: true, scrollToFocus: false });
          setStatus(
            conflicts.length > 0 ? "warn" : "success",
            tr(T.modelsAdded, { n: ids.length }) +
              (conflicts.length > 0 ? tr(T.modelsAddedConflicts, { n: conflicts.length, names: conflicts.slice(0, 5).join(", ") + (conflicts.length > 5 ? " …" : "") }) : ""),
          );
        });
        actions.append(closeButton, reloadButton, addButton);
        body.appendChild(actions);

        let allIds = [];
        const selected = new Set();

        function getAddedModelIds() {
          return new Set(getGroupModels(providerName).map((model) => (model.model || "").trim()));
        }

        function visibleIds() {
          const query = filter.value.trim().toLowerCase();
          return allIds.filter((id) => !query || id.toLowerCase().includes(query));
        }

        function selectableVisibleIds() {
          const addedModels = getAddedModelIds();
          return visibleIds().filter((id) => !addedModels.has(id));
        }

        function renderList() {
          const addedModels = getAddedModelIds();
          list.textContent = "";
          const ids = visibleIds();
          if (ids.length === 0) {
            const empty = document.createElement("div");
            empty.className = "helper";
            empty.textContent = allIds.length === 0 ? T.noModelsYet : T.noMatchingModels;
            list.appendChild(empty);
          }
          ids.forEach((id) => {
            const isAdded = addedModels.has(id);
            const row = document.createElement("label");
            row.className = "fetch-model-item" + (isAdded ? " added" : "");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = isAdded || selected.has(id);
            checkbox.disabled = isAdded;
            checkbox.addEventListener("change", () => {
              if (checkbox.checked) selected.add(id); else selected.delete(id);
              renderList();
            });
            const text = document.createElement("span");
            text.textContent = id + (isAdded ? T.addedSuffix : "");
            row.append(checkbox, text);
            list.appendChild(row);
          });
          const targets = selectableVisibleIds();
          const allSelected = targets.length > 0 && targets.every((id) => selected.has(id));
          selectAllButton.textContent = allSelected ? T.deselectAll : T.selectAll;
          selectAllButton.disabled = targets.length === 0;
          const count = allIds.filter((id) => selected.has(id) && !addedModels.has(id)).length;
          addButton.textContent = tr(T.addModelsCount, { n: count });
          addButton.disabled = count === 0;
        }

        async function load() {
          reloadButton.disabled = true;
          status.className = "status warn";
          status.textContent = T.fetching;
          try {
            const response = isSubscription
              ? await fetch("/admin/providers/" + encodeURIComponent(providerName) + "/models", { cache: "no-store" })
              : await fetch("/admin/upstream-models", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ provider: provider.provider, base_url: provider.base_url, api_key: provider.api_key, proxy: provider.proxy || "" }),
                });
            const payload = readJsonResponse(await response.text());
            if (!response.ok || !payload.ok) throw new Error(typeof payload.error === "string" ? payload.error : T.fetchModelsFailed);
            allIds = Array.isArray(payload.models) ? payload.models : [];
            selected.clear();
            status.className = "status success";
            status.textContent = tr(T.fetchedCount, { n: allIds.length });
          } catch (error) {
            allIds = [];
            status.className = "status error";
            status.textContent = error instanceof Error ? error.message : String(error);
          } finally {
            reloadButton.disabled = false;
            renderList();
          }
        }

        filter.addEventListener("input", renderList);
        renderList();
        dialog.appendChild(body);
        document.body.appendChild(dialog);
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        dialog.showModal();
        filter.focus();
        load();
      }

      function buildModelGroupCard(providerName, duplicateNames) {
        const members = getGroupModels(providerName);
        const expanded = expandedModelGroups.has(providerName);
        const provider = formState.providers.find((item) => item.name === providerName);
        const card = document.createElement("section");
        card.className = "card group-card" + (expanded ? "" : " compact");
        card.setAttribute("data-model-group", providerName);

        const head = document.createElement("div");
        head.className = "card-head";
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "card-toggle";
        toggle.addEventListener("click", () => {
          if (expanded) expandedModelGroups.delete(providerName); else expandedModelGroups.add(providerName);
          renderAll({ preserveScroll: true, scrollToFocus: false });
        });
        const toggleTop = document.createElement("div");
        toggleTop.className = "card-toggle-top";
        const chevron = document.createElement("span");
        chevron.className = "card-chevron";
        chevron.textContent = expanded ? "▾" : "▸";
        const title = document.createElement("div");
        title.className = "card-title";
        const h3 = document.createElement("h3");
        h3.textContent = providerName;
        title.appendChild(h3);
        const kindBadge = document.createElement("div");
        kindBadge.className = "pill kind";
        kindBadge.textContent = T.providerBadge;
        title.appendChild(kindBadge);
        const countBadge = document.createElement("div");
        countBadge.className = "pill neutral";
        countBadge.textContent = tr(T.modelCount, { n: members.length });
        title.appendChild(countBadge);
        const conflictedMembers = members.filter((model) => duplicateNames.has(normalizeModelRef(model.name)));
        if (conflictedMembers.length > 0) {
          card.classList.add("conflict");
          const badge = document.createElement("div");
          badge.className = "pill conflict";
          badge.textContent = "⚠ " + tr(T.modelNameConflicts, { n: conflictedMembers.length });
          badge.title = T.conflictedModels + conflictedMembers.map((model) => normalizeModelRef(model.name)).join(T.listSeparator) + T.expandToSeeMarks;
          title.appendChild(badge);
        }
        toggleTop.append(chevron, title);
        toggle.appendChild(toggleTop);
        const summary = document.createElement("div");
        summary.className = "card-summary";
        summary.textContent = provider
          ? (SUBSCRIPTION_PROVIDERS.includes(provider.provider) ? provider.provider : (provider.provider || T.noProtocol) + " · " + (provider.base_url || T.noBaseUrl))
          : T.providerNotFound;
        toggle.appendChild(summary);
        head.appendChild(toggle);

        const actions = document.createElement("div");
        actions.className = "card-actions";
        const suffixLabel = document.createElement("label");
        suffixLabel.className = "suffix-toggle";
        suffixLabel.title = T.suffixTitle;
        const suffixCheckbox = document.createElement("input");
        suffixCheckbox.type = "checkbox";
        suffixCheckbox.checked = isGroupSuffixed(providerName);
        suffixCheckbox.addEventListener("change", () => setGroupSuffix(providerName, suffixCheckbox.checked));
        suffixLabel.append(suffixCheckbox, document.createTextNode(T.addProviderSuffix));
        if (provider) actions.appendChild(createActionButton(T.editProvider, "ghost", () => locateProvider(provider)));
        actions.appendChild(suffixLabel);
        actions.appendChild(createActionButton(T.deleteAllModels, "danger", () => deleteGroupModels(providerName)));
        head.appendChild(actions);
        card.appendChild(head);

        // Members are only rendered while expanded so that very large groups stay cheap.
        if (expanded) {
          const body = document.createElement("div");
          body.className = "group-body";
          members.forEach((model) => body.appendChild(buildModelCard(model, formState.models.indexOf(model), duplicateNames)));
          card.appendChild(body);
        }
        return card;
      }

      function renderModels() {
        modelsContainer.textContent = "";
        if (formState.models.length === 0) {
          const empty = document.createElement("div");
          empty.className = "note-box";
          empty.textContent = T.noModels;
          modelsContainer.appendChild(empty);
          return;
        }
        const duplicateNames = getNameConflicts();
        if (duplicateNames.size > 0) modelsContainer.appendChild(buildConflictBanner(duplicateNames));
        // Provider groups come first (ordered by their first member), standalone models follow.
        const groupKeys = [];
        formState.models.forEach((model) => {
          const groupKey = getModelGroupKey(model);
          if (groupKey && !groupKeys.includes(groupKey)) groupKeys.push(groupKey);
        });
        const standalone = formState.models
          .map((model, index) => ({ model, index }))
          .filter(({ model }) => !getModelGroupKey(model));
        const addHeading = (text) => {
          const heading = document.createElement("div");
          heading.className = "subhead";
          heading.textContent = text;
          modelsContainer.appendChild(heading);
        };
        const showHeadings = groupKeys.length > 0 && standalone.length > 0;
        if (showHeadings) addHeading(tr(T.providerModelsHeading, { n: groupKeys.length }));
        groupKeys.forEach((groupKey) => modelsContainer.appendChild(buildModelGroupCard(groupKey, duplicateNames)));
        if (showHeadings) addHeading(tr(T.standaloneModelsHeading, { n: standalone.length }));
        standalone.forEach(({ model, index }) => modelsContainer.appendChild(buildModelCard(model, index, duplicateNames)));
      }

      function buildModelCard(model, index, duplicateNames) {
          const nameSources = duplicateNames.get(normalizeModelRef(model.name));
          const nameConflict = nameSources ? tr(T.nameClash, { others: describeOtherSources(nameSources, model) }) : "";
          const card = document.createElement("section");
          card.className = "card" + (model._expanded ? "" : " compact") + (nameConflict ? " conflict" : "");

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
          h3.textContent = model.name?.trim() || tr(T.unnamedModelN, { n: index + 1 });
          title.appendChild(h3);
          if (nameConflict) {
            const badge = document.createElement("div");
            badge.className = "pill conflict";
            badge.textContent = "⚠ " + T.nameConflict;
            badge.title = nameConflict;
            title.appendChild(badge);
          }
          if (model.extras && Object.keys(model.extras).length > 0) {
            const badge = document.createElement("div");
            badge.className = "pill neutral";
            badge.textContent = T.keepsAdvanced;
            badge.title = formatExtrasDetail(model.extras);
            title.appendChild(badge);
          }
          const expressionKeys = ["body_expression", "response_expression"].filter((key) => (model[key] || "").trim());
          if (expressionKeys.length > 0) {
            const badge = document.createElement("div");
            badge.className = "pill neutral";
            badge.textContent = expressionKeys.join(" · ");
            title.appendChild(badge);
          }
          toggleTop.appendChild(title);
          toggle.appendChild(toggleTop);

          const summary = document.createElement("div");
          summary.className = "card-summary";
          summary.textContent = buildModelSummary(model);
          toggle.appendChild(summary);

          head.appendChild(toggle);
          const actions = document.createElement("div");
          actions.className = "card-actions";
          if (getEffectiveModelProvider(model) !== "openai-image") {
            const testButton = createActionButton(T.test, "secondary", () => openModelTestDialog(model));
            if (!isModelSaved(model)) {
              // Testing uses the server-side saved config, so an unsaved model would always fail.
              testButton.disabled = true;
              testButton.setAttribute("data-blocked", "1");
              testButton.title = T.saveBeforeTest;
            }
            actions.appendChild(testButton);
          }
          actions.appendChild(
            createActionButton(T.duplicate, "secondary", () => {
              const id = nextId("model");
              const duplicate = clone(model);
              duplicate._id = id;
              duplicate._expanded = true;
              formState.models.splice(index + 1, 0, duplicate);
              pendingFocusTarget = "model-name-" + id;
              markDirty(true);
              renderAll();
            }),
          );
          actions.appendChild(
            createActionButton(T.deleteModel, "danger", () => {
              const deletedName = normalizeModelRef(model.name);
              formState.models = formState.models.filter((item) => item._id !== model._id);
              formState.fallbackGroups.forEach((group) => {
                group.members = group.members.filter((member) => normalizeModelRef(member.value) !== deletedName);
              });
              markDirty(true);
              renderAll();
            }),
          );
          head.appendChild(actions);
          attachCardDrag(card, head, "model", () => formState.models, model);
          card.appendChild(head);

          const body = document.createElement("div");
          body.className = "card-body";
          body.hidden = !model._expanded;

          const grid = document.createElement("div");
          grid.className = "field-grid two";
          bindField(grid, "name", {
            value: model.name,
            invalid: Boolean(nameConflict),
            helper: nameConflict ? "⚠ " + nameConflict : "",
            helperError: true,
            attributes: { "data-focus-id": "model-name-" + model._id },
            onInput(value) {
              const previousName = model.name;
              model.name = value;
              if (previousName !== value) {
                const previousRef = normalizeModelRef(previousName);
                formState.fallbackGroups.forEach((group) => {
                  group.members.forEach((member) => {
                    if (normalizeModelRef(member.value) === previousRef) member.value = value;
                  });
                });
              }
              markDirty(true);
              pendingFocusTarget = "model-name-" + model._id;
              renderAll({ preserveScroll: true, scrollToFocus: false });
            },
          });
          bindField(grid, "provider", {
            type: "select",
            options: [...MODEL_PROVIDERS, "custom_provider"],
            value: model.connection_mode === "custom" ? "custom_provider" : (model.provider || PROVIDERS[0]),
            onInput(value) {
              if (value === "custom_provider") {
                model.connection_mode = "custom";
                model.custom_provider = model.custom_provider || formState.providers[0]?.name || "";
                if (model.custom_provider) expandedModelGroups.add(model.custom_provider);
              } else {
                model.connection_mode = "direct";
                model.provider = value;
                model.custom_provider = "";
              }
              markDirty(true);
              renderAll({ preserveScroll: true, scrollToFocus: false });
            },
          });
          if (model.connection_mode === "custom") {
            bindField(grid, T.customProviderLabel, {
              type: "select",
              options: formState.providers.map((provider) => provider.name),
              value: model.custom_provider || "",
              helper: formState.providers.length > 0 ? "" : T.addProviderFirst,
              onInput(value) {
                model.custom_provider = value;
                if (value) expandedModelGroups.add(value);
                markDirty(true);
                renderAll({ preserveScroll: true, scrollToFocus: false });
              },
            });
          }
          if (model.connection_mode === "direct") {
            bindField(grid, "base_url", {
              value: model.base_url,
              placeholder: "https://example.com/v1",
              onInput(value) {
                model.base_url = value;
                markDirty(true);
              },
            });
          }
          bindField(grid, "model", {
            value: model.model,
            placeholder: T.upstreamModelPlaceholder,
            onInput(value) {
              model.model = value;
              markDirty(true);
            },
          });
          if (model.connection_mode === "direct") {
            bindField(grid, "api_key", {
              spanClass: "span-2",
              value: model.api_key,
              placeholder: T.apiKeyPlaceholder,
              onInput(value) {
                model.api_key = value;
                markDirty(true);
              },
            });
          }
          bindField(grid, "proxy", {
            spanClass: "span-2",
            value: model.proxy || "",
            placeholder: "http://127.0.0.1:7890",
            helper: T.modelProxyHelper,
            onInput(value) {
              model.proxy = value;
              markDirty(true);
            },
          });
          bindAuthTokenField(grid, model, T.modelAuthTokenHelper);
          bindExpressionField(grid, model, "body_expression", {
            placeholder: "({\n  ...body,\n  temperature: 0.2,\n})",
            helper: T.bodyExpressionHelper,
          });
          bindExpressionField(grid, model, "response_expression", {
            placeholder: "(() => {\n  if (response.model !== 'expected') throw new Error('unexpected model');\n  return response;\n})()",
            helper: T.responseExpressionHelper,
          });
          bindAdvancedJsonField(grid, model, index);
          body.appendChild(grid);

          card.appendChild(body);

          return card;
      }

      function renderFallbackGroups() {
        fallbackContainer.textContent = "";
        if (formState.fallbackGroups.length === 0) {
          const empty = document.createElement("div");
          empty.className = "note-box";
          empty.textContent = T.noFallbackGroups;
          fallbackContainer.appendChild(empty);
          return;
        }

        const options = getModelNameOptions();
        const nameConflicts = getNameConflicts();

        formState.fallbackGroups.forEach((group, index) => {
          const card = document.createElement("section");
          card.className = "card" + (group._expanded ? "" : " compact");
          const duplicateMembers = getDuplicateMembers(group);

          const head = document.createElement("div");
          head.className = "card-head";
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "card-toggle";
          toggle.addEventListener("click", () => {
            group._expanded = !group._expanded;
            renderAll();
          });
          const toggleTop = document.createElement("div");
          toggleTop.className = "card-toggle-top";
          const chevron = document.createElement("span");
          chevron.className = "card-chevron";
          chevron.textContent = group._expanded ? "▾" : "▸";
          const title = document.createElement("div");
          title.className = "card-title";
          const h3 = document.createElement("h3");
          h3.textContent = group.name?.trim() || tr(T.unnamedGroupN, { n: index + 1 });
          title.appendChild(h3);
          toggleTop.appendChild(chevron);
          toggleTop.appendChild(title);
          toggle.appendChild(toggleTop);
          const summary = document.createElement("div");
          summary.className = "card-summary";
          summary.textContent = tr(T.modelCount, { n: group.members.length });
          toggle.appendChild(summary);
          head.appendChild(toggle);
          const headActions = document.createElement("div");
          headActions.className = "card-actions";
          headActions.appendChild(
            createActionButton(T.deleteGroup, "danger", () => {
              formState.fallbackGroups = formState.fallbackGroups.filter((item) => item._id !== group._id);
              markDirty(true);
              renderAll();
            }),
          );
          head.appendChild(headActions);
          attachCardDrag(card, head, "fallback", () => formState.fallbackGroups, group);
          card.appendChild(head);

          const body = document.createElement("div");
          body.className = "card-body";
          body.hidden = !group._expanded;

          const grid = document.createElement("div");
          grid.className = "field-grid";
          const groupNameSources = nameConflicts.get(normalizeModelRef(group.name));
          bindField(grid, "group name", {
            spanClass: "span-3",
            value: group.name,
            invalid: Boolean(groupNameSources),
            helper: groupNameSources ? "⚠ " + tr(T.groupNameClash, { others: describeOtherSourcesForGroup(groupNameSources) }) : "",
            helperError: true,
            attributes: { "data-focus-id": "fallback-name-" + group._id },
            placeholder: T.groupNamePlaceholder,
            onInput(value) {
              group.name = value;
              markDirty(true);
              pendingFocusTarget = "fallback-name-" + group._id;
              renderAll({ preserveScroll: true, scrollToFocus: false });
            },
          });
          bindAuthTokenField(grid, group, T.groupAuthTokenHelper);
          body.appendChild(grid);

          const membersWrap = document.createElement("div");
          membersWrap.className = "member-list";
          if (duplicateMembers.length > 0) {
            const helper = document.createElement("div");
            helper.className = "error-box";
            helper.textContent = tr(T.duplicateMembers, { names: duplicateMembers.join(", ") });
            membersWrap.appendChild(helper);
          }
          if (group.members.length === 0) {
            const helper = document.createElement("div");
            helper.className = "helper";
            helper.textContent = T.noMembers;
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
            handle.title = T.dragToReorder;
            handle.setAttribute("aria-label", T.dragToReorder);
            row.appendChild(handle);

            const select = document.createElement("select");
            const blank = document.createElement("option");
            blank.value = "";
            blank.textContent = options.length === 0 ? T.addModelsFirst : T.chooseModel;
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
              createActionButton(T.moveUp, "ghost", () => {
                if (memberIndex === 0) return;
                moveArrayItem(group.members, memberIndex, memberIndex - 1);
                markDirty(true);
                pendingFocusTarget = "fallback-member-" + member._id;
                renderAll();
              }),
            );
            actions.appendChild(
              createActionButton(T.moveDown, "ghost", () => {
                if (memberIndex === group.members.length - 1) return;
                moveArrayItem(group.members, memberIndex, memberIndex + 1);
                markDirty(true);
                pendingFocusTarget = "fallback-member-" + member._id;
                renderAll();
              }),
            );
            actions.appendChild(createActionButton(T.remove, "ghost", () => {
              group.members = group.members.filter((item) => item._id !== member._id);
              markDirty(true);
              renderAll();
            }));

            row.appendChild(select);
            row.appendChild(actions);
            membersWrap.appendChild(row);
          });

          body.appendChild(membersWrap);

          body.appendChild(
            createActionButton(T.addModelToGroup, "secondary", () => {
              const memberId = nextId("member");
              const used = new Set(group.members.map((item) => item.value).filter(Boolean));
              const nextValue = options.find((option) => !used.has(option)) || "";
              group.members.push({ _id: memberId, value: nextValue });
              markDirty(true);
              pendingFocusTarget = "fallback-member-" + memberId;
              renderAll();
            }),
          );
          card.appendChild(body);

          fallbackContainer.appendChild(card);
        });
      }

      function renderAll({ preserveScroll = false, scrollToFocus = true } = {}) {
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;
        const selection = captureFocusedSelection();
        renderSnapshotMeta();
        renderGlobalFields();
        renderProviders();
        renderModels();
        renderFallbackGroups();
        if (preserveScroll) window.scrollTo(scrollX, scrollY);
        focusPendingTarget({ scrollToFocus, selection });
        if (preserveScroll) {
          requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
        }
      }

      async function refreshFromServer() {
        const response = await fetch("/admin/config/data", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || T.refreshConfigFailed);
        }
        currentSnapshot = payload;
        formState = hydrateForm(payload.form);
        subscriptionStatusCache.clear();
        markDirty(false);
        renderAll();
        return payload;
      }

      function isHistoryRestore(event) {
        if (event && event.persisted) return true;
        if (typeof performance.getEntriesByType === "function") {
          const navigationEntry = performance.getEntriesByType("navigation")[0];
          if (navigationEntry && navigationEntry.type === "back_forward") {
            return true;
          }
        }
        return Boolean(performance.navigation && performance.navigation.type === 2);
      }

      function syncAfterHistoryRestore(event) {
        if (saving || dirty || !isHistoryRestore(event)) return;
        refreshFromServer().catch((error) => {
          setStatus("error", error instanceof Error ? error.message : T.refreshFailed);
        });
      }

      async function saveConfig() {
        setSaving(true);
        setStatus("warn", T.saving);
        try {
          let config;
          try {
            config = dehydrateForm();
          } catch (error) {
            setStatus("error", error instanceof Error ? error.message : T.advancedJsonInvalid);
            renderAll({ preserveScroll: true, scrollToFocus: false });
            return;
          }
          const response = await fetch("/admin/config/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              config,
              baseVersion: currentSnapshot.version,
            }),
          });
          const payload = await response.json();
          if (!response.ok) {
            if (payload.currentSnapshot) {
              currentSnapshot = payload.currentSnapshot;
              if (response.status === 409) {
                formState = hydrateForm(payload.currentSnapshot.form);
                subscriptionStatusCache.clear();
              }
              renderAll();
            }
            if (response.status === 409) {
              setStatus("error", T.saveConflict);
              return;
            }
            setStatus("error", payload.error || T.saveFailed);
            return;
          }

          currentSnapshot = payload.snapshot;
          formState = hydrateForm(payload.snapshot.form);
          subscriptionStatusCache.clear();
          markDirty(false);
          renderAll();
          if (payload.requiresRestartFields.length > 0) {
            setStatus("warn", T.savedNeedsRestart);
          } else {
            setStatus("success", T.saved);
          }
        } catch (error) {
          setStatus("error", error instanceof Error ? error.message : T.saveFailed);
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
          connection_mode: "direct",
          custom_provider: "",
          base_url: "",
          api_key: "",
          model: "",
          proxy: "",
          body_expression: "",
          response_expression: "",
          extras: {},
          _advancedExpanded: false,
          _advancedJsonText: "{}",
          _extrasError: "",
        });
        pendingFocusTarget = "model-name-" + id;
        markDirty(true);
        renderAll();
      });

      document.getElementById("add-provider-button").addEventListener("click", () => {
        const id = nextId("provider");
        formState.providers.push({
          _id: id,
          _expanded: true,
          _groupName: "",
          name: "",
          provider: "openai-chat",
          base_url: "",
          api_key: "",
          proxy: "",
        });
        pendingFocusTarget = "provider-name-" + id;
        markDirty(true);
        renderAll();
      });

      document.getElementById("add-fallback-button").addEventListener("click", () => {
        const id = nextId("fallback");
        formState.fallbackGroups.push({
          _id: id,
          _expanded: true,
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
          setStatus("error", error instanceof Error ? error.message : T.saveFailed);
        });
      });

      refreshButton.addEventListener("click", () => {
        refreshFromServer()
          .then(() => setStatus("success", T.refreshed))
          .catch((error) => setStatus("error", error instanceof Error ? error.message : T.refreshFailed));
      });

      resetButton.addEventListener("click", () => {
        formState = hydrateForm(currentSnapshot.form);
        markDirty(false);
        renderAll();
        setStatus("", T.reverted);
      });

      window.addEventListener("pageshow", (event) => {
        syncAfterHistoryRestore(event);
      });

      renderAll();
`;

function AdminConfigPage({ payload, lang }: { payload: Record<string, unknown>; lang: Lang }) {
  const m = MESSAGES[lang];
  return (
    <html lang={htmlLang(lang)}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>nanollm config admin</title>
        <link rel="icon" type="image/svg+xml" href={LOGO_DATA_URI} />
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>
        <main class="page">
          <div class="stack">
            <section class="panel">
              <div class="section-header">
                <div>
                  <h1>Config Admin</h1>
                  <p class="meta">{m.introBefore}<code>config.yaml</code>{m.introAfter}</p>
                </div>
                <div class="toolbar">
                  <button id="save-button" type="button">{m.saveAndApply}</button>
                  <button id="refresh-button" class="secondary" type="button">{m.refreshFromServer}</button>
                  <button id="reset-button" class="ghost" type="button">{m.discardChanges}</button>
                </div>
              </div>
              <div class="status-row">
                <div class="pills" id="summary-pills"></div>
                <div class="status" id="save-status"></div>
                <div class="note-box" id="snapshot-meta"></div>
                <div class="note-box">{m.noteBox}</div>
                <div class="error-box" id="error-box" hidden>
                  <div id="error-text"></div>
                </div>
                <div class="quick-links">
                  <a class="quick-link" href="/status">
                    <div class="quick-link-title">/status</div>
                    <div class="quick-link-desc">{m.statusDesc}</div>
                  </a>
                  <a class="quick-link" href="/record">
                    <div class="quick-link-title">/record</div>
                    <div class="quick-link-desc">{m.recordDesc}</div>
                  </a>
                  <a class="quick-link" href="/jobs">
                    <div class="quick-link-title">/jobs</div>
                    <div class="quick-link-desc">{m.jobsDesc}</div>
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
                  <h2>Providers</h2>
                  <p class="meta">{m.providersIntro}</p>
                </div>
                <button id="add-provider-button" class="secondary" type="button">{m.addProvider}</button>
              </div>
              <div class="card-list" id="providers-container"></div>
            </section>

            <section class="panel">
              <div class="section-header">
                <div>
                  <h2>Models</h2>
                  <p class="meta">{m.modelsIntro}</p>
                </div>
                <button id="add-model-button" class="secondary" type="button">{m.addModel}</button>
              </div>
              <div class="card-list" id="models-container"></div>
            </section>

            <section class="panel">
              <div class="section-header">
                <div>
                  <h2>Fallback</h2>
                  <p class="meta">{m.fallbackIntro}</p>
                </div>
                <button id="add-fallback-button" class="secondary" type="button">{m.addGroup}</button>
              </div>
              <div class="card-list" id="fallback-container"></div>
            </section>
          </div>
        </main>
        <script
          dangerouslySetInnerHTML={{
            __html: SCRIPT
              .replace("__INITIAL_PAYLOAD__", serializeForScript(payload))
              .replace("__MESSAGES__", serializeForScript(m)),
          }}
        />
      </body>
    </html>
  );
}

export function renderAdminConfigPage(payload: Record<string, unknown>, lang: Lang = "zh"): string {
  return withPageCorner("<!doctype html>" + renderToString(<AdminConfigPage payload={payload} lang={lang} />), lang, { scrolls: true });
}
