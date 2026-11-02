package budget.core

import java.time.LocalDate
import java.time.YearMonth
import java.time.temporal.ChronoUnit

/**
 * 상계: 결제 하나와 그 돈을 되돌려받은 기록(다음 달에 들어온 환불, 더치페이 입금)을 연결한다.
 * 둘 다 지우지 않는다. 돌려받은 기록에 결제 id를 달아 두면 통계에서 결제를 그만큼 줄여 세고,
 * 돌려받은 기록은 합계에서 빠진다. 연결을 풀면 원래대로.
 */
object Offset {

    fun canOffset(a: Tx, b: Tx): Boolean = (isSpend(a) && isOpenBack(b)) || (isOpenBack(a) && isSpend(b))

    private fun isSpend(t: Tx) = (t.kind == Kind.PAYMENT || t.kind == Kind.TRANSFER) && !t.cancelled && !MoneyFlow.isFlowCategory(t.category)

    /** 결제에 붙일 수 있는 환불·입금인지 (수입·내 계좌 이동으로 고른 입금은 아님) */
    fun isBack(t: Tx) = !t.cancelled && (t.kind == Kind.CANCEL || (t.kind == Kind.INCOME && (t.category == null || t.category == MoneyFlow.RETURNED)))

    private fun isOpenBack(t: Tx) = isBack(t) && t.offsetOf == null

    /** 아직 결제와 연결 안 한 돌려받은 돈·환불 (분류 안 된 입금은 분류부터) */
    fun isOpen(t: Tx) = isOpenBack(t) && (t.kind == Kind.CANCEL || t.category == MoneyFlow.RETURNED)

    /** 연결: 돌려받은 기록 쪽을 바꿔서 돌려준다. 입금이면 '돌려받은 돈'으로 분류한다. */
    fun link(a: Tx, b: Tx): Tx {
        require(canOffset(a, b))
        val spend = if (isSpend(a)) a else b
        val back = if (spend === a) b else a
        val linked = back.copy(offsetOf = spend.id)
        return if (back.kind == Kind.INCOME) MoneyFlow.withCategory(linked, MoneyFlow.RETURNED) else linked
    }

    fun unlink(t: Tx): Tx = t.copy(offsetOf = null)

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
