/**
 * 小爱课表导入器 - Cloudflare Pages Function（一体化业务后端）
 * 部署：仓库根目录 functions/api/[[path]].js → Pages 项目自动部署到 *.pages.dev
 *
 * 路由（catch-all 匹配 /api/* 下任意路径）：
 *   GET  /api/ping                          心跳
 *   GET  /api/state                         状态
 *   GET  /api/tables                        课表列表
 *   GET  /api/table?ctId=                   获取课表课程
 *   GET  /api/jiaowu_extractor.js           教务提取脚本（静态）
 *   GET  /api/jiaowu_userscript.js          油猴脚本（静态）
 *   POST /api/connect                        凭据识别 + 验证 + 创建会话
 *   POST /api/create_table                   新建课表
 *   POST /api/parse                          解析 JSON
 *   POST /api/import                         导入课程 + 同步设置
 *   POST /api/delete                         删除课程
 *   POST /api/clear                          清空课表
 */

// ============ 常量 ============
const STYLES = [
  ["#00A6F2", "#E5F4FF"], ["#FC6B50", "#FDEBDE"],
  ["#3CB3C8", "#DEFBF8"], ["#7D7AEA", "#EDEDFF"],
  ["#FF9900", "#FCEBCD"], ["#EF5B75", "#FFEFF0"],
  ["#5B8EFF", "#EAF1FF"], ["#F067BB", "#FFEDF8"],
  ["#29BBAA", "#E2F8F3"], ["#CBA713", "#FFF8C8"],
  ["#B967E3", "#F9EDFF"], ["#6E8ADA", "#F3F2FD"],
];
const BASE = "https://i.ai.mi.com/course-multi-auth";
const WEEKDAY_MAP = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "天": 7, "日": 7 };
const RANGE_RE = /(\d+)\s*(?:-|至|~)\s*(\d+)(?:[\s周\(（\)）]*(单|双)[\s周\(（\)）]*)?|(\d+)/g;

// 每个隔离器（isolate）的会话缓存：sid -> { appId, serviceToken, deviceId }
// 注意：Cloudflare 在不同实例间不共享内存，会话过期后需重新 connect
const SESSIONS = new Map();

