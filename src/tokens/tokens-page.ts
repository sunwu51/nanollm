import { LOGO_DATA_URI } from "../pages/logo.js";
import { htmlLang, withPageCorner, type Lang } from "../core/i18n.js";

function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

const zh = {
  title: "访问令牌 · nanollm",
  heading: "访问令牌",
  intro: "客户端用 Authorization: Bearer 或 x-api-key 发送令牌，只能使用该令牌下列出的模型名，每个名字转发到一个模型或 fallback 分组。以 * 结尾的名字按前缀映射（例如 claude-* → wild-*）。管理员令牌仍可使用所有模型。保存后写入 config.yaml 的 tokens 并立即生效。",
  noAdminToken: "当前没有配置管理员令牌：未被任何令牌映射的模型对所有人开放；被令牌映射的模型和分组只能通过令牌访问。",
  newToken: "新建令牌",
  save: "保存并应用",
  reload: "重新加载",
  saved: "已保存并应用",
  noTokens: "还没有令牌。点击“新建令牌”添加一个。",
  name: "名称",
  namePlaceholder: "可选，例如 team-a",
  value: "令牌值",
  valuePlaceholder: "sk-… 或 ${ENV_VAR}",
  generate: "生成",
  copy: "复制",
  copied: "已复制",
  deleteToken: "删除令牌",
  models: "可用模型",
  alias: "客户端模型名",
  aliasPlaceholder: "客户端传的 model",
  target: "转发到",
  chooseTarget: "选择模型或分组",
  groups: "Fallback 分组",
  modelsGroup: "模型",
  missing: "（不存在）",
  addModel: "添加模型",
  remove: "移除",
  noModels: "这个令牌还不能使用任何模型。",
  untitled: "未命名令牌",
  modelCount: "{n} 个模型",
  requestFailed: "请求失败",
  unsavedReload: "有未保存的修改，确定重新加载？",
  confirmDelete: "删除令牌“{name}”？保存后使用它的客户端将无法访问。",
};

const MESSAGES: Record<Lang, typeof zh> = {
  zh,
  en: {
    title: "Tokens · nanollm",
    heading: "Tokens",
    intro: "Clients send a token as Authorization: Bearer or x-api-key and can only use the model names listed under it; each name routes to a model or fallback group. A name ending in * maps a prefix (for example claude-* → wild-*). The admin token can still use every model. Saving writes the tokens list in config.yaml and applies it right away.",
    noAdminToken: "No admin token is configured: models no token maps to are open to everyone, while the models and groups a token maps to can only be used with a token.",
    newToken: "New token",
    save: "Save and apply",
    reload: "Reload",
    saved: "Saved and applied",
    noTokens: "No tokens yet. Click “New token” to add one.",
    name: "Name",
    namePlaceholder: "Optional, e.g. team-a",
    value: "Token value",
    valuePlaceholder: "sk-… or ${ENV_VAR}",
    generate: "Generate",
    copy: "Copy",
    copied: "Copied",
    deleteToken: "Delete token",
    models: "Available models",
    alias: "Client model name",
    aliasPlaceholder: "model the client sends",
    target: "Routes to",
    chooseTarget: "Choose a model or group",
    groups: "Fallback groups",
    modelsGroup: "Models",
    missing: " (missing)",
    addModel: "Add model",
    remove: "Remove",
    noModels: "This token can't use any model yet.",
    untitled: "Untitled token",
    modelCount: "{n} model{s}",
    requestFailed: "Request failed",
    unsavedReload: "You have unsaved changes. Reload anyway?",
    confirmDelete: "Delete token “{name}”? Once saved, clients using it lose access.",
  },
};

