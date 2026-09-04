# -*- coding: utf-8 -*-
"""
小爱课表导入器 · 简洁版
========================
单文件本地应用，仅用 Python 标准库，无任何第三方依赖。

用法：
    python 小爱课表导入器.py
    （自动打开浏览器 http://127.0.0.1:8899，仅本机可访问）

    python 小爱课表导入器.py --share
    （监听 0.0.0.0，同一局域网的手机/电脑都能访问；
      每个浏览器独立会话，多人同时用互不顶号；
      共享模式下不回传/保存凭据，各自粘贴自己的 Debug JSON）

    python 小爱课表导入器.py --public
    （隐含 --share；自动启动 cloudflared quick tunnel，
      打印一个 https://*.trycloudflare.com 公网地址，
      不限网络、不限设备都能访问。链接每次启动会变。
      需要 cloudflared：放到 tools/cloudflared.exe 或加入 PATH）

功能：
    1. 粘贴小爱课表 H5 的 Debug JSON，自动提取 appId / serviceToken / deviceId
    2. 选择或新建目标课表
    3. 粘贴小爱标准格式的课程 JSON（字段名宽松兼容、周次支持 1-16周(单) 写法）
    4. 一键解析预览（周视图 + 错误提示），确认后批量导入
    5. 查看 / 删除 / 清空 / 导出现有课表

接口协议逆向自 com.mercury.courseimport（小爱课程导入 APK）。
"""

import base64
import gzip
import io
import json
import os
import re
import shutil
import socket
import ssl
import sys
import threading
import time
import uuid
import webbrowser

# ---------- 路径辅助：兼容 PyInstaller 打包 ----------
def _resource_dir():
    """只读资源目录（开发时=脚本目录，PyInstaller 打包后=_MEIPASS）"""
    if getattr(sys, "frozen", False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))

