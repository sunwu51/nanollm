import { LOGO_DATA_URI } from "./logo.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderLoginPage(returnTo: string, failed = false): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · nanollm</title>
<link rel="icon" type="image/svg+xml" href="${LOGO_DATA_URI}">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f1e8;color:#2d2418;font-family:system-ui,sans-serif;padding:24px}
main{width:100%;max-width:400px;padding:32px;background:#fffcf6;border:1px solid #d8cdb8;border-radius:16px;box-shadow:0 12px 40px #2d241810}
img{width:40px;height:40px}h1{font-size:24px;margin:16px 0 8px}p{color:#7b6a54;font-size:14px;line-height:1.6}label{display:block;margin:24px 0 8px;font-size:14px}
input,button{width:100%;padding:12px;border-radius:8px;font:inherit}input{border:1px solid #d8cdb8;background:white}button{margin-top:16px;border:0;background:#2d2418;color:white;cursor:pointer}.error{color:#b42318}
</style></head><body><main><img src="${LOGO_DATA_URI}" alt=""><h1>登录 nanollm</h1>
<p>请输入服务器配置的访问密码。登录状态将保留 90 天。</p>
${failed ? '<p class="error" role="alert">密码错误，请重新输入。</p>' : ""}
<form method="post" action="/login"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
<label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">登录</button></form></main></body></html>`;
}

// Install before page scripts so every same-origin fetch handles an expired login.
export function withWebUIAuth(html: string): string {
  return html.replace("<head>", `<head><script>
(() => {
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const input = args[0];
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (response.status === 401 && response.headers.get('X-Nanollm-Auth-Required') === '1' && url.origin === location.origin) {
      const target = new URL(location.href);
      target.searchParams.delete('token');
      location.replace('/login?returnTo=' + encodeURIComponent(target.pathname + target.search));
    }
    return response;
  };
})();
</script>`);
}
