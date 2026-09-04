// 小爱课表导入器 - 前端逻辑
const WORKER_URL = "https://xiaoai-kebiao.xiaoai-kebiao.workers.dev"; // 永久部署的 Worker
const THIS_ORIGIN = location.origin + location.pathname.replace(/[^/]*$/, "");

// 优先用 URL 参数 ?worker=xxx 覆盖
const urlParams = new URLSearchParams(location.search);
if (urlParams.get("worker")) {
  const w = urlParams.get("worker").replace(/\/$/, "");
  if (w.startsWith("http")) localStorage.setItem("worker_url", w);
}
const WORKER = localStorage.getItem("worker_url") || WORKER_URL;

const $ = (id) => document.getElementById(id);

// ============================================================================
// 凭据自动识别（移植自后端 extract_credentials）
// ============================================================================
function extractCredentials(text) {
  if (!text || !text.trim()) return { appId: "", serviceToken: "", deviceId: "" };

  function looksLikeAuth(s) {
    return typeof s === "string" && (s.startsWith("DO-TOKEN") || s.startsWith("AO-TOKEN"));
  }

  // 尝试 JSON 解析
  let raw = null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) raw = parsed;
  } catch (e) {}

  function jsonGet(...keys) {
    if (raw && typeof raw === "object") {
      for (const k of keys) {
        if (raw[k] != null && raw[k] !== "") return String(raw[k]).trim();
      }
    }
    return null;
  }
  function regexFind(...names) {
    for (const n of names) {
      const m = text.match(new RegExp('["\']?' + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '["\']?\\s*[:=]\\s*["\']([^"\']+?)["\']', "i"));
      if (m) return m[1].trim();
    }
    return null;
  }

  let appId = jsonGet("appId", "app_id", "appid") || regexFind("appId", "app_id", "appid");
  let serviceToken = jsonGet("serviceToken", "service_token", "accessToken", "access_token")
    || regexFind("serviceToken", "service_token", "accessToken", "access_token");
  let deviceId = jsonGet("deviceId", "device_id", "deviceid", "deviceIdNew")
    || regexFind("deviceId", "device_id", "deviceid", "deviceIdNew");

  // authorization 字段是完整 Authorization 头，优先级最高
  const auth = jsonGet("authorization", "Authorization") || regexFind("authorization", "Authorization");
  if (auth && looksLikeAuth(auth)) {
    serviceToken = auth;
    if (!appId) {
      const m = auth.match(/(?:dev_)?app_id:\s*([^,\s]+)/i);
      if (m) appId = m[1].trim();
    }
    if (!deviceId) {
      const m = auth.match(/scope_data:([A-Za-z0-9+/=]+)/);
      if (m) {
        try {
          const scope = JSON.parse(atob(m[1]));
          if (scope && scope.d) deviceId = String(scope.d);
        } catch (e) {}
      }
    }
  }
  return { appId: appId || "", serviceToken: serviceToken || "", deviceId: deviceId || "" };
}

// ============================================================================
// Bookmarklet 生成（注入 jiaowu_extractor.js，提取后跳回本页）
// ============================================================================
function makeBookmarklet() {
  const base = THIS_ORIGIN;
  return "javascript:void((function(){"
    + "var s=document.createElement('script');"
    + "s.src='" + base + "jiaowu_extractor.js?t='+Date.now();"
    + "s.setAttribute('data-qzpyp-base','" + location.origin + location.pathname + "');"
    + "document.head.appendChild(s);"
    + "})());";
}

// ============================================================================
// 事件绑定
// ============================================================================
$("btnImport").addEventListener("click", importCourses);
$("btnList").addEventListener("click", listTables);
$("btnClear").addEventListener("click", () => {
  $("jsonInput").value = "";
  $("credPaste").value = "";
  $("appId").value = "";
  $("serviceToken").value = "";
  $("deviceId").value = "";
  $("resultCard").classList.add("hidden");
  $("listCard").classList.add("hidden");
});

// 凭据粘贴框 → 自动识别
$("credPaste").addEventListener("input", () => {
  const { appId, serviceToken, deviceId } = extractCredentials($("credPaste").value);
  if (appId) $("appId").value = appId;
  if (serviceToken) $("serviceToken").value = serviceToken;
  if (deviceId) $("deviceId").value = deviceId;
});

// 复制提取书签
$("btnCopyBookmarklet").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(makeBookmarklet());
    alert("✅ 已复制书签代码\n\n下一步：\n1. 浏览器按 Ctrl+Shift+B 显示书签栏\n2. 右键书签栏 → 添加网页\n3. 名称填「📚 提取课表」\n4. 网址粘进刚复制的代码\n5. 在教务系统课表页点这个书签即可");
  } catch (e) {
    prompt("复制下面这段，加到书签栏的网址栏：", makeBookmarklet());
  }
});

// 把拖拽链接的 href 设为 bookmarklet
$("bookmarkletLink").href = makeBookmarklet();