def _user_dir():
    """用户数据目录（始终返回 exe/脚本 所在目录，存 credentials.json、access.log 等）"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))
import http.cookiejar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

# ============================================================================
# 小爱课表 API（基于逆向还原的协议，用标准库 urllib 实现）
# ============================================================================

STYLES = [
    ("#00A6F2", "#E5F4FF"), ("#FC6B50", "#FDEBDE"),
    ("#3CB3C8", "#DEFBF8"), ("#7D7AEA", "#EDEDFF"),
    ("#FF9900", "#FCEBCD"), ("#EF5B75", "#FFEFF0"),
    ("#5B8EFF", "#EAF1FF"), ("#F067BB", "#FFEDF8"),
    ("#29BBAA", "#E2F8F3"), ("#CBA713", "#FFF8C8"),
    ("#B967E3", "#F9EDFF"), ("#6E8ADA", "#F3F2FD"),
]


class ApiError(Exception):
    pass


class XiaoaiApi:
    BASE = "https://i.ai.mi.com/course-multi-auth"

    def __init__(self, app_id, service_token, device_id, timeout=30):
        self.app_id = app_id
        self.service_token = service_token
        self.device_id = device_id
        self.timeout = timeout

    # ---------- 鉴权 ----------

    def _authorization(self):
        if self.service_token.startswith(("DO-TOKEN", "AO-TOKEN")):
            return self.service_token
        scope = base64.b64encode(
            json.dumps({"d": self.device_id}, separators=(",", ":"))
            .encode("utf-8")).decode("ascii")
        return ("AO-TOKEN-V1 dev_app_id:%s,access_token:%s,scope_data:%s"
                % (self.app_id, self.service_token, scope))

    def _headers(self, with_request_id=False):
        h = {
            "Authorization": self._authorization(),
            "Content-Type": "application/json",
            "Accept": "*/*",
            "User-Agent": ("Mozilla/5.0 (Linux; Android 16; wv) "
                           "AppleWebKit/537.36 Mobile Safari/537.36"),
            "X-Requested-With": "com.xiaomi.aischedule",
            "Origin": "https://i.ai.mi.com",
            "Referer": "https://i.ai.mi.com/h5/precache/ai-schedule/",
        }
        if with_request_id:
            h["RequestId"] = uuid.uuid4().hex.upper()
        return h

    # ---------- 底层请求 ----------

    def _open(self, req):
        """urlopen：先正常校验证书；校园网/代理拦截（自签名）时回退跳过校验"""
        try:
            return urlrequest.urlopen(req, timeout=self.timeout)
        except urlerror.HTTPError:
            raise
        except Exception as e:
            if "SSL" in str(e).upper() or "CERTIFICATE" in str(e).upper():
                return urlrequest.urlopen(req, timeout=self.timeout,
                                           context=ssl._create_unverified_context())
            raise

    def _http(self, method, url, body=None, with_request_id=False):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urlrequest.Request(url, data=data, method=method)
        for k, v in self._headers(with_request_id).items():
            req.add_header(k, v)
        try:
            with self._open(req) as resp:
                text = resp.read().decode("utf-8", "ignore")
        except urlerror.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:200]
            if e.code in (401, 500):
                raise ApiError("认证失效（HTTP %d），请重新在小爱课表页面复制凭据" % e.code)
            raise ApiError("HTTP %d: %s" % (e.code, detail))
        except Exception as e:
            raise ApiError("网络请求失败：%s" % e)
        try:
            data = json.loads(text)
        except Exception:
            raise ApiError("响应不是 JSON：%s" % text[:200])
        code = data.get("code", -1)
        if code not in (0, 200):
            raise ApiError("接口返回 code=%s %s" % (code, data.get("desc") or data.get("msg") or ""))
        return data

    # ---------- 业务接口 ----------

    def list_tables(self):
        q = urlparse.urlencode({"requestId": uuid.uuid4().hex.upper(),
                                "sourceName": "course-app-aiSchedule"})
        data = self._http("GET", self.BASE + "/tables?" + q)
        out = []
        for t in (data.get("data") or []):
            out.append({"id": t.get("id"), "name": t.get("name", "未命名"),
                        "current": t.get("current", 0)})
        return out

    def get_table(self, ct_id):
        q = urlparse.urlencode({"ctId": ct_id,
                                "requestId": uuid.uuid4().hex.upper(),
                                "sourceName": "course-app-aiSchedule"})
        data = self._http("GET", self.BASE + "/table?" + q)
        return data.get("data") or {}

    def create_table(self, name):
        data = self._http("POST", self.BASE + "/table",
                          {"name": name, "current": 0,
                           "sourceName": "course-app-aiSchedule"})
        return int(data["data"])

    def batch_create_courses(self, ct_id, courses):
        """courses: 已规范化的 [{name,teacher,position,day,sections,weeks,style}]"""
        payload = []
        for c in courses:
            payload.append({
                "name": c.get("name") or "",
                "position": c.get("position") or "",
                "teacher": c.get("teacher") or "",
                "day": int(c["day"]),
                "sections": c.get("sections") or "",
                "style": c.get("style") or '{"color":"%s","background":"%s"}' % STYLES[0],
                "weeks": c.get("weeks") or "",
            })
        total = len(payload)
        for i in range(0, total, 100):  # 分批，每批 100 条
            chunk = payload[i:i + 100]
            data = self._http("POST", self.BASE + "/courseInfos",
                              {"ctId": ct_id, "courses": chunk,
                               "sourceName": "course-app-aiSchedule"},
                              with_request_id=True)
            if data.get("status", 0) == -1:
                raise ApiError("批量创建失败：课程参数不合法（第 %d 条起）" % (i + 1))
        return total

    def delete_course(self, ct_id, c_id):
        self._http("DELETE", self.BASE + "/courseInfo",
                   {"ctId": ct_id, "cId": c_id,
                    "sourceName": "course-app-aiSchedule"})

    def update_table_settings(self, ct_id, name, schedule):
        """同步课表设置（PUT /table）。

        先 GET 现有 setting 再合并，避免清空用户已有的背景/学位等设置。
        schedule: {morningNum, afternoonNum, nightNum, totalWeek, sections}
                  sections 为 [{i,s,e}, ...] 列表，各字段均可选。
        """
        cur = self.get_table(ct_id) or {}
        setting = cur.get("setting") or {}
        if not isinstance(setting, dict):
            setting = {}
        for k in ("morningNum", "afternoonNum", "nightNum", "totalWeek"):
            v = schedule.get(k)
            if v not in (None, ""):
                try:
                    setting[k] = int(v)
                except (TypeError, ValueError):
                    pass
        sections = schedule.get("sections")
        if sections:  # [{i,s,e}, ...] -> 转义 JSON 字符串（小爱要求字符串）
            setting["sections"] = json.dumps(sections, ensure_ascii=False)
        table_name = name or cur.get("name") or "未命名"
        self._http("PUT", self.BASE + "/table", {
            "ctId": ct_id, "name": table_name,
            "sourceName": "course-app-aiSchedule",
            "setting": setting,
        })


# ============================================================================
# 课程 JSON 解析（宽松字段名 + 周次/节次智能展开）
# ============================================================================

_RANGE_RE = re.compile(r"(\d+)\s*(?:-|至|~)\s*(\d+)(?:[\s周\(（\)）]*(单|双)[\s周\(（\)）]*)?|(\d+)")

WEEKDAY_MAP = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "天": 7, "日": 7}


def expand_weeks(text):
    """'1-16周(单)' / '1至16' / '3' → '1,3,5,...'"""
    weeks = []
    for m in _RANGE_RE.finditer(str(text)):
        if m.group(4):
            weeks.append(int(m.group(4)))
            continue
        start, end, parity = int(m.group(1)), int(m.group(2)), m.group(3)
        rng = range(start, end + 1)
        if parity == "单":
            rng = [w for w in rng if w % 2 == 1]
        elif parity == "双":
            rng = [w for w in rng if w % 2 == 0]
        weeks.extend(rng)
    return ",".join(str(w) for w in weeks)


def compress_weeks(weeks_str):
    """'1,3,5,7,9,11,13,15' → '1-15周(单)'，用于预览展示"""
    try:
        ws = sorted({int(x) for x in str(weeks_str).split(",") if x.strip()})
    except Exception:
        return str(weeks_str)
    if not ws:
        return ""
    if len(ws) >= 3 and ws == list(range(ws[0], ws[-1] + 1, 2)):
        return "%d-%d周(%s)" % (ws[0], ws[-1], "单" if ws[0] % 2 == 1 else "双")
    if len(ws) >= 2 and ws == list(range(ws[0], ws[-1] + 1)):
        return "%d-%d周" % (ws[0], ws[-1])
    parts, run = [], [ws[0]]
    for w in ws[1:]:
        if w == run[-1] + 1:
            run.append(w)
        else:
            parts.append("%d-%d" % (run[0], run[-1]) if len(run) > 1 else str(run[0]))
            run = [w]
    parts.append("%d-%d" % (run[0], run[-1]) if len(run) > 1 else str(run[0]))
    return "第" + "、".join(parts) + "周"


def _pick(d, *keys):
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return None


def parse_day(v):
    if v is None:
        raise ValueError("缺少星期字段 day")
    if isinstance(v, int):
        d = v
    else:
        s = str(v).strip()
        if s.isdigit():
            d = int(s)
        else:
            m = re.search(r"[一二三四五六七天日]", s)
            if not m:
                raise ValueError("无法识别星期 %r" % v)
            d = WEEKDAY_MAP[m.group(0)]
    if not 1 <= d <= 7:
        raise ValueError("星期 day=%s 超出 1-7" % d)
    return d


def parse_sections(v):
    if v is None:
        raise ValueError("缺少节次字段 sections")
    nums = []
    if isinstance(v, (list, tuple)):
        for x in v:
            nums.append(int(str(x).strip()))
    else:
        s = str(v)
        for m in re.finditer(r"(\d+)\s*[-~至]\s*(\d+)|(\d+)", s):
            if m.group(3):
                nums.append(int(m.group(3)))
            else:
                nums.extend(range(int(m.group(1)), int(m.group(2)) + 1))
    nums = sorted(set(int(n) for n in nums if n > 0))
    if not nums:
        raise ValueError("无法识别节次 %r" % v)
    return ",".join(str(n) for n in nums)


def parse_weeks(v):
    if v is None:
        raise ValueError("缺少周次字段 weeks")
    if isinstance(v, (list, tuple)):
        w = ",".join(str(int(x)) for x in v)
    else:
        w = expand_weeks(str(v))
        if not w:
            w = str(v).strip()
    if not w or not re.fullmatch(r"\d+(,\d+)*", w):
        raise ValueError("无法识别周次 %r" % v)
    return w


def normalize_courses(raw):
    """把任意宽松 JSON 规范化为小爱标准格式，返回 (courses, errors)"""
    items = []
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        for k in ("courses", "courseInfos", "list", "data", "result", "课表", "课程"):
            v = raw.get(k)
            if isinstance(v, list):
                items = v
                break
            if isinstance(v, dict):  # 嵌套再找一层
                for k2 in ("courses", "courseInfos", "list", "data"):
                    if isinstance(v.get(k2), list):
                        items = v[k2]
                        break
                if items:
                    break
        if not items and _pick(raw, "name", "courseName", "课程") is not None:
            items = [raw]

    courses, errors = [], []
    color_map, palette_idx = {}, 0
    for idx, it in enumerate(items):
        try:
            if not isinstance(it, dict):
                raise ValueError("不是 JSON 对象")
            name = _pick(it, "name", "courseName", "course", "课程名", "课程", "课程名称", "title", "subject")
            if not name:
                raise ValueError("缺少课程名 name")
            name = str(name).strip()
            teacher = str(_pick(it, "teacher", "teacherName", "teacher_name", "老师", "教师") or "").strip()
            position = str(_pick(it, "position", "place", "room", "location", "地点", "教室", "位置") or "").strip()
            day = parse_day(_pick(it, "day", "weekday", "weekDay", "dayOfWeek", "day_of_week", "星期", "周几"))
            sections = parse_sections(_pick(it, "sections", "section", "sectionList", "jie", "节次", "节数"))
            weeks = parse_weeks(_pick(it, "weeks", "week", "zhou", "周次", "周"))
            if name not in color_map:
                color_map[name] = palette_idx % 12
                palette_idx += 1
            courses.append({
                "name": name, "teacher": teacher, "position": position,
                "day": day, "sections": sections, "weeks": weeks,
                "styleIdx": color_map[name],
                "weeksText": compress_weeks(weeks),
            })
        except Exception as e:
            errors.append("第 %d 条：%s" % (idx + 1, e))
    return courses, errors


def normalize_schedule(raw):
    """从粘贴的 JSON 对象里提取并规范化 schedule（课表设置）。

    支持两种形态：
      1) 顶层带 schedule/setting 对象：{"courses":[...], "schedule":{...}}
      2) 字段直接散落在顶层：{"courses":[...], "morningNum":5, ...}
    返回 {morningNum, afternoonNum, nightNum, totalWeek, sections}，未识别的字段为 None。
    sections 为 [{i,s,e}, ...] 列表（小爱标准时间表）。
    """
    sched = {"morningNum": None, "afternoonNum": None,
             "nightNum": None, "totalWeek": None, "sections": None}
    if not isinstance(raw, dict):
        return sched
    src = raw.get("schedule") or raw.get("setting")
    if not isinstance(src, dict):
        src = {}

    def pick(*keys):
        for d in (src, raw):
            for k in keys:
                v = d.get(k)
                if v not in (None, ""):
                    return v
        return None

    def to_int(v):
        try:
            return int(str(v).strip())
        except Exception:
            return None

    sched["morningNum"] = to_int(pick("morningNum", "morning_num",
                                      "上午节数", "上午"))
    sched["afternoonNum"] = to_int(pick("afternoonNum", "afternoon_num",
                                        "下午节数", "下午"))
    sched["nightNum"] = to_int(pick("nightNum", "night_num", "eveningNum",
                                    "晚上节数", "晚上"))
    sched["totalWeek"] = to_int(pick("totalWeek", "total_week",
                                     "总周数", "周数"))
    secs = pick("sections", "sectionTimes", "节次时间", "时间表")
    if secs is not None:
        if isinstance(secs, str):
            try:
                secs = json.loads(secs)  # 可能是已转义的 JSON 字符串
            except Exception:
                secs = None
        if isinstance(secs, list):
            out = []
            for it in secs:
                if not isinstance(it, dict):
                    continue
                i = it.get("i", it.get("index", it.get("节次")))
                s = it.get("s", it.get("start", it.get("sTime", it.get("开始"))))
                e = it.get("e", it.get("end", it.get("eTime", it.get("结束"))))
                try:
                    i = int(i)
                except Exception:
                    continue
                if s is None or e is None:
                    continue
                out.append({"i": i, "s": str(s).strip(), "e": str(e).strip()})
            if out:
                sched["sections"] = out
    return sched


def extract_credentials(text):
    """从粘贴的 Debug JSON 文本中提取 appId / serviceToken / deviceId。

    小爱 H5 的 Debug JSON 有两种形态：
      1) 独立字段：appId / serviceToken / deviceId
      2) authorization 字段里自带 app_id / access_token / scope_data.deviceId
    这里优先尝试 JSON 解析，再回退到正则；authorization 整串可直接作为 serviceToken。
    """

    def looks_like_auth(s):
        return isinstance(s, str) and s.startswith(("DO-TOKEN", "AO-TOKEN"))

    raw = None
    try:
        raw = json.loads(text)
        if not isinstance(raw, dict):
            raw = None
    except Exception:
        pass

    def json_get(*keys):
        if isinstance(raw, dict):
            for k in keys:
                if k in raw and raw[k] not in (None, ""):
                    return str(raw[k]).strip()
        return None

    def regex_find(*names):
        for n in names:
            m = re.search(r'["\']?%s["\']?\s*[:=]\s*["\']([^"\']+?)["\']' % re.escape(n), text)
            if m:
                return m.group(1).strip()
        return None

    app_id = json_get("appId", "app_id", "appid") or regex_find("appId", "app_id", "appid")
    service_token = json_get("serviceToken", "service_token", "accessToken", "access_token") \
        or regex_find("serviceToken", "service_token", "accessToken", "access_token")
    device_id = json_get("deviceId", "device_id", "deviceid", "deviceIdNew") \
        or regex_find("deviceId", "device_id", "deviceid", "deviceIdNew")

    # authorization 字段是现成的完整 Authorization 头，优先级最高
    auth = json_get("authorization", "Authorization") or regex_find("authorization", "Authorization")
    if auth and looks_like_auth(auth):
        service_token = auth
        if not app_id:
            m = re.search(r'(?:dev_)?app_id:\s*([^,\s]+)', auth, re.I)
            if m:
                app_id = m.group(1).strip()
        if not device_id:
            m = re.search(r'scope_data:([A-Za-z0-9+/=]+)', auth)
            if m:
                try:
                    scope = json.loads(base64.b64decode(m.group(1)).decode("utf-8", "ignore"))
                    if isinstance(scope, dict) and scope.get("d"):
                        device_id = str(scope["d"])
                except Exception:
                    pass

    return app_id, service_token, device_id


# ============================================================================
# 本地 Web 服务
# ============================================================================

CRED_FILE = os.path.join(_user_dir(), "credentials.json")
SESSIONS = {}        # sid -> XiaoaiApi 实例（多浏览器/多人各自独立，互不顶号）
SHARE_MODE = False   # --share 启动时监听 0.0.0.0，允许局域网访问
STATE = {}           # 运行期状态：port、public_url 等可被 /api/state 读取


def load_saved_creds():
    try:
        with open(CRED_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_creds(creds):
    try:
        with open(CRED_FILE, "w", encoding="utf-8") as f:
            json.dump(creds, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# ============================================================================
# 强智教务提取脚本：从同目录 tools/jiaowu_extractor.js 读取
# ============================================================================

JIAOWU_JS_PATH = os.path.join(_resource_dir(), "tools", "jiaowu_extractor.js")
_JIAOWU_JS_CACHE = {"data": None}


def open_jiaowu_js():
    if _JIAOWU_JS_CACHE["data"] is not None:
        return _JIAOWU_JS_CACHE["data"]
    try:
        with open(JIAOWU_JS_PATH, "r", encoding="utf-8") as f:
            data = f.read()
        _JIAOWU_JS_CACHE["data"] = data
        return data
    except Exception as e:
        return "// 提取脚本未找到: %s\n" % e


def build_userscript(js_body):
    """把核心 JS 包成油猴脚本头部（含 @match / @grant 等元数据）"""
    header = (
        "// ==UserScript==\n"
        "// @name         强智教务课表提取器 - 标准格式\n"
        "// @namespace    https://tampermonkey.net/\n"
        "// @version      3.3.0\n"
        "// @description  从「小爱课表导入器」内置提供\n"
        "// @match        *://jiaowu.gzpyp.edu.cn/*\n"
        "// @match        *://*.gzpyp.edu.cn/*\n"
        "// @match        *://*jsxsd*\n"
        "// @run-at       document-idle\n"
        "// ==/UserScript==\n\n"
    )
    return header + js_body


# ============================================================================
# 教务系统直登抓取（纯标准库 urllib + cookiejar；校园网自签名证书禁用校验）
# ============================================================================

JIAOWU_SCHOOL = {
    "host": "jiaowu.gzpyp.edu.cn",
    "base": "https://jiaowu.gzpyp.edu.cn",
    "login_page": "https://jiaowu.gzpyp.edu.cn/",
    "login_post": "https://jiaowu.gzpyp.edu.cn/Logon.do?method=logon",
    "login_sess": "https://jiaowu.gzpyp.edu.cn/Logon.do?method=logon&flag=sess",
    "captcha": "https://jiaowu.gzpyp.edu.cn/verifycode.servlet",
    "schedule": "https://jiaowu.gzpyp.edu.cn/jsxsd/xskb/xskb_list.do",
}

# sid -> JiaowuFetcher 实例（每个浏览器会话独立教务登录态，避免多人互顶）
JIAOWU_SESSIONS = {}


def _jiaowu_ssl_ctx():
    """校园网自签名证书：禁用校验，避免 SSL 握手失败"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class JiaowuFetcher:
    """强智教务（jsxsd）登录 + 课表抓取，纯标准库实现"""

    UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
          "AppleWebKit/537.36 (KHTML, like Gecko) "
          "Chrome/120.0.0.0 Safari/537.36")

    def __init__(self):
        self.cookie_jar = http.cookiejar.CookieJar()
        opener = urlrequest.build_opener(
            urlrequest.HTTPSHandler(context=_jiaowu_ssl_ctx()),
            urlrequest.HTTPCookieProcessor(self.cookie_jar),
        )
        opener.addheaders = [("User-Agent", self.UA)]
        self.opener = opener

    def _get(self, url):
        req = urlrequest.Request(url, headers={"User-Agent": self.UA})
        with self.opener.open(req, timeout=30) as resp:
            data = resp.read()
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            return data

    def _post(self, url, data):
        # data 是 dict 时 urlencode 成表单串；统一转 bytes 走 POST
        if isinstance(data, dict):
            data = urlparse.urlencode(data)
        if isinstance(data, str):
            data = data.encode("utf-8")
        req = urlrequest.Request(url, data=data)
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.add_header("User-Agent", self.UA)
        with self.opener.open(req, timeout=30) as resp:
            raw = resp.read()
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw

    def fetch_captcha(self):
        """拉取验证码图片，返回 bytes"""
        req = urlrequest.Request(JIAOWU_SCHOOL["captcha"],
                                 headers={"User-Agent": self.UA})
        with self.opener.open(req, timeout=30) as resp:
            return resp.read()

    def _encode(self, account, password):
        """预检拿 scode#sxh，按登录页 JS 算法加密返回 encoded"""
        body = self._post(JIAOWU_SCHOOL["login_sess"], {})
        body = (body or "").strip().strip('"').strip()
        if "#" not in body:
            raise ApiError("登录预检失败：未拿到加密参数")
        scode, sxh = body.split("#", 1)
        scode = scode.strip()
        sxh = sxh.strip()
        code = account + "%%%" + password
        encoded = ""
        remain = scode
        for i, ch in enumerate(code):
            if i < 20 and i < len(sxh):
                n = int(sxh[i])
                encoded += ch + remain[:n]
                remain = remain[n:]
            else:
                encoded += ch
        return encoded

    def login(self, account, password, captcha):
        """登录教务系统，失败抛 ApiError，成功返回响应 body"""
        encoded = self._encode(account, password)
        body = self._post(JIAOWU_SCHOOL["login_post"], {
            "userAccount": account,
            "userPassword": password,
            "RANDOMCODE": captcha,
            "encoded": encoded,
        })
        if not isinstance(body, str):
            body = str(body)
        # 错误页关键词识别（强智返回的错误提示页）
        if "密码" in body and ("错误" in body or "不正确" in body):
            raise ApiError("账号或密码错误")
        if "验证码" in body and ("错误" in body or "不正确" in body):
            raise ApiError("验证码错误")
        return body

    def fetch_terms(self):
        """解析课表页学年学期下拉，返回 (terms列表[{id,name}], 当前选中id或None)"""
        html = self._get(JIAOWU_SCHOOL["schedule"])
        terms = []
        cur = None
        m = re.search(r'<select[^>]*name=["\']xnxq01id["\'][^>]*>(.*?)</select>',
                      html, re.S | re.I)
        if m:
            for opt in re.finditer(r'<option([^>]*)>([^<]*)</option>',
                                   m.group(1), re.I):
                attrs = opt.group(1)
                val_m = re.search(r'value=["\']([^"\']*)["\']', attrs, re.I)
                val = val_m.group(1) if val_m else ""
                terms.append({"id": val, "name": opt.group(2).strip()})
                if re.search(r'\bselected\b', attrs, re.I):
                    cur = val
        return terms, cur

    def fetch_schedule_html(self, term_id):
        """抓取指定学期的课表页 HTML，返回 str"""
        url = JIAOWU_SCHOOL["schedule"]
        if term_id:
            url = url + "?xnxq01id=" + urlparse.quote(term_id)
        return self._get(url)


