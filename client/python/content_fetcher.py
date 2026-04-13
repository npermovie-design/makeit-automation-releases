"""서버에서 글 받아오기 (Claude API는 서버에서 호출)

인증: 메이킷 계정 email/password
요청: 글타입/톤/말투/분량 + 필드 → 응답: title + blocks(text/image 순서)
"""

import requests
from dataclasses import dataclass, field

CONTENT_API_URL = "https://snsmakeit.com/api/naverbot/content-generate"
TIMEOUT = 180  # 4000자 글은 1~2분 걸림


@dataclass
class GeneratedPost:
    title: str = ""
    blocks: list = field(default_factory=list)
    tags: list = field(default_factory=list)
    quota: dict = field(default_factory=dict)
    error: str = ""

    def text_only(self) -> str:
        return "\n\n".join(b["content"] for b in self.blocks if b.get("type") == "text")

    def image_blocks(self) -> list:
        return [b for b in self.blocks if b.get("type") == "image"]


def fetch_post(
    *,
    access_token: str = "",
    email: str = "",
    password: str = "",
    subtype: str = "info",
    tone: str = "friendly",
    speech: str = "polite_yo",
    word_count: str = "medium",
    fields: dict | None = None,
    user_prompt: str = "",
) -> GeneratedPost:
    """글 1개 생성 요청 (메이킷 계정 인증 — 토큰 또는 이메일/비번)"""
    if not fields or not fields.get("keyword"):
        return GeneratedPost(error="fields.keyword 필수")
    if not access_token and not (email and password):
        return GeneratedPost(error="로그인 정보 없음")

    payload = {
        "subtype": subtype,
        "tone": tone,
        "speech": speech,
        "word_count": word_count,
        "fields": fields,
        "user_prompt": user_prompt,
    }
    if access_token:
        payload["access_token"] = access_token
    if email:
        payload["email"] = email
    if password:
        payload["password"] = password

    try:
        resp = requests.post(CONTENT_API_URL, json=payload, timeout=TIMEOUT)
        data = resp.json() if resp.content else {}
        if resp.status_code != 200 or not data.get("ok"):
            err = data.get("error") or f"서버 응답 {resp.status_code}"
            return GeneratedPost(error=err)
        return GeneratedPost(
            title=data.get("title", ""),
            blocks=data.get("blocks", []),
            tags=data.get("tags", []),
            quota=data.get("quota", {}),
        )
    except requests.RequestException as e:
        return GeneratedPost(error=f"네트워크 오류: {e}")