// 教务提取脚本：内联常量（部署时不依赖环境变量）
let JIAOWU_JS_BODY = `// ==/JIAOWU EXTRACTOR==
// 由「小爱课表导入器」内置提供
// 兼容：油猴脚本 / Bookmarklet 直接 <script> 注入到强智教务页面
// 用途：登录后，在学期理论课表或个人中心页面点击右下角「📚 提取课表」按钮 → 提取课表 JSON 并复制到剪贴板

(function() {
  'use strict';

  var courses = [];
  var maxPageSection = 0;

  function cleanText(text) {
    return (text || '')
      .replace(/&nbsp;/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // "1-16(周)" / "1-16(周)单" / "1,3,5(周)" → "1-16周(单)" / "1,3,5周"
  function normalizeWeeks(weekText) {
    weekText = cleanText(weekText);
    if (!weekText) return '';
    var m = weekText.match(/[\d]+(?:\s*[-—~,，]\s*\d+)*/);
    var base = m ? m[0] : weekText;
    base = base.replace(/\s+/g, '')
               .replace(/[—–]/g, '-')
               .replace(/[，~]/g, ',')
               .replace(/,+$/, '')
               .replace(/周+$/, '');
    var suffix = '';
    if (/单/.test(weekText)) suffix = '(单)';
    else if (/双/.test(weekText)) suffix = '(双)';
    return base + '周' + suffix;
  }

  function buildSections(start, end) {
    var result = [];
    for (var i = start; i <= end; i++) result.push(i);
    return result.join(',');
  }

  // 穿透 iframe / frame
  function findEl(d, selector) {
    try {
      var el = d.querySelector(selector);
      if (el) return el;
    } catch (e) {}
    var frames = [];
    try { d.querySelectorAll('iframe').forEach(function (f) { frames.push(f); }); } catch (e) {}
    try { d.querySelectorAll('frame').forEach(function (f) { frames.push(f); }); } catch (e) {}
    for (var i = 0; i < frames.length; i++) {
      try {
        var fd = frames[i].contentDocument || frames[i].contentWindow.document;
        if (fd) {
          var r = findEl(fd, selector);
          if (r) return r;
        }
      } catch (e) {}
    }
    return null;
  }

  function locateDoc(d, selector) {
    try { if (d.querySelector(selector)) return d; } catch (e) {}
    var frames = [];
    try { d.querySelectorAll('iframe').forEach(function (f) { frames.push(f); }); } catch (e) {}
    try { d.querySelectorAll('frame').forEach(function (f) { frames.push(f); }); } catch (e) {}
    for (var i = 0; i < frames.length; i++) {
      try {
        var fd = frames[i].contentDocument || frames[i].contentWindow.document;
        if (fd) {
          var hit = locateDoc(fd, selector);
          if (hit) return hit;
        }
      } catch (e) {}
    }
    return null;
  }

  // 模式 1：学期理论课表 (#kbtable)
  function parseKbtable(d, table) {
    var rows = table.querySelectorAll('tr');
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var th = row.querySelector('th');
      if (!th) continue;
      var firstText = cleanText(th.textContent);
      if (firstText.indexOf('星期') >= 0 || firstText.indexOf('备注') >= 0) continue;
      var periodMatch = firstText.match(/第\s*(\d+)\s*[-—]\s*(\d+)\s*节/);
      if (!periodMatch) continue;
      var start = parseInt(periodMatch[1]);
      var end = parseInt(periodMatch[2]);
      if (end > maxPageSection) maxPageSection = end;
      var tds = row.querySelectorAll('td');
      for (var j = 0; j < tds.length && j < 7; j++) {
        var day = j + 1;
        var td = tds[j];
        var divs = td.querySelectorAll('div');
        var contentDiv = null;
        for (var k = 0; k < divs.length; k++) {
          var cn = (typeof divs[k].className === 'string') ? divs[k].className : '';
          if (cn.indexOf('kbcontent') >= 0 && cn.indexOf('kbcontent1') < 0 && cn.indexOf('sykb2') < 0) {
            if (cleanText(divs[k].textContent)) { contentDiv = divs[k]; break; }
          }
        }
        if (!contentDiv) continue;
        var blocks = contentDiv.innerHTML.split(/-{15,}/);
        for (var b = 0; b < blocks.length; b++) {
          var block = blocks[b];
          if (!block.trim()) continue;
          var temp = d.createElement('div');
          temp.innerHTML = block;
          var name = '';
          var walker = d.createTreeWalker(temp, NodeFilter.SHOW_TEXT, null, false);
          var node;
          while ((node = walker.nextNode())) {
            var text = cleanText(node.textContent);
            if (text) { name = text; break; }
          }
          if (!name) continue;
          name = name.replace(/\s*[PO]\s*$/, '').trim();
          var teacherEl = temp.querySelector("font[title='老师']");
          var teacher = teacherEl ? cleanText(teacherEl.textContent) : '';
          var classroomEl = temp.querySelector("font[title='教室']");
          var position = classroomEl ? cleanText(classroomEl.textContent) : '';
          var weeks = '';
          var weekEl = temp.querySelector("font[title='周次(节次)']");
          if (weekEl) weeks = normalizeWeeks(weekEl.textContent);
          courses.push({
            name: name, teacher: teacher, position: position,
            day: day, sections: buildSections(start, end), weeks: weeks
          });
        }
      }
    }
  }

  // 模式 2：个人中心 (#tab1)
  function parsePersonalKb(d, table, forceWeek) {
    var rows = table.querySelectorAll('tbody tr');
    if (!rows.length) rows = table.querySelectorAll('tr');
    for (var r = 0; r < rows.length; r++) {
      var tds = rows[r].querySelectorAll('td');
      if (tds.length < 2) continue;
      var periodMatch = tds[0].textContent.match(/第\s*(\d+)\s*[-—]\s*(\d+)\s*节/);
      if (!periodMatch) continue;
      var start = parseInt(periodMatch[1]);
      var end = parseInt(periodMatch[2]);
      if (end > maxPageSection) maxPageSection = end;
      for (var j = 1; j < tds.length && j <= 7; j++) {
        var day = j;
        var ps = tds[j].querySelectorAll('p[title]');
        for (var p = 0; p < ps.length; p++) {
          var title = ps[p].getAttribute('title') || '';
          if (!title) continue;
          var nameMatch = title.match(/课程名称[：:]\s*([^\f\n\r<]+)/);
          if (!nameMatch) continue;
          var name = cleanText(nameMatch[1]);
          var weekMatch = title.match(/第\s*(\d+)\s*周/);
          var weeks = forceWeek ? (forceWeek + '周') : (weekMatch ? (weekMatch[1] + '周') : '');
          var dayMatch = title.match(/星期([一二三四五六日])/);
          if (dayMatch) {
            var dm = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7};
            day = dm[dayMatch[1]] || day;
          }
          var roomMatch = title.match(/上课地点[：:]\s*([^\f\n\r<]+)/);
          var position = roomMatch ? cleanText(roomMatch[1]) : '';
          var teacherMatch = title.match(/教师[：:]\s*([^\f\n\r<]+)/);
          var teacher = teacherMatch ? cleanText(teacherMatch[1]) : '';
          courses.push({
            name: name, teacher: teacher, position: position,
            day: day, sections: buildSections(start, end), weeks: weeks
          });
        }
      }
    }
  }

  function loadAllWeeks() {
    try {
      var liWeek = document.querySelector('#li_showWeek');
      var currentWeek = 18;
      if (liWeek) {
        var m = liWeek.textContent.match(/第\s*(\d+)\s*周/);
        if (m) currentWeek = parseInt(m[1]);
      }
      var rq = document.querySelector('#rq');
      var currentDate = rq ? rq.value : '';
      if (!currentDate) return;
      var parts = currentDate.split('-');
      var startDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      var currentDay = startDate.getDay() || 7;
      startDate.setDate(startDate.getDate() - currentDay + 1);
      startDate.setDate(startDate.getDate() - (currentWeek - 1) * 7);
      var sjms = document.querySelector('#sjms');
      var sjmsValue = sjms ? sjms.value : '';
      for (var week = 1; week <= 20; week++) {
        var date = new Date(startDate);
        date.setDate(date.getDate() + (week - 1) * 7);
        var ds = date.getFullYear() + '-' +
          String(date.getMonth() + 1).padStart(2, '0') + '-' +
          String(date.getDate()).padStart(2, '0');
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/jsxsd/framework/main_index_loadkb.jsp', false);
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        xhr.send('rq=' + encodeURIComponent(ds) +
                 '&sjmsValue=' + encodeURIComponent(sjmsValue));
        if (xhr.status === 200 && xhr.responseText) {
          var t = document.createElement('div');
          t.innerHTML = xhr.responseText;
          var tab = t.querySelector('#tab1');
          if (tab) parsePersonalKb(t, tab, week);
        }
      }
    } catch (e) {}
  }

  function removeDuplicates() {
    var seen = {};
    courses = courses.filter(function (c) {
      var k = [c.name, c.teacher, c.position, c.day, c.sections, c.weeks].join('|');
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  function buildSchedule(list) {
    var maxWeek = 0;
    var maxSec = maxPageSection || 0;
    list.forEach(function (c) {
      var wm = String(c.weeks || '').match(/\d+/g);
      if (wm) wm.forEach(function (x) { var n = parseInt(x, 10); if (n > maxWeek) maxWeek = n; });
      var sm = String(c.sections || '').match(/\d+/g);
      if (sm) sm.forEach(function (x) { var n = parseInt(x, 10); if (n > maxSec) maxSec = n; });
    });
    var morn, aft, night;
    if (maxSec <= 0) { morn = null; aft = null; night = null; }
    else if (maxSec <= 4) { morn = maxSec; aft = 0; night = 0; }
    else if (maxSec <= 8) { morn = 4; aft = maxSec - 4; night = 0; }
    else if (maxSec <= 12) { morn = 4; aft = 4; night = maxSec - 8; }
    else { morn = 6; aft = 4; night = maxSec - 10; }
    return {
      totalWeek: maxWeek || null,
      morningNum: morn, afternoonNum: aft, nightNum: night,
      sections: DEFAULT_SECTIONS.slice(0, maxSec)
    };
  }

  function extractSchedule() {
    courses = [];
    maxPageSection = 0;
    var kbtable = findEl(document, '#kbtable');
    if (kbtable) {
      parseKbtable(locateDoc(document, '#kbtable') || document, kbtable);
    }
    if (!courses.length) {
      var tab1 = findEl(document, '#tab1');
      if (tab1) {
        parsePersonalKb(locateDoc(document, '#tab1') || document, tab1, null);
        loadAllWeeks();
        removeDuplicates();
      }
    }
    if (!courses.length) return { courses: [], schedule: {} };
    return { courses: courses, schedule: buildSchedule(courses) };
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {}, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  function showToast(text) {
    var old = document.querySelector('#__qzpyp_extract_toast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.id = '__qzpyp_extract_toast';
    t.textContent = text;
    Object.assign(t.style, {
      position: 'fixed', left: '50%', bottom: '80px',
      transform: 'translateX(-50%)', zIndex: '999999999',
      background: '#222', color: '#fff', padding: '12px 20px',
      borderRadius: '10px', fontSize: '15px',
      boxShadow: '0 4px 15px rgba(0,0,0,.3)'
    });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3000);
  }

  function createButton() {
    if (document.querySelector('#__qzpyp_extract_btn')) return;
    var btn = document.createElement('button');
    btn.id = '__qzpyp_extract_btn';
    btn.textContent = '📚 提取课表';
    Object.assign(btn.style, {
      position: 'fixed', right: '20px', bottom: '20px',
      zIndex: '999999999', padding: '12px 18px', border: 'none',
      borderRadius: '10px', background: '#1677ff', color: '#fff',
      fontSize: '15px', fontWeight: 'bold', cursor: 'pointer',
      boxShadow: '0 4px 12px rgba(0,0,0,.25)'
    });
    btn.onclick = function () {
      btn.disabled = true;
      btn.textContent = '⏳ 提取中...';
      setTimeout(function () {
        try {
          var result = extractSchedule();
          btn.disabled = false;
          if (result && result.courses && result.courses.length) {
            btn.textContent = '✅ 已复制 ' + result.courses.length + ' 条';
            copyToClipboard(JSON.stringify(result, null, 2));
            showToast('✅ 已复制 ' + result.courses.length + ' 条课表到剪贴板');
            showResult(result);
          } else {
            btn.textContent = '❌ 没找到课程';
            showToast('❌ 当前页面未识别到课程数据，请先进入「学期理论课表」或个人中心');
          }
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '❌ 提取出错';
          showToast('❌ ' + (e.message || e));
        }
        setTimeout(function () { btn.textContent = '📚 提取课表'; }, 3000);
      }, 80);
    };
    document.body.appendChild(btn);
  }

  // 提取后在教务页面右下角弹一个浮窗，显示抓到的课程摘要 + 直接跳转导入器按钮
  function showResult(result) {
    var box = document.querySelector('#__qzpyp_result_box');
    if (box) box.remove();
    box = document.createElement('div');
    box.id = '__qzpyp_result_box';
    var list = result.courses.slice(0, 6);
    var html = '<div style="font-weight:600;margin-bottom:6px">已提取 ' + result.courses.length + ' 条课程</div>';
    list.forEach(function (c) {
      html += '<div style="font-size:12px;opacity:.9;line-height:1.5">· ' +
              c.name + ' · 周' + c.day + ' · 第' + c.sections + '节 · ' + (c.weeks || '?') + '</div>';
    });
    if (result.courses.length > list.length) {
      html += '<div style="font-size:12px;opacity:.7;margin-top:4px">等 ' + result.courses.length + ' 条</div>';
    }
    var sched = result.schedule || {};
    html += '<div style="font-size:12px;opacity:.85;margin-top:8px;border-top:1px solid #555;padding-top:6px">';
    html += '总周数=' + (sched.totalWeek || '?') +
            ' · 上午/下午/晚上=' + (sched.morningNum != null ? (sched.morningNum + '/' + sched.afternoonNum + '/' + sched.nightNum) : '?');
    html += '</div>';
    // 如果导入器在客户端本地跑，从浮窗提供「复制 + 跳到导入器粘贴」按钮
    var origin = (document.querySelector('script[data-qzpyp-base]') || {}).dataset && document.querySelector('script[data-qzpyp-base]').dataset.qzpypBase;
    if (origin) {
      html += '<a href="' + origin + '/#autofocus" target="_blank" ' +
              'style="display:inline-block;margin-top:10px;padding:7px 14px;background:#1677ff;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">↗ 打开小爱课表导入器（已自动填入）</a>';
    }
    html += '<div style="font-size:11px;opacity:.6;margin-top:6px">课表 JSON 已复制到剪贴板，直接到导入器粘贴即可</div>';

    box.innerHTML = html;
    Object.assign(box.style, {
      position: 'fixed', right: '20px', bottom: '80px',
      zIndex: '999999999', padding: '14px 16px',
      background: '#1f1f1f', color: '#fff',
      borderRadius: '10px', maxWidth: '320px',
      boxShadow: '0 6px 20px rgba(0,0,0,.4)',
      fontSize: '13px', lineHeight: '1.5'
    });
    document.body.appendChild(box);
    setTimeout(function () { if (box.parentNode) box.remove(); }, 15000);
  }

  // 默认节次时间表
  var DEFAULT_SECTIONS = [
    { i:  1, s: "08:30", e: "09:10" },
    { i:  2, s: "09:20", e: "10:00" },
    { i:  3, s: "10:25", e: "11:05" },
    { i:  4, s: "11:15", e: "11:55" },
    { i:  5, s: "12:00", e: "12:40" },
    { i:  6, s: "12:50", e: "13:30" },
    { i:  7, s: "14:30", e: "15:10" },
    { i:  8, s: "15:20", e: "16:00" },
    { i:  9, s: "16:25", e: "17:05" },
    { i: 10, s: "17:15", e: "17:55" },
    { i: 11, s: "19:00", e: "19:40" },
    { i: 12, s: "19:50", e: "20:30" },
    { i: 13, s: "20:40", e: "21:20" }
  ];

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createButton);
  } else {
    createButton();
  }

  // 调试入口
  window.__qzpypExtract = extractSchedule;
})();
`;

