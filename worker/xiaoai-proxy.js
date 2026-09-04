/**
 * 小爱课表导入 Worker
 * 部署到 Cloudflare Workers 后，前端直接 POST /api/import 完成全流程
 * 全部业务逻辑在 Worker 内编排（list→create→batch_create→update_setting→switch）
 *
 * 端点：
 *   POST /api/import   { appId, serviceToken, deviceId, tableName, courses, schedule }
 *   POST /api/list     { appId, serviceToken, deviceId }  → 返回课表列表
 *   POST /api/preview  { appId, serviceToken, deviceId, ctId }  → 预览某课表
 *   OPTIONS *          → CORS 预检
 */

const BASE = "https://i.ai.mi.com/course-multi-auth";
const SWITCH_URL = "https://i.xiaomixiaoai.com/course-multi-auth/table_switch";
const REFERER = "https://i.ai.mi.com/h5/precache/ai-schedule/";

const STYLES = [
  '{"color":"#00A6F2","background":"#E5F4FF"}',
  '{"color":"#FC6B50","background":"#FDEBDE"}',
  '{"color":"#3CB3C8","background":"#DEFBF8"}',
  '{"color":"#7D7AEA","background":"#EDEDFF"}',
  '{"color":"#FF9900","background":"#FCEBCD"}',
  '{"color":"#EF5B75","background":"#FFEFF0"}',
  '{"color":"#5B8EFF","background":"#EAF1FF"}',
  '{"color":"#F067BB","background":"#FFEDF8"}',
  '{"color":"#29BBAA","background":"#E2F8F3"}',
  '{"color":"#CBA713","background":"#FFF8C8"}',
  '{"color":"#B967E3","background":"#F9EDFF"}',
  '{"color":"#6E8ADA","background":"#F3F2FD"}',
];

// ---------- 工具函数 ----------

function requestId() {
  // 32位大写无横线 UUID（crypto.randomUUID 去横线转大写）
  return crypto.randomUUID().replace(/-/g, "").toUpperCase();
}

function authorization(appId, serviceToken, deviceId) {
  if (serviceToken.startsWith("DO-TOKEN") || serviceToken.startsWith("AO-TOKEN")) {
    return serviceToken;
  }
  const scope = btoa(JSON.stringify({ d: deviceId }));
  return `AO-TOKEN-V1 dev_app_id:${appId},access_token:${serviceToken},scope_data:${scope}`;
}

function headers(appId, serviceToken, deviceId, { withRequestId = false, isSwitch = false } = {}) {
  const h = {
    "Authorization": authorization(appId, serviceToken, deviceId),
    "Content-Type": "application/json",
    "Accept": "*/*",
    "User-Agent": "Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 Mobile Safari/537.36 AgentWeb/4.1.3",
    "X-Requested-With": isSwitch ? "com.miui.voiceassist" : "com.xiaomi.aischedule",
    "Origin": isSwitch ? "https://i.xiaomixiaoai.com" : "https://i.ai.mi.com",
    "Referer": isSwitch ? "https://i.xiaomixiaoai.com/h5/precache/ai-schedule/" : REFERER,
  };
  if (withRequestId) h["RequestId"] = requestId();
  return h;
}