export function renderTokensPage(lang: Lang = "zh"): string {
  const m = MESSAGES[lang];
  return withPageCorner(String.raw`<!doctype html>
<html lang="${htmlLang(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${m.title}</title><link rel="icon" type="image/svg+xml" href="${LOGO_DATA_URI}">
<style>
:root{color-scheme:light;--bg:#f1ede4;--panel:#fffdf8;--text:#30291f;--muted:#786a57;--accent:#8f5b33;--border:#d8cebf}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#faf7f0,var(--bg));color:var(--text);font-family:"Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1100px;margin:auto;padding:28px}main>.toolbar{padding-top:32px}h1{font-size:30px;margin:14px 0}h2{font-size:18px;margin:0}.panel{background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:22px;margin:18px 0;box-shadow:0 12px 32px #43301708}.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.toolbar h1,.toolbar h2{margin-right:auto}.muted{color:var(--muted);font-size:14px;line-height:1.6}.notice{padding:12px 16px;border-radius:10px;background:#f5ebdb;color:#755329;line-height:1.6;margin:12px 0}.danger{color:#ac3f31}.status-message{min-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}button{font:inherit;border:1px solid var(--border);border-radius:9px;padding:9px 14px;cursor:pointer;background:#fffaf2;color:var(--accent)}button.primary{background:var(--accent);color:white;border-color:var(--accent)}button.danger{color:#ac3f31}button:disabled{opacity:.5;cursor:not-allowed}input,select{font:inherit;padding:10px;border:1px solid var(--border);border-radius:8px;background:white;color:var(--text);width:100%;min-width:0}.mono{font-family:Consolas,monospace;font-size:14px}.grid{display:grid;grid-template-columns:1fr 2fr;gap:18px;margin:16px 0}.field{display:grid;gap:8px;align-content:start;min-width:0}.field>label{font-weight:600}.value-row{display:flex;gap:8px}.value-row input{flex:1}.mappings{display:grid;gap:8px}.mapping{display:grid;grid-template-columns:1fr auto 1fr auto;gap:8px;align-items:center}.mapping-head{color:var(--muted);font-size:13px}.panel>h2{margin:8px 0 12px}.arrow{color:var(--muted)}.empty{text-align:center;padding:36px;color:var(--muted)}@media(max-width:700px){main{padding:16px}.panel{padding:16px}.grid{grid-template-columns:1fr}.mapping{grid-template-columns:1fr auto}.mapping .arrow{display:none}.mapping-head{display:none}.value-row{flex-wrap:wrap}}
.back-admin{position:fixed;top:16px;right:16px;z-index:100;padding:8px 14px;border-radius:999px;border:1px solid rgba(140,90,47,.28);background:rgba(255,250,242,.95);color:#8c5a2f;font-size:13px;font-weight:700;text-decoration:none;box-shadow:0 6px 18px rgba(58,43,24,.12)}.back-admin:hover{background:#8c5a2f;color:#fff9f1}
</style></head><body><main><div class="toolbar"><h1>${m.heading}</h1><button id="reload" type="button">${m.reload}</button><button id="add" type="button">${m.newToken}</button><button id="save" class="primary" type="button">${m.save}</button></div><p class="notice">${m.intro}</p><p id="admin-notice" class="notice" hidden>${m.noAdminToken}</p><div id="message" class="status-message" role="status"></div><div id="app"></div></main>
<script>
const T=${serializeForScript(m)};
const fmt=(template,values)=>template.replace(/\{(\w+)\}/g,(match,key)=>key==='s'?(values.n===1?'':'s'):key in values?String(values[key]):match);
const $=id=>document.getElementById(id),app=$('app');
let data,tokens=[],dirty=false;
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
function message(value,error=false){$('message').textContent=value||'';$('message').className='status-message'+(error?' danger':'');}
function markDirty(){dirty=true;message('');}
function button(label,onclick,cls){const b=node('button',label,cls);b.type='button';b.onclick=onclick;return b;}
function input(value,placeholder,oninput,cls){const i=node('input',undefined,cls);i.value=value;i.placeholder=placeholder;i.spellcheck=false;i.autocomplete='off';i.oninput=()=>{oninput(i.value);markDirty();};return i;}
function field(label,control){const f=node('div',undefined,'field'),l=node('label',label);f.append(l,control);return f;}
async function api(path,method='GET',body){const response=await fetch('/tokens/api/'+path,{method,cache:'no-store',headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw new Error(result.error||T.requestFailed);return result;}
function load(result){data=result;tokens=structuredClone(result.tokens);dirty=false;$('admin-notice').hidden=result.hasAdminToken;render();if(result.lastError)message(result.lastError,true);}
function randomToken(){const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);return 'sk-nanollm-'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
function targetSelect(mapping,onchange){const s=node('select');s.append(new Option(T.chooseTarget,''));const known=new Set(data.targets.map(t=>t.name));if(mapping.target&&!known.has(mapping.target))s.append(new Option(mapping.target+T.missing,mapping.target));for(const [kind,label] of [['group',T.groups],['model',T.modelsGroup]]){const items=data.targets.filter(t=>t.kind===kind);if(!items.length)continue;const g=node('optgroup');g.label=label;for(const t of items)g.append(new Option(t.provider?t.name+' · '+t.provider:t.name,t.name));s.append(g);}s.value=mapping.target;s.onchange=()=>{mapping.target=s.value;onchange();markDirty();};return s;}
function mappingRow(token,mapping){const row=node('div',undefined,'mapping');const alias=input(mapping.alias,T.aliasPlaceholder,v=>mapping.alias=v,'mono');alias.setAttribute('aria-label',T.alias);const target=targetSelect(mapping,()=>{if(!mapping.alias.trim()){mapping.alias=mapping.target;alias.value=mapping.target;}});target.setAttribute('aria-label',T.target);row.append(alias,node('span','→','arrow'),target,button(T.remove,()=>{token.models.splice(token.models.indexOf(mapping),1);markDirty();render();}));return row;}
function tokenPanel(token){const panel=node('section',undefined,'panel'),head=node('div',undefined,'toolbar');const title=node('h2',token.name||T.untitled);head.append(title,node('span',fmt(T.modelCount,{n:token.models.length}),'muted'),button(T.deleteToken,()=>{if(!window.confirm(fmt(T.confirmDelete,{name:token.name||T.untitled})))return;tokens.splice(tokens.indexOf(token),1);markDirty();render();},'danger'));panel.append(head);
const grid=node('div',undefined,'grid');grid.append(field(T.name,input(token.name,T.namePlaceholder,v=>{token.name=v;title.textContent=v.trim()||T.untitled;})));const valueRow=node('div',undefined,'value-row'),value=input(token.value,T.valuePlaceholder,v=>token.value=v,'mono');const copy=button(T.copy,async()=>{try{await navigator.clipboard.writeText(value.value);copy.textContent=T.copied;setTimeout(()=>copy.textContent=T.copy,1500);}catch{value.select();}});valueRow.append(value,button(T.generate,()=>{token.value=randomToken();value.value=token.value;markDirty();}),copy);grid.append(field(T.value,valueRow));panel.append(grid);
const list=node('div',undefined,'mappings');panel.append(node('h2',T.models));if(token.models.length){const header=node('div',undefined,'mapping mapping-head');header.append(node('span',T.alias),node('span','→','arrow'),node('span',T.target),node('span'));list.append(header);for(const mapping of token.models)list.append(mappingRow(token,mapping));}else list.append(node('p',T.noModels,'muted'));const tools=node('div',undefined,'toolbar');tools.style.marginTop='12px';tools.append(button(T.addModel,()=>{token.models.push({alias:'',target:''});markDirty();render();}));panel.append(list,tools);return panel;}
function render(){const keepScroll=window.scrollY;app.replaceChildren();if(!tokens.length)app.append(node('p',T.noTokens,'panel empty'));for(const token of tokens)app.append(tokenPanel(token));window.scrollTo(0,keepScroll);}
async function action(fn,b){if(b)b.disabled=true;try{await fn();}catch(e){message(e.message,true);}finally{if(b)b.disabled=false;}}
$('add').onclick=()=>{tokens.push({name:'',value:randomToken(),models:[{alias:'',target:''}]});markDirty();render();app.lastElementChild.scrollIntoView({behavior:'smooth',block:'start'});app.lastElementChild.querySelector('input').focus({preventScroll:true});};
$('save').onclick=()=>action(async()=>{load(await api('tokens','PUT',{tokens,baseVersion:data.version}));message(T.saved);},$('save'));
$('reload').onclick=()=>{if(dirty&&!window.confirm(T.unsavedReload))return;void action(async()=>{load(await api('data'));message('');},$('reload'));};
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
void action(async()=>load(await api('data')));
</script></body></html>`, lang, { backToAdmin: true });
}
