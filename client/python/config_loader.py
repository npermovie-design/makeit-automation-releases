"""사용자 설정 로드/저장 모듈

설정 위치: %APPDATA%\\NaverBotSaaS\\config.json
비밀번호: Windows Credential Manager (keyring) — 평문 저장 금지
"""

import json
import os
from pathlib import Path
from dataclasses import dataclass, asdict, field

try:
    import keyring
except ImportError:
    keyring = None

KEYRING_SERVICE = "NaverBotSaaS"


def get_config_dir() -> Path:
    base = Path(os.environ.get("APPDATA", str(Path.home()))) / "NaverBotSaaS"
    base.mkdir(parents=True, exist_ok=True)
    return base


def get_config_path() -> Path:
    return get_config_dir() / "config.json"


@dataclass
class WriteSettings:
    """글쓰기 설정 (사용자가 GUI에서 입력)"""
    topics: list[str] = field(default_factory=list)
    topic_mode: str = "sequential"  # sequential | random
    length: int = 4000  # 1000 ~ 8000
    style_prompt: str = ""  # 사용자 자유 작성 (말투/구조/규칙)
    auto_title: bool = True
    auto_image: bool = True
    auto_hashtag: bool = False


@dataclass
class ScheduleSettings:
    times: list[str] = field(default_factory=lambda: ["09:00"])  # HH:MM
    count_per_day: int = 1
    random_jitter_min: int = 0  # 분 단위 랜덤 지터


@dataclass
class BlogTarget:
    type: str = "blog"  # 현재는 blog만, 추후 cafe 추가
    blog_id: str = ""  # 네이버 블로그 ID (URL: blog.naver.com/{blog_id})


@dataclass
class UserConfig:
    user_id: str = ""  # SaaS 내부 ID (라이선스와 연동)
    naver_id: str = ""  # 네이버 로그인 ID
    targets: list[BlogTarget] = field(default_factory=list)
    write: WriteSettings = field(default_factory=WriteSettings)
    schedule: ScheduleSettings = field(default_factory=ScheduleSettings)
    license_key: str = ""

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "naver_id": self.naver_id,
            "targets": [asdict(t) for t in self.targets],
            "write": asdict(self.write),
            "schedule": asdict(self.schedule),
            "license_key": self.license_key,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "UserConfig":
        return cls(
            user_id=data.get("user_id", ""),
            naver_id=data.get("naver_id", ""),
            targets=[BlogTarget(**t) for t in data.get("targets", [])],
            write=WriteSettings(**data.get("write", {})),
            schedule=ScheduleSettings(**data.get("schedule", {})),
            license_key=data.get("license_key", ""),
        )


def load_config() -> UserConfig:
    path = get_config_path()
    if not path.exists():
        return UserConfig()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return UserConfig.from_dict(data)
    except Exception as e:
        raise RuntimeError(f"설정 파일 손상: {e}")


def save_config(cfg: UserConfig) -> None:
    path = get_config_path()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg.to_dict(), f, ensure_ascii=False, indent=2)


def save_password(naver_id: str, password: str) -> None:
    """네이버 비번을 Windows Credential Manager에 저장"""
    if keyring is None:
        raise RuntimeError("keyring 미설치 - pip install keyring 필요")
    keyring.set_password(KEYRING_SERVICE, naver_id, password)


def load_password(naver_id: str) -> str | None:
    if keyring is None:
        raise RuntimeError("keyring 미설치 - pip install keyring 필요")
    return keyring.get_password(KEYRING_SERVICE, naver_id)


def delete_password(naver_id: str) -> None:
    if keyring is None:
        return
    try:
        keyring.delete_password(KEYRING_SERVICE, naver_id)
    except Exception:
        pass


if __name__ == "__main__":
    # 테스트
    cfg = UserConfig(
        user_id="test_user",
        naver_id="test_naver",
        targets=[BlogTarget(blog_id="myblog")],
        write=WriteSettings(
            topics=["부동산 시장", "재테크 입문"],
            length=3500,
            style_prompt="친근한 반말체로 5~7개 섹션. 이모지 금지.",
        ),
        schedule=ScheduleSettings(times=["09:00", "14:00"], count_per_day=2),
        license_key="DUMMY-KEY",
    )
    save_config(cfg)
    loaded = load_config()
    print(json.dumps(loaded.to_dict(), ensure_ascii=False, indent=2))
