package budget.core

/** 가게 이름 다듬기, 결제대행사 판별, 기본 카테고리 추천. */
object Merchants {

    /**
     * 이 이름들만 보이면 실제로 어디서 샀는지 알 수 없다.
     * 이런 이름은 "한 번 고르면 기억"하지 않고 매번 물어본다.
     */
    private val PAYMENT_AGENTS = listOf(
        "네이버파이낸셜", "네이버페이", "토스페이먼츠", "나이스정보통신", "나이스인프라", "kcp",
        "이니시스", "다날", "세틀뱅크", "헥토파이낸셜", "한국정보통신", "섹타나인", "갤럭시아",
        "엑심베이", "한국신용카드결제", "비바리퍼블리카", "구글페이먼트", "코페이", "주식회사카카오",
        "카카오페이",
    )

    /** "토스페이먼츠 - 주식회사 파이어볼트"처럼 대행사와 실제 가게가 같이 찍히면 뒤쪽이 실제 가게. */
    fun displayName(raw: String): String {
        val name = raw.trim()
        val idx = name.lastIndexOf(" - ")
        return if (idx >= 0 && idx + 3 < name.length) name.substring(idx + 3).trim() else name
    }

    /** 같은 가게인지 비교하고 분류 규칙을 저장할 때 쓰는 열쇠 */
    fun key(raw: String): String {
        var s = displayName(raw).lowercase()
        s = s.replace(Regex("^\\d{1,2}월"), "") // "10월경기시내버스 0008건"
        s = s.replace(Regex("\\s*\\d+건$"), "")
        s = s.replace(Regex("\\(주\\)|㈜|\\( 주 \\)|주식회사|유한회사|\\(유\\)"), "")
        s = s.replace(Regex("[\\s_.,·*()\\[\\]-]"), "")
        return s
    }

    fun isPaymentAgentOnly(raw: String): Boolean {
        val k = key(raw)
        if (k.isEmpty()) return true
        return PAYMENT_AGENTS.any { k.contains(it) }
    }

    fun similar(a: String, b: String): Boolean {
        val ka = key(a)
        val kb = key(b)
        if (ka.isEmpty() || kb.isEmpty()) return false
        return ka == kb || ka.contains(kb) || kb.contains(ka)
    }

    /** 처음 보는 가게에 미리 골라두는 카테고리. 사용자가 바꾸면 그게 우선이다. */
    private val SUGGESTIONS: List<Pair<String, List<String>>> = listOf(
        "교통" to listOf("택시", "버스", "지하철", "티머니", "카카오t", "주차", "주유", "도시공사", "하이패스", "코레일", "srt"),
        "카페·간식" to listOf("커피", "카페", "투썸", "이디야", "스타벅스", "메가mgc", "컴포즈", "배스킨", "베이커리", "파리바게뜨", "뚜레쥬르", "빽다방"),
        "식비" to listOf(
            "gs25", "씨유", "세븐일레븐", "이마트24", "맥도날드", "맘스터치", "롯데리아", "버거", "치킨", "통닭",
            "족발", "보쌈", "국밥", "순대", "김밥", "피자", "갈비", "식당", "밀면", "돈까스", "카츠", "삼겹", "냉삼", "감자탕", "주막",
            "마트", "하나로", "트레이더스", "푸드",
        ),
        "구독" to listOf("멤버십", "openai", "chatgpt", "anthropic", "claude", "netflix", "youtube", "googleone", "구독", "와우"),
        "쇼핑" to listOf("쿠팡", "다이소", "롯데쇼핑", "오늘의집", "알라딘", "예스이십사", "무신사", "올리브영"),
        "의료" to listOf("의원", "병원", "약국", "치과", "한의원"),
        "생활" to listOf("헤어", "미용", "세탁", "대한통운", "우체국"),
        "여가" to listOf("노래", "보드게임", "클라이밍", "영화", "cgv", "메가박스", "게임", "games"),
    )

    fun suggestCategory(raw: String, kind: Kind): String? {
        if (kind == Kind.TRANSFER) return Categories.TRANSFER
        if (isPaymentAgentOnly(raw)) return null
        val k = key(raw)
        return SUGGESTIONS.firstOrNull { (_, words) -> words.any { k.contains(it) } }?.first
    }
}

object Categories {
    const val TRANSFER = "송금"
    const val UNCATEGORIZED = "미분류"
    val DEFAULT = listOf("식비", "카페·간식", "교통", "쇼핑", "구독", "여가", "생활", "의료", TRANSFER, "기타")
}