ACCESS_LOG = os.path.join(_user_dir(), "access.log")


class Handler(BaseHTTPRequestHandler):

    # HTTP/1.1 长连接：避免每个请求重新握手（弱 Wi-Fi 下明显更快）
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # 共享模式下记录访问日志（时间 / 来源IP / 耗时 / 请求），便于定位慢在哪
        if not SHARE_MODE:
            return
        try:
            ms = ""
            t0 = getattr(self, "_t0", None)
            if t0 is not None:
                ms = " %4dms" % ((time.time() - t0) * 1000)
            line = "[%s] %-15s%s %s\n" % (time.strftime("%H:%M:%S"),
                                          self.client_address[0], ms, fmt % args)
            with open(ACCESS_LOG, "a", encoding="utf-8") as f:
                f.write(line)
            print(line, end="")
        except Exception:
            pass

    # ---------- 响应工具 ----------

    def _send(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _ok(self, data=None):
        self._send({"ok": True, "data": data})

    def _fail(self, msg):
        self._send({"ok": False, "error": str(msg)})

    def _send_script(self, js_text, *, cors=False, content_type="application/javascript; charset=utf-8"):
        """返回一段 JS：cors=True 时附带 Access-Control-Allow-Origin: *"""
        body = js_text.encode("utf-8") if isinstance(js_text, str) else js_text
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:
            return {}

    def _sid(self):
        return (self.headers.get("X-Sid") or "default").strip()[:64]

    def _api(self):
        api = SESSIONS.get(self._sid())
        if api is None:
            raise ApiError("尚未连接：请先填写凭据并点击「连接」")
        return api

    # ---------- 路由 ----------

    def do_GET(self):
        self._t0 = time.time()
        path = urlparse.urlparse(self.path).path
        try:
            if path in ("/", "/index.html"):
                body = PAGE.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                if "gzip" in (self.headers.get("Accept-Encoding") or ""):
                    buf = io.BytesIO()
                    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as g:
                        g.write(body)
                    body = buf.getvalue()
                    self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif path == "/api/ping":
                # 手机上直接访问这个地址测延迟：…/api/ping
                self._ok({"time": time.strftime("%H:%M:%S"), "share": SHARE_MODE})
            elif path == "/api/jiaowu_captcha":
                # 教务系统验证码图片：按会话懒建 fetcher，直接回字节（不走 self._ok）
                fetcher = JIAOWU_SESSIONS.get(self._sid())
                if fetcher is None:
                    fetcher = JiaowuFetcher()
                    JIAOWU_SESSIONS[self._sid()] = fetcher
                img = fetcher.fetch_captcha()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(img)))
                self.end_headers()
                self.wfile.write(img)
            elif path == "/api/jiaowu_extractor.js":
                # 给教务页面注入用：跨域允许（Bookmarklet/油猴脚本都能拉）
                self._send_script(open_jiaowu_js(), cors=True)
            elif path == "/api/jiaowu_userscript.js":
                # 油猴脚本：把油猴头部 + 提取脚本一次性打包发出去
                self._send_script(build_userscript(open_jiaowu_js()), cors=True,
                                  content_type="application/x-javascript; charset=utf-8")
            elif path == "/api/state":
                # 共享模式下不回传保存的凭据，避免 token 泄露给局域网用户
                creds = load_saved_creds() if not SHARE_MODE else None
                self._ok({"connected": SESSIONS.get(self._sid()) is not None,
                         "creds": {k: (creds or {}).get(k, "") for k in
                                   ("appId", "serviceToken", "deviceId")} if creds else None,
                         "publicUrl": STATE.get("public_url"),
                         "port": STATE.get("port")})
            elif path == "/api/tables":
                self._ok(self._api().list_tables())
            elif path == "/api/table":
                qs = urlparse.parse_qs(urlparse.urlparse(self.path).query)
                ct_id = int(qs["ctId"][0])
                data = self._api().get_table(ct_id)
                courses = data.get("courses") or []
                out = []
                for c in courses:
                    cid = c.get("id", c.get("cId"))
                    if cid is None:
                        continue
                    out.append({"id": cid, "name": c.get("name", ""),
                                "teacher": c.get("teacher") or "",
                                "position": c.get("position") or "",
                                "day": c.get("day"), "sections": c.get("sections") or "",
                                "weeks": c.get("weeks") or "",
                                "weeksText": compress_weeks(c.get("weeks") or "")})
                out.sort(key=lambda x: (x["day"] or 0,
                                        int(str(x["sections"]).split(",")[0] or 0)))
                self._ok({"courses": out})
            else:
                self._send({"ok": False, "error": "not found"}, 404)
        except Exception as e:
            self._fail(e)

    def do_POST(self):
        self._t0 = time.time()
        path = urlparse.urlparse(self.path).path
        body = self._body()
        try:
            if path == "/api/connect":
                raw = str(body.get("raw") or "")
                app_id = (body.get("appId") or "").strip()
                token = (body.get("serviceToken") or "").strip()
                device = (body.get("deviceId") or "").strip()
                if raw:
                    e1, e2, e3 = extract_credentials(raw)
                    app_id, token, device = app_id or e1 or "", token or e2 or "", device or e3 or ""
                creds_out = {"appId": app_id or "", "serviceToken": token or "", "deviceId": device or ""}
                if not (app_id and token and device):
                    missing = [n for n, v in (("appId", app_id), ("serviceToken", token),
                                               ("deviceId", device)) if not v]
                    self._send({"ok": False,
                                "error": "凭据不完整，缺少：%s（可把整段 Debug JSON 直接粘贴到上方大框自动提取）"
                                % "、".join(missing),
                                "extracted": creds_out})
                    return
                try:
                    api = XiaoaiApi(app_id, token, device)
                    tables = api.list_tables()  # 连接即验证
                    SESSIONS[self._sid()] = api
                    if body.get("remember") and not SHARE_MODE:
                        save_creds(creds_out)
                    self._ok({"tables": tables, "extracted": creds_out})
                except Exception as e:
                    self._send({"ok": False, "error": str(e), "extracted": creds_out})
            elif path == "/api/jiaowu_login":
                # 教务系统直登：账号/密码/验证码 → 登录 → 返回学年学期列表
                account = str(body.get("account") or "").strip()
                password = str(body.get("password") or "")
                captcha = str(body.get("captcha") or "").strip()
                if not (account and password and captcha):
                    raise ApiError("请填写账号、密码、验证码")
                fetcher = JIAOWU_SESSIONS.get(self._sid())
                if fetcher is None:
                    fetcher = JiaowuFetcher()
                    JIAOWU_SESSIONS[self._sid()] = fetcher
                try:
                    fetcher.login(account, password, captcha)
                except ApiError:
                    raise
                except Exception as e:
                    # 登录失败清掉 session，强制前端重新拉验证码
                    JIAOWU_SESSIONS.pop(self._sid(), None)
                    raise ApiError("登录失败：%s" % e)
                terms, cur = fetcher.fetch_terms()
                self._ok({"terms": terms, "current": cur})
            elif path == "/api/jiaowu_fetch":
                # 登录后抓取指定学期课表页 HTML（前端再解析）
                fetcher = JIAOWU_SESSIONS.get(self._sid())
                if fetcher is None:
                    raise ApiError("请先登录教务系统")
                term_id = str(body.get("termId") or "").strip()
                html = fetcher.fetch_schedule_html(term_id)
                self._ok({"html": html})
            elif path == "/api/create_table":
                name = str(body.get("name") or "").strip()
                if not name:
                    raise ApiError("课表名不能为空")
                ct_id = self._api().create_table(name)
                self._ok({"ctId": ct_id})
            elif path == "/api/parse":
                text = str(body.get("text") or "").strip()
                if not text:
                    raise ApiError("请先粘贴课程 JSON")
                # 容错：截取第一个 [ 或 { 到最后一个 ] 或 }
                s, e = -1, -1
                for ch_open, ch_close in (("[", "]"), ("{", "}")):
                    i, j = text.find(ch_open), text.rfind(ch_close)
                    if i >= 0 and j > i and (s == -1 or i < s):
                        s, e = i, j
                if s == -1:
                    raise ApiError("未找到 JSON 内容（需要以 [ 或 { 开头的数组/对象）")
                try:
                    raw = json.loads(text[s:e + 1])
                except Exception as ex:
                    raise ApiError("JSON 解析失败：%s" % ex)
                courses, errors = normalize_courses(raw)
                if not courses:
                    raise ApiError("没有解析出任何有效课程：%s" % "；".join(errors[:3]))
                schedule = normalize_schedule(raw) if isinstance(raw, dict) else None
                self._ok({"courses": courses, "errors": errors,
                          "count": len(courses), "schedule": schedule})
            elif path == "/api/import":
                api = self._api()
                ct_id = int(body.get("ctId"))
                courses = body.get("courses") or []
                if not courses:
                    raise ApiError("没有课程可导入")
                for c in courses:
                    fg, bg = STYLES[c.get("styleIdx", 0) % 12]
                    c["style"] = '{"color":"%s","background":"%s"}' % (fg, bg)
                deleted = 0
                if body.get("clearFirst"):
                    existing = (api.get_table(ct_id).get("courses") or [])
                    for c in existing:
                        cid = c.get("id", c.get("cId"))
                        if cid is not None:
                            api.delete_course(ct_id, cid)
                            deleted += 1
                n = api.batch_create_courses(ct_id, courses)
                synced = False
                sync_err = None
                schedule = body.get("schedule")
                if body.get("syncSettings") and isinstance(schedule, dict):
                    has_value = any(v not in (None, "", []) for v in schedule.values())
                    if has_value:
                        try:
                            api.update_table_settings(ct_id, None, schedule)
                            synced = True
                        except Exception as e:
                            sync_err = str(e)
                self._ok({"imported": n, "deleted": deleted,
                          "synced": synced, "syncError": sync_err})
            elif path == "/api/delete":
                api = self._api()
                ct_id = int(body.get("ctId"))
                for cid in body.get("cIds") or []:
                    api.delete_course(ct_id, int(cid))
                self._ok({"deleted": len(body.get("cIds") or [])})
            elif path == "/api/clear":
                api = self._api()
                ct_id = int(body.get("ctId"))
                existing = (api.get_table(ct_id).get("courses") or [])
                for c in existing:
                    cid = c.get("id", c.get("cId"))
                    if cid is not None:
                        api.delete_course(ct_id, cid)
                self._ok({"deleted": len(existing)})
            else:
                self._send({"ok": False, "error": "not found"}, 404)
        except Exception as e:
            self._fail(e)


