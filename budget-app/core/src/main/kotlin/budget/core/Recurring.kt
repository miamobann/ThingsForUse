package budget.core

import java.time.LocalDate
import java.time.YearMonth

/** 매달 비슷한 금액으로 한 번씩 나가는 지출 (구독, 회비, 월세 송금 등) */
data class Recurring(
    val key: String,
    val merchant: String,
    val category: String?,
    /** 가장 최근 금액 */
    val amount: Long,
    /** 보통 나가는 날 (가장 최근 결제일) */
    val day: Int,
    /** 최근 몇 달 중 나간 달 수 */
    val months: Int,
    val paidThisMonth: Boolean,
    val lastPaid: LocalDate,
    /** 생활 고정 지출(집세·관리비·통신비·보험·공과금, 정기 송금)이 아니면 구독으로 따로 보여 준다 */
    val subscription: Boolean = true,
)

object RecurringFinder {
    /** 생활 고정 지출로 보는 카테고리 */
    private val LIVING_CATEGORIES = setOf("생활", "주거", "통신", "통신비", "공과금", "보험", "관리비", "월세", Categories.TRANSFER)

    /** 생활 고정 지출로 보는 가게 이름 단어 */
    private val LIVING_WORDS = listOf(
        "관리비", "월세", "임대", "skt", "sk텔레콤", "케이티", "lgu", "유플러스", "알뜰폰", "헬로모바일", "통신",
        "보험", "생명", "화재", "도시가스", "가스", "한국전력", "한전", "전기", "수도", "아파트", "인터넷",
    )

    /** 집세·관리비·통신비처럼 생활에 쓰는 고정 지출인지. 구독 카테고리는 무조건 구독. */
    fun isLiving(category: String?, merchant: String): Boolean {
        if (category == "구독") return false
        if (category in LIVING_CATEGORIES) return true
        val k = Merchants.key(merchant)
        return k.startsWith("kt") || LIVING_WORDS.any { k.contains(it) }
    }

    /** 같은 고정 지출로 보는 금액 차이 (10%) */
    private const val AMOUNT_TOLERANCE = 10

    /**
     * 지난 [lookback]개월(이번 달 제외)을 보고 고정 지출을 찾는다.
     * - 같은 가게에서 최근 금액과 10% 안쪽인 결제가 지난달과 그 전달 모두, 또는 최근 4달 중 3달 이상 있고
     * - 그런 결제가 한 달에 한 번씩만 있으면 (카페처럼 자주 가는 곳은 빼려고)
     * 가게 하나에 구독이 여러 개면(치지직 채널 구독 여러 개, 구글 결제로 나가는 유튜브·앱 구독) 가게 단위로는 한 달에 여러 번이라
     * 안 잡힌다. 그때는 메모의 상품명(없으면 금액)으로 나눠서 각각 본다.
     */
    fun find(txs: List<Tx>, today: LocalDate, lookback: Int = 6, hidden: Set<String> = emptySet()): List<Recurring> {
        val thisMonth = YearMonth.from(today)
        val start = thisMonth.minusMonths(lookback.toLong())
        val candidates = txs.filter {
            (it.kind == Kind.PAYMENT || it.kind == Kind.TRANSFER) && !it.cancelled && it.includeInSpending &&
                !YearMonth.from(it.time).isBefore(start) && !it.time.toLocalDate().isAfter(today)
        }
        val out = mutableListOf<Recurring>()
        candidates.groupBy { Merchants.key(it.merchant) }.filterKeys { it.isNotEmpty() }.forEach { (key, list) ->
            val agentOnly = Merchants.isPaymentAgentOnly(list.first().originalMerchant) && Merchants.isPaymentAgentOnly(list.first().merchant)
            val manyProducts = list.mapNotNull(::product).toSet().size > 1
            val whole = if (agentOnly || manyProducts) null else judge(key, list, thisMonth, null)
            if (whole != null) {
                if (key !in hidden) out += whole
            } else {
                val parts = list.groupBy { product(it) ?: "${it.amount}원" }.mapNotNull { (sub, part) ->
                    if (part.size >= 2) judge("$key|$sub", part, thisMonth, sub) else null
                }
                // 상품명이 매번 조금씩 달라서(주문번호 등) 나눠지면 아무것도 안 잡힐 때는 가게 단위로 다시 본다
                val found = if (parts.isEmpty() && manyProducts && !agentOnly) listOfNotNull(judge(key, list, thisMonth, null)) else parts
                out += found.filter { it.key !in hidden }
            }
        }
        return out.sortedWith(compareBy({ it.paidThisMonth }, { it.day }))
    }

    /** 메모의 상품명: "시라유키 히나 1개월 해둥이 정기구독 / 상태:결제완료 / ..." → 앞부분 */
    fun product(t: Tx): String? =
        t.memo.substringBefore(" / ").trim().removeSuffix("...").removeSuffix("..").trim().takeIf { it.isNotEmpty() }

    private fun judge(key: String, list: List<Tx>, thisMonth: YearMonth, sub: String?): Recurring? {
        val past = list.filter { YearMonth.from(it.time).isBefore(thisMonth) }.sortedBy { it.time }
        val ref = past.lastOrNull() ?: return null
        fun near(t: Tx) = kotlin.math.abs(t.amount - ref.amount) * 100 <= ref.amount * AMOUNT_TOLERANCE

        // 상품별로 나눈 묶음은 금액이 달라도 한 달에 두 번 이상이면 구독이 아니다 (치즈 충전 등)
        if (sub != null && past.groupBy { YearMonth.from(it.time) }.values.any { it.size > 1 }) return null
        val byMonth = past.filter(::near).groupBy { YearMonth.from(it.time) }
        if (byMonth.values.any { it.size > 1 }) return null
        val last = thisMonth.minusMonths(1)
        val consecutive = last in byMonth && last.minusMonths(1) in byMonth
        val recent4 = (1..4).count { thisMonth.minusMonths(it.toLong()) in byMonth }
        if (!consecutive && recent4 < 3) return null

        val current = list.filter { YearMonth.from(it.time) == thisMonth && near(it) }
        val latest = current.maxByOrNull { it.time } ?: ref
        return Recurring(
            key = key,
            merchant = if (sub == null) latest.merchant else "${latest.merchant} · $sub",
            category = latest.category,
            amount = latest.amount,
            day = ref.time.dayOfMonth,
            months = byMonth.size,
            paidThisMonth = current.isNotEmpty(),
            lastPaid = latest.time.toLocalDate(),
            subscription = !isLiving(latest.category, latest.merchant),
        )
    }

    /** 이번 달 아직 안 나간 고정 지출 합계 */
    fun remaining(list: List<Recurring>): Long = list.filter { !it.paidThisMonth }.sumOf { it.amount }
}
