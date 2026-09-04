"""
小爱课表导入器 - 控制台 (一体化)
用法: Kebiao.exe start|stop|status|open
"""
import os, sys, re, time, socket, shutil, threading, subprocess, webbrowser, importlib.util
# Pre-import backend deps so PyInstaller collects them
import uuid, base64, gzip, json, http, http.server, urllib, urllib.request, urllib.parse, hashlib

# ---------- 路径 ----------
def _resource_dir():
    if getattr(sys, "frozen", False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))

def _user_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

CLOUDFLARED_SRC = os.path.join(_resource_dir(), "cloudflared.exe")
BACKEND_SRC = os.path.join(_resource_dir(), "小爱课表导入器.py")
CLOUDFLARED_RUN = os.path.join(_user_dir(), "cloudflared.exe")

_backend_server = None
_cf_proc = None
_public_url = ""
_running = False

def _ensure_assets():
    if not os.path.exists(CLOUDFLARED_RUN) and os.path.exists(CLOUDFLARED_SRC):
        shutil.copy2(CLOUDFLARED_SRC, CLOUDFLARED_RUN)

def _check_port(port):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return False
    except OSError:
        return True
    finally:
        s.close()

def _wait_backend(timeout=15):
    import urllib.request
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            r = urllib.request.urlopen("http://127.0.0.1:8899/api/ping", timeout=2)
            if r.status == 200:
                return True
        except Exception:
            pass
        time.sleep(1)
    return False

def _wait_cf_url(timeout=30):
    log_path = os.path.join(_user_dir(), "cloudflared.log")
    t0 = time.time()
    while time.time() - t0 < timeout:
        if os.path.exists(log_path):
            try:
                with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
                    for line in f:
                        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
                        if m:
                            return m.group(0).strip()
            except Exception:
                pass
        time.sleep(1)
    return ""

def _import_backend():
    spec = importlib.util.spec_from_file_location("xiaoai_backend", BACKEND_SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def _start_backend_thread():
    global _backend_server
    mod = _import_backend()
    sys.argv = [BACKEND_SRC, "--share"]
    mod.SHARE_MODE = True
    mod.PUBLIC_MODE = False
    port = mod.pick_port()
    mod.STATE["port"] = port
    mod.STATE["share_mode"] = True
    _backend_server = mod.ThreadingHTTPServer(("0.0.0.0", port), mod.Handler)
    def _serve():
        try: _backend_server.serve_forever()
        except Exception: pass
    threading.Thread(target=_serve, daemon=True).start()
    return port

def _kill_all():
    global _backend_server, _cf_proc, _running, _public_url
    if _backend_server:
        try: _backend_server.shutdown()
        except: pass
        _backend_server = None
    if _cf_proc and _cf_proc.poll() is None:
        try: _cf_proc.terminate()
        except: pass
        time.sleep(0.5)
        if _cf_proc.poll() is None:
            try: _cf_proc.kill()
            except: pass
    _cf_proc = None
    _running = False
    _public_url = ""

def cmd_start():
    global _cf_proc, _running, _public_url, _backend_server
    if _running or _check_port(8899):
        print("  [!] 8899 端口已被占用")
        return 1
    _ensure_assets()
    _kill_all()
    for f in ("cloudflared.log", "public_url.txt"):
        p = os.path.join(_user_dir(), f)
        if os.path.exists(p):
            try: os.remove(p)
            except: pass
    
    print("  [1/3] 启动后端...", end=" ", flush=True)
    try:
        _start_backend_thread()
    except Exception as e:
        import traceback; traceback.print_exc()
        print(f"FAIL ({e})")
        return 1
    if not _wait_backend(15):
        print("FAIL")
        _kill_all()
        return 1
    print("OK")
    
    print("  [2/3] 启动公网穿透...", end=" ", flush=True)
    log_path = os.path.join(_user_dir(), "cloudflared.log")
    with open(log_path, "w") as log_f:
        _cf_proc = subprocess.Popen(
            [CLOUDFLARED_RUN, "tunnel", "--url", "http://localhost:8899"],
            stdout=log_f, stderr=subprocess.STDOUT,
            creationflags=0x08000000 if os.name == "nt" else 0
        )
    _public_url = _wait_cf_url(30)
    if _public_url:
        _running = True
        with open(os.path.join(_user_dir(), "public_url.txt"), "w") as f:
            f.write(_public_url)
        print("OK")
    else:
        print("WARN (没拿到URL，看cloudflared.log)")
        _running = True
    
    print()
    print("  ╔══════════════════════════════════════════╗")
    print(f"  ║  公网: {_public_url or '(未获取到)'}")
    print("  ║  本机: http://127.0.0.1:8899/")
    print("  ╚══════════════════════════════════════════╝")
    print()
    print("  复制公网地址发给同学即可")
    print("  关闭此窗口即停止所有服务")
    print()
    threading.Event().wait()

def cmd_stop():
    _kill_all()
    for f in ("cloudflared.log", "public_url.txt"):
        p = os.path.join(_user_dir(), f)
        if os.path.exists(p):
            try: os.remove(p)
            except: pass
    if os.name == "nt":
        subprocess.run(["taskkill", "/f", "/im", "cloudflared.exe"], capture_output=True)
        subprocess.run(["taskkill", "/f", "/im", "Kebiao.exe"], capture_output=True)
    print("  已停止")
    return 0

def cmd_status():
    port_ok = _check_port(8899)
    cf_ok = _cf_proc and _cf_proc.poll() is None
    url = _public_url
    if not url:
        f = os.path.join(_user_dir(), "public_url.txt")
        if os.path.exists(f):
            url = open(f).read().strip()
    print()
    print(f"  后端 (8899) : {'运行中' if port_ok else '未运行'}")
    print(f"  cloudflared : {'运行中' if cf_ok else '未运行'}")
    print(f"  公网地址    : {url or '(未启动)'}")
    print()
    return 0

def cmd_open():
    if not _check_port(8899):
        print("  [!] 后端没启动，先运行: Kebiao.exe start")
        return 1
    url = _public_url
    if not url:
        f = os.path.join(_user_dir(), "public_url.txt")
        if os.path.exists(f):
            url = open(f).read().strip()
    webbrowser.open(url or "http://127.0.0.1:8899/")
    print("  已打开浏览器")
    return 0

def main():
    args = sys.argv[1:]
    if args:
        cmd = args[0].lower()
        if cmd in ("s", "start"): sys.exit(cmd_start())
        elif cmd in ("x", "stop"): sys.exit(cmd_stop())
        elif cmd in ("u", "status"): sys.exit(cmd_status())
        elif cmd in ("o", "open"): sys.exit(cmd_open())
        elif cmd in ("q", "quit"): _kill_all(); sys.exit(0)
        else: print(f"  用法: Kebiao.exe [start|stop|status|open]"); sys.exit(1)
    else:
        # 无参数 = 交互式菜单
        while True:
            print()
            print("  ┌─────────────────────────────────────┐")
            print("  │  小爱课表导入器  ·  控制台            │")
            print("  ├─────────────────────────────────────┤")
            print("  │  [S] 启动  [X] 停止  [U] 状态  [O] 浏览器  [Q] 退出")
            print("  └─────────────────────────────────────┘")
            print()
            try:
                choice = input("  > ").strip().upper()
            except (EOFError, KeyboardInterrupt):
                break
            if choice == "S": cmd_start(); break
            elif choice == "X": cmd_stop()
            elif choice == "U": cmd_status()
            elif choice == "O": cmd_open()
            elif choice == "Q": break
    _kill_all()

if __name__ == "__main__":
    main()