# ============================================================================
# 页面（内嵌 HTML，无外部依赖）
# ============================================================================

PAGE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>小爱课表导入器</title>
<style>
:root{
  --bg:#f3f5f9; --card:#ffffff; --text:#1c2333; --sub:#7a8299;
  --line:#e6e9f2; --accent:#4f6ef7; --accent2:#3b56d9;
  --ok:#1fa967; --err:#e5484d; --radius:14px;
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#14161c; --card:#1e2129; --text:#e8eaf0; --sub:#9aa1b5;
         --line:#2c303c; --accent:#6b85ff; --accent2:#5470f0; }
}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
     background:var(--bg);color:var(--text);line-height:1.6}
.wrap{max-width:1060px;margin:0 auto;padding:28px 18px 80px}
header{display:flex;align-items:baseline;gap:12px;margin-bottom:22px}
header h1{font-size:24px;margin:0;letter-spacing:.5px}
header .tag{font-size:13px;color:var(--sub)}
.dot{width:9px;height:9px;border-radius:50%;background:#c3c8d6;display:inline-block;margin-right:6px}
.dot.on{background:var(--ok);box-shadow:0 0 0 4px rgba(31,169,103,.15)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
      padding:20px 22px;margin-bottom:18px;box-shadow:0 1px 3px rgba(20,25,40,.05)}
.card h2{font-size:16px;margin:0 0 4px}
.hint{font-size:13px;color:var(--sub);margin:0 0 12px}
textarea,input,select,button{font-family:inherit;font-size:14px;color:var(--text)}
textarea{width:100%;min-height:110px;padding:10px 12px;border:1px solid var(--line);
  border-radius:10px;background:var(--bg);resize:vertical;outline:none}
textarea:focus{border-color:var(--accent)}
#credPaste{min-height:70px;font-size:12px;color:var(--sub)}
.row3{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:12px}
.row3 label{font-size:12px;color:var(--sub);display:flex;flex-direction:column;gap:4px}
.row3 input{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.row3 input:focus{outline:none;border-color:var(--accent)}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px;align-items:center}
.link{display:inline-block;padding:8px 14px;border-radius:9px;border:1px solid var(--line);
      background:var(--bg);color:var(--text);text-decoration:none;font-size:14px}
.link:hover{border-color:var(--accent)}
button{padding:8px 18px;border-radius:9px;border:1px solid var(--line);cursor:pointer;
  background:var(--card);transition:.15s}
button:hover{border-color:var(--accent);color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
button.primary:hover{background:var(--accent2);color:#fff}
button.danger{color:var(--err)}
button.danger:hover{border-color:var(--err)}
button:disabled{opacity:.45;cursor:not-allowed}
.chk{font-size:13px;color:var(--sub);display:flex;align-items:center;gap:6px;user-select:none}
.msg{font-size:13px;margin-top:10px;padding:9px 12px;border-radius:9px;display:none}
.msg.ok{display:block;color:var(--ok);background:rgba(31,169,103,.09)}
.msg.err{display:block;color:var(--err);background:rgba(229,72,77,.09)}
.tblbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
select{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);min-width:220px}
#stats{font-size:13px;color:var(--sub);margin-top:12px}
.errlist{font-size:13px;color:var(--err);margin-top:8px;white-space:pre-line}
table.grid{border-collapse:collapse;width:100%;margin-top:14px;table-layout:fixed}
table.grid th,table.grid td{border:1px solid var(--line);padding:0;font-size:12px;text-align:center;vertical-align:top}
table.grid th{padding:7px 4px;color:var(--sub);font-weight:600;background:var(--bg)}
table.grid td{height:46px}
.cc{margin:2px;border-radius:7px;padding:4px 6px;text-align:left;overflow:hidden}
.cc .n{font-weight:600;font-size:12px;line-height:1.35}
.cc .m{font-size:11px;opacity:.85;line-height:1.3}
table.rows{border-collapse:collapse;width:100%;margin-top:12px;font-size:13px}
table.rows th,table.rows td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left}
table.rows th{color:var(--sub);font-weight:600}
table.rows tr:hover td{background:var(--bg)}
.badge{display:inline-block;font-size:11px;padding:1px 8px;border-radius:20px;
  background:var(--bg);border:1px solid var(--line);color:var(--sub)}
footer{text-align:center;font-size:12px;color:var(--sub);margin-top:26px}
.hidden{display:none}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>小爱课表导入器</h1>
  <span class="tag">粘贴 JSON → 预览 → 一键导入 · 比原版少点 8 次屏幕</span>
</header>

<div class="card" id="cardCred">
  <h2><span class="dot" id="dot"></span>1 · 连接小爱</h2>
  <p class="hint">打开小爱 App 的「课程表」H5 页面，复制 Debug JSON 整段粘贴到下面（自动提取凭据），或直接手动填写三项。凭据只保存在你本机。</p>
  <textarea id="credPaste" placeholder="把包含 appId / serviceToken / deviceId 的 Debug JSON 整段粘贴到这里，自动识别…"></textarea>
  <div class="row3">
    <label>appId<input id="appId" autocomplete="off"></label>
    <label>serviceToken<input id="serviceToken" autocomplete="off"></label>
    <label>deviceId<input id="deviceId" autocomplete="off"></label>
  </div>
  <div class="btns">
    <button class="primary" id="btnConnect">连接</button>
    <label class="chk"><input type="checkbox" id="remember" checked>记住凭据（本机 credentials.json）</label>
  </div>
  <div class="msg" id="credMsg"></div>
</div>

<div class="card" id="cardJiaowu">
  <h2>📥 0 · 从教务系统提取课表 <span class="tag" style="margin-left:8px;background:var(--bg);border:1px solid var(--line);color:var(--sub);padding:1px 8px;font-size:11px">强智教务（jsxsd）</span></h2>
  <p class="hint">用校内 <strong>强智教务系统</strong>（例如广州番禺 / 长沙理工 / 中南 等众多高校）登录课表页面后，在浏览器书签栏里点「提取课表」按钮 → 自动把 JSON 复制到剪贴板，回本页粘贴即可。</p>

  <div class="btns" style="margin-bottom:10px">
    <a class="link" id="linkLogin" target="_blank" rel="noopener">🔑 打开登录页</a>
    <a class="link" id="linkKb" target="_blank" rel="noopener">📖 学期理论课表</a>
    <a class="link" id="linkPersonal" target="_blank" rel="noopener">👤 个人中心</a>
  </div>

  <div class="btns">
    <button id="btnCopyBookmarklet">📚 复制提取书签（拖到书签栏）</button>
    <button id="btnCopyUserscript">📋 复制油猴脚本内容</button>
    <a class="link" id="linkJsSource" target="_blank" rel="noopener">⬇ 直接看脚本源码</a>
  </div>

  <div class="msg" id="jiaowuMsg"></div>

  <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
  <div style="font-size:13px;font-weight:600;color:var(--sub);margin-bottom:8px">⚡ 直接登录抓取（免装油猴）</div>
  <div class="row3">
    <label>学号<input id="jwAccount" placeholder="学号" autocomplete="off"></label>
    <label>密码<input id="jwPassword" type="password" placeholder="密码" autocomplete="off"></label>
  </div>
  <div class="btns">
    <img id="jwCaptchaImg" alt="验证码" title="点击刷新"
         style="height:40px;border:1px solid var(--line);cursor:pointer;border-radius:6px;background:var(--bg)">
    <input id="jwCaptcha" placeholder="验证码" autocomplete="off"
           style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);width:110px">
    <button id="btnJwCaptcha">刷新验证码</button>
  </div>
  <div class="btns">
    <select id="jwTerm" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);min-width:180px"></select>
    <button class="primary" id="btnJwLogin">登录并抓取课表</button>
  </div>
  <div class="msg" id="jwMsg"></div>

  <details style="margin-top:12px">
    <summary style="cursor:pointer;color:var(--sub);font-size:13px">📘 怎么用？</summary>
    <ol style="line-height:1.8;font-size:13px;padding-left:20px">
      <li>点「📚 复制提取书签」→ 浏览器会复制一段 <code>javascript:</code> 开头的链接</li>
      <li>把这条链接拖到浏览器<strong>书签栏</strong>（或右键书签 → 添加网页 → 粘贴到网址栏）</li>
      <li>打开教务系统（上面任一链接）→ 登录 → 进入「学期理论课表」或个人中心课表</li>
      <li>点书签栏里的「提取课表」→ 自动复制课表 JSON 到剪贴板，并在页面右下角显示提示</li>
      <li>回本页下方「<strong>3 · 粘贴课程 JSON</strong>」一栏 → 课表 JSON <strong>会自动填入</strong>（已开剪贴板自动识别）</li>
    </ol>
    <p class="hint" style="margin-top:8px">替代方案：直接用油猴插件，在脚本管理里新建脚本粘贴内容即可（点上面「📋 复制油猴脚本内容」→ 在油猴编辑器里粘贴保存）。</p>
  </details>