async function check(resp, action) {
  if (resp.status === 401 || resp.status === 500) {
    throw new Error(`${action}: HTTP ${resp.status} 认证失效，请重新获取凭据`);
  }
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`${action}: HTTP ${resp.status} ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const code = data.code ?? -1;
  if (code !== 0 && code !== 200) {
    throw new Error(`${action}: code=${code} ${data.desc || data.msg || ""}`);
  }
  return data;
}

// ---------- API 调用 ----------

async function listTables(appId, serviceToken, deviceId) {
  const url = `${BASE}/tables?requestId=${requestId()}&sourceName=course-app-aiSchedule`;
  const r = await fetch(url, { method: "GET", headers: headers(appId, serviceToken, deviceId) });
  const data = await check(r, "获取课表列表");
  return (data.data || []).map(t => ({
    id: t.id, name: t.name || "未命名",
    current: t.current || 0, setting: t.setting,
  }));
}

async function createTable(appId, serviceToken, deviceId, name) {
  const r = await fetch(`${BASE}/table`, {
    method: "POST",
    headers: headers(appId, serviceToken, deviceId),
    body: JSON.stringify({ name, current: 0, sourceName: "course-app-aiSchedule" }),
  });
  const data = await check(r, "新建课表");
  return parseInt(data.data, 10);
}

async function updateSettings(appId, serviceToken, deviceId, ctId, name, setting) {
  const r = await fetch(`${BASE}/table`, {
    method: "PUT",
    headers: headers(appId, serviceToken, deviceId),
    body: JSON.stringify({ ctId, name, setting, sourceName: "course-app-aiSchedule" }),
  });
  if (!r.ok) throw new Error(`同步课表设置失败(HTTP ${r.status})`);
}

async function batchCreateCourses(appId, serviceToken, deviceId, ctId, courses) {
  const colorMap = {};
  let paletteIdx = 0;
  const payload = [];
  for (const c of courses) {
    const nm = c.name || "";
    if (nm && !(nm in colorMap)) {
      colorMap[nm] = STYLES[paletteIdx % 12];
      paletteIdx++;
    }
    payload.push({
      name: c.name || "",
      position: c.position || "",
      teacher: c.teacher || "",
      day: parseInt(c.day, 10),
      sections: c.sections || "",
      style: colorMap[nm] || STYLES[0],
      weeks: c.weeks || "",
    });
  }
  const r = await fetch(`${BASE}/courseInfos`, {
    method: "POST",
    headers: headers(appId, serviceToken, deviceId, { withRequestId: true }),
    body: JSON.stringify({ ctId, courses: payload, sourceName: "course-app-aiSchedule" }),
  });
  const data = await check(r, "批量创建课程");
  if (data.status === -1) throw new Error("批量创建失败: status=-1 (可能课程参数不合法)");
  return payload.length;
}

async function switchTable(appId, serviceToken, deviceId, fromCtId, toCtId) {
  if (fromCtId === toCtId) return;
  const r = await fetch(SWITCH_URL, {
    method: "POST",
    headers: headers(appId, serviceToken, deviceId, { isSwitch: true }),
    body: JSON.stringify({ fromCtId, toCtId, sourceName: "course-app-miui" }),
  });
  await check(r, "切换课表");
}

// ---------- 周次展开（与 Python 版一致） ----------

const RANGE_RE = /(\d+)\s*(?:-|至|~)\s*(\d+)(?:[\s周\(（\)）]*(单|双)[\s周\(（\)）]*)?|(\d+)/g;

function expandWeeks(text) {
  if (!text) return "";
  // 已经是逗号分隔的纯数字串，直接返回
  if (/^[\d,\s]+$/.test(text)) return text.split(/[,\s]+/).filter(Boolean).join(",");
  const weeks = [];
  let m;
  RANGE_RE.lastIndex = 0;
  while ((m = RANGE_RE.exec(text)) !== null) {
    if (m[4]) { weeks.push(parseInt(m[4], 10)); continue; }
    const s = parseInt(m[1], 10), e = parseInt(m[2], 10), parity = m[3];
    let rng = [];
    for (let w = s; w <= e; w++) rng.push(w);
    if (parity === "单") rng = rng.filter(w => w % 2 === 1);
    else if (parity === "双") rng = rng.filter(w => w % 2 === 0);
    weeks.push(...rng);
  }
  return weeks.join(",");
}

// ---------- 课表 JSON 规范化（与导入器 normalize_schedule 一致） ----------

function normalizeSchedule(input) {
  const courses = Array.isArray(input.courses) ? input.courses
    : Array.isArray(input) ? input : [];

  const schedule = input.schedule || input.setting || {};
  const sections = schedule.sections
    || schedule.sectionTimes
    || schedule["节次时间"]
    || schedule["sectionTimes"];

  let sectionList = [];
  if (typeof sections === "string") {
    try { sectionList = JSON.parse(sections); } catch { sectionList = []; }
  } else if (Array.isArray(sections)) {
    sectionList = sections;
  }

  const morningNum = schedule.morningNum || schedule["上午节数"] || schedule.morning || 4;
  const afternoonNum = schedule.afternoonNum || schedule["下午节数"] || schedule.afternoon || 4;
  const nightNum = schedule.nightNum || schedule["晚上节数"] || schedule.night || 3;
  const totalWeek = schedule.totalWeek || schedule["总周数"] || schedule.weeks || 20;

  const setting = {
    morningNum: parseInt(morningNum, 10) || 4,
    afternoonNum: parseInt(afternoonNum, 10) || 4,
    nightNum: parseInt(nightNum, 10) || 3,
    sections: sectionList,
    totalWeek: parseInt(totalWeek, 10) || 20,
  };

  const normalized = courses.map(c => {
    const day = parseInt(c.day ?? c["星期"] ?? c.weekday ?? 1, 10);
    const secRaw = c.sections ?? c.section ?? c["节次"];
    let secStr = "";
    if (Array.isArray(secRaw)) secStr = secRaw.join(",");
    else if (typeof secRaw === "string") secStr = secRaw;
    else if (typeof secRaw === "number") secStr = String(secRaw);
    // "1-2" → "1,2"
    secStr = secStr.replace(/(\d+)\s*[-至~]\s*(\d+)/g, (_, a, b) => {
      const out = [];
      for (let i = +a; i <= +b; i++) out.push(i);
      return out.join(",");
    });

    const wRaw = c.weeks ?? c.week ?? c["周次"];
    let wStr = "";
    if (Array.isArray(wRaw)) wStr = wRaw.join(",");
    else if (typeof wRaw === "string") wStr = expandWeeks(wRaw);
    else if (typeof wRaw === "number") wStr = String(wRaw);

    return {
      name: c.name || c.courseName || c["课程名"] || "",
      teacher: c.teacher || c["教师"] || "",
      position: c.position || c.location || c["地点"] || "",
      day,
      sections: secStr,
      weeks: wStr,
    };
  });

  return { courses: normalized, setting };
}

// ---------- 主入口 ----------

async function handleImport(req) {
  const body = await req.json();
  const { appId, serviceToken, deviceId, tableName, courses: rawCourses, schedule: rawSchedule } = body;
  if (!appId || !serviceToken || !deviceId) {
    return json({ ok: false, error: "缺少凭据 appId/serviceToken/deviceId" }, 400);
  }
  if (!Array.isArray(rawCourses) || rawCourses.length === 0) {
    return json({ ok: false, error: "课表数据为空" }, 400);
  }

  const log = [];
  const step = (s) => log.push(s);

  try {
    const { courses, setting } = normalizeSchedule({
      courses: rawCourses,
      schedule: rawSchedule || {},
    });
    step(`规范化 ${courses.length} 门课程`);

    // 1. 列出已有课表
    const tables = await listTables(appId, serviceToken, deviceId);
    step(`查询已有 ${tables.length} 张课表`);
    const fromCt = tables.find(t => t.current === 1)?.id;

    // 2. 新建课表
    const newCtId = await createTable(appId, serviceToken, deviceId, tableName || "我的课表");
    step(`新建课表成功 ctId=${newCtId}`);

    // 3. 同步设置（节数 + 节次时间表）
    try {
      await updateSettings(appId, serviceToken, deviceId, newCtId, tableName || "我的课表", setting);
      step(`同步设置成功（${setting.morningNum}/${setting.afternoonNum}/${setting.nightNum} 节，${setting.sections.length} 时间段，${setting.totalWeek} 周）`);
    } catch (e) {
      step(`同步设置失败（不影响课程）：${e.message}`);
    }

    // 4. 批量创建课程
    const n = await batchCreateCourses(appId, serviceToken, deviceId, newCtId, courses);
    step(`导入 ${n} 门课程成功`);

    // 5. 切换到新课表
    if (fromCt && fromCt !== newCtId) {
      try {
        await switchTable(appId, serviceToken, deviceId, fromCt, newCtId);
        step(`已切换到新课表`);
      } catch (e) {
        step(`切换课表失败（不影响导入）：${e.message}`);
      }
    }

    return json({ ok: true, ctId: newCtId, log });
  } catch (e) {
    return json({ ok: false, error: e.message, log });
  }
}

async function handleList(req) {
  const body = await req.json();
  const { appId, serviceToken, deviceId } = body;
  if (!appId || !serviceToken || !deviceId) {
    return json({ ok: false, error: "缺少凭据" }, 400);
  }
  try {
    const tables = await listTables(appId, serviceToken, deviceId);
    return json({ ok: true, tables });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
}

// ---------- 响应/CORS ----------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors();
    if (request.method !== "POST") {
      return json({ ok: false, error: "只支持 POST 请求" }, 405);
    }
    try {
      if (url.pathname === "/api/import") return await handleImport(request);
      if (url.pathname === "/api/list") return await handleList(request);
      return json({ ok: false, error: "未知路径: " + url.pathname }, 404);
    } catch (e) {
      return json({ ok: false, error: "Worker 内部错误: " + e.message }, 500);
    }
  },
};
