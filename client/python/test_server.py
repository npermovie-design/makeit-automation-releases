"""서버 API 연결 테스트

1) 라이선스 검증
2) 글 생성

실행:
    python test_server.py
"""

import requests
import json

LICENSE_KEY = "TEST-NPER-0001-DEMO"
BASE = "https://snsmakeit.com/api/naverbot"


def test_license():
    print("=" * 60)
    print(" 1) 라이선스 검증 테스트")
    print("=" * 60)
    # 리다이렉트 확인용
    resp_no_redir = requests.post(
        f"{BASE}/license-verify",
        json={"license_key": LICENSE_KEY, "machine_id": "test-machine-001"},
        timeout=15,
        allow_redirects=False,
    )
    print(f"[리다이렉트 미허용] Status: {resp_no_redir.status_code}")
    print(f"  Headers Location: {resp_no_redir.headers.get('location', '(없음)')}")

    resp = requests.post(
        f"{BASE}/license-verify",
        json={"license_key": LICENSE_KEY, "machine_id": "test-machine-001"},
        timeout=15,
    )
    print(f"[리다이렉트 허용] Status: {resp.status_code}, 최종 URL: {resp.url}")
    try:
        print(f"Body: {json.dumps(resp.json(), ensure_ascii=False, indent=2)}")
        print()
        return resp.status_code == 200 and resp.json().get("valid")
    except Exception:
        print(f"Body (text): {resp.text[:300]}")
        return False


def test_generate():
    print("=" * 60)
    print(" 2) 글 생성 테스트 (Claude 호출 — 30~60초 소요)")
    print("=" * 60)
    resp = requests.post(
        f"{BASE}/content-generate",
        json={
            "license_key": LICENSE_KEY,
            "machine_id": "test-machine-001",
            "topic": "1인 사업자가 알아야 할 절세 팁",
            "length": 2000,
            "style_prompt": "친근한 반말체로 5~6개 섹션. 실전 사례 포함. 이모지 금지.",
            "auto_title": True,
            "auto_hashtag": False,
        },
        timeout=120,
    )
    print(f"Status: {resp.status_code}")
    data = resp.json()
    if data.get("ok"):
        print(f"제목: {data.get('title')}")
        print(f"본문 길이: {len(data.get('body', ''))}자")
        print(f"본문 미리보기:\n{data.get('body', '')[:300]}...")
        print(f"쿼터: {data.get('quota')}")
    else:
        print(f"에러: {data.get('error')}")
    print()


if __name__ == "__main__":
    if test_license():
        test_generate()
    else:
        print("라이선스 검증 실패 → 글 생성 테스트 스킵")