// ============ 工具 ============
function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().toUpperCase().replace(/-/g, "");
  }
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  }).toUpperCase();
}

function pick(d) {
  if (!d || typeof d !== "object") return null;
  for (let i = 1; i < arguments.length; i++) {
    const k = arguments[i];
    if (k in d && d[k] !== null && d[k] !== "") return d[k];
  }
  return null;
}

// ---------- 周次 ----------
function expandWeeks(text) {
  const weeks = [];
  RANGE_RE.lastIndex = 0;
  let m;
  while ((m = RANGE_RE.exec(String(text))) !== null) {
    if (m[4]) {
      weeks.push(parseInt(m[4], 10));
      continue;
    }
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    const parity = m[3];
    let rng = [];
    for (let w = start; w <= end; w++) rng.push(w);
    if (parity === "单") rng = rng.filter(w => w % 2 === 1);
    else if (parity === "双") rng = rng.filter(w => w % 2 === 0);
    weeks.push(...rng);
  }
  return weeks.join(",");
}

function compressWeeks(weeksStr) {
  let ws;
  try {
    ws = [...new Set(String(weeksStr).split(",").filter(x => x.trim()).map(x => parseInt(x, 10)))].sort((a, b) => a - b);
  } catch (e) { return String(weeksStr); }
  if (!ws.length) return "";
  if (ws.length >= 3 && ws.every((w, i) => i === 0 || w - ws[i - 1] === 2)) {
    return `${ws[0]}-${ws[ws.length - 1]}周(${ws[0] % 2 === 1 ? "单" : "双"})`;
  }
  if (ws.length >= 2 && ws.every((w, i) => i === 0 || w - ws[i - 1] === 1)) {
    return `${ws[0]}-${ws[ws.length - 1]}周`;
  }
  const parts = [];
  let run = [ws[0]];
  for (let i = 1; i < ws.length; i++) {
    if (ws[i] === run[run.length - 1] + 1) run.push(ws[i]);
    else {
      parts.push(run.length > 1 ? `${run[0]}-${run[run.length - 1]}` : String(run[0]));
      run = [ws[i]];
    }
  }
  parts.push(run.length > 1 ? `${run[0]}-${run[run.length - 1]}` : String(run[0]));
  return "第" + parts.join("、") + "周";
}

