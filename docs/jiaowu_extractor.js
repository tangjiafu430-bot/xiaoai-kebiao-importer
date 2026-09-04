// ==/JIAOWU EXTRACTOR==
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
