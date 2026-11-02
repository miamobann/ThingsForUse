package budget.core

import java.time.LocalDate
import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RecurringAndCsvTest {
    private val today = LocalDate.of(2026, 11, 20)
    private var id = 0L

    private fun pay(merchant: String, amount: Long, y: Int, m: Int, d: Int, kind: Kind = Kind.PAYMENT) = Tx(
        ++id, LocalDateTime.of(y, m, d, 10, 0), true, amount, merchant, merchant, "구독", Source.CARD_NOTI, kind,
    )

    @Test
    fun monthlySubscriptionIsFound() {
        val txs = listOf(
            pay("메타크래프트", 14_900, 2026, 8, 5), pay("메타크래프트", 14_900, 2026, 9, 5),
            pay("메타크래프트", 14_900, 2026, 10, 6), pay("메타크래프트", 14_900, 2026, 11, 5),
            pay("Google One", 2_400, 2026, 9, 25), pay("Google One", 2_400, 2026, 10, 25),
        )
        val r = RecurringFinder.find(txs, today)
        assertEquals(2, r.size)
        val meta = r.first { it.merchant == "메타크래프트" }
        assertTrue(meta.paidThisMonth)
        val g = r.first { it.merchant == "Google One" }
        assertFalse(g.paidThisMonth)
        assertEquals(25, g.day)
        assertEquals(2_400, RecurringFinder.remaining(r))
        assertEquals("Google One", r.first().merchant) // 안 나간 것 먼저
    }

    @Test
    fun frequentOrIrregularIsNotFixed() {
        val txs = listOf(
            // 같은 값의 커피를 한 달에 여러 번
            pay("스타벅스", 4_500, 2026, 9, 1), pay("스타벅스", 4_500, 2026, 9, 8),
            pay("스타벅스", 4_500, 2026, 10, 1), pay("스타벅스", 4_500, 2026, 10, 9),
            // 금액이 매번 크게 다름
            pay("이마트", 30_000, 2026, 9, 3), pay("이마트", 55_000, 2026, 10, 3),
            // 한 번뿐
            pay("넷플릭스", 13_500, 2026, 10, 1),
            // 두 달 전에 끊긴 것
            pay("헬스장", 50_000, 2026, 7, 1), pay("헬스장", 50_000, 2026, 8, 1),
        )
        assertTrue(RecurringFinder.find(txs, today).isEmpty())
        // 빼기로 한 가게
        val sub = listOf(pay("멜론", 10_900, 2026, 9, 2), pay("멜론", 10_900, 2026, 10, 2))
        assertEquals(1, RecurringFinder.find(sub, today).size)
        assertTrue(RecurringFinder.find(sub, today, hidden = setOf(Merchants.key("멜론"))).isEmpty())
    }

    @Test
    fun readsAppCsv() {
        val csv = "﻿id,날짜,시각,금액,가게명,원래가게명,카테고리,결제수단,할부,송금여부,지출포함여부,취소됨,메모,출처\r\n" +
            "1,2026-10-15,15:20,29000,ChatGPT,\"NICE_통신판매 - 나이스정보통신(대리점)\",구독,현대카드,,N,Y,N,,카드 알림\r\n" +
            "2,2026-10-16,,120000,맥북 케이스,케이스몰,쇼핑,현대카드,3,N,Y,N,\"메모, 쉼표\",카드 파일\r\n" +
            "3,2026-10-17,09:00,-15000,홍길동,홍길동,입금,농협,,N,N,N,더치페이,농협 문자\r\n" +
            "4,2026-10-18,12:00,-3800,GS25,GS25,식비,현대카드,,N,Y,N,,카드 알림\r\n" +
            "5,2026-10-19,13:00,11700,카카오페이,카카오페이,송금,농협,,Y,Y,N,,농협 문자\r\n" +
            "6,날짜아님,,1000,x,x,,,,,,,,\r\n"
        val r = AppCsv.parse(csv)
        assertEquals(5, r.rows.size)
        assertEquals(1, r.skipped)
        val (a, b, c, d, e) = r.rows
        assertEquals("ChatGPT", a.merchant)
        assertEquals("NICE_통신판매 - 나이스정보통신(대리점)", a.parsed.merchant)
        assertEquals(Source.CARD_NOTI, a.parsed.source)
        assertEquals(LocalDateTime.of(2026, 10, 15, 15, 20), a.parsed.time)
        assertFalse(b.parsed.timeKnown)
        assertEquals(3, b.parsed.installmentMonths)
        assertEquals("메모, 쉼표", b.memo)
        assertEquals(Kind.INCOME, c.parsed.kind)
        assertEquals(null, c.category) // 예전 '입금' 카테고리는 구분 안 한 입금으로
        assertFalse(c.includeInSpending)
        assertEquals(15_000, c.parsed.amount)
        assertEquals(Kind.CANCEL, d.parsed.kind)
        assertEquals(Kind.TRANSFER, e.parsed.kind)
    }
}

