"""End-to-End 통합 테스트 (메이킷 패턴 적용)

순서:
1. 라이선스 검증
2. 서버에서 글타입/톤/말투/분량 + 필드로 글 생성 (blocks 응답)
3. blocks 그대로 네이버 블로그에 발행 (이미지 마커 위치 정확)
"""

from license import verify_license
from content_fetcher import fetch_post
from naver_blog import publish_to_naver_blog


# ── 본인 정보 ──
LICENSE_KEY = "TEST-NPER-0001-DEMO"
NAVER_ID = "npermovie"
NAVER_PW = "Ehekfmstkfa1!!!!"

# ── 글 설정 (메이킷 BlogUtils 패턴) ──
SUBTYPE = "info"          # info|visit|travel|product|column|article
TONE = "friendly"         # friendly|diary|review|professional
SPEECH = "casual"         # polite_yo|formal|casual|mixed (반말체)
WORD_COUNT = "medium"     # short|medium|long
FIELDS = {
    "keyword": "1인 사업자가 알아야 할 절세 팁",
    "target": "초보 사장님",
    "extra": "구체적 사례와 숫자 위주, 실전 활용법 중심",
}


def main():
    print("=" * 60)
    print(" Step 1) 라이선스 검증")
    print("=" * 60)
    lic = verify_license(LICENSE_KEY)
    print(f"valid={lic.valid}, plan={lic.plan}")
    if not lic.valid:
        print(f"실패: {lic.error}")
        return
    print()

    print("=" * 60)
    print(f" Step 2) 글 생성 ({SUBTYPE}/{TONE}/{SPEECH}/{WORD_COUNT})")
    print(" Claude 호출 — 1~2분 소요")
    print("=" * 60)
    post = fetch_post(
        license_key=LICENSE_KEY,
        subtype=SUBTYPE,
        tone=TONE,
        speech=SPEECH,
        word_count=WORD_COUNT,
        fields=FIELDS,
    )
    if post.error:
        print(f"실패: {post.error}")
        return

    print(f"제목: {post.title}")
    print(f"블록 수: {len(post.blocks)}")
    print(f"  - 텍스트: {sum(1 for b in post.blocks if b.get('type')=='text')}개")
    print(f"  - 이미지: {sum(1 for b in post.blocks if b.get('type')=='image')}개")
    print(f"태그: {post.tags}")
    print(f"쿼터: {post.quota}")
    print(f"트렌드 활용: 트렌드 응답 필드 확인은 서버 로그 참조")
    print()
    print("이미지 키워드/URL:")
    for b in post.blocks:
        if b.get("type") == "image":
            print(f"  [{b.get('keyword')}] {b.get('url', '')[:60]}...")
    print()
    print("본문 미리보기 (텍스트만):")
    text_preview = post.text_only()[:300]
    print(text_preview + ("..." if len(post.text_only()) > 300 else ""))
    print()

    print("=" * 60)
    print(" Step 3) 네이버 블로그 발행 (blocks 순서대로)")
    print("=" * 60)
    result = publish_to_naver_blog(
        user_id="test_user",
        naver_id=NAVER_ID,
        naver_pw=NAVER_PW,
        title=post.title,
        blocks=post.blocks,
        tags=post.tags,
        headless=True,
    )
    print(f"success={result['success']}")
    if result["success"]:
        print(f"URL: {result['post_url']}")
        print()
        print(">>> blog.naver.com/npermovie 확인 <<<")
    else:
        print(f"에러: {result['error']}")


if __name__ == "__main__":
    main()