// ---------- 课程字段 ----------
function parseDay(v) {
  if (v === null || v === undefined) throw new Error("缺少星期字段 day");
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const d = parseInt(s, 10);
    if (d < 1 || d > 7) throw new Error(`星期 day=${d} 超出 1-7`);
    return d;
  }
  const m = /[一二三四五六七天日]/.exec(s);
  if (!m) throw new Error(`无法识别星期 ${JSON.stringify(v)}`);
  return WEEKDAY_MAP[m[0]];
}

function parseSections(v) {
  if (v === null || v === undefined) throw new Error("缺少节次字段 sections");
  let nums = [];
  if (Array.isArray(v)) {
    nums = v.map(x => parseInt(String(x).trim(), 10));
  } else {
    const s = String(v);
    const re = /(\d+)\s*[-~至]\s*(\d+)|(\d+)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m[3]) nums.push(parseInt(m[3], 10));
      else {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        for (let i = a; i <= b; i++) nums.push(i);
      }
    }
  }
  nums = [...new Set(nums.filter(n => n > 0))].sort((a, b) => a - b);
  if (!nums.length) throw new Error(`无法识别节次 ${JSON.stringify(v)}`);
  return nums.join(",");
}

function parseWeeks(v) {
  if (v === null || v === undefined) throw new Error("缺少周次字段 weeks");
  let w;
  if (Array.isArray(v)) w = v.map(x => parseInt(x, 10)).join(",");
  else {
    w = expandWeeks(String(v));
    if (!w) w = String(v).trim();
  }
  if (!w || !/^\d+(,\d+)*$/.test(w)) throw new Error(`无法识别周次 ${JSON.stringify(v)}`);
  return w;
}

