package budget.core

import java.time.LocalDate
import java.time.YearMonth

/** 통계·예산 계산. 화면은 이 결과만 그린다. */
class Stats(private val txs: List<Tx>, private val includeTransfers: Boolean) {

    /** 이 거래가 지출 합계에 더하는 금액 (취소는 빼고, 지출에서 뺀 송금은 0) */
    fun effective(t: Tx): Long = when {
        t.cancelled -> 0
        !t.includeInSpending -> 0
        t.kind == Kind.INCOME -> 0
        t.kind == Kind.TRANSFER && !includeTransfers -> 0
        t.kind == Kind.CANCEL -> -t.amount
        else -> t.amount
    }

    private fun inMonth(ym: YearMonth) = txs.filter { YearMonth.from(it.time) == ym }

    fun monthTotal(ym: YearMonth): Long = inMonth(ym).sumOf(::effective)

    /** 그 달 1일부터 day일까지 (전월 같은 날짜와 비교할 때) */
    fun totalUntil(ym: YearMonth, day: Int): Long {
        val last = minOf(day, ym.lengthOfMonth())
        return inMonth(ym).filter { it.time.dayOfMonth <= last }.sumOf(::effective)
    }

    /** 카테고리별 합계, 큰 순서. 0 이하는 뺀다. */
    fun byCategory(ym: YearMonth): List<Pair<String, Long>> =
        inMonth(ym).groupBy { it.category ?: Categories.UNCATEGORIZED }
            .mapValues { (_, list) -> list.sumOf(::effective) }
            .filter { it.value > 0 }
            .toList()
            .sortedByDescending { it.second }

    /** 날짜(1~말일) → 그날 지출 */
    fun daily(ym: YearMonth): Map<Int, Long> =
        inMonth(ym).groupBy { it.time.dayOfMonth }.mapValues { (_, l) -> l.sumOf(::effective) }

    /** 최근 n개월 총지출 (오래된 달부터) */
    fun monthly(last: YearMonth, n: Int): List<Pair<YearMonth, Long>> =
        (n - 1 downTo 0).map { last.minusMonths(it.toLong()) }.map { it to monthTotal(it) }

    fun forDay(date: LocalDate): List<Tx> = txs.filter { it.time.toLocalDate() == date }.sortedByDescending { it.time }
}

data class BudgetStatus(
    val budget: Long,
    val spent: Long,
    /** 오늘 포함 이번 달 남은 날 */
    val daysLeft: Int,
) {
    val remaining: Long get() = budget - spent
    val ratio: Double get() = if (budget <= 0) 0.0 else spent.toDouble() / budget
    val perDay: Long get() = if (daysLeft <= 0 || remaining <= 0) 0 else remaining / daysLeft

    companion object {
        fun of(budget: Long, spent: Long, today: LocalDate): BudgetStatus =
            BudgetStatus(budget, spent, today.lengthOfMonth() - today.dayOfMonth + 1)
    }
}

object BudgetAlert {
    /** 알림을 보내는 지점 (예산의 80%, 100%) */
    val LEVELS = listOf(80, 100)

    /** 이번 달 아직 알리지 않은 단계 중 지출이 넘어선 가장 높은 단계. 없으면 null */
    fun due(budget: Long, spent: Long, alreadySent: Set<Int>): Int? {
        if (budget <= 0) return null
        val reached = LEVELS.filter { spent * 100 >= budget * it }
        val top = reached.maxOrNull() ?: return null
        return if (top in alreadySent) null else top
    }
}