</div>

<div class="card hidden" id="cardTable">
  <h2>2 · 选择目标课表</h2>
  <p class="hint">课程将写入选中的课表；也可以新建一个（例如「2026 春」），导入后再去小爱 App 里切换。</p>
  <div class="tblbar">
    <select id="tableSel"></select>
    <button id="btnNewTable">＋ 新建课表</button>
    <span class="hint" id="tableInfo" style="margin:0"></span>
  </div>
  <div class="msg" id="tableMsg"></div>
</div>

<div class="card hidden" id="cardImport">
  <h2>3 · 粘贴课程 JSON</h2>
  <p class="hint">标准格式：<code>[{"name":"高等数学","teacher":"张三","position":"A101","day":1,"sections":"1,2","weeks":"1-16周(单)"}]</code> —— 字段名宽松兼容（courseName/老师/教室/星期 都认），周次支持 <code>1-16周(单)</code>、<code>1至16</code> 等写法。</p>
  <textarea id="jsonInput" style="min-height:180px;font-family:Consolas,monospace;font-size:13px"
    placeholder='[{"name":"高等数学(下)","teacher":"张三","position":"教1-101","day":1,"sections":"1,2","weeks":"1-16周"},
 {"name":"大学英语","teacher":"李四","position":"外语楼302","day":2,"sections":"3,4","weeks":"1-16周(单)"}]'></textarea>
  <div class="btns">
    <button id="btnParse">解析预览</button>
    <button id="btnSample">填入示例</button>
    <label class="chk"><input type="checkbox" id="clearFirst">导入前清空该课表现有课程</label>
    <button class="primary" id="btnImport" disabled>导入到小爱 →</button>
  </div>
  <div id="stats"></div>
  <div class="errlist" id="errlist"></div>
  <div id="schedPanel" class="hidden">
    <h2 style="font-size:15px;margin:14px 0 4px">课表设置（节数 / 时间表）</h2>
    <p class="hint">来自教务系统的课表设置，导入时一并同步到小爱（合并到现有 setting，不清空背景等）。节数和时间可手动修改。</p>
    <div class="row3">
      <label>上午节数<input id="numMorning" type="number" min="0" max="12"></label>
      <label>下午节数<input id="numAfternoon" type="number" min="0" max="12"></label>
      <label>晚上节数<input id="numNight" type="number" min="0" max="12"></label>
      <label>总周数<input id="numTotalWeek" type="number" min="1" max="40"></label>
    </div>
    <div id="schedTimes" style="margin-top:10px"></div>
    <div class="btns" style="margin-top:8px">
      <label class="chk"><input type="checkbox" id="syncSettings" checked>导入时同步课表设置</label>
    </div>
  </div>
  <div id="grid"></div>
  <div class="msg" id="importMsg"></div>
</div>

<div class="card hidden" id="cardManage">
  <h2>4 · 管理课表</h2>
  <p class="hint">查看当前课表已有课程、单条删除、全部清空，或导出为标准 JSON 备份/迁移。</p>
  <div class="btns">
    <button id="btnLoadCourses">查看该课表课程</button>
    <button id="btnExport">导出为 JSON</button>
    <button class="danger" id="btnClear">清空该课表</button>
  </div>
  <div id="courseList" style="margin-top:6px"></div>
  <div class="msg" id="manageMsg"></div>
</div>

<footer>接口协议逆向自「小爱课程导入」APK · 数据只经过你的电脑和小爱服务器</footer>
</div>

<script>
"use strict";
const $ = id => document.getElementById(id);
const PALETTE = [["#00A6F2","#E5F4FF"],["#FC6B50","#FDEBDE"],["#3CB3C8","#DEFBF8"],
["#7D7AEA","#EDEDFF"],["#FF9900","#FCEBCD"],["#EF5B75","#FFEFF0"],["#5B8EFF","#EAF1FF"],
["#F067BB","#FFEDF8"],["#29BBAA","#E2F8F3"],["#CBA713","#FFF8C8"],["#B967E3","#F9EDFF"],
["#6E8ADA","#F3F2FD"]];
const DAY_NAMES = ["","周一","周二","周三","周四","周五","周六","周日"];
let state = {courses:[], ctId:null, schedule:null};

// 每个浏览器一个独立会话 id（多人同时使用互不顶号）
let SID = localStorage.getItem("xiaoai_sid");
if(!SID){
  SID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem("xiaoai_sid", SID);
}

// 网络状态指示：请求到不了服务器时页面顶部给出醒目提示
function updateNet(ok){
  let el = document.getElementById("netBanner");
  if(!ok && !el){
    el = document.createElement("div");
    el.id = "netBanner";
    el.style.cssText = "background:#fff3f0;color:#d93026;padding:10px 14px;margin:0 0 12px;" +
      "border:1px solid #f5c6c0;border-radius:8px;font-size:14px;line-height:1.6";
    el.textContent = "⚠ 无法连接到导入器服务。可能原因：手机 Wi-Fi 不稳已自动切到流量" +
      "（私网地址会失效，可开飞行模式再单独开 Wi-Fi）、电脑上的程序被关、或信号差。";
    const first = document.body.firstChild;
    document.body.insertBefore(el, first);
  }else if(ok && el){
    el.remove();
  }
}

async function api(path, body){
  const opt = body ? {method:"POST",headers:{"Content-Type":"application/json","X-Sid":SID},
                      body:JSON.stringify(body)} : {headers:{"X-Sid":SID}};
  let r;
  try{
    r = await fetch(path, opt);
  }catch(e){
    updateNet(false);
    throw new Error("无法连接到导入器服务（请求未到达电脑）。请检查：手机是否还连着校园网" +
      "（Wi-Fi 不稳会自动切流量，私网地址会失效，建议开飞行模式再单独打开 Wi-Fi）、" +
      "电脑上的程序是否还在运行。");
  }
  updateNet(true);
  const j = await r.json();
  if(!j.ok) throw new Error(j.error || "请求失败");
  return j.data;
}
function msg(el, text, ok){
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
}
const DAY_NAMES_CN = ["周日","周一","周二","周三","周四","周五","周六"];

