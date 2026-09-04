# -*- coding: utf-8 -*-
"""
小爱课表 API 客户端 —— 由「小爱课程导入」APK (com.mercury.courseimport) 逆向还原。

用法：
    api = XiaoaiCourseApi(app_id="...", service_token="...", device_id="...")
    tables = api.list_tables()
    ct_id = api.create_table("2026春课表")
    api.batch_create_courses(ct_id, courses)
    api.update_table_settings(ct_id, "2026春课表", setting)
    api.switch_table(from_ct_id, to_ct_id)

凭据获取：在小爱 App 课表 H5 页面抓取 Debug JSON，包含 appId / serviceToken(或authorization) / deviceId。
"""

import base64
import json
import uuid

import requests


class XiaoaiCourseApi:
    BASE = "https://i.ai.mi.com/course-multi-auth"
    SWITCH_URL = "https://i.xiaomixiaoai.com/course-multi-auth/table_switch"
    REFERER = "https://i.ai.mi.com/h5/precache/ai-schedule/"

    # APK 内置的 12 种课程颜色（同课名循环取色）
    STYLES = [
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
    ]

    def __init__(self, app_id: str, service_token: str, device_id: str,
                 timeout: int = 30):
        self.app_id = app_id
        self.service_token = service_token
        self.device_id = device_id
        self.timeout = timeout
        self.session = requests.Session()

    # ---------- 鉴权 ----------

    def _authorization(self) -> str:
        """AO-TOKEN-V1 dev_app_id:{appId},access_token:{token},scope_data:{b64}"""
        if self.service_token.startswith(("DO-TOKEN", "AO-TOKEN")):
            return self.service_token
        scope = base64.b64encode(
            json.dumps({"d": self.device_id}, separators=(",", ":"))
            .encode("utf-8")
        ).decode("ascii")
        return (
            f"AO-TOKEN-V1 dev_app_id:{self.app_id},"
            f"access_token:{self.service_token},"
            f"scope_data:{scope}"
        )

    def _headers(self, *, with_request_id=False, switch=False) -> dict:
        h = {
            "Authorization": self._authorization(),
            "Content-Type": "application/json",
            "Accept": "*/*",
            "User-Agent": ("Mozilla/5.0 (Linux; Android 16; wv) "
                           "AppleWebKit/537.36 Mobile Safari/537.36 AgentWeb/4.1.3"),
            "X-Requested-With": "com.miui.voiceassist" if switch else "com.xiaomi.aischedule",
            "Origin": "https://i.xiaomixiaoai.com" if switch else "https://i.ai.mi.com",
            "Referer": ("https://i.xiaomixiaoai.com/h5/precache/ai-schedule/"
                        if switch else self.REFERER),
        }
        if with_request_id:
            h["RequestId"] = self._request_id()
        return h

    @staticmethod
    def _request_id() -> str:
        return uuid.uuid4().hex.upper()  # 32位大写无横线

    def _check(self, resp: requests.Response, action: str) -> dict:
        if resp.status_code in (401, 500):
            raise RuntimeError(f"{action}: HTTP {resp.status_code} 认证失效，请重新获取用户信息")
        if not resp.ok:
            raise RuntimeError(f"{action}: HTTP {resp.status_code} {resp.text[:200]}")
        data = resp.json()
        code = data.get("code", -1)
        if code not in (0, 200):
            raise RuntimeError(f"{action}: code={code} "
                               f"{data.get('desc') or data.get('msg')}")
        return data

    # ---------- 接口 ----------

    def list_tables(self) -> list:
        """课表列表：[{id, name, current, setting}]"""
        r = self.session.get(
            f"{self.BASE}/tables",
            params={"requestId": self._request_id(),
                    "sourceName": "course-app-aiSchedule"},
            headers=self._headers(),
            timeout=self.timeout,
        )
        data = self._check(r, "获取课表列表")
        return [
            {
                "id": t.get("id"),
                "name": t.get("name", "未命名"),
                "current": t.get("current", 0),
                "setting": t.get("setting"),
            }
            for t in data.get("data", [])
        ]

    def get_table(self, ct_id: int) -> dict:
        """课表详情（含 courses / setting）"""
        r = self.session.get(
            f"{self.BASE}/table",
            params={"ctId": ct_id,
                    "requestId": self._request_id(),
                    "sourceName": "course-app-aiSchedule"},
            headers=self._headers(),
            timeout=self.timeout,
        )
        return self._check(r, "查询课表详情").get("data", {})

    def create_table(self, name: str) -> int:
        """新建课表，返回新 ctId"""
        r = self.session.post(
            f"{self.BASE}/table",
            json={"name": name, "current": 0,
                  "sourceName": "course-app-aiSchedule"},
            headers=self._headers(),
            timeout=self.timeout,
        )
        return int(self._check(r, "新建课表")["data"])

    def update_table_settings(self, ct_id: int, name: str, setting: dict) -> None:
        """同步课表设置（PUT）。setting 字段见报告第四节。"""
        r = self.session.put(
            f"{self.BASE}/table",
            json={"ctId": ct_id, "name": name,
                  "setting": setting, "sourceName": "course-app-aiSchedule"},
            headers=self._headers(),
            timeout=self.timeout,
        )
        if not r.ok:
            raise RuntimeError(f"同步课表设置失败(HTTP {r.status_code})")

    def batch_create_courses(self, ct_id: int, courses: list) -> None:
        """批量写入课程。

        courses: [{"name","teacher","position","day"(1-7),
                   "sections":"1,2","weeks":"1,2,..."}]
        同名课程自动按 APK 内置色板着色。
        """
        color_map = {}
        palette_idx = 0
        payload = []
        for c in courses:
            nm = c.get("name") or ""
            if nm and nm not in color_map:
                color_map[nm] = self.STYLES[palette_idx % 12]
                palette_idx += 1
            payload.append({
                "name": c.get("name") or "",
                "position": c.get("position") or "",
                "teacher": c.get("teacher") or "",
                "day": int(c["day"]),
                "sections": c.get("sections") or "",
                "style": color_map.get(nm, self.STYLES[0]),
                "weeks": c.get("weeks") or "",
            })
        r = self.session.post(
            f"{self.BASE}/courseInfos",
            json={"ctId": ct_id, "courses": payload,
                  "sourceName": "course-app-aiSchedule"},
            headers=self._headers(with_request_id=True),
            timeout=self.timeout,
        )
        data = self._check(r, "批量创建课程")
        if data.get("status", 0) == -1:
            raise RuntimeError("批量创建失败: status=-1 (可能课程参数不合法)")

    def delete_course(self, ct_id: int, c_id: int) -> None:
        """删除单条课程"""
        r = self.session.delete(
            f"{self.BASE}/courseInfo",
            json={"ctId": ct_id, "cId": c_id,
                  "sourceName": "course-app-aiSchedule"},
            headers=self._headers(),
            timeout=self.timeout,
        )
        self._check(r, "删除课程")

    def switch_table(self, from_ct_id: int, to_ct_id: int) -> None:
        """切换当前课表（小爱同学域名，注意 from/to 不能相同）"""
        r = self.session.post(
            self.SWITCH_URL,
            json={"fromCtId": from_ct_id, "toCtId": to_ct_id,
                  "sourceName": "course-app-miui"},
            headers=self._headers(switch=True),
            timeout=self.timeout,
        )
        self._check(r, "切换课表")


# ---------- 单双周 / 节次区间展开（Course 类逻辑复刻） ----------

import re

_RANGE_RE = re.compile(
    r"(\d+)\s*(?:-|至|~)\s*(\d+)(?:[\s周\(（\)）]*(单|双)[\s周\(（\)）]*)?|(\d+)"
)


def expand_weeks(text: str) -> str:
    """把 '1-16周(单)'、'1至16'、'1~16(双)'、'3' 等展开成逗号分隔的周次串。"""
    weeks = []
    for m in _RANGE_RE.finditer(text):
        if m.group(4):                       # 单个数字
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


if __name__ == "__main__":
    # 演示：展开周次写法
    print(expand_weeks("1-16周(单)"))   # 1,3,5,...,15
    print(expand_weeks("1至16"))        # 1,2,...,16
    print(expand_weeks("1~20(双)"))     # 2,4,...,20
