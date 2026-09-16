const nativeFetch = window.fetch.bind(window);
const channel =
  typeof BroadcastChannel === "function"
    ? new BroadcastChannel("process-log-auth")
    : null;
let days = 7;
let loginDialog;
let activeAccount;
export function accountKey() {
  return activeAccount?.storage_id || "owner";
}
function lock(message = "登录已过期，请重新登录后继续编辑。") {
  if (document.querySelector("#login-form")) return;
  if (!loginDialog) {
    loginDialog = document.createElement("dialog");
    loginDialog.className = "auth-dialog";
    loginDialog.innerHTML =
      '<h2>登录过程簿</h2><p class="auth-description"></p><form id="reauth-form"><label>账号<input name="username" autocomplete="username" maxlength="64" required></label><label>密码<input name="password" type="password" autocomplete="current-password" maxlength="256" required></label><p class="auth-error" role="alert"></p><button type="submit">登录并继续</button><p class="auth-hint" data-session-hint></p></form>';
    loginDialog.addEventListener("cancel", (event) => event.preventDefault());
    document.body.append(loginDialog);
    bindLogin(loginDialog.querySelector("form"), false);
  }
  loginDialog.querySelector(".auth-description").textContent = message;
  loginDialog.querySelector("[data-session-hint]").textContent =
    `此设备 ${days} 天内免重复登录`;
  document.documentElement.classList.add("auth-locked");
  if (!loginDialog.open) loginDialog.showModal();
}
window.fetch = async (...args) => {
  const target = new URL(
    typeof args[0] === "string" ? args[0] : args[0].url || String(args[0]),
    location.href,
  );
  if (
    target.origin === location.origin &&
    target.pathname.startsWith("/api/") &&
    !["/api/auth/login", "/api/auth/status"].includes(target.pathname)
  ) {
    const headers = new Headers(
      args[1]?.headers ||
        (args[0] instanceof Request ? args[0].headers : undefined),
    );
    headers.set("X-Process-Log-Account", accountKey());
    args[1] = { ...args[1], headers };
  }
  const response = await nativeFetch(...args);
  if (
    response.status === 401 &&
    target.origin === location.origin &&
    target.pathname.startsWith("/api/") &&
    !["/api/auth/login", "/api/auth/password"].includes(target.pathname)
  )
    lock();
  return response;
};
async function submit(path, data) {
  const response = await nativeFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Process-Log": "1",
      "X-Process-Log-Account": accountKey(),
    },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作失败，请重试");
  return result;
}
function bindLogin(form, initial) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button"),
      error = form.querySelector(".auth-error");
    button.disabled = true;
    error.textContent = "";
    try {
      await submit("/api/auth/login", Object.fromEntries(new FormData(form)));
      form.reset();
      const status = await (await nativeFetch("/api/auth/status")).json();
      channel?.postMessage({ account: status.user?.storage_id });
      if (
        initial ||
        !activeAccount ||
        status.user?.storage_id !== activeAccount.storage_id
      )
        location.replace("/");
      else {
        loginDialog.close();
        document.documentElement.classList.remove("auth-locked");
        window.dispatchEvent(new Event("auth-restored"));
      }
    } catch (e) {
      error.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  });
}
export function notifyLogout() {
  channel?.postMessage("logout");
}
export function changePassword() {
  const dialog = document.createElement("dialog");
  dialog.className = "auth-dialog";
  dialog.innerHTML =
    '<h2>修改密码</h2><p class="auth-description">修改后当前账号的所有设备需要重新登录。</p><form><label>当前密码<input name="password" type="password" autocomplete="current-password" maxlength="256" required></label><label>新密码<input name="new_password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><label>确认新密码<input name="confirm_password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><p class="auth-error" role="alert"></p><button type="submit">修改密码</button><button type="button" class="auth-cancel">取消</button></form>';
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector(".auth-cancel").onclick = () => dialog.close();
  dialog.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      button = form.querySelector('[type="submit"]'),
      error = form.querySelector(".auth-error"),
      data = Object.fromEntries(new FormData(form));
    error.textContent = "";
    if (data.new_password !== data.confirm_password) {
      error.textContent = "两次新密码不一致";
      return;
    }
    button.disabled = true;
    try {
      await submit("/api/auth/password", data);
      dialog.close();
      notifyLogout();
      lock("密码已修改，请使用新密码登录。");
    } catch (e) {
      error.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  dialog.showModal();
}
async function checkSession() {
  try {
    const response = await nativeFetch("/api/auth/status");
    if (!response.ok) return;
    const status = await response.json();
    days = status.days || 7;
    if (status.user && !activeAccount) activeAccount = status.user;
    if (
      activeAccount &&
      status.user &&
      activeAccount.storage_id !== status.user.storage_id
    ) {
      lock(
        "其他标签页已切换账号，请登录原账号继续，或登录新账号进入独立空间。",
      );
      return;
    }
    document
      .querySelectorAll("[data-admin-control]")
      .forEach((el) => (el.hidden = !status.user?.is_admin));
    document
      .querySelectorAll("[data-account-name]")
      .forEach((el) => (el.textContent = status.user?.username || ""));
    document
      .querySelectorAll("[data-session-hint]")
      .forEach((el) => (el.textContent = `此设备 ${days} 天内免重复登录`));
    document
      .querySelectorAll("[data-auth-control]")
      .forEach((el) => (el.hidden = !status.enabled));
    if (status.enabled && !status.authenticated) lock();
  } catch {
    /* A network outage must not discard the current draft. */
  }
}
const initialForm = document.querySelector("#login-form");
if (initialForm) bindLogin(initialForm, true);
channel?.addEventListener("message", (event) => {
  if (
    event.data?.account &&
    activeAccount &&
    event.data.account !== activeAccount.storage_id
  )
    lock("其他标签页已切换账号，请重新登录。");
  if (event.data === "logout") lock("此账号已退出登录，请重新登录。");
});
window.addEventListener("focus", checkSession);
setInterval(checkSession, 60000);
await checkSession();
