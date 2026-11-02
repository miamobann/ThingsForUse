package budget.core

import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ParsersTest {
    private val now = LocalDateTime.of(2026, 11, 2, 9, 0)

    @Test
    fun `현대카드 앱 알림`() {
        val p = HyundaiCardMessageParser.parse(
            "네이버파이낸셜",
            "4,900원 · 일반승인\n홍*동님, 현대 넥슨 승인 일시불, 11/1 10:00\n누적83,960원",
            now,
        )
        assertNotNull(p)
        assertEquals(4900, p.amount)
        assertEquals("네이버파이낸셜", p.merchant)
        assertEquals(LocalDateTime.of(2026, 11, 1, 10, 0), p.time)
        assertEquals(Kind.PAYMENT, p.kind)
    }

    @Test
    fun `현대카드 알림 - 제목 없이 한 덩어리로 와도 가게 이름을 찾는다`() {
        val p = HyundaiCardMessageParser.parse(
            null,
            "카카오T일반택시_0\n11,700원 · 일반승인\n홍*동, 현대 넥슨 승인 일시불, 10/30 1:18\n누적50,260원",
            now,
        )
        assertNotNull(p)
        assertEquals("카카오T일반택시_0", p.merchant)
        assertEquals(11700, p.amount)
        assertEquals(LocalDateTime.of(2026, 10, 30, 1, 18), p.time)
    }

    @Test
    fun `현대카드 취소 알림`() {
        val p = HyundaiCardMessageParser.parse("GS25용인점", "3,800원 · 승인취소\n홍*동님, 현대 넥슨 취소, 10/16 23:59", now)
        assertNotNull(p)
        assertEquals(Kind.CANCEL, p.kind)
    }

    @Test
    fun `현대카드가 아닌 알림은 무시`() {
        assertNull(HyundaiCardMessageParser.parse("카톡", "점심 뭐 먹지", now))
    }

    @Test
    fun `연말 결제를 연초에 처리하면 작년으로 본다`() {
        val p = HyundaiCardMessageParser.parse("GS25", "1,800원 · 일반승인\n현대 넥슨 승인 일시불, 12/31 23:50", LocalDateTime.of(2027, 1, 1, 0, 5))
        assertEquals(2026, p!!.time.year)
    }

    @Test
    fun `네이버페이 결제완료`() {
        val p = NaverPayParser.parse("결제완료", "OPENAI *CHATGPT SUBSCR >\n29,000원 | 10. 15. 15:20 결제", now)
        assertNotNull(p)
        assertEquals("OPENAI *CHATGPT SUBSCR", p.merchant)
        assertEquals(29000, p.amount)
        assertEquals(LocalDateTime.of(2026, 10, 15, 15, 20), p.time)
    }

    @Test
    fun `네이버페이 적립 줄은 금액으로 보지 않는다`() {
        val p = NaverPayParser.parse(null, "결제완료\nGoogle One\n29,000원 | 10. 2. 15:26 결제\n87원 적립 완료", now)
        assertEquals(29000, p!!.amount)
        assertEquals("Google One", p.merchant)
    }

    @Test
    fun `농협 출금 문자`() {
        val p = NhBankSmsParser.parse("[Web발신]\n농협 출금11,700원\n10/31 00:53 352-****-7848-43\n카카오페이 잔액404,500원", now)
        assertNotNull(p)
        assertEquals(11700, p.amount)
        assertEquals("카카오페이", p.merchant)
        assertEquals(Kind.TRANSFER, p.kind)
        assertEquals(LocalDateTime.of(2026, 10, 31, 0, 53), p.time)
    }

    @Test
    fun `농협 입금은 지출이 아닌 입금으로`() {
        assertTrue(NhBankSmsParser.looksLikeNh("농협 입금50,000원"))
        val p = NhBankSmsParser.parse("농협 입금50,000원\n11/01 10:13 352-****-7848-43\n홍길동 잔액1원", now)!!
        assertEquals(Kind.INCOME, p.kind)
        assertEquals("홍길동", p.merchant)
        val t = p.toTx(1, null)
        assertEquals(Categories.INCOME, t.category)
        assertFalse(t.includeInSpending)
    }

    @Test
    fun `가게 이름 다듬기`() {
        assertEquals("주식회사 파이어볼트", Merchants.displayName("토스페이먼츠 - 주식회사 파이어볼트"))
        assertEquals(Merchants.key("08월경기시내버스 0041건"), Merchants.key("09월경기시내버스 0039건"))
        assertTrue(Merchants.isPaymentAgentOnly("네이버파이낸셜"))
        assertTrue(Merchants.isPaymentAgentOnly("NICE_통신판매 - 나이스정보통신(대리점)"))
        assertFalse(Merchants.isPaymentAgentOnly("KCP - 맘스터치 용인천리점"))
        assertEquals("식비", Merchants.suggestCategory("KCP - 맘스터치 용인천리점", Kind.PAYMENT))
        assertEquals("교통", Merchants.suggestCategory("카카오T일반택시_0", Kind.PAYMENT))
        assertNull(Merchants.suggestCategory("네이버파이낸셜", Kind.PAYMENT))
        assertEquals(Categories.TRANSFER, Merchants.suggestCategory("카카오페이", Kind.TRANSFER))
    }
}