function normalizeCourses(raw) {
  let items = [];
  if (Array.isArray(raw)) items = raw;
  else if (raw && typeof raw === "object") {
    for (const k of ["courses", "courseInfos", "list", "data", "result", "课表", "课程"]) {
      const v = raw[k];
      if (Array.isArray(v)) { items = v; break; }
      if (v && typeof v === "object") {
        for (const k2 of ["courses", "courseInfos", "list", "data"]) {
          if (Array.isArray(v[k2])) { items = v[k2]; break; }
        }
        if (items.length) break;
      }
    }
    if (!items.length && pick(raw, "name", "courseName", "课程") != null) items = [raw];
  }
  const courses = [], errors = [];
  const colorMap = {};
  let paletteIdx = 0;
  items.forEach((it, idx) => {
    try {
      if (!it || typeof it !== "object") throw new Error("不是 JSON 对象");
      let name = pick(it, "name", "courseName", "course", "课程名", "课程", "课程名称", "title", "subject");
      if (!name) throw new Error("缺少课程名 name");
      name = String(name).trim();
      const teacher = String(pick(it, "teacher", "teacherName", "teacher_name", "老师", "教师") || "").trim();
      const position = String(pick(it, "position", "place", "room", "location", "地点", "教室", "位置") || "").trim();
      const day = parseDay(pick(it, "day", "weekday", "weekDay", "dayOfWeek", "day_of_week", "星期", "周几"));
      const sections = parseSections(pick(it, "sections", "section", "sectionList", "jie", "节次", "节数"));
      const weeks = parseWeeks(pick(it, "weeks", "week", "zhou", "周次", "周"));
      if (!(name in colorMap)) {
        colorMap[name] = paletteIdx % 12;
        paletteIdx++;
      }
      courses.push({
        name, teacher, position,
        day, sections, weeks,
        styleIdx: colorMap[name],
        weeksText: compressWeeks(weeks),
      });
    } catch (e) {
      errors.push(`第 ${idx + 1} 条：${e.message}`);
    }
  });
  return [courses, errors];
}

function toInt(v) {
  if (v === null || v === undefined) return null;
  const n = parseInt(String(v).trim(), 10);
  return isNaN(n) ? null : n;
}

function normalizeSchedule(raw) {
  const sched = { morningNum: null, afternoonNum: null, nightNum: null, totalWeek: null, sections: null };
  if (!raw || typeof raw !== "object") return sched;
  let src = raw.schedule || raw.setting;
  if (!src || typeof src !== "object") src = {};

  const pickAll = function () {
    for (const d of [src, raw]) {
      for (let i = 0; i < arguments.length; i++) {
        const k = arguments[i];
        if (k in d && d[k] !== null && d[k] !== "") return d[k];
      }
    }
    return null;
  };

  sched.morningNum = toInt(pickAll("morningNum", "morning_num", "上午节数", "上午"));
  sched.afternoonNum = toInt(pickAll("afternoonNum", "afternoon_num", "下午节数", "下午"));
  sched.nightNum = toInt(pickAll("nightNum", "night_num", "eveningNum", "晚上节数", "晚上"));
  sched.totalWeek = toInt(pickAll("totalWeek", "total_week", "总周数", "周数"));
  let secs = pickAll("sections", "sectionTimes", "节次时间", "时间表");
  if (secs !== null && secs !== undefined) {
    if (typeof secs === "string") {
      try { secs = JSON.parse(secs); } catch (e) { secs = null; }
    }
    if (Array.isArray(secs)) {
      const out = [];
      for (const it of secs) {
        if (!it || typeof it !== "object") continue;
        let i = it.i != null ? it.i : (it.index != null ? it.index : it["节次"]);
        let s = it.s != null ? it.s : (it.start != null ? it.start : (it.sTime != null ? it.sTime : it["开始"]));
        let e = it.e != null ? it.e : (it.end != null ? it.end : (it.eTime != null ? it.eTime : it["结束"]));
        const ni = parseInt(i, 10);
        if (isNaN(ni) || s == null || e == null) continue;
        out.push({ i: ni, s: String(s).trim(), e: String(e).trim() });
      }
      if (out.length) sched.sections = out;
    }
  }
  return sched;
}

