package budget.core

import java.time.LocalDate
import java.time.YearMonth
import java.time.temporal.ChronoUnit

/**
 * 상계: 결제 하나와 그 돈을 되돌려받은 기록(다음 달에 들어온 환불, 더치페이 입금)을 맞붙인다.
 * - 금액이 같으면 둘 다 지운다.
 * - 되돌려받은 돈이 더 적으면 결제 금액을 그만큼 줄이고 되돌려받은 기록은 지운다. (더치페이)
 * - 되돌려받은 돈이 더 많으면 결제는 지우고 남은 금액만 되돌려받은 기록에 남긴다.
 */
object Offset {
    data class Result(val update: List<Tx>, val delete: List<Long>)

    fun canOffset(a: Tx, b: Tx): Boolean = (isSpend(a) && isRefund(b)) || (isRefund(a) && isSpend(b))

    private fun isSpend(t: Tx) = (t.kind == Kind.PAYMENT || t.kind == Kind.TRANSFER) && !t.cancelled
    private fun isRefund(t: Tx) = t.kind == Kind.CANCEL || t.kind == Kind.INCOME

    fun apply(a: Tx, b: Tx): Result {
        require(canOffset(a, b))
        val spend = if (isSpend(a)) a else b
        val back = if (spend === a) b else a
        return when {
            back.amount == spend.amount -> Result(emptyList(), listOf(spend.id, back.id))
            back.amount < spend.amount -> {
                val note = "${back.merchant}에서 ${"%,d".format(back.amount)}원 상계"
                Result(
                    listOf(spend.copy(amount = spend.amount - back.amount, memo = listOf(spend.memo, note).filter { it.isNotBlank() }.joinToString(" / "))),
                    listOf(back.id),
                )
            }
            else -> Result(listOf(back.copy(amount = back.amount - spend.amount)), listOf(spend.id))
        }
    }

    /** 상계할 상대 후보: 반대 종류, 앞뒤 2달, 금액이 가까운 순 */
    fun candidates(t: Tx, all: List<Tx>): List<Tx> =
        all.filter { it.id != t.id && canOffset(t, it) && kotlin.math.abs(ChronoUnit.DAYS.between(it.time, t.time)) <= 62 }
            .sortedWith(compareBy({ kotlin.math.abs(it.amount - t.amount) }, { kotlin.math.abs(ChronoUnit.MINUTES.between(it.time, t.time)) }))
}

/** 할부 표시: 전체 금액, 지금까지 낸 회차, 남은 금액 */
data class Installment(val months: Int, val paid: Int, val total: Long) {
    val perMonth: Long get() = total / months
    val remaining: Long get() = (total - perMonth * paid).coerceAtLeast(0)
    val remainingMonths: Int get() = months - paid

    companion object {
        /** 첫 회차는 결제한 다음 달에 청구된다고 본다 */
        fun of(t: Tx, today: LocalDate = LocalDate.now()): Installment? {
            if (t.installmentMonths < 2 || t.kind != Kind.PAYMENT || t.cancelled) return null
            val elapsed = ChronoUnit.MONTHS.between(YearMonth.from(t.time), YearMonth.from(today)).toInt()
            return Installment(t.installmentMonths, elapsed.coerceIn(0, t.installmentMonths), t.amount)
        }
    }
}
