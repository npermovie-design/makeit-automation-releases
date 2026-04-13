"""1회 테스트 실행 - 본인 네이버 ID/PW만 아래에 입력하고 실행

사용:
    python test_run.py
"""

from naver_blog import publish_to_naver_blog

# ── 여기 두 줄만 본인 정보로 바꾸세요 ──
NAVER_ID = "npermovie"
NAVER_PW = "Ehekfmstkfa1!!!!"
# ──────────────────────────────────────

result = publish_to_naver_blog(
    user_id="test_user",
    naver_id=NAVER_ID,
    naver_pw=NAVER_PW,
    title="[테스트] 자동포스팅",
    body="이건 자동 포스팅 테스트입니다.\n등록되면 삭제해주세요.",
    tags=["테스트"],
    headless=False,  # 첫 실행은 반드시 False (캡차/2차인증 통과용)
)

print("=" * 50)
print("결과:")
print(result)
print("=" * 50)