async function connect(){
  const m = $("credMsg"); m.className = "msg";
  $("btnConnect").disabled = true; $("btnConnect").textContent = "连接中…";
  try{
    let resp;
    try{
      resp = await fetch("/api/connect", {
        method: "POST",
        headers: {"Content-Type":"application/json", "X-Sid":SID},
        body: JSON.stringify({
          raw: $("credPaste").value.trim(),
          appId: $("appId").value.trim(),
          serviceToken: $("serviceToken").value.trim(),
          deviceId: $("deviceId").value.trim(),
          remember: $("remember").checked
        })
      });
    }catch(netErr){
      updateNet(false);
      throw new Error("无法连接到导入器服务（请求未到达电脑）。请检查：手机是否还连着校园网" +
        "（Wi-Fi 不稳会自动切流量，私网地址会失效，建议开飞行模式再单独打开 Wi-Fi）、" +
        "电脑上的程序是否还在运行。");
    }
    updateNet(true);
    const j = await resp.json();
    const ext = (j.data && j.data.extracted) || j.extracted;
    if(ext){
      if(ext.appId) $("appId").value = ext.appId;
      if(ext.serviceToken) $("serviceToken").value = ext.serviceToken;
      if(ext.deviceId) $("deviceId").value = ext.deviceId;
    }
    if(!j.ok){
      const suffix = ext && (ext.appId || ext.serviceToken || ext.deviceId)
                     ? " — 已把识别到的值填进上方输入框，请检查是否为空。" : "";
      msg(m, (j.error || "请求失败") + suffix, false);
    }else{
      $("dot").classList.add("on");
      msg(m, "连接成功，共 " + j.data.tables.length + " 个课表。", true);
      fillTables(j.data.tables);
      $("credPaste").value = "";
    }
  }catch(e){ msg(m, e.message, false); }
  $("btnConnect").disabled = false; $("btnConnect").textContent = "连接";
}

function fillTables(tables){
  const sel = $("tableSel"); sel.innerHTML = "";
  tables.forEach(t=>{
    const o = document.createElement("option");
    o.value = t.id; o.textContent = t.name + (t.current ? "（当前使用）":"");
    if(t.current) o.selected = true;
    sel.appendChild(o);
  });
  state.ctId = sel.value;
  ["cardTable","cardImport","cardManage"].forEach(id=>$(id).classList.remove("hidden"));
}

async function newTable(){
  const name = prompt("新课表名称：", "我的新课表");
  if(!name) return;
  try{
    const d = await api("/api/create_table", {name});
    msg($("tableMsg"), "已创建课表「" + name + "」（ID " + d.ctId + "），去小爱 App 里切换使用。", true);
    const tables = await api("/api/tables");
    fillTables(tables);
    $("tableSel").value = d.ctId; state.ctId = d.ctId;
  }catch(e){ msg($("tableMsg"), e.message, false); }
}

async function doParse(){
  const m = $("importMsg"); m.className = "msg";
  $("errlist").textContent = ""; $("grid").innerHTML = ""; $("stats").textContent = "";
  try{
    const d = await api("/api/parse", {text: $("jsonInput").value});
    state.courses = d.courses;
    state.schedule = d.schedule;
    let html = "已解析 <b>" + d.count + "</b> 门课程";
    if(d.errors.length) html += "，<span style='color:var(--err)'>" + d.errors.length + " 条被跳过</span>";
    $("stats").innerHTML = html;
    if(d.errors.length) $("errlist").textContent = "跳过详情：\n" + d.errors.join("\n");
    renderSchedule(d.schedule);
    renderGrid(d.courses);
    $("btnImport").disabled = false;
  }catch(e){ msg(m, e.message, false); $("btnImport").disabled = true; }
}

function renderGrid(courses){
  let maxSec = 0;
  const cells = {};
  courses.forEach(c=>{
    const secs = c.sections.split(",").map(s=>+s).filter(s=>!isNaN(s)).sort((a,b)=>a-b);
    c.secList = secs;
    // 把连续节次拆成一段一段，用于 rowspan 合并
    c.runs = [];
    if(secs.length){
      let start = secs[0], len = 1;
      for(let i=1;i<secs.length;i++){
        if(secs[i] === secs[i-1]+1){ len++; }
        else { c.runs.push({start,len}); start=secs[i]; len=1; }
      }
      c.runs.push({start,len});
    }
    secs.forEach(s=>{ maxSec=Math.max(maxSec,s); (cells[c.day+"_"+s]=cells[c.day+"_"+s]||[]).push(c); });
  });
  const occupied = new Set(); // 被上方 rowspan 占掉的 (day_section)
  let html = '<table class="grid"><tr><th style="width:52px">节\\天</th>';
  for(let d=1; d<=7; d++) html += "<th>" + DAY_NAMES[d] + "</th>";
  html += "</tr>";
  for(let s=1; s<=maxSec; s++){
    html += "<tr><th>" + s + "</th>";
    for(let d=1; d<=7; d++){
      if(occupied.has(d+"_"+s)) continue;
      const list = cells[d+"_"+s];
      if(list && list.length===1){
        const c = list[0];
        const run = c.runs.find(r=>r.start===s);
        if(run && run.len>1){
          for(let i=1;i<run.len;i++) occupied.add(d+"_"+(s+i));
          html += courseCell(c, run.len);
          continue;
        }
      }
      if(list && list.length){
        let inner = "";
        list.forEach(c=>{ inner += courseCellInner(c); });
        html += "<td>"+inner+"</td>";
      }else html += "<td></td>";
    }
    html += "</tr>";
  }
  html += "</table>";
  $("grid").innerHTML = html;
}
function courseCell(c, rowspan){
  return '<td rowspan="'+rowspan+'">'+courseCellInner(c)+'</td>';
}
function courseCellInner(c){
  const p = PALETTE[c.styleIdx % 12];
  const meta = [c.teacher, c.position].filter(x=>x).join(" · ");
  return '<div class="cc" style="background:'+p[1]+';color:'+p[0]+'">'+
    '<div class="n">'+esc(c.name)+'</div>'+
    (meta?'<div class="m">'+esc(meta)+'</div>':'')+
    '<div class="m">'+esc(c.weeksText)+'</div></div>';
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}

// ---- 课表设置（节数 / 节次时间表）----
const DEFAULT_TIMES = [
  ["08:00","08:45"],["08:55","09:40"],["10:00","10:45"],["10:55","11:40"],
  ["14:00","14:45"],["14:55","15:40"],["16:00","16:45"],["16:55","17:40"],
  ["19:00","19:45"],["19:55","20:40"],["20:50","21:35"],["21:45","22:30"]
];

function secRowHtml(i, s, e){
  const base = 'padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text)';
  return '<tr><td style="text-align:center"><input class="secI" type="number" min="1" max="30" value="'+esc(String(i))+'" style="width:52px;'+base+'"></td>'
    + '<td><input class="secS" type="time" value="'+esc(String(s))+'" style="'+base+'"></td>'
    + '<td><input class="secE" type="time" value="'+esc(String(e))+'" style="'+base+'"></td>'
    + '<td><button class="danger" style="padding:3px 10px" onclick="this.closest(\'tr\').remove()">删除</button></td></tr>';
}

function renderSchedule(sched){
  $("schedPanel").classList.remove("hidden");
  const s = sched || {};
  $("numMorning").value = s.morningNum != null ? s.morningNum : "";
  $("numAfternoon").value = s.afternoonNum != null ? s.afternoonNum : "";
  $("numNight").value = s.nightNum != null ? s.nightNum : "";
  $("numTotalWeek").value = s.totalWeek != null ? s.totalWeek : "";
  const wrap = $("schedTimes");
  let html = '<table class="rows" id="secTable"><thead><tr><th style="width:64px">节次</th><th>开始</th><th>结束</th><th style="width:72px"></th></tr></thead><tbody>';
  const secs = s.sections || [];
  secs.forEach((c,i) => { html += secRowHtml(c.i != null ? c.i : (i+1), c.s || "", c.e || ""); });
  html += '</tbody></table>';
  html += '<div class="btns" style="margin-top:8px"><button id="btnAddSec">＋ 添加节次</button><button id="btnDefTimes">填入常见12节时间表</button></div>';
  if(!secs.length){
    html += '<p class="hint" style="margin-top:6px">教务系统未提供节次时间表，可手动添加或点上方按钮填入常见时间表。</p>';
  }
  wrap.innerHTML = html;
  $("btnAddSec").onclick = addSecRow;
  $("btnDefTimes").onclick = fillDefaultTimes;
}

function addSecRow(){
  const tbody = $("secTable").querySelector("tbody");
  let nextI = 1;
  const rows = tbody.querySelectorAll("tr");
  if(rows.length){
    const last = rows[rows.length-1];
    nextI = (parseInt(last.querySelector(".secI").value)||0) + 1;
  }
  const tmp = document.createElement("table");
  tmp.innerHTML = "<tbody>" + secRowHtml(nextI, "", "") + "</tbody>";
  tbody.appendChild(tmp.querySelector("tr"));
}

function fillDefaultTimes(){
  const tbody = $("secTable").querySelector("tbody");
  tbody.innerHTML = "";
  DEFAULT_TIMES.forEach((p,idx) => {
    const tmp = document.createElement("table");
    tmp.innerHTML = "<tbody>" + secRowHtml(idx+1, p[0], p[1]) + "</tbody>";
    tbody.appendChild(tmp.querySelector("tr"));
  });
}

function collectSchedule(){
  const sched = {
    morningNum: $("numMorning").value || null,
    afternoonNum: $("numAfternoon").value || null,
    nightNum: $("numNight").value || null,
    totalWeek: $("numTotalWeek").value || null
  };
  const tbody = $("secTable") && $("secTable").querySelector("tbody");
  if(tbody){
    const secs = [];
    tbody.querySelectorAll("tr").forEach(r => {
      const ii = r.querySelector(".secI"), ss = r.querySelector(".secS"), ee = r.querySelector(".secE");
      if(!ii || !ss || !ee) return;
      const iv = ii.value.trim(), sv = ss.value.trim(), ev = ee.value.trim();
      if(!iv || !sv || !ev) return;
      secs.push({i: parseInt(iv), s: sv, e: ev});
    });
    if(secs.length) sched.sections = secs;
  }
  return sched;
}

