// 小爱课表导入器 - 前端逻辑
// Worker 地址（部署 wrangler 后填这里，或用 prompts 动态读取）
// 部署后 Cloudflare 会给你一个 https://xxx.workers.dev 地址，把它填到下面：
const WORKER_URL = "https://xiaoai-kebiao-temp.cubic-ant.workers.dev"; // 临时 Worker（60分钟过期，需永久部署）

// 优先用 URL 参数 ?worker=xxx 覆盖，方便切换 Worker
const urlParams = new URLSearchParams(location.search);
if (urlParams.get("worker")) {
  // 不带末尾斜杠
  const w = urlParams.get("worker").replace(/\/$/, "");
  if (w.startsWith("http")) localStorage.setItem("worker_url", w);
}
const WORKER = localStorage.getItem("worker_url") || WORKER_URL;

const $ = (id) => document.getElementById(id);

$("btnImport").addEventListener("click", importCourses);
$("btnList").addEventListener("click", listTables);
$("btnClear").addEventListener("click", () => {
  $("jsonInput").value = "";
  $("resultCard").classList.add("hidden");
  $("listCard").classList.add("hidden");
});

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
    alert("请填入 appId / serviceToken / deviceId");
    return;
  }
  const jsonText = $("jsonInput").value.trim();
  if (!jsonText) {
    alert("请粘贴课表 JSON");
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
console.log("提示：可用 ?worker=https://你的-worker.workers.dev 覆盖");
