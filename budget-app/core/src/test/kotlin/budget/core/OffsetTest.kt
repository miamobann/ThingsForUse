package budget.core

import java.time.LocalDate
import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class OffsetTest {
    private fun tx(id: Long, amount: Long, kind: Kind, time: LocalDateTime = LocalDateTime.of(2026, 10, 10, 19, 0), months: Int = 0, name: String = "가게") =
        Tx(id, time, true, amount, name, name, null, Source.CARD_NOTI, kind, installmentMonths = months)

    @Test
    fun dutchPayLinksAndReducesInStats() {
        val dinner = tx(1, 60_000, Kind.PAYMENT)
        val back = tx(2, 20_000, Kind.INCOME, name = "홍길동")
        val linked = Offset.link(dinner, back)
        assertEquals(1L, linked.offsetOf)
        assertEquals(MoneyFlow.RETURNED, linked.category)
        assertEquals(false, linked.includeInSpending)
        val stats = Stats(listOf(dinner, linked), includeTransfers = true)
        assertEquals(40_000, stats.monthTotal(java.time.YearMonth.of(2026, 10)))
        // 연결을 풀면 결제는 원래 금액
        assertEquals(60_000, Stats(listOf(dinner, Offset.unlink(linked)), true).monthTotal(java.time.YearMonth.of(2026, 10)))
    }

    @Test
    fun linkedRefundNextMonthCountsInPaymentMonth() {
        val pay = tx(1, 30_000, Kind.PAYMENT, LocalDateTime.of(2026, 10, 30, 12, 0))
        val refund = tx(2, 30_000, Kind.CANCEL, LocalDateTime.of(2026, 11, 2, 9, 0))
        val linked = Offset.link(refund, pay)
        val stats = Stats(listOf(pay, linked), true)
        assertEquals(0, stats.monthTotal(java.time.YearMonth.of(2026, 10)))
        assertEquals(0, stats.monthTotal(java.time.YearMonth.of(2026, 11)))
        // 연결 안 한 환불은 들어온 달에서 빠진다
        assertEquals(-30_000, Stats(listOf(pay, refund), true).monthTotal(java.time.YearMonth.of(2026, 11)))
    }

    @Test
    fun earnedIncomeIsNotOffsetCandidate() {
        val salary = tx(5, 800_000, Kind.INCOME, name = "회사").copy(category = MoneyFlow.EARNED)
        assertEquals(emptyList(), Offset.candidates(salary, listOf(tx(1, 800_000, Kind.PAYMENT))))
        val linkedAlready = tx(6, 10_000, Kind.INCOME).copy(offsetOf = 3)
        assertEquals(emptyList(), Offset.candidates(tx(1, 10_000, Kind.PAYMENT), listOf(linkedAlready)).map { it.id })
    }

    @Test
    fun refundNextMonthIsLeftAlone() {
        val pay = tx(1, 30_000, Kind.PAYMENT, LocalDateTime.of(2026, 10, 30, 12, 0), name = "쇼핑몰")
        val refund = Parsed(Source.CARD_NOTI, Kind.CANCEL, 30_000, "쇼핑몰", LocalDateTime.of(2026, 11, 2, 9, 0))
        assertIs<Matcher.Decision.Insert>(Matcher.decide(refund, listOf(pay)))
        // 같은 달이면 자동 취소
        val sameMonth = refund.copy(time = LocalDateTime.of(2026, 10, 31, 9, 0))
        assertIs<Matcher.Decision.Cancel>(Matcher.decide(sameMonth, listOf(pay)))
    }

    @Test
    fun candidatesAreOppositeKindClosestAmount() {
        val back = tx(9, 20_000, Kind.INCOME)
        val list = listOf(tx(1, 60_000, Kind.PAYMENT), tx(2, 21_000, Kind.PAYMENT), tx(3, 20_000, Kind.CANCEL))
        assertEquals(listOf(2L, 1L), Offset.candidates(back, list).map { it.id })
    }

    @Test
    fun installmentRemaining() {
        val t = tx(1, 300_000, Kind.PAYMENT, LocalDateTime.of(2026, 9, 15, 12, 0), months = 3)
        val i = Installment.of(t, LocalDate.of(2026, 11, 2))!!
        assertEquals(2, i.paid)
        assertEquals(100_000, i.remaining)
        assertEquals(1, i.remainingMonths)
        assertEquals(null, Installment.of(tx(2, 1000, Kind.PAYMENT), LocalDate.of(2026, 11, 2)))
    }
}
