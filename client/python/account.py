"""메이킷 계정 인증 모듈 (access_token 우선)

- access_token 있으면 토큰으로 verify
- 없으면 email/password fallback
"""

import hashlib
import platform
import uuid
import requests
from dataclasses import dataclass

ACCOUNT_API_URL = "https://snsmakeit.com/api/naverbot/account-verify"
TIMEOUT = 15


def get_machine_id() -> str:
    try:
        mac = uuid.getnode()
        node = platform.node()
        raw = f"{mac}-{node}-{platform.system()}"
        return hashlib.sha256(raw.encode()).hexdigest()[:32]
    except Exception:
        return "unknown"


@dataclass
class AccountStatus:
    valid: bool
    plan: str = ""
    expires_at: str = ""
    uid: str = ""
    email: str = ""
    nick: str = ""
    trial: bool = False
    trial_used: int = 0
    trial_limit: int = 5
    error: str = ""


def verify_account(
    *,
    access_token: str = "",
    email: str = "",
    password: str = "",
) -> AccountStatus:
    if not access_token and not (email and password):
        return AccountStatus(valid=False, error="인증 정보 없음")

    payload = {}
    if access_token:
        payload["access_token"] = access_token
    if email:
        payload["email"] = email
    if password:
        payload["password"] = password

    try:
        resp = requests.post(ACCOUNT_API_URL, json=payload, timeout=TIMEOUT)
        data = resp.json() if resp.content else {}
        if resp.status_code != 200:
            return AccountStatus(valid=False, error=data.get("error") or f"서버 응답 {resp.status_code}")
        if not data.get("valid"):
            return AccountStatus(valid=False, error=data.get("error", "검증 실패"))

        user = data.get("user", {})
        return AccountStatus(
            valid=True,
            plan=data.get("plan", ""),
            expires_at=data.get("expires_at") or "",
            uid=user.get("uid", ""),
            email=user.get("email", ""),
            nick=user.get("nick", ""),
            trial=bool(data.get("trial")),
            trial_used=int(data.get("trial_used", 0)),
            trial_limit=int(data.get("trial_limit", 5)),
        )
    except requests.RequestException as e:
        return AccountStatus(valid=False, error=f"네트워크 오류: {e}")
