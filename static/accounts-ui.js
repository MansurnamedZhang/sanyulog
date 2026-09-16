async function api(path, method = "GET", data) {
  const response = await fetch("/api/auth/users" + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Process-Log": "1" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "账号操作失败");
  return result;
}
export async function manageAccounts() {
  const dialog = document.createElement("dialog");
  dialog.className = "auth-dialog accounts-dialog";
  dialog.innerHTML =
    '<h2>账号管理</h2><p class="auth-description">每个账号拥有独立的工作空间、笔记和附件。停用账号会立即撤销它的登录，保留其数据。</p><div data-users></div><hr><h3>创建账号</h3><form data-create-account><label>账号<input name="username" autocomplete="off" maxlength="64" required></label><label>初始密码<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><p class="auth-error" role="alert"></p><button type="submit">创建账号</button></form><p data-account-message role="status"></p><button type="button" class="auth-cancel">关闭</button>';
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector(".auth-cancel").onclick = () => dialog.close();
  const message = dialog.querySelector("[data-account-message]");
  async function refresh() {
    const result = await api("");
    const list = dialog.querySelector("[data-users]");
    list.replaceChildren();
    for (const user of result.users) {
      const row = document.createElement("div");
      row.className = "account-row";
      const name = document.createElement("strong");
      name.textContent = user.username;
      const state = document.createElement("span");
      state.textContent = user.is_admin
        ? "管理员"
        : user.enabled
          ? "正常"
          : "已停用";
      row.append(name, state);
      if (!user.is_admin) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.textContent = user.enabled ? "停用" : "启用";
        toggle.onclick = async () => {
          toggle.disabled = true;
          try {
            await api("/" + user.id, "PUT", { enabled: !user.enabled });
            await refresh();
            message.textContent = "账号状态已更新。";
          } catch (e) {
            message.textContent = e.message;
            toggle.disabled = false;
          }
        };
        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "重置密码";
        reset.onclick = () => resetPassword(user);
        row.append(toggle, reset);
      }
      list.append(row);
    }
  }
  function resetPassword(user) {
    const reset = document.createElement("dialog");
    reset.className = "auth-dialog";
    reset.innerHTML =
      '<h2></h2><p class="auth-description">重置后该账号的所有设备需要重新登录。</p><form><label>新密码<input name="new_password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><p class="auth-error" role="alert"></p><button type="submit">重置密码</button><button type="button" class="auth-cancel">取消</button></form>';
    reset.querySelector("h2").textContent = "重置 " + user.username + " 的密码";
    document.body.append(reset);
    reset.addEventListener("close", () => reset.remove());
    reset.querySelector(".auth-cancel").onclick = () => reset.close();
    reset.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      const button = reset.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        await api(
          "/" + user.id,
          "PUT",
          Object.fromEntries(new FormData(event.currentTarget)),
        );
        reset.close();
        message.textContent = "密码已重置，请将新密码单独告知对方。";
      } catch (e) {
        reset.querySelector(".auth-error").textContent = e.message;
        button.disabled = false;
      }
    };
    reset.showModal();
  }
  dialog.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      button = form.querySelector("button"),
      error = form.querySelector(".auth-error");
    button.disabled = true;
    error.textContent = "";
    try {
      await api("", "POST", Object.fromEntries(new FormData(form)));
      form.reset();
      await refresh();
      message.textContent = "账号已创建，请将初始密码单独告知对方。";
    } catch (e) {
      error.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  dialog.showModal();
  try {
    await refresh();
  } catch (e) {
    message.textContent = e.message;
  }
}
