// ==UserScript==
// @name         强智教务课表提取器 - 标准格式
// @namespace    https://tampermonkey.net/
// @version      3.3.0
// @description  提取强智教务系统课表并转换为标准 JSON（含课表设置：节数/总周数），可直接粘贴到小爱课表导入器
// @author       User
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
    'use strict';

    let courses = [];
    let maxPageSection = 0;  // 页面上所有「第N-M节」行的最大 M（含无课行，用于准确推断总节数）

    // ============================================================
    // 工具：清理文本
    // ============================================================

    function cleanText(text) {
        return (text || '')
            .replace(/&nbsp;/g, '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ============================================================
    // 工具：周次标准化
    // 强智原始写法          ->  标准格式
    // "1-16(周)"            ->  "1-16周"
    // "1-16(周)单" / 单周    ->  "1-16周(单)"
    // "1-16(周)双" / 双周    ->  "1-16周(双)"
    // "1,3,5(周)"           ->  "1,3,5周"
    // ============================================================

    function normalizeWeeks(weekText) {
        weekText = cleanText(weekText);
        if (!weekText) return '';

        // 提取数字部分（支持 1-16 / 1—16 / 1,3,5 / 1-16,18 混合）
        var m = weekText.match(/[\d]+(?:\s*[-—~,，]\s*\d+)*/);
        var base = m ? m[0] : weekText;
        base = base.replace(/\s+/g, '')
                   .replace(/[—–]/g, '-')   // 全角/长破折号 -> 连字符
                   .replace(/[，~]/g, ',')   // 全角逗号等 -> 逗号
                   .replace(/,+$/, '')
                   .replace(/周+$/, '');

        var suffix = '';
        if (/单/.test(weekText)) suffix = '(单)';
        else if (/双/.test(weekText)) suffix = '(双)';

        return base + '周' + suffix;
    }

    // ============================================================
    // 工具：生成节次字符串 "1,2"
    // ============================================================

    function buildSections(start, end) {
        var result = [];
        for (var i = start; i <= end; i++) result.push(i);
        return result.join(',');
    }

    // ============================================================
    // 递归查找元素（穿透 iframe / frame）
    // ============================================================

    function findEl(d, selector) {
        try {
            var el = d.querySelector(selector);
            if (el) return el;
        } catch (e) {}

        var frames = [];
        try { d.querySelectorAll('iframe').forEach(f => frames.push(f)); } catch (e) {}
        try { d.querySelectorAll('frame').forEach(f => frames.push(f)); } catch (e) {}

        for (var i = 0; i < frames.length; i++) {
            try {
                var fd = frames[i].contentDocument || frames[i].contentWindow.document;
                if (fd) {
                    var result = findEl(fd, selector);
                    if (result) return result;
                }
            } catch (e) {}
        }
        return null;
    }

    // ============================================================
    // 模式1：学期理论课表（#kbtable）
    // ============================================================

    function parseKbtable(d, table) {
        console.log('[课表] 检测到学期理论课表');

        var rows = table.querySelectorAll('tr');

        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            var th = row.querySelector('th');
            if (!th) continue;

            var firstText = cleanText(th.textContent);
            if (firstText.includes('星期') || firstText.includes('备注')) continue;

            var periodMatch = firstText.match(/第\s*(\d+)\s*[-—]\s*(\d+)\s*节/);
            if (!periodMatch) continue;

            var start = parseInt(periodMatch[1]);
            var end = parseInt(periodMatch[2]);
            if (end > maxPageSection) maxPageSection = end;  // 含无课行，准确拿总节数
            var tds = row.querySelectorAll('td');

            for (var j = 0; j < tds.length && j < 7; j++) {
                var day = j + 1;
                var td = tds[j];
                var divs = td.querySelectorAll('div');

                var contentDiv = null;
                for (var k = 0; k < divs.length; k++) {
                    var className = typeof divs[k].className === 'string' ? divs[k].className : '';
                    if (className.includes('kbcontent') &&
                        !className.includes('kbcontent1') &&
                        !className.includes('sykb2')) {
                        if (cleanText(divs[k].textContent)) {
                            contentDiv = divs[k];
                            break;
                        }
                    }
                }
                if (!contentDiv) continue;

                var blocks = contentDiv.innerHTML.split(/-{15,}/);

                for (var b = 0; b < blocks.length; b++) {
                    var block = blocks[b];
                    if (!block.trim()) continue;

                    var temp = d.createElement('div');
                    temp.innerHTML = block;

                    // ---- 课程名称 ----
                    var name = '';
                    var walker = d.createTreeWalker(temp, NodeFilter.SHOW_TEXT, null, false);
                    var node;
                    while ((node = walker.nextNode())) {
                        var text = cleanText(node.textContent);
                        if (text) { name = text; break; }
                    }
                    if (!name) continue;

                    // ---- P / O 标记 ----
                    var redFonts = temp.querySelectorAll('font[color="red"]');
                    for (var f = 0; f < redFonts.length; f++) {
                        var ftext = cleanText(redFonts[f].textContent);
                        if (ftext.includes('P') || ftext.includes('O')) {
                            // 标记去掉，不进 name
                        }
                    }
                    name = name.replace(/\s*[PO]\s*$/, '').trim();

                    // ---- 教师 ----
                    var teacherEl = temp.querySelector("font[title='老师']");
                    var teacher = teacherEl ? cleanText(teacherEl.textContent) : '';

                    // ---- 教室 ----
                    var classroomEl = temp.querySelector("font[title='教室']");
                    var position = classroomEl ? cleanText(classroomEl.textContent) : '';

                    // ---- 周次 -> 标准格式 ----
                    var weeks = '';
                    var weekEl = temp.querySelector("font[title='周次(节次)']");
                    if (weekEl) {
                        weeks = normalizeWeeks(weekEl.textContent);
                    }

                    courses.push({
                        name: name,
                        teacher: teacher,
                        position: position,
                        day: day,
                        sections: buildSections(start, end),
                        weeks: weeks
                    });
                }
            }
        }
    }

    // ============================================================
    // 模式2：个人中心课表（#tab1）
    // ============================================================

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

                    // ---- 课程名称 ----
                    var nameMatch = title.match(/课程名称[：:]\s*([^\f\n\r<]+)/);
                    if (!nameMatch) continue;
                    var name = cleanText(nameMatch[1]);

                    // ---- 周次 -> 标准格式 ----
                    var weekMatch = title.match(/第\s*(\d+)\s*周/);
                    var weeks = forceWeek
                        ? forceWeek + '周'
                        : weekMatch ? weekMatch[1] + '周' : '';

                    // ---- 星期 ----
                    var dayMatch = title.match(/星期([一二三四五六日])/);
                    if (dayMatch) {
                        var dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7 };
                        day = dayMap[dayMatch[1]] || day;
                    }

                    // ---- 上课地点 ----
                    var roomMatch = title.match(/上课地点[：:]\s*([^\f\n\r<]+)/);
                    var position = roomMatch ? cleanText(roomMatch[1]) : '';

                    // ---- 教师（个人中心 title 里有时带教师信息）----
                    var teacherMatch = title.match(/教师[：:]\s*([^\f\n\r<]+)/);
                    var teacher = teacherMatch ? cleanText(teacherMatch[1]) : '';

                    courses.push({
                        name: name,
                        teacher: teacher,
                        position: position,
                        day: day,
                        sections: buildSections(start, end),
                        weeks: weeks
                    });
                }
            }
        }
    }

    // ============================================================
    // 获取个人中心 1~20 周
    // ============================================================

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

            console.log('[课表] 正在读取第 1~20 周...');

            for (var week = 1; week <= 20; week++) {
                var date = new Date(startDate);
                date.setDate(date.getDate() + (week - 1) * 7);
                var dateString = date.getFullYear() + '-' +
                    String(date.getMonth() + 1).padStart(2, '0') + '-' +
                    String(date.getDate()).padStart(2, '0');

                var xhr = new XMLHttpRequest();
                xhr.open('POST', '/jsxsd/framework/main_index_loadkb.jsp', false);
                xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
                xhr.send('rq=' + encodeURIComponent(dateString) +
                         '&sjmsValue=' + encodeURIComponent(sjmsValue));

                if (xhr.status === 200 && xhr.responseText) {
                    var temp = document.createElement('div');
                    temp.innerHTML = xhr.responseText;
                    var tab = temp.querySelector('#tab1');
                    if (tab) parsePersonalKb(temp, tab, week);
                }
            }
        } catch (e) {
            console.error('[课表] 获取周次失败:', e);
        }
    }

    // ============================================================
    // 去重
    // ============================================================

    function removeDuplicates() {
        var seen = {};
        courses = courses.filter(function (course) {
            var key = [course.name, course.teacher, course.position,
                       course.day, course.sections, course.weeks].join('|');
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });
    }

    // ============================================================
    // 构建 schedule（课表设置：总周数 / 上午·下午·晚上节数）
    // 强智课表页面只有节次区间（如「第1-2节」），无单节上下课时间，
    // 故 sections 时间表留空，需在导入器里手动填或用默认时间表。
    // ============================================================

    function buildSchedule(list) {
        var maxWeek = 0;
        // 总节数优先用页面所有「第N-M节」行的最大 M（含无课行），
        // 再与课程实际出现的节次取最大，确保不会因某节没课而偏小
        var maxSec = maxPageSection || 0;
        list.forEach(function (c) {
            var w = String(c.weeks || '');
            var wm = w.match(/\d+/g);
            if (wm) wm.forEach(function (x) {
                var n = parseInt(x, 10);
                if (n > maxWeek) maxWeek = n;
            });
            var sm = String(c.sections || '').match(/\d+/g);
            if (sm) sm.forEach(function (x) {
                var n = parseInt(x, 10);
                if (n > maxSec) maxSec = n;
            });
        });

        // 按总节数推断上午/下午/晚上分法（仅合理默认，用户可在导入器改）
        var morn, aft, night;
        if (maxSec <= 0) { morn = null; aft = null; night = null; }
        else if (maxSec <= 4) { morn = maxSec; aft = 0; night = 0; }
        else if (maxSec <= 8) { morn = 4; aft = maxSec - 4; night = 0; }
        else if (maxSec <= 12) { morn = 4; aft = 4; night = maxSec - 8; }
        else { morn = 6; aft = 4; night = maxSec - 10; }  // >12 节：6上午/4下午/其余晚上（13节=6/4/3）

        return {
            totalWeek: maxWeek || null,
            morningNum: morn,
            afternoonNum: aft,
            nightNum: night,
            sections: DEFAULT_SECTIONS.slice(0, maxSec)  // 小尾巴默认时间表，按实际节数裁剪
        };
    }

    // ============================================================
    // 复制到剪贴板
    // ============================================================

    function copyToClipboard(text) {
        try {
            GM_setClipboard(text, 'text');
            return true;
        } catch (e) {
            console.warn('[课表] GM_setClipboard失败', e);
        }
        return false;
    }

    // ============================================================
    // Toast
    // ============================================================

    function showToast(text) {
        var old = document.querySelector('#__schedule_toast');
        if (old) old.remove();

        var toast = document.createElement('div');
        toast.id = '__schedule_toast';
        toast.textContent = text;
        Object.assign(toast.style, {
            position: 'fixed', left: '50%', bottom: '80px',
            transform: 'translateX(-50%)', zIndex: '999999999',
            background: '#222', color: '#fff', padding: '12px 20px',
            borderRadius: '10px', fontSize: '15px',
            boxShadow: '0 4px 15px rgba(0,0,0,.3)'
        });
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    // ============================================================
    // 主提取：输出 { courses:[...], schedule:{总周数/节数} }
    // ============================================================

    function extractSchedule() {
        courses = [];
        maxPageSection = 0;  // 重置页面节次最大值
        var targetDoc = null;

        console.log('[课表] 开始提取...');

        // 模式1：学期理论课表
        var kbtable = findEl(document, '#kbtable');
        if (kbtable) {
            // findEl 需要知道目标在哪个 document，重新探测一遍
            targetDoc = locateDoc(document, '#kbtable') || document;
            parseKbtable(targetDoc, kbtable);
        }

        // 模式2：个人中心课表
        if (!courses.length) {
            var tab1 = findEl(document, '#tab1');
            if (tab1) {
                targetDoc = locateDoc(document, '#tab1') || document;
                console.log('[课表] 使用个人中心模式');
                parsePersonalKb(targetDoc, tab1, null);
                loadAllWeeks();
                removeDuplicates();
            }
        }

        if (!courses.length) {
            copyToClipboard('{}');
            showToast('❌ 没有找到课程数据');
            console.log('[课表] 提取结果: {}');
            return { courses: [], schedule: {} };
        }

        // ---- 构建 schedule（课表设置）----
        var schedule = buildSchedule(courses);

        // ---- 输出 {courses, schedule} ----
        var output = { courses: courses, schedule: schedule };
        var text = JSON.stringify(output, null, 2);

        console.log('======================================');
        console.log('✅ 提取成功：' + courses.length + ' 条课程 + 课表设置');
        console.log('   总周数=' + (schedule.totalWeek || '?') +
                    '，节数=' + (schedule.morningNum != null
                        ? (schedule.morningNum + '/' + schedule.afternoonNum + '/' + schedule.nightNum)
                        : '?') +
                    '，时间表=' + (schedule.sections.length ? '有' : '无（需在导入器填）'));
        console.log(text);
        console.log('======================================');

        var copied = copyToClipboard(text);
        showToast(copied ? ('✅ 已复制 ' + courses.length + ' 条课程 + 课表设置（节数/总周数/时间表）')
                        : '⚠️ 提取成功，但复制失败');

        return output;
    }

    // 定位目标元素所在的 document
    function locateDoc(d, selector) {
        try {
            if (d.querySelector(selector)) return d;
        } catch (e) {}
        var frames = [];
        try { d.querySelectorAll('iframe').forEach(f => frames.push(f)); } catch (e) {}
        try { d.querySelectorAll('frame').forEach(f => frames.push(f)); } catch (e) {}
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

    // ============================================================
    // 创建按钮
    // ============================================================

    function createButton() {
        if (document.querySelector('#__schedule_extract_btn')) return;

        var button = document.createElement('button');
        button.id = '__schedule_extract_btn';
        button.textContent = '📚 提取课表';
        Object.assign(button.style, {
            position: 'fixed', right: '20px', bottom: '20px',
            zIndex: '999999999', padding: '12px 18px', border: 'none',
            borderRadius: '10px', background: '#1677ff', color: '#fff',
            fontSize: '15px', fontWeight: 'bold', cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,.25)'
        });

        button.onclick = function () {
            button.textContent = '⏳ 提取中...';
            setTimeout(function () {
                var result = extractSchedule();
                if (result && result.courses && result.courses.length) {
                    button.textContent = '✅ 已复制 ' + result.courses.length + ' 条';
                } else {
                    button.textContent = '❌ 提取失败';
                }
                setTimeout(() => { button.textContent = '📚 提取课表'; }, 3000);
            }, 50);
        };

        document.body.appendChild(button);
    }

    // ============================================================
    // 启动
    // ============================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createButton);
    } else {
        createButton();
    }

    // 控制台手动执行
    window.extractSchedule = extractSchedule;

    // ============================================================
    // [小尾巴] 默认节次时间表（13节，每节40分钟+课间10分钟，大课间25分钟）
    // 强智教务页面本身不提供上下课时间，故在此硬编码常见时间表。
    // 与小爱课表 APP 设置页中「节次时间」格式一致：[{i,s,e}, ...]
    // 如需调整（例如节次不同），直接修改下面数组即可。
    // ============================================================
    const DEFAULT_SECTIONS = [
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

})();