class AppCsvFlowColumnsTest {
    @Test
    fun readsKindAndOffsetColumns() {
        val csv = "id,날짜,시각,금액,가게명,원래가게명,카테고리,결제수단,할부,송금여부,지출포함여부,취소됨,메모,출처,종류,상계대상,귀속월\n" +
            "10,2026-10-10,19:00,60000,고깃집,고깃집,식비,현대카드,,N,Y,N,,카드 알림,결제,,2026-10\n" +
            "11,2026-10-11,09:00,-20000,홍길동,홍길동,돌려받은 돈,농협,,N,N,N,,농협 문자,입금,10,2026-10\n" +
            "12,2026-10-31,09:00,-800000,회사,회사,수입,농협,,N,N,N,,농협 문자,입금,,2026-11\n" +
            "13,2026-11-01,09:00,300000,적금,적금,저축,농협,,Y,N,N,,농협 문자,출금,,2026-11\n"
        val (pay, back, salary, saving) = AppCsv.parse(csv).rows
        assertEquals(10L, pay.fileId)
        assertEquals(Kind.INCOME, back.parsed.kind)
        assertEquals(10L, back.offsetTarget)
        assertEquals(MoneyFlow.EARNED, salary.category)
        assertEquals(Kind.TRANSFER, saving.parsed.kind)
        assertFalse(saving.includeInSpending)
    }
}

class DuplicateCheckTest {
    private fun tx(id: Long, amount: Long, h: Int, m: Int, source: Source, timeKnown: Boolean = true, approval: String? = null) = Tx(
        id, java.time.LocalDateTime.of(2026, 11, 2, h, m), timeKnown, amount, "가게$id", "가게$id", null, source, Kind.PAYMENT,
        approvalNo = approval,
    )

    @Test
    fun findsCrossSourcePairsOnly() {
        val txs = listOf(
            tx(1, 5_000, 10, 0, Source.CARD_NOTI), tx(2, 5_000, 10, 6, Source.MANUAL),        // 다른 출처 6분 → 의심
            tx(3, 1_500, 8, 0, Source.CARD_FILE, false), tx(4, 1_500, 18, 0, Source.CARD_FILE, false), // 같은 파일 같은 날 → 아님
            tx(5, 9_000, 12, 0, Source.CARD_NOTI), tx(6, 9_000, 12, 1, Source.CARD_NOTI),      // 같은 출처 1분 → 의심
            tx(7, 9_000, 15, 0, Source.CARD_NOTI),                                              // 3시간 뒤 같은 금액 → 아님
            tx(8, 2_000, 9, 0, Source.CARD_FILE, false), tx(9, 2_000, 21, 0, Source.NAVERPAY), // 날짜만 있는 파일 vs 알림 같은 날 → 의심
            tx(10, 7_000, 9, 0, Source.CARD_FILE, approval = "1"), tx(11, 7_000, 9, 0, Source.CARD_NOTI, approval = "2"), // 승인번호 다름
        )
        val keys = DuplicateCheck.suspects(txs).map { it.key }.toSet()
        assertEquals(setOf("1-2", "5-6", "8-9"), keys)
        assertEquals(setOf("1-2", "8-9"), DuplicateCheck.suspects(txs, dismissed = setOf("5-6")).map { it.key }.toSet())
    }
}
