package budget.core

import java.time.LocalDateTime
import java.time.YearMonth
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MoneyFlowTest {
    private fun tx(id: Long, amount: Long, kind: Kind, time: LocalDateTime, category: String? = null, name: String = "가게") =
        MoneyFlow.withCategory(Tx(id, time, true, amount, name, name, null, Source.BANK_SMS, kind), category)

    @Test
    fun incomeAfterCutoffCountsNextMonth() {
        val oct31 = tx(1, 800_000, Kind.INCOME, LocalDateTime.of(2026, 10, 31, 9, 0), MoneyFlow.EARNED, "회사")
        val oct24 = tx(2, 50_000, Kind.INCOME, LocalDateTime.of(2026, 10, 24, 9, 0), MoneyFlow.EARNED, "부업")
        val oct25 = tx(3, 10_000, Kind.INCOME, LocalDateTime.of(2026, 10, 25, 9, 0), MoneyFlow.EARNED, "이자")
        val friend = tx(4, 20_000, Kind.INCOME, LocalDateTime.of(2026, 10, 28, 9, 0), MoneyFlow.RETURNED, "홍길동")
        val s = Stats(listOf(oct31, oct24, oct25, friend), true, cutoff = 25)
        assertEquals(50_000, s.income(YearMonth.of(2026, 10)))
        assertEquals(810_000, s.income(YearMonth.of(2026, 11)))
        // 기준일을 끄면(0) 받은 달 그대로
        assertEquals(860_000, Stats(listOf(oct31, oct24, oct25), true, cutoff = 0).income(YearMonth.of(2026, 10)))
    }

    @Test
    fun savingsAndOwnMoveAreNotSpending() {
        val t = LocalDateTime.of(2026, 11, 1, 10, 0)
        val saving = tx(1, 300_000, Kind.TRANSFER, t, MoneyFlow.SAVING, "적금")
        val own = tx(2, 100_000, Kind.TRANSFER, t, MoneyFlow.OWN, "내 토스")
        val lunch = tx(3, 9_000, Kind.PAYMENT, t, "식비")
        val s = Stats(listOf(saving, own, lunch), includeTransfers = true)
        assertEquals(9_000, s.monthTotal(YearMonth.of(2026, 11)))
        assertEquals(300_000, s.savings(YearMonth.of(2026, 11)))
        assertFalse(saving.includeInSpending)
        // 저축에서 송금으로 바꾸면 다시 지출에 들어간다
        assertTrue(MoneyFlow.withCategory(saving, Categories.TRANSFER).includeInSpending)
    }

    @Test
    fun budgetIsIncomeMinusSavings() {
        assertEquals(500_000, MoneyFlow.budget(auto = true, manual = 700_000, income = 800_000, savings = 300_000))
        assertEquals(700_000, MoneyFlow.budget(auto = true, manual = 700_000, income = 0, savings = 300_000))
        assertEquals(700_000, MoneyFlow.budget(auto = false, manual = 700_000, income = 800_000, savings = 300_000))
    }

    @Test
    fun friendNamesDefaultToReturned() {
        assertEquals(MoneyFlow.RETURNED, Merchants.suggestCategory("홍길동", Kind.INCOME))
        assertEquals(null, Merchants.suggestCategory("(주)컴퍼니급여", Kind.INCOME))
        assertEquals(null, Merchants.suggestCategory("농협이자", Kind.INCOME))
        assertEquals("in:홍길동", MoneyFlow.ruleKey("홍길동", Kind.INCOME))
        assertEquals("홍길동", MoneyFlow.ruleKey("홍길동", Kind.TRANSFER))
    }

    @Test
    fun newIncomeIsOutOfSpending() {
        val p = Parsed(Source.BANK_SMS, Kind.INCOME, 20_000, "홍길동", LocalDateTime.of(2026, 11, 1, 10, 0))
        val t = p.toTx(0, Merchants.suggestCategory(p.merchant, p.kind))
        assertEquals(MoneyFlow.RETURNED, t.category)
        assertFalse(t.includeInSpending)
        val save = Parsed(Source.BANK_SMS, Kind.TRANSFER, 300_000, "적금", LocalDateTime.of(2026, 11, 1, 10, 0)).toTx(0, MoneyFlow.SAVING)
        assertFalse(save.includeInSpending)
    }
}

class RulesTest {
    @Test
    fun learnsAmountSpecificRules() {
        val seen = listOf(
            Rules.Seen("치지직", Kind.PAYMENT, 4_900, "구독"),
            Rules.Seen("치지직", Kind.PAYMENT, 4_900, "구독"),
            Rules.Seen("치지직", Kind.PAYMENT, 10_000, "후원"),
            Rules.Seen("치지직", Kind.PAYMENT, 3_000, "후원"),
            Rules.Seen("치지직", Kind.PAYMENT, 5_000, "후원"),
            Rules.Seen("네이버파이낸셜", Kind.PAYMENT, 1_000, "쇼핑"),
        )
        val r = Rules.learn(seen)
        assertEquals("후원", r["치지직"])
        assertEquals("구독", r["치지직@4900"])
        assertEquals(2, r.size)
        assertEquals(listOf("치지직@4900", "치지직"), Rules.lookupKeys("치지직", Kind.PAYMENT, 4_900))
    }
}
