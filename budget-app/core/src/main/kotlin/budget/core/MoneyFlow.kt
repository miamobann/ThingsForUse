package budget.core

import java.time.YearMonth

/**
 * 지출이 아닌 돈의 흐름: 수입, 저축, 돌려받은 돈, 내 계좌끼리 옮긴 돈.
 * 모두 카테고리로 구분하고 지출 합계에서는 빠진다.
 */
object MoneyFlow {
    /** 번 돈 (월급·부수입·이자) */
    const val EARNED = "수입"

    /** 더치페이·환불처럼 돌려받은 돈. 결제와 상계한다. */
    const val RETURNED = "돌려받은 돈"

    /** 내 다른 계좌와 주고받은 돈 (적금 만기 포함) */
    const val OWN = "내 계좌 이동"

    /** 적금 등 저축으로 나간 돈 */
    const val SAVING = "저축"

    /** 입금에 고를 수 있는 구분 */
    val INCOME_CHOICES = listOf(EARNED, RETURNED, OWN)

    /** 출금에 더 고를 수 있는 구분 */
    val OUT_CHOICES = listOf(SAVING, OWN)

    private val ALL = setOf(EARNED, RETURNED, OWN, SAVING)

    /** 이 기준일(포함) 이후 받은 수입은 다음 달 수입으로 센다 */
    const val DEFAULT_CUTOFF = 25

    fun isFlowCategory(c: String?): Boolean = c in ALL

    /** 카테고리를 바꾸면서 지출 포함 여부도 맞춘다: 수입·저축 등은 빼고, 거기서 일반 카테고리로 돌아오면 다시 넣는다 */
    fun withCategory(t: Tx, category: String?): Tx = when {
        isFlowCategory(category) -> t.copy(category = category, includeInSpending = false)
        isFlowCategory(t.category) && t.kind != Kind.INCOME -> t.copy(category = category, includeInSpending = true)
        else -> t.copy(category = category)
    }

    /** 분류 기억의 열쇠. 같은 사람에게 보낸 돈(송금)과 받은 돈(입금)은 따로 기억한다. */
    fun ruleKey(merchant: String, kind: Kind): String =
        (if (kind == Kind.INCOME) "in:" else "") + Merchants.key(merchant)

    private val NOT_PERSON = listOf(
        "주식회사", "은행", "증권", "보험", "카드", "페이", "공단", "센터", "회사", "재단", "협회", "학교", "대학",
        "농협", "국민", "신한", "우리", "하나", "카카오", "토스", "네이버", "이자", "급여", "월급", "환급", "캐시백",
        "적금", "예금", "입금", "출금", "이체", "결산", "정산", "환불",
    )

    /** "홍길동"처럼 사람 이름으로 보이는지 (한글 2~4자, 회사·은행 단어 없음) */
    fun looksLikePerson(name: String): Boolean {
        val s = name.trim().replace(" ", "")
        return s.length in 2..4 && s.all { it in '가'..'힣' } && NOT_PERSON.none { s.contains(it) }
    }

    /** 처음 보는 입금의 기본 구분: 친구 이름이면 돌려받은 돈, 아니면 물어본다(null) */
    fun defaultIncomeCategory(sender: String): String? = if (looksLikePerson(sender)) RETURNED else null

    /** 통계에서 이 거래를 세는 달. 기준일 이후 받은 수입만 다음 달로 넘긴다. 내역 날짜는 그대로. */
    fun budgetMonth(t: Tx, cutoff: Int): YearMonth {
        val ym = YearMonth.from(t.time)
        return if (isEarned(t) && cutoff in 1..31 && t.time.dayOfMonth >= cutoff) ym.plusMonths(1) else ym
    }

    fun isEarned(t: Tx): Boolean = t.kind == Kind.INCOME && t.category == EARNED && !t.cancelled

    fun isSaving(t: Tx): Boolean =
        (t.kind == Kind.TRANSFER || t.kind == Kind.PAYMENT) && t.category == SAVING && !t.cancelled

    /** 월 예산: 자동이면 그 달 수입 − 저축(수입이 아직 없으면 직접 정한 금액) */
    fun budget(auto: Boolean, manual: Long, income: Long, savings: Long): Long =
        if (auto && income > 0) (income - savings).coerceAtLeast(0) else manual
}
