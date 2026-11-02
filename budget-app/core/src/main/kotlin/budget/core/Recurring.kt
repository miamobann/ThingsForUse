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
)

object RecurringFinder {
    /** 같은 고정 지출로 보는 금액 차이 (10%) */
    private const val AMOUNT_TOLERANCE = 10

    /**
     * 지난 [lookback]개월(이번 달 제외)을 보고 고정 지출을 찾는다.
     * - 같은 가게에서 최근 금액과 10% 안쪽인 결제가 지난달과 그 전달 모두, 또는 최근 4달 중 3달 이상 있고
     * - 그런 결제가 한 달에 한 번씩만 있으면 (카페처럼 자주 가는 곳은 빼려고)
     */
    fun find(txs: List<Tx>, today: LocalDate, lookback: Int = 6, hidden: Set<String> = emptySet()): List<Recurring> {
        val thisMonth = YearMonth.from(today)
        val start = thisMonth.minusMonths(lookback.toLong())
        val candidates = txs.filter {
            (it.kind == Kind.PAYMENT || it.kind == Kind.TRANSFER) && !it.cancelled && it.includeInSpending &&
                !YearMonth.from(it.time).isBefore(start) && !it.time.toLocalDate().isAfter(today)
        }
        return candidates.groupBy { Merchants.key(it.merchant) }
            .filterKeys { it.isNotEmpty() && it !in hidden }
            .mapNotNull { (key, list) -> judge(key, list, thisMonth) }
            .sortedWith(compareBy({ it.paidThisMonth }, { it.day }))
    }

    private fun judge(key: String, list: List<Tx>, thisMonth: YearMonth): Recurring? {
        if (Merchants.isPaymentAgentOnly(list.first().originalMerchant) && Merchants.isPaymentAgentOnly(list.first().merchant)) return null
        val past = list.filter { YearMonth.from(it.time).isBefore(thisMonth) }.sortedBy { it.time }
        val ref = past.lastOrNull() ?: return null
        fun near(t: Tx) = kotlin.math.abs(t.amount - ref.amount) * 100 <= ref.amount * AMOUNT_TOLERANCE

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
            merchant = latest.merchant,
            category = latest.category,
            amount = latest.amount,
            day = ref.time.dayOfMonth,
            months = byMonth.size,
            paidThisMonth = current.isNotEmpty(),
            lastPaid = latest.time.toLocalDate(),
        )
    }

    /** 이번 달 아직 안 나간 고정 지출 합계 */
    fun remaining(list: List<Recurring>): Long = list.filter { !it.paidThisMonth }.sumOf { it.amount }
}