// ---------- 凭据识别 ----------
function extractCredentials(text) {
  const looksLikeAuth = s => typeof s === "string" && (s.startsWith("DO-TOKEN") || s.startsWith("AO-TOKEN"));
  let raw = null;
  try {
    raw = JSON.parse(text);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) raw = null;
  } catch (e) { raw = null; }
  const jsonGet = function () {
    if (raw) {
      for (let i = 0; i < arguments.length; i++) {
        const k = arguments[i];
        if (k in raw && raw[k] !== null && raw[k] !== "") return String(raw[k]).trim();
      }
    }
    return null;
  };
  const regexFind = function () {
    for (let i = 0; i < arguments.length; i++) {
      const n = arguments[i];
      const m = new RegExp(`["']?${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*[:=]\\s*["']([^"']+)["']`).exec(text);
      if (m) return m[1].trim();
    }
    return null;
  };

  let appId = jsonGet("appId", "app_id", "appid") || regexFind("appId", "app_id", "appid");
  let serviceToken = jsonGet("serviceToken", "service_token", "accessToken", "access_token")
    || regexFind("serviceToken", "service_token", "accessToken", "access_token");
  let deviceId = jsonGet("deviceId", "device_id", "deviceid", "deviceIdNew")
    || regexFind("deviceId", "device_id", "deviceid", "deviceIdNew");

  const auth = jsonGet("authorization", "Authorization") || regexFind("authorization", "Authorization");
  if (auth && looksLikeAuth(auth)) {
    serviceToken = auth;
    if (!appId) {
      const m = /(?:dev_)?app_id:\s*([^,\s]+)/i.exec(auth);
      if (m) appId = m[1].trim();
    }
    if (!deviceId) {
      const m = /scope_data:([A-Za-z0-9+/=]+)/.exec(auth);
      if (m) {
        try {
          const json = atob(m[1]);
          const scope = JSON.parse(json);
          if (scope && scope.d) deviceId = String(scope.d);
        } catch (e) { /* 忽略 */ }
      }
    }
  }
  return [appId, serviceToken, deviceId];
}

// ============ XiaoaiApi ============
class XiaoaiApi {
  constructor(appId, serviceToken, deviceId) {
    this.appId = appId;
    this.serviceToken = serviceToken;
    this.deviceId = deviceId;
  }

  _authorization() {
    if (this.serviceToken.startsWith("DO-TOKEN") || this.serviceToken.startsWith("AO-TOKEN")) {
      return this.serviceToken;
    }
    const json = JSON.stringify({ d: this.deviceId });
    const scope = btoa(json);
    return `AO-TOKEN-V1 dev_app_id:${this.appId},access_token:${this.serviceToken},scope_data:${scope}`;
  }

  _headers(withRequestId) {
    const h = {
      "Authorization": this._authorization(),
      "Content-Type": "application/json",
      "Accept": "*/*",
      "User-Agent": "Mozilla/5.0 (Linux; Android 16; wv) AppleWebKit/537.36 Mobile Safari/537.36",
      "X-Requested-With": "com.xiaomi.aischedule",
      "Origin": "https://i.ai.mi.com",
      "Referer": "https://i.ai.mi.com/h5/precache/ai-schedule/",
    };
    if (withRequestId) h["RequestId"] = uuid();
    return h;
  }

  async _http(method, url, body, withRequestId) {
    const init = { method, headers: this._headers(withRequestId) };
    if (body !== undefined && body !== null) init.body = JSON.stringify(body);
    let resp;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      throw new Error(`网络请求失败：${e.message}`);
    }
    const text = await resp.text();
    if (resp.status === 401 || resp.status === 500) {
      throw new Error(`认证失效（HTTP ${resp.status}），请重新在小爱课表页面复制凭据`);
    }
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    let data;
    try { data = JSON.parse(text); } catch (e) {
      throw new Error(`响应不是 JSON：${text.slice(0, 200)}`);
    }
    const code = data.code !== undefined ? data.code : -1;
    if (code !== 0 && code !== 200) {
      throw new Error(`接口返回 code=${code} ${data.desc || data.msg || ""}`);
    }
    return data;
  }

  listTables() {
    const q = new URLSearchParams({
      requestId: uuid(),
      sourceName: "course-app-aiSchedule",
    }).toString();
    return this._http("GET", `${BASE}/tables?${q}`).then(data => {
      const out = [];
      for (const t of (data.data || [])) {
        out.push({ id: t.id, name: t.name || "未命名", current: t.current || 0 });
      }
      return out;
    });
  }

  getTable(ctId) {
    const q = new URLSearchParams({
      ctId: String(ctId),
      requestId: uuid(),
      sourceName: "course-app-aiSchedule",
    }).toString();
    return this._http("GET", `${BASE}/table?${q}`).then(data => data.data || {});
  }

  createTable(name) {
    return this._http("POST", `${BASE}/table`, {
      name, current: 0, sourceName: "course-app-aiSchedule",
    }).then(data => parseInt(data.data, 10));
  }

  async batchCreateCourses(ctId, courses) {
    const payload = courses.map(c => ({
      name: c.name || "",
      position: c.position || "",
      teacher: c.teacher || "",
      day: parseInt(c.day, 10),
      sections: c.sections || "",
      style: c.style || `{"color":"${STYLES[0][0]}","background":"${STYLES[0][1]}"}`,
      weeks: c.weeks || "",
    }));
    const total = payload.length;
    for (let i = 0; i < total; i += 100) {
      const chunk = payload.slice(i, i + 100);
      const data = await this._http("POST", `${BASE}/courseInfos`, {
        ctId, courses: chunk, sourceName: "course-app-aiSchedule",
      }, true);
      if (data.status === -1) {
        throw new Error(`批量创建失败：课程参数不合法（第 ${i + 1} 条起）`);
      }
    }
    return total;
  }

  deleteCourse(ctId, cId) {
    return this._http("DELETE", `${BASE}/courseInfo`, {
      ctId, cId, sourceName: "course-app-aiSchedule",
    });
  }

  async updateTableSettings(ctId, name, schedule) {
    const cur = await this.getTable(ctId) || {};
    let setting = cur.setting || {};
    if (typeof setting !== "object" || setting === null) setting = {};
    for (const k of ["morningNum", "afternoonNum", "nightNum", "totalWeek"]) {
      const v = schedule[k];
      if (v !== null && v !== undefined && v !== "") {
        const n = parseInt(v, 10);
        if (!isNaN(n)) setting[k] = n;
      }
    }
    const sections = schedule.sections;
    if (sections && Array.isArray(sections)) {
      setting.sections = JSON.stringify(sections);
    }
    const tableName = name || cur.name || "未命名";
    return this._http("PUT", `${BASE}/table`, {
      ctId, name: tableName, sourceName: "course-app-aiSchedule", setting,
    });
  }
}

