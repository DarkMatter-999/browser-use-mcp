export const OVERLAY_SCRIPT = `(() => {
  if (window.__browserUseOverlay) { window.__browserUseOverlay.ping(); return true; }
  const host = document.createElement("div");
  host.setAttribute("data-browser-use-overlay", "");
  host.setAttribute("popover", "manual");
  host.style.cssText = "all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;pointer-events:none;overflow:visible;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML =
    '<style>' +
    '.frame{position:fixed;inset:0;box-sizing:border-box;border:3px solid #1a73e8;opacity:0;transition:opacity .25s;pointer-events:none}' +
    '.frame.on{opacity:.85}' +
    '.cursor{position:fixed;left:0;top:0;width:22px;height:22px;transform:translate(-100px,-100px);transition:transform .35s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));pointer-events:none}' +
    '.label{position:fixed;left:0;top:0;transform:translate(-100px,-100px);transition:transform .35s cubic-bezier(.2,.8,.2,1);background:#1a73e8;color:#fff;font:12px/1.3 system-ui,sans-serif;padding:3px 9px;border-radius:11px;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;pointer-events:none}' +
    '</style><div class="frame"></div>' +
    '<svg class="cursor" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#1a73e8" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>' +
    '<div class="label"></div>';
  const frame = root.querySelector(".frame");
  const cursor = root.querySelector(".cursor");
  const label = root.querySelector(".label");
  let idleTimer;
  const attach = () => {
    (document.documentElement || document.body).appendChild(host);
    try { host.showPopover(); } catch (e) { /* popover unsupported: still visible via z-index */ }
  };
  attach();
  const api = {
    moveTo(x, y, text) {
      if (!host.isConnected) attach();
      cursor.style.transform = "translate(" + x + "px," + y + "px)";
      label.style.transform = "translate(" + (x + 16) + "px," + (y + 20) + "px)";
      label.textContent = String(text || "");
      frame.classList.add("on");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => frame.classList.remove("on"), 4000);
    },
    hide() { host.style.visibility = "hidden"; },
    show() { host.style.visibility = "visible"; },
    ping() { if (!host.isConnected) attach(); return true; },
  };
  Object.defineProperty(window, "__browserUseOverlay", { value: api, configurable: true });
  return true;
})()`;
