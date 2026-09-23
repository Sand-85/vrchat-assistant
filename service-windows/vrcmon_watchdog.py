"""vrc-monitor watchdog — 崩溃自动修复（建议由计划任务每分钟运行一次）。

行为：
  - 服务健康（http://127.0.0.1:8799/health 返回 200）→ 清零连续失败计数，静默退出。
  - 服务不健康但**端口尚未监听或刚拉起过（< GRACE_SECONDS=300s）**→ 认为仍在启动中，
    静默退出不做任何动作（大库 storage.init 实测可达 70s+，此前 4s 超时会误判为宕机，
    导致「杀掉正在启动的进程 → 重新拉起 → 又超时 → 再杀」的每分钟重启风暴，
    每次重启还会触发一次全量 DB 备份）。
  - 服务不健康但**只是偶发一次**（连续失败未达 FAIL_THRESHOLD=2，窗口 FAIL_WINDOW=600s）
    → 静默退出。事件循环被小时级任务阻塞时 /health 会短暂超时，单次超时不足以判定宕机。
  - 连续若干次不健康 → 杀掉 :8799 残留监听进程（仅 Windows）→ 以独立进程重新启动 →
    等待 25 秒验证 → 成功则在修复日志追加一行；失败写入 watchdog 日志。
  - 全程无 stdout 输出（接入通知系统时：空输出 = 静默，可零成本轮询）。

路径配置（环境变量，与 start-monitor.js 的 .env 约定一致）：
  VRC_MONITOR_DIR       项目根目录（默认：本脚本所在目录的上一级）
  VRC_MONITOR_NODE      node 可执行文件（默认：PATH 中的 node）
  VRC_MONITOR_LOG_DIR   日志目录（默认：<项目>/service-logs）
    修复日志：<LOG_DIR>/vrcmon-repairs.log（每日报告脚本消费）
    watchdog 日志：<LOG_DIR>/vrcmon-watchdog.log
    服务日志：<LOG_DIR>/vrcmon-service.log

平台：kill 残留进程用 netstat/taskkill，仅 Windows 启用（sys.platform 门控）；
非 Windows 跳过该步直接重启，其余逻辑跨平台。
"""
import subprocess, sys, os, time, datetime, urllib.request

HEALTH_URL = "http://127.0.0.1:8799/health"
HEALTH_TIMEOUT = 8       # 健康检查超时（秒）：4s 在磁盘忙时太紧，容易误判
GRACE_SECONDS = 300      # 启动宽限期：端口尚未监听 + 刚拉起过 → 视为启动中，不动它
STAMP_NAME = ".vrcmon-watchdog-launch"   # 上次由本 watchdog 拉起服务的时刻戳
FAIL_NAME = ".vrcmon-watchdog-unhealthy" # 连续不健康计数（内容 "count epoch"）
FAIL_THRESHOLD = 2       # 连续探测失败达到该次数才判定宕机
FAIL_WINDOW = 600        # 两次失败间隔超过该秒数则重新计数（秒）


def project_dir():
    env = os.environ.get("VRC_MONITOR_DIR")
    if env:
        return os.path.abspath(env)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def node_bin():
    return os.environ.get("VRC_MONITOR_NODE") or "node"


def log_dir():
    env = os.environ.get("VRC_MONITOR_LOG_DIR")
    if env:
        return os.path.abspath(env)
    return os.path.join(project_dir(), "service-logs")


def healthy():
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=HEALTH_TIMEOUT) as r:
            return r.status == 200
    except Exception:
        return False


def stamp_path():
    return os.path.join(log_dir(), STAMP_NAME)


def stamp_age():
    """距上次由本 watchdog 拉起服务的秒数；没有戳记返回 None。"""
    try:
        return time.time() - os.path.getmtime(stamp_path())
    except OSError:
        return None


def touch_stamp():
    try:
        os.makedirs(log_dir(), exist_ok=True)
        with open(stamp_path(), "w", encoding="utf-8") as f:
            f.write(datetime.datetime.now().isoformat())
    except Exception:
        pass


def fail_path():
    return os.path.join(log_dir(), FAIL_NAME)


def read_fail():
    """返回 (连续失败次数, 上次失败时刻)。"""
    try:
        with open(fail_path(), encoding="utf-8") as f:
            count, ts = f.read().split()
        return int(count), float(ts)
    except Exception:
        return 0, 0.0


def bump_fail():
    """记录一次探测失败并返回累计次数；距上次失败超过 FAIL_WINDOW 则重新计数。"""
    count, last = read_fail()
    if time.time() - last > FAIL_WINDOW:
        count = 0
    count += 1
    try:
        os.makedirs(log_dir(), exist_ok=True)
        with open(fail_path(), "w", encoding="utf-8") as f:
            f.write(f"{count} {time.time()}")
    except Exception:
        pass
    return count


def clear_fail():
    try:
        os.remove(fail_path())
    except OSError:
        pass


def port_pid(port=8799):
    """Windows: 返回监听指定端口的 PID（netstat 输出按本机代码页解码，兼容中文系统）。"""
    if sys.platform != "win32":
        return None
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, timeout=15).stdout
        for line in out.decode("utf-8", errors="ignore").splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.split()
                if parts:
                    return int(parts[-1])
    except Exception:
        pass
    return None


def _append(path, text):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(text)
    except Exception:
        pass


def _launch_detached():
    os.makedirs(log_dir(), exist_ok=True)
    logf = open(os.path.join(log_dir(), "vrcmon-service.log"), "ab")
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        try:
            flags |= subprocess.CREATE_NO_WINDOW
        except AttributeError:
            pass
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    subprocess.Popen(
        [node_bin(), "start-monitor.js"],
        cwd=project_dir(),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=logf,
        stderr=logf,
        creationflags=flags,
        close_fds=True,
    )


def main():
    if healthy():
        clear_fail()    # 健康即清零：偶发的短时阻塞不会累积成误判
        return 0  # 一切正常，静默

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 启动宽限期：只要是本 watchdog 刚拉起过的（< GRACE_SECONDS）就视为"正在启动"，本轮不介入。
    # 注意：init 期间端口可能已 Listen 但处理器阻塞在 DB 上（表现为超时），
    # 因此判据只看拉起时刻，不看端口状态，否则仍会误杀。
    age = stamp_age()
    if age is not None and age < GRACE_SECONDS:
        return 0

    # 连续失败判定：单次超时可能只是事件循环被小时级大任务阻塞（实测「追踪非好友刷新」
    # 期间 /health 会 >8s 无响应），此时杀进程＝把正常服务打断并重启（每次还要重建
    # 380MB 备份）。要求连续 FAIL_THRESHOLD 次探测失败（FAIL_WINDOW 内）才判定宕机。
    count = bump_fail()
    if count < FAIL_THRESHOLD:
        return 0

    clear_fail()
    pid = port_pid()
    if pid is not None:
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, timeout=15)
        except Exception:
            pass
        time.sleep(2)

    try:
        _launch_detached()
        touch_stamp()   # 记录拉起时刻，供下一轮宽限期判定
    except Exception as e:
        _append(os.path.join(log_dir(), "vrcmon-watchdog.log"), f"{now} launch error: {e}\n")
        return 0

    time.sleep(25)
    if healthy():
        _append(os.path.join(log_dir(), "vrcmon-repairs.log"), f"{now} repair\n")
    else:
        _append(os.path.join(log_dir(), "vrcmon-watchdog.log"), f"{now} repair attempt failed (not healthy after 25s)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