async function doImport(){
  const m = $("importMsg");
  if(!state.ctId){ msg(m,"请先选择目标课表",false); return; }
  const sync = $("syncSettings").checked && !$("schedPanel").classList.contains("hidden");
  const schedule = sync ? collectSchedule() : null;
  const hasSched = schedule && Object.keys(schedule).some(k => schedule[k] != null);
  if(!confirm("将向所选课表导入 " + state.courses.length + " 门课程" +
      ($("clearFirst").checked ? "，并先清空该课表现有课程（不可恢复）" : "") +
      (sync && hasSched ? "，并同步课表设置（节数/时间表）" : "") + "，确定？")) return;
  $("btnImport").disabled = true; $("btnImport").textContent = "导入中…";
  try{
    const d = await api("/api/import", {
      ctId: state.ctId, courses: state.courses, clearFirst: $("clearFirst").checked,
      schedule: schedule, syncSettings: sync
    });
    let txt = "导入成功：新增 " + d.imported + " 门课程" +
        (d.deleted ? "，已先删除原有 " + d.deleted + " 门" : "");
    if(d.synced) txt += "，课表设置已同步";
    else if(d.syncError) txt += "（课表设置同步失败：" + d.syncError + "）";
    txt += "。打开小爱 App 课程表即可看到。";
    msg(m, txt, true);
  }catch(e){ msg(m, e.message, false); }
  $("btnImport").disabled = false; $("btnImport").textContent = "导入到小爱 →";
}

async function loadCourses(){
  const m = $("manageMsg"); m.className = "msg";
  try{
    const d = await api("/api/table?ctId=" + state.ctId);
    renderCourseList(d.courses);
    if(!d.courses.length) msg(m, "该课表当前没有课程。", true);
  }catch(e){ msg(m, e.message, false); }
}

function renderCourseList(cs){
  if(!cs.length){ $("courseList").innerHTML = ""; return; }
  let html = '<table class="rows"><tr><th>课程</th><th>时间</th><th>周次</th><th></th></tr>';
  cs.forEach(c=>{
    html += "<tr><td><b>"+esc(c.name)+"</b>"+
      (c.teacher?"<div style='font-size:12px;color:var(--sub)'>"+esc(c.teacher)+
      (c.position?" · "+esc(c.position):"")+"</div>":"")+
      "</td><td>"+DAY_NAMES[c.day||0]+" 第"+esc(c.sections)+"节</td><td><span class='badge'>"+
      esc(c.weeksText||c.weeks)+"</span></td>"+
      '<td><button class="danger" style="padding:3px 10px" onclick="delCourse('+c.id+')">删除</button></td></tr>';
  });
  html += "</table>";
  $("courseList").innerHTML = html;
}

async function delCourse(cid){
  if(!confirm("删除这一门课程？")) return;
  try{
    await api("/api/delete", {ctId: state.ctId, cIds:[cid]});
    loadCourses();
  }catch(e){ msg($("manageMsg"), e.message, false); }
}

async function clearTable(){
  if(!confirm("确定清空该课表的全部课程？此操作不可恢复！")) return;
  try{
    const d = await api("/api/clear", {ctId: state.ctId});
    msg($("manageMsg"), "已清空，删除 " + d.deleted + " 门课程。", true);
    $("courseList").innerHTML = "";
  }catch(e){ msg($("manageMsg"), e.message, false); }
}

function exportJson(){
  const rows = $("courseList").querySelectorAll("table.rows tr");
  if(rows.length < 2){ msg($("manageMsg"), "请先点击「查看该课表课程」。", false); return; }
  const data = [];
  rows.forEach((r,i)=>{
    if(i===0) return;
    const btn = r.querySelector("button");
    // 从 renderCourseList 重建数据不可靠，这里直接重新请求并导出
  });
  api("/api/table?ctId=" + state.ctId).then(d=>{
    const out = d.courses.map(c=>({
      name:c.name, teacher:c.teacher, position:c.position,
      day:c.day, sections:c.sections, weeks:c.weeks
    }));
    const blob = new Blob([JSON.stringify(out,null,2)], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "小爱课表导出.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }).catch(e=>msg($("manageMsg"), e.message, false));
}

const SAMPLE = [
 {"name":"高等数学(下)","teacher":"张三","position":"教1-101","day":1,"sections":"1,2","weeks":"1-16周"},
 {"name":"大学英语","teacher":"李四","position":"外语楼302","day":2,"sections":"3,4","weeks":"1-16周(单)"},
 {"name":"数据结构","teacher":"王五","position":"计算机楼B201","day":3,"sections":"6,7,8","weeks":"1-8周"},
 {"name":"线性代数","teacher":"刘六","position":"教2-305","day":4,"sections":"1,2","weeks":"1-16周(双)"},
 {"name":"体育(篮球)","teacher":"赵七","position":"东区操场","day":5,"sections":"2","weeks":"1-16周(双)"},
 {"name":"毛概","teacher":"孙八","position":"教3-201","day":3,"sections":"3,4","weeks":"9-16周"}
];

$("btnConnect").onclick = connect;
$("btnNewTable").onclick = newTable;
$("btnParse").onclick = doParse;
$("btnImport").onclick = doImport;
$("btnSample").onclick = ()=>{ $("jsonInput").value = JSON.stringify(SAMPLE,null,2); };
$("btnLoadCourses").onclick = loadCourses;
$("btnClear").onclick = clearTable;
$("btnExport").onclick = exportJson;
$("tableSel").onchange = e=>{ state.ctId = e.target.value; };

// ----- 强智教务书签 / 脚本分发 -----
const JIAOWU_SCHOOLS = {
  // 主默认：广州番禺职业技术学院（用户提问里的学校）
  "gzpyp": {
    name: "广州番禺职业技术学院",
    host: "jiaowu.gzpyp.edu.cn",
    pages: {
      login:   "https://jiaowu.gzpyp.edu.cn/jsxsd/framework/xsMain.jsp",
      semester:"https://jiaowu.gzpyp.edu.cn/jsxsd/xskb/xskb_list.jsp",
      personal:"https://jiaowu.gzpyp.edu.cn/jsxsd/framework/main_index.jsp",
    }
  },
};
// 用户可在 URL 后加 ?school=xxx 切换
const urlSchool = new URLSearchParams(location.search).get("school") || "gzpyp";
const school = JIAOWU_SCHOOLS[urlSchool] || JIAOWU_SCHOOLS["gzpyp"];
function jiaowuUrl(p){ return school.pages[p] || school.pages.login; }
function makeBookmarklet(srcBase){
  // 把这个页面 origin 当作注入脚本的来源。教务页面里的 src 就是这个 base
  // 注意：当用户用公网地址访问本页时，Bookmarklet 会从公网拉脚本，其他同学也能用
  // 当用户用 127.0.0.1 访问，Bookmarklet 只能在本机拉（其他同学在自己电脑也开就能用）
  var base = (srcBase || location.origin + location.pathname.replace(/[^/]*$/, ""));
  return "javascript:void((function(){"
       + "var s=document.createElement('script');"
       + "s.src='" + base + "api/jiaowu_extractor.js?t='+Date.now();"
       + "s.setAttribute('data-qzpyp-base','" + location.origin + "');"
       + "document.head.appendChild(s);"
       + "})());";
}

$("linkLogin").href   = jiaowuUrl("login");
$("linkKb").href      = jiaowuUrl("semester");
$("linkPersonal").href= jiaowuUrl("personal");
$("linkJsSource").href= "/api/jiaowu_extractor.js";

function jiaowuCopy(text, msg){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){
      $("jiaowuMsg").className = "msg ok"; $("jiaowuMsg").textContent = msg;
    }, function(){ jiaowuFallbackCopy(text, msg); });
  }else jiaowuFallbackCopy(text, msg);
}
function jiaowuFallbackCopy(text, msg){
  var ta = document.createElement("textarea");
  ta.value = text; ta.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand("copy"); }catch(e){}
  document.body.removeChild(ta);
  $("jiaowuMsg").className = "msg ok"; $("jiaowuMsg").textContent = msg;
}

$("btnCopyBookmarklet").onclick = ()=>{
  jiaowuCopy(makeBookmarklet(), "✅ 提取书签已复制，把它拖到书签栏（在书签右键 → 添加网页处粘贴网址栏也行）");
};
$("btnCopyUserscript").onclick = ()=>{
  // 把油猴脚本原文复制出去（用户自己粘到油猴编辑器）
  // 此处内容直接从相同来源拉一次，避免内嵌重复
  fetch("/api/jiaowu_userscript.js").then(r=>r.text()).then(function(t){
    jiaowuCopy(t, "✅ 油猴脚本已复制，去 Tampermonkey 管理面板新建脚本粘贴即可");
  }).catch(function(e){
    $("jiaowuMsg").className = "msg err"; $("jiaowuMsg").textContent = "❌ 获取脚本失败：" + e;
  });
};