// 从剪贴板自动粘贴 JSON
$("btnPaste").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text && (text.trim().startsWith("{") || text.trim().startsWith("["))) {
      $("jsonInput").value = text;
      $("jsonInput").scrollIntoView({ behavior: "smooth" });
    } else {
      alert("剪贴板里没有 JSON，请先在教务系统点「📚 提取课表」书签");
    }
  } catch (e) {
    alert("剪贴板读取失败：" + e.message + "\n请手动 Ctrl+V 粘贴到下方框");
  }
});

// ============================================================================
// 检测 #autofocus，自动从剪贴板读 JSON（从教务页面跳回时触发）
// ============================================================================
if (location.hash === "#autofocus" || location.hash === "#autofill") {
  // 异步读剪贴板
  (async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && (text.trim().startsWith("{") || text.trim().startsWith("["))) {
        $("jsonInput").value = text;
        $("jsonInput").scrollIntoView({ behavior: "smooth" });
        // 自动滚到凭据区，方便继续操作
        setTimeout(() => $("credPaste").scrollIntoView({ behavior: "smooth" }), 500);
      }
    } catch (e) {}
    // 清掉 hash 避免刷新重复触发
    history.replaceState(null, "", location.pathname);
  })();
}

// ============================================================================
// API 调用
// ============================================================================
function getCreds() {
  return {
    appId: $("appId").value.trim(),
    serviceToken: $("serviceToken").value.trim(),
    deviceId: $("deviceId").value.trim(),
    tableName: $("tableName").value.trim() || "我的课表",
  };
}

function showLog(log) {
  $("resultCard").classList.remove("hidden");
  $("resultLog").textContent = (log || []).join("\n");
}

async function call(path, body) {
  const r = await fetch(WORKER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function importCourses() {
  const creds = getCreds();
  if (!creds.appId || !creds.serviceToken || !creds.deviceId) {
    alert("请粘贴小爱 Debug JSON 自动识别凭据，或手动填 appId / serviceToken / deviceId");
    $("credPaste").focus();
    return;
  }
  const jsonText = $("jsonInput").value.trim();
  if (!jsonText) {
    alert("请先提取课表 JSON（点「📚 提取课表」书签），或手动粘贴");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    alert("JSON 格式错误: " + e.message);
    return;
  }

  const btn = $("btnImport");
  btn.disabled = true;
  btn.textContent = "导入中...";
  showLog(["正在导入..."]);

  try {
    const r = await call("/api/import", {
      appId: creds.appId,
      serviceToken: creds.serviceToken,
      deviceId: creds.deviceId,
      tableName: creds.tableName,
      courses: parsed.courses || parsed,
      schedule: parsed.schedule || parsed.setting || {},
    });
    if (r.ok) {
      showLog([
        "✅ 导入成功！ctId=" + r.ctId,
        "",
        "执行步骤：",
        ...(r.log || []).map(s => "  • " + s),
        "",
        "去小爱课表 App 刷新看看吧",
      ]);
    } else {
      showLog([
        "❌ 导入失败",
        "",
        "错误：" + (r.error || "未知错误"),
        "",
        "执行步骤：",
        ...(r.log || []).map(s => "  • " + s),
      ]);
    }
  } catch (e) {
    showLog(["❌ 网络错误: " + e.message]);
  } finally {
    btn.disabled = false;
    btn.textContent = "导入到小爱课表";
  }
}

async function listTables() {
  const creds = getCreds();
  if (!creds.appId || !creds.serviceToken || !creds.deviceId) {
    alert("请填入凭据");
    return;
  }
  const btn = $("btnList");
  btn.disabled = true;
  btn.textContent = "查询中...";
  try {
    const r = await call("/api/list", {
      appId: creds.appId,
      serviceToken: creds.serviceToken,
      deviceId: creds.deviceId,
    });
    $("listCard").classList.remove("hidden");
    const ul = $("listOutput");
    ul.innerHTML = "";
    if (r.ok && r.tables) {
      r.tables.forEach(t => {
        const li = document.createElement("li");
        if (t.current === 1) li.classList.add("current");
        li.textContent = (t.current === 1 ? "★ " : "") + t.name + "  (id=" + t.id + ")";
        ul.appendChild(li);
      });
    } else {
      ul.innerHTML = "<li>查询失败: " + (r.error || "") + "</li>";
    }
  } catch (e) {
    alert("查询失败: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "查看我的课表";
  }
}

// 智能读取 URL 中的凭据（小爱 H5 页面 URL 自带 ?appId=...&serviceToken=...&deviceId=...）
["appId", "serviceToken", "deviceId", "tableName"].forEach(k => {
  const v = urlParams.get(k);
  if (v) $(k).value = v;
});

console.log("Worker 地址:", WORKER);
console.log("本页 Origin:", THIS_ORIGIN);
console.log("Bookmarklet:", makeBookmarklet());