// ============ 响应辅助 ============
function ok(data) {
  return json({ ok: true, data });
}
function fail(error, extra) {
  return json({ ok: false, error: String(error || "请求失败"), ...(extra || {}) });
}
function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Sid",
    },
  });
}

function getSession(sid) { return SESSIONS.get(sid); }
function setSession(sid, api) { SESSIONS.set(sid, api); }
function requireApi(sid) {
  const api = getSession(sid);
  if (!api) throw new Error("未连接，请先点「连接」按钮");
  return api;
}

// 油猴脚本头部
function buildUserscript(jsBody) {
  return `// ==UserScript==
// @name         强智教务课表提取器 - 标准格式
// @namespace    https://tampermonkey.net/
// @version      3.3.0
// @description  从「小爱课表导入器」内置提供
// @match        *://jiaowu.gzpyp.edu.cn/*
// @match        *://*.gzpyp.edu.cn/*
// @match        *://*jsxsd*
// @run-at       document-idle
// ==/UserScript==

${jsBody}`;
}

// ============ 路由 ============
async function handleApi(method, path, request, sid, env) {
  // CORS 预检
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Sid",
      },
    });
  }

  // GET 路由
  if (method === "GET") {
    if (path === "/api/ping") {
      return ok({ time: new Date().toUTCString().slice(17, 25), share: true });
    }
    if (path === "/api/state") {
      const api = getSession(sid);
      return ok({ connected: !!api, creds: null, publicUrl: null, port: null });
    }
    if (path === "/api/jiaowu_extractor.js") {
      if (!JIAOWU_JS_BODY) {
        if (env && env.JIAOWU_JS) {
          JIAOWU_JS_BODY = env.JIAOWU_JS;
        } else if (env && env.JIAOWU_EXTRACTOR_JS) {
          JIAOWU_JS_BODY = env.JIAOWU_EXTRACTOR_JS;
        }
      }
      const body = JIAOWU_JS_BODY || "// 未配置 JIAOWU_JS 环境变量";
      return new Response(body, {
        headers: {
          "Content-Type": "application/x-javascript; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        },
      });
    }
    if (path === "/api/jiaowu_userscript.js") {
      if (!JIAOWU_JS_BODY) {
        if (env && env.JIAOWU_JS) JIAOWU_JS_BODY = env.JIAOWU_JS;
        else if (env && env.JIAOWU_EXTRACTOR_JS) JIAOWU_JS_BODY = env.JIAOWU_EXTRACTOR_JS;
      }
      const body = JIAOWU_JS_BODY || "";
      return new Response(buildUserscript(body), {
        headers: {
          "Content-Type": "application/x-javascript; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        },
      });
    }
    if (path === "/api/tables") {
      try {
        const api = requireApi(sid);
        const tables = await api.listTables();
        return ok(tables);
      } catch (e) { return fail(e.message); }
    }
    if (path === "/api/table") {
      try {
        const api = requireApi(sid);
        const url = new URL(request.url);
        const ctId = parseInt(url.searchParams.get("ctId"), 10);
        if (isNaN(ctId)) return fail("缺少 ctId 参数");
        const data = await api.getTable(ctId);
        const courses = data.courses || [];
        const out = [];
        for (const c of courses) {
          const cid = c.id != null ? c.id : c.cId;
          if (cid === null || cid === undefined) continue;
          out.push({
            id: cid,
            name: c.name || "",
            teacher: c.teacher || "",
            position: c.position || "",
            day: c.day,
            sections: c.sections || "",
            weeks: c.weeks || "",
            weeksText: compressWeeks(c.weeks || ""),
          });
        }
        out.sort((a, b) => (a.day || 0) - (b.day || 0)
          || parseInt(String(a.sections).split(",")[0] || "0", 10) - parseInt(String(b.sections).split(",")[0] || "0", 10));
        return ok({ courses: out });
      } catch (e) { return fail(e.message); }
    }
    if (path === "/api/jiaowu_captcha" || path === "/api/jiaowu_login" || path === "/api/jiaowu_fetch") {
      return fail("公网部署不支持教务直登，请改用「📚 复制提取书签」按钮在教务页面提取课表");
    }
    return fail("not found");
  }

  // POST 路由
  if (method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { body = {}; }

    if (path === "/api/connect") {
      try {
        const raw = String(body.raw || "");
        let appId = String(body.appId || "").trim();
        let token = String(body.serviceToken || "").trim();
        let device = String(body.deviceId || "").trim();
        if (raw) {
          const [e1, e2, e3] = extractCredentials(raw);
          appId = appId || e1 || "";
          token = token || e2 || "";
          device = device || e3 || "";
        }
        const credsOut = { appId: appId || "", serviceToken: token || "", deviceId: device || "" };
        if (!appId || !token || !device) {
          const missing = [];
          if (!appId) missing.push("appId");
          if (!token) missing.push("serviceToken");
          if (!device) missing.push("deviceId");
          return fail(`凭据不完整，缺少：${missing.join("、")}（可把整段 Debug JSON 直接粘贴到上方大框自动提取）`, { extracted: credsOut });
        }
        try {
          const api = new XiaoaiApi(appId, token, device);
          const tables = await api.listTables();
          setSession(sid, api);
          return ok({ tables, extracted: credsOut });
        } catch (e) {
          return fail(e.message, { extracted: credsOut });
        }
      } catch (e) { return fail(e.message); }
    }

    if (path === "/api/create_table") {
      try {
        const api = requireApi(sid);
        const name = String(body.name || "").trim();
        if (!name) return fail("课表名不能为空");
        const ctId = await api.createTable(name);
        return ok({ ctId });
      } catch (e) { return fail(e.message); }
    }

    if (path === "/api/parse") {
      try {
        const text = String(body.text || "").trim();
        if (!text) return fail("请先粘贴课程 JSON");
        let s = -1, e = -1;
        for (const [open, close] of [["[", "]"], ["{", "}"]]) {
          const i = text.indexOf(open);
          const j = text.lastIndexOf(close);
          if (i >= 0 && j > i && (s === -1 || i < s)) { s = i; e = j; }
        }
        if (s === -1) return fail("未找到 JSON 内容（需要以 [ 或 { 开头的数组/对象）");
        let raw;
        try { raw = JSON.parse(text.slice(s, e + 1)); } catch (ex) {
          return fail(`JSON 解析失败：${ex.message}`);
        }
        const [courses, errors] = normalizeCourses(raw);
        if (!courses.length) return fail(`没有解析出任何有效课程：${errors.slice(0, 3).join("；")}`);
        const schedule = raw && typeof raw === "object" && !Array.isArray(raw) ? normalizeSchedule(raw) : null;
        return ok({ courses, errors, count: courses.length, schedule });
      } catch (e) { return fail(e.message); }
    }

    if (path === "/api/import") {
      try {
        const api = requireApi(sid);
        const ctId = parseInt(body.ctId, 10);
        if (isNaN(ctId)) return fail("缺少 ctId");
        const courses = body.courses || [];
        if (!courses.length) return fail("没有课程可导入");
        for (const c of courses) {
          const [fg, bg] = STYLES[(c.styleIdx || 0) % 12];
          c.style = `{"color":"${fg}","background":"${bg}"}`;
        }
        let deleted = 0;
        if (body.clearFirst) {
          const existing = (await api.getTable(ctId)).courses || [];
          for (const c of existing) {
            const cid = c.id != null ? c.id : c.cId;
            if (cid !== null && cid !== undefined) {
              await api.deleteCourse(ctId, cid);
              deleted++;
            }
          }
        }
        const n = await api.batchCreateCourses(ctId, courses);
        let synced = false;
        let syncErr = null;
        const schedule = body.schedule;
        if (body.syncSettings && schedule && typeof schedule === "object") {
          const hasValue = Object.values(schedule).some(v => v !== null && v !== undefined && v !== "");
          if (hasValue) {
            try {
              await api.updateTableSettings(ctId, null, schedule);
              synced = true;
            } catch (e) {
              syncErr = e.message;
            }
          }
        }
        return ok({ imported: n, deleted, synced, syncError: syncErr });
      } catch (e) { return fail(e.message); }
    }

    if (path === "/api/delete") {
      try {
        const api = requireApi(sid);
        const ctId = parseInt(body.ctId, 10);
        if (isNaN(ctId)) return fail("缺少 ctId");
        const cIds = body.cIds || [];
        for (const cid of cIds) {
          await api.deleteCourse(ctId, parseInt(cid, 10));
        }
        return ok({ deleted: cIds.length });
      } catch (e) { return fail(e.message); }
    }

    if (path === "/api/clear") {
      try {
        const api = requireApi(sid);
        const ctId = parseInt(body.ctId, 10);
        if (isNaN(ctId)) return fail("缺少 ctId");
        const existing = (await api.getTable(ctId)).courses || [];
        for (const c of existing) {
          const cid = c.id != null ? c.id : c.cId;
          if (cid !== null && cid !== undefined) {
            await api.deleteCourse(ctId, cid);
          }
        }
        return ok({ deleted: existing.length });
      } catch (e) { return fail(e.message); }
    }

    if (path === "/api/jiaowu_login" || path === "/api/jiaowu_fetch") {
      return fail("公网部署不支持教务直登，请改用「📚 复制提取书签」按钮");
    }

    return fail("not found");
  }

  return fail(`不支持 ${method} 请求`);
}

// ============ Pages Function 入口 ============
// catch-all 路由：/api/[[path]] 匹配 /api/ 下任意深度路径
async function dispatch(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const sid = request.headers.get("X-Sid") || "default";
  try {
    return await handleApi(request.method, path, request, sid, env);
  } catch (e) {
    return fail(`服务器内部错误：${e.message}`);
  }
}

export async function onRequestGet(context) {
  return dispatch(context.request, context.env, context.ctx);
}
export async function onRequestPost(context) {
  return dispatch(context.request, context.env, context.ctx);
}
export async function onRequestOptions(context) {
  return dispatch(context.request, context.env, context.ctx);
}