// ============================================================================
// 教务系统直登抓取：纯函数（移植自 jiaowu_extractor.js）+ 页面交互
// ============================================================================
function cleanText(text){
  return (text || '')
    .replace(/&nbsp;/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// 周次文本归一："1-16(周)" / "1-16(周)单" / "1,3,5(周)" → "1-16周(单)" / "1,3,5周"
function normalizeWeeks(weekText){
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
function buildSections(start, end){
  var result = [];
  for (var i = start; i <= end; i++) result.push(i);
  return result.join(',');
}
// 默认节次时间表（13 节，直接取自 jiaowu_extractor.js）
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
function buildSchedule(list, maxPageSec){
  var maxWeek = 0;
  var maxSec = maxPageSec || 0;
  list.forEach(function (c){
    var wm = String(c.weeks || '').match(/\d+/g);
    if (wm) wm.forEach(function (x){ var n = parseInt(x, 10); if (n > maxWeek) maxWeek = n; });
    var sm = String(c.sections || '').match(/\d+/g);
    if (sm) sm.forEach(function (x){ var n = parseInt(x, 10); if (n > maxSec) maxSec = n; });
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

// 解析课表页 HTML（移植 parseKbtable；不穿透 iframe：传入 html 已是课表页内容）
function parseJiaowuHtml(html){
  var courses = [];
  var maxPageSection = 0;
  var holder = document.createElement('div');
  holder.innerHTML = html;
  var table = holder.querySelector('#kbtable');
  if (!table) return { courses: [], schedule: {} };
  var rows = table.querySelectorAll('tr');
  for (var r = 0; r < rows.length; r++){
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
    for (var j = 0; j < tds.length && j < 7; j++){
      var day = j + 1;
      var td = tds[j];
      var divs = td.querySelectorAll('div');
      var contentDiv = null;
      for (var k = 0; k < divs.length; k++){
        var cn = (typeof divs[k].className === 'string') ? divs[k].className : '';
        // 排除 kbcontent1（隐藏占位）/ sykb2（周安排），只取真正含课的 kbcontent
        if (cn.indexOf('kbcontent') >= 0 && cn.indexOf('kbcontent1') < 0 && cn.indexOf('sykb2') < 0){
          if (cleanText(divs[k].textContent)){ contentDiv = divs[k]; break; }
        }
      }
      if (!contentDiv) continue;
      // 多门课用 15+ 连字符分隔
      var blocks = contentDiv.innerHTML.split(/-{15,}/);
      for (var b = 0; b < blocks.length; b++){
        var block = blocks[b];
        if (!block.trim()) continue;
        var temp = document.createElement('div');
        temp.innerHTML = block;
        // 课程名：第一个非空文本节点（去掉末尾 P/O 标记）
        var name = '';
        var walker = document.createTreeWalker(temp, NodeFilter.SHOW_TEXT, null, false);
        var node;
        while ((node = walker.nextNode())){
          var text = cleanText(node.textContent);
          if (text){ name = text; break; }
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
  return { courses: courses, schedule: buildSchedule(courses, maxPageSection) };
}

function setJwMsg(text, cls){
  var el = $("jwMsg");
  el.className = "msg " + (cls || "");
  el.textContent = text;
}
function refreshJwCaptcha(){
  $("jwCaptchaImg").src = "/api/jiaowu_captcha?t=" + Date.now();
}
$("btnJwCaptcha").onclick = refreshJwCaptcha;
$("jwCaptchaImg").onclick = refreshJwCaptcha;
// 页面加载时自动拉一次验证码
refreshJwCaptcha();

$("btnJwLogin").onclick = async () => {
  var account = $("jwAccount").value.trim();
  var password = $("jwPassword").value;
  var captcha = $("jwCaptcha").value.trim();
  if (!account || !password || !captcha){
    setJwMsg("请填写学号、密码、验证码", "err");
    return;
  }
  $("btnJwLogin").disabled = true;
  setJwMsg("登录中…", "");
  try{
    var resp = await fetch("/api/jiaowu_login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: account, password: password, captcha: captcha })
    });
    var data = await resp.json();
    if (!data.ok){
      setJwMsg(data.error || "登录失败", "err");
      refreshJwCaptcha();
      return;
    }
    var info = data.data || {};
    var sel = $("jwTerm");
    sel.innerHTML = "";
    (info.terms || []).forEach(function (t){
      var o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.name || t.id;
      sel.appendChild(o);
    });
    if (info.current) sel.value = info.current;
    setJwMsg("✅ 登录成功，开始抓取课表…", "ok");
    await doJwFetch();
  }catch(e){
    setJwMsg("登录失败：" + e, "err");
    refreshJwCaptcha();
  }finally{
    $("btnJwLogin").disabled = false;
  }
};

async function doJwFetch(){
  var termId = $("jwTerm").value;
  setJwMsg("抓取课表中…", "");
  try{
    var resp = await fetch("/api/jiaowu_fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ termId: termId })
    });
    var data = await resp.json();
    if (!data.ok){
      setJwMsg(data.error || "抓取失败", "err");
      return;
    }
    var result = parseJiaowuHtml(data.data.html);
    if (!result.courses.length){
      setJwMsg("⚠️ 没解析到课程，可能该学期课表为空或页面结构变化", "err");
      return;
    }
    $("jsonInput").value = JSON.stringify(result, null, 2);
    setJwMsg("✅ 抓取到 " + result.courses.length + " 条课程，已填入下方 JSON 框，正在解析预览…", "ok");
    $("btnParse").click();
  }catch(e){
    setJwMsg("抓取失败：" + e, "err");
  }
}

// 剪贴板自动填入：每 800ms 检测一次，强智脚本复制后能立刻填到 textarea
let __lastClipboardText = "";
setInterval(async () => {
  if(document.hidden) return;
  try{
    const text = await navigator.clipboard.readText();
    if(!text || text === __lastClipboardText) return;
    __lastClipboardText = text;
    // 仅当含课程关键字段
    if(!/"(name|courseName)"\s*:/i.test(text)) return;
    let parsed; try{ parsed = JSON.parse(text); }catch(e){ return; }
    const arr = Array.isArray(parsed) ? parsed : (parsed.courses || []);
    if(!arr.length) return;
    // 把 courses 数组形式直接填进去（不强求 schedule）
    const target = Array.isArray(parsed) ? parsed : arr;
    $("jsonInput").value = JSON.stringify(target, null, 2);
    $("jiaowuMsg").className = "msg ok";
    $("jiaowuMsg").textContent = "✅ 剪贴板识别到 " + arr.length + " 条课表，已自动填入下方 JSON 框 → 点「解析预览」";
    $("jsonInput").scrollIntoView({behavior: "smooth", block: "center"});
    doParse();   // 自动解析预览
  }catch(e){ /* 用户未授权剪贴板读取，忽略 */ }
}, 1500);

(async function init(){
  try{
    const s = await api("/api/state");
    if(s.creds && s.creds.serviceToken){
      $("appId").value = s.creds.appId || "";
      $("serviceToken").value = s.creds.serviceToken || "";
      $("deviceId").value = s.creds.deviceId || "";
    }
    if(s.publicUrl){
      const banner = document.createElement("div");
      banner.style.cssText = "background:#1677ff;color:#fff;padding:10px 16px;border-radius:8px;margin-bottom:14px;display:flex;align-items:center;gap:10px;font-size:14px";
      banner.innerHTML = '<strong>🌐 公网地址</strong><input id="__pub" style="flex:1;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.4);color:#fff;padding:5px 8px;border-radius:4px;font:13px monospace" value="'+s.publicUrl+'"><button id="__pubCp" style="padding:5px 10px;background:#fff;color:#1677ff;border:none;border-radius:4px;cursor:pointer;font-weight:600">复制链接</button><span style="opacity:.85;font-size:12px">关电脑即失效</span>';
      const root = document.body.firstChild; document.body.insertBefore(banner, root);
      $("__pubCp").onclick = ()=>{ $("__pub").select(); document.execCommand("copy"); $("__pubCp").textContent="已复制"; setTimeout(()=>$("__pubCp").textContent="复制链接", 1500); };
    }
  }catch(e){}
  // 心跳：Wi-Fi 切到流量/断网时自动在页面顶部提示，恢复后自动消失
  setInterval(async ()=>{
    try{ await fetch("/api/ping", {headers:{"X-Sid":SID}, cache:"no-store"}); updateNet(true); }
    catch(e){ updateNet(false); }
  }, 5000);
})();
</script>
</body>
</html>
"""

# ============================================================================
# 启动
# ============================================================================

def pick_port():
    for port in range(8899, 8799, -1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("8899-8800 端口均被占用")


def lan_ips():
    """列出本机局域网 IPv4 地址"""
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip and not ip.startswith("127."):
                ips.add(ip)
    except Exception:
        pass
    return sorted(ips)


def _find_cloudflared():
    """按顺序查找 cloudflared 可执行文件"""
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools", "cloudflared.exe"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools", "cloudflared"),
        r"C:\Program Files\cloudflared\cloudflared.exe",
        r"C:\ProgramData\chocolatey\bin\cloudflared.exe",
    ]
    which = shutil.which("cloudflared")
    if which:
        candidates.append(which)
    for p in candidates:
        if p and os.path.isfile(p):
            return p
    return None


def start_cloudflared(local_port):
    """
    启动 cloudflared quick tunnel，自动解析公网 URL。
    返回 (process, public_url)，失败时返回 (None, None)。
    """
    import re, subprocess
    cf = _find_cloudflared()
    if not cf:
        print("  ⚠️  找不到 cloudflared.exe（请放到 tools/ 子目录或加入 PATH）")
        return None, None
    print("  启动 cloudflared：%s" % cf)
    proc = subprocess.Popen(
        [cf, "tunnel", "--url", "http://127.0.0.1:%d" % local_port, "--no-autoupdate"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    url, deadline = None, time.time() + 30
    url_re = re.compile(r"https://[a-z0-9\-]+\.trycloudflare\.com", re.I)
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                break
            continue
        text = line.decode("utf-8", "ignore")
        print("  [tunnel] " + text.rstrip())
        m = url_re.search(text)
        if m:
            url = m.group(0).lower()
            break
    if not url:
        print("  ⚠️  30 秒内未拿到公网 URL，访问可能仍可用但未自动展示")
    # 将公网 URL 暴露给前端（/api/public_url 用）
    STATE["public_url"] = url
    return proc, url


def main():
    global SHARE_MODE
    SHARE_MODE = ("--share" in sys.argv) or ("--public" in sys.argv)
    PUBLIC_MODE = "--public" in sys.argv
    port = pick_port()
    bind = "0.0.0.0" if SHARE_MODE else "127.0.0.1"
    STATE["port"] = port
    server = ThreadingHTTPServer((bind, port), Handler)
    url = "http://127.0.0.1:%d" % port
    print("=" * 46)
    print("  小爱课表导入器 · 简洁版")
    print("  本机访问：%s" % url)
    if PUBLIC_MODE:
        SHARE_MODE = True   # --public 隐含 --share
    if SHARE_MODE:
        for ip in lan_ips():
            print("  局域网访问：http://%s:%d  （手机和其他电脑）" % (ip, port))
        print("  注意：共享模式不回传/保存凭据，每人各自粘贴自己的")
        print("  首次启动 Windows 防火墙弹窗请点「允许访问」")
    else:
        print("  仅本机可访问；加 --share 参数可让局域网使用")
    tunnel_proc, public_url = (None, None)
    if PUBLIC_MODE:
        tunnel_proc, public_url = start_cloudflared(port)
        if public_url:
            print("")
            print("  🌐 公网地址（任何人、不限网络都能用）：")
            print("     %s" % public_url)
            print("  ⚠️  链接每次启动会变，长期用请注册 Cloudflare 账户做 named tunnel")
            print("")
    print("  Ctrl+C 停止")
    print("=" * 46)
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        if tunnel_proc and tunnel_proc.poll() is None:
            try: tunnel_proc.terminate()
            except Exception: pass


if __name__ == "__main__":
    main()
