package budget.core

import java.time.LocalDate
import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AutocompleteTest {
    private val t0 = LocalDateTime.of(2026, 11, 1, 12, 0)

    @Test
    fun 초성_검색() {
        assertEquals(0, Autocomplete.matchAt("스타벅스 강남점", "ㅅㅌ"))
        assertEquals(0, Autocomplete.matchAt("스타벅스", "스ㅌ"))
        assertEquals(2, Autocomplete.matchAt("스타벅스", "ㅂㅅ"))
        assertEquals(4, Autocomplete.matchAt("스타벅스 강남점", "강남"))
        assertNull(Autocomplete.matchAt("스타벅스", "ㄱ"))
        assertEquals(0, Autocomplete.matchAt("GS25 역삼점", "gs"))
    }

    @Test
    fun 빈도순_최근순_합치기() {
        val c = Autocomplete.build(
            listOf(
                "편의점" to t0, "스타벅스" to t0, "스타벅스 " to t0.plusDays(1), "다이소" to t0.plusDays(2), "" to t0,
            ),
        )
        assertEquals(listOf("스타벅스", "다이소", "편의점"), c.map { it.text })
        assertEquals(2, c.first().count)
    }

    @Test
    fun 숨긴_값_결제대행사_제외() {
        val c = Autocomplete.build(listOf("다이소" to t0, "편의점" to t0), hidden = setOf("다이소"))
        assertEquals(listOf("편의점"), c.map { it.text })
        val tx = Tx(1, t0, true, 1000, "네이버페이", "네이버페이", null, Source.NAVERPAY, Kind.PAYMENT)
        assertEquals(emptyList(), Autocomplete.merchants(listOf(tx)))
    }

    @Test
    fun 앞부분_일치가_먼저_같은값_제외() {
        val c = Autocomplete.build(listOf("메가커피" to t0, "메가커피" to t0, "커피빈" to t0, "커피" to t0))
        assertEquals(listOf("커피빈", "메가커피"), Autocomplete.suggest(c, "커피").map { it.text })
    }

    @Test
    fun 같은날_같은금액() {
        val d = LocalDate.of(2026, 11, 1)
        val a = Tx(1, t0, true, 5000, "카페", "카페", null, Source.CARD_NOTI, Kind.PAYMENT)
        val b = a.copy(id = 2, cancelled = true)
        val c = a.copy(id = 3, kind = Kind.INCOME)
        val e = a.copy(id = 4, time = t0.plusDays(1))
        assertEquals(listOf(1L), SameDay.find(listOf(a, b, c, e), d, 5000, Kind.PAYMENT).map { it.id })
        assertEquals(listOf(3L), SameDay.find(listOf(a, b, c, e), d, 5000, Kind.INCOME).map { it.id })
    }
}
