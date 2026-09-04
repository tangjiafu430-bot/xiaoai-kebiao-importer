# 小爱课表导入器

将教务系统（强智教务系统）的课表一键批量写入小爱课表 App 的工具链。
包含油猴脚本（课表提取）+ 本地后端（导入服务）+ 控制台 exe（一键启停）+ Cloudflare Tunnel 公网穿透，让非校园网的同学也能扫码登录教务系统提取课表。

## 功能

- 油猴脚本：在强智教务系统课表页面注入"提取为 JSON"按钮，自动推断节数、总周数、生成默认节次时间表
- 本地后端：解析课表 JSON → 调用小爱课表 API → 批量创建/导入课表到指定账号
- 公网穿透：通过 Cloudflare quick tunnel 将本地 8899 端口暴露为临时公网域名，发给同学即可使用
- 一键控制台：双击 `Kebiao.exe` 启动 / 停止 / 查看状态，无需命令行

## 项目结构

```
课表脚本/
├── kebiao_console.py           # 一体化控制台源码（打包为 Kebiao.exe）
├── 小爱课表导入器.py              # 后端服务源码（HTTP API + 课表导入逻辑）
├── xiaoai_course_api.py        # 小爱课表 API 客户端库
├── 强智课表提取器.user.js         # 油猴脚本（教务系统课表提取）
├── Kebiao.spec                 # PyInstaller 打包配置
├── 小爱课程导入_逆向分析报告.md      # 小爱课表 API 逆向分析文档
├── tools/
│   └── jiaowu_extractor.js     # 教务系统提取脚本源
├── credentials.json            # 用户凭据（运行时生成，不上传）
└── dist/Kebiao/                # 打包输出（用户自行打包）
    ├── Kebiao.exe
    ├── cloudflared.exe         # 公网穿透工具（需另下载）
    └── _internal/              # PyInstaller 运行时依赖
```

## 使用方法

### 方式 1：直接使用打包好的 exe（推荐）

1. 在 `dist/Kebiao/` 目录下放好 `cloudflared.exe`（从 [Cloudflare 官方](https://github.com/cloudflare/cloudflared/releases/latest) 下载 windows-amd64 版）
2. 双击 `Kebiao.exe`
3. 按 `S` 启动 → 等待 3 步完成
4. 屏幕会显示：
   - 公网地址（如 `https://xxx.trycloudflare.com`）→ 发给同学
   - 本机地址 `http://127.0.0.1:8899/` → 自己用
5. 同学打开链接 → 登录教务系统 → 课表自动写入小爱课表

**停止：** 关闭控制台窗口，或新开窗口运行 `Kebiao.exe stop`

### 方式 2：源码运行

```bash
pip install -r requirements.txt  # 暂无第三方依赖（仅标准库）
py -m PyInstaller Kebiao.spec --noconfirm  # 重新打包
```

直接运行后端：
```bash
py 小爱课表导入器.py --share   # 启动后端，绑定 0.0.0.0:8899
```

## 使用须知

- **电脑必须开机**：公网穿透依赖本地 PC 持续运行服务
- **临时域名**：每次启动 cloudflared 会生成新的随机域名，需重新发地址给同学
- **公网慎用**：请勿勾选"记住凭据"，防止 credentials.json 泄露
- **校园网/非校园网**：非校园网用户访问教务系统会被 webexp 网关拦截，要求企业微信扫码认证——本工具通过本地 PC 中转解决该问题
- **凭据保护**：`credentials.json` 已在 `.gitignore` 中，不会被提交

## 控制台命令

| 命令 | 说明 |
|------|------|
| `Kebiao.exe` | 进入交互菜单 |
| `Kebiao.exe start` | 启动后端 + 公网穿透 |
| `Kebiao.exe stop` | 停止所有服务 |
| `Kebiao.exe status` | 查看运行状态和公网地址 |
| `Kebiao.exe open` | 用浏览器打开公网地址 |

## 课表 JSON 格式

油猴脚本生成的 JSON 包含 `courses` 数组 + `schedule` 对象：

```json
{
  "courses": [
    { "name": "高等数学", "teacher": "张三", "weeks": [1,2,3], "day": 1, "sections": [1,2], "location": "教学楼A101" }
  ],
  "schedule": {
    "totalWeek": 20,
    "morningNum": 4,
    "afternoonNum": 4,
    "nightNum": 3,
    "sections": [
      {"i": 1, "s": "08:00", "e": "08:45"},
      {"i": 2, "s": "08:55", "e": "09:40"}
    ]
  }
}
```

## 技术栈

- Python 3.14（标准库：http.server, urllib, json, threading, subprocess, importlib）
- PyInstaller 6.20（打包为单 exe）
- Cloudflare Tunnel（quick tunnel 免费公网穿透，无需账号）
- JavaScript（油猴脚本，教务系统课表提取）

## License

MIT
