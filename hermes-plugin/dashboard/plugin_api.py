"""vrc-monitor dashboard plugin — backend API routes.

Mounted at /api/plugins/vrc-monitor/ by the dashboard plugin system.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

import json
import logging

from fastapi import APIRouter
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import process_manager as pm  # noqa: E402

router = APIRouter()

logger = logging.getLogger(__name__)


# ── /status ────────────────────────────────────────────────────────────


@router.get("/status")
def get_status() -> Dict[str, Any]:
    try:
        return pm.status()
    except Exception:
        logger.exception("get_status failed")
        return {"ok": False, "error": "内部错误，请查看服务端日志"}


# ── /start ─────────────────────────────────────────────────────────────


@router.post("/start")
def post_start() -> Dict[str, Any]:
    try:
        return pm.start()
    except Exception:
        logger.exception("post_start failed")
        return {"ok": False, "error": "内部错误，请查看服务端日志"}


# ── /stop ──────────────────────────────────────────────────────────────


@router.post("/stop")
def post_stop() -> Dict[str, Any]:
    try:
        return pm.stop()
    except Exception:
        logger.exception("post_stop failed")
        return {"ok": False, "error": "内部错误，请查看服务端日志"}


# ── /restart ───────────────────────────────────────────────────────────


@router.post("/restart")
def post_restart() -> Dict[str, Any]:
    try:
        return pm.restart()
    except Exception:
        logger.exception("post_restart failed")
        return {"ok": False, "error": "内部错误，请查看服务端日志"}


# ── /config (GET) ──────────────────────────────────────────────────────


@router.get("/config")
def get_config() -> Dict[str, Any]:
    try:
        return {
            "ok": True,
            "monitor_dir_configured": pm._resolve_monitor_dir() is not None,
            "node_exe": pm._resolve_node_exe(),
            "env_monitor_dir_set": bool(os.environ.get("VRC_MONITOR_DIR")),
            "env_node_exe": os.environ.get("VRC_MONITOR_NODE"),
            "config_file_exists": pm._config_path().is_file(),
        }
    except Exception:
        logger.exception("get_config failed")
        return {"ok": False, "error": "内部错误，请查看服务端日志"}


# ── /doctor ─────────────────────────────────────────────────────────────


@router.get("/doctor")
def get_doctor() -> Dict[str, Any]:
    try:
        monitor_dir = pm._resolve_monitor_dir()
        node_exe = pm._resolve_node_exe()

        checks = []

        checks.append({
            "name": "服务目录",
            "ok": monitor_dir is not None,
            "detail": "已解析" if monitor_dir else "未找到服务目录：请设置环境变量 VRC_MONITOR_DIR 指向克隆的仓库目录，或参考仓库 AGENTS.md 配置",
        })

        checks.append({
            "name": "Node.js",
            "ok": node_exe is not None,
            "detail": node_exe if node_exe else "未找到 node：请安装 Node.js 或设置 VRC_MONITOR_NODE",
        })

        if monitor_dir:
            cred_path = Path(monitor_dir) / "credentials.json"
            cred_ok = cred_path.is_file()
            checks.append({
                "name": "凭据文件",
                "ok": cred_ok,
                "detail": f"credentials.json {'存在' if cred_ok else '不存在'}",
            })
        else:
            checks.append({
                "name": "凭据文件",
                "ok": False,
                "detail": "无法检查：服务目录未解析",
            })

        all_ok = all(c["ok"] for c in checks)

        return {
            "ok": all_ok,
            "checks": checks,
            "resolved": {
                "monitor_dir_configured": monitor_dir is not None,
                "node_exe": node_exe,
            },
        }
    except Exception:
        logger.exception("get_doctor failed")
        return {"ok": False, "error": "内部错误，请查看服务端日志"}


# ── credentials ───────────────────────────────────────────────────────


class CredentialBody(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    imap_auth_code: Optional[str] = None
    qqmail_auth_code: Optional[str] = None


def _credentials_path() -> Optional[Path]:
    monitor_dir = pm._resolve_monitor_dir()
    if not monitor_dir:
        return None
    return Path(monitor_dir) / "credentials.json"


def _mask_email(email: str) -> str:
    """Mask email local part: user@example.com -> u***r@example.com"""
    if "@" not in email:
        return email
    local, domain = email.split("@", 1)
    if len(local) <= 1:
        masked_local = "***"
    elif len(local) <= 4:
        masked_local = local[0] + "***" + local[-1]
    else:
        masked_local = local[:2] + "***" + local[-2:]
    return f"{masked_local}@{domain}"


@router.get("/credentials")
def get_credentials() -> Dict[str, Any]:
    try:
        monitor_dir = pm._resolve_monitor_dir()
        cred_path = None
        configured = False
        email_masked = None

        if monitor_dir:
            cred_path = Path(monitor_dir) / "credentials.json"
            if cred_path.is_file():
                configured = True
                try:
                    creds = json.loads(cred_path.read_text(encoding="utf-8"))
                except Exception:
                    creds = {}
                email = creds.get("email", "") or ""
                if email:
                    email_masked = _mask_email(email)

        return {
            "ok": True,
            "configured": configured,
            "email_masked": email_masked,
        }
    except Exception:
        logger.exception("get_credentials failed")
        return {"ok": False, "error": "内部错误，请查看服务端日志"}


@router.post("/credentials")
def post_credentials(body: CredentialBody) -> Dict[str, Any]:
    try:
        monitor_dir = pm._resolve_monitor_dir()
        if not monitor_dir:
            return {
                "ok": False,
                "error": "服务目录未配置，请先设置 VRC_MONITOR_DIR 环境变量或参考 AGENTS.md",
            }

        cred_path = Path(monitor_dir) / "credentials.json"

        if cred_path.is_file():
            try:
                creds = json.loads(cred_path.read_text(encoding="utf-8"))
            except Exception:
                creds = {}
        else:
            creds = {}

        fields = []

        if body.email is not None:
            if body.email == "":
                creds.pop("email", None)
            else:
                creds["email"] = body.email
            fields.append("email")

        if body.password is not None:
            if body.password == "":
                creds.pop("password", None)
            else:
                creds["password"] = body.password
            fields.append("password")

        if body.imap_auth_code is not None:
            if body.imap_auth_code == "":
                creds.pop("imap_auth_code", None)
            else:
                creds["imap_auth_code"] = body.imap_auth_code
            creds.pop("qqmail_auth_code", None)  # 删除旧字段避免冗余
            fields.append("imap_auth_code")
        elif body.qqmail_auth_code is not None:
            # 兼容旧字段，迁移到新字段名
            if body.qqmail_auth_code == "":
                creds.pop("qqmail_auth_code", None)
            else:
                creds["imap_auth_code"] = body.qqmail_auth_code
                creds.pop("qqmail_auth_code", None)
            fields.append("imap_auth_code")

        cred_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = cred_path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(creds, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        tmp.replace(cred_path)
        os.chmod(cred_path, 0o600)

        return {
            "ok": True,
            "saved": True,
            "fields": fields,
        }
    except Exception:
        logger.exception("post_credentials failed")
        return {"ok": False, "error": "内部错误，请查看服务端日志"}
