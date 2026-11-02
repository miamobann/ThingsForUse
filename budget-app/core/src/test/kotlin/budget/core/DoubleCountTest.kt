package budget.core

import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** 같은 돈이 두 번 잡히기 쉬운 경우들 */
class DoubleCountTest {
    private val t = LocalDateTime.of(2026, 11, 2, 10, 0)

    private fun tx(id: Long, p: Parsed) = p.toTx(id, null)

    @Test
    fun cardBillFromBankIsNotSpending() {
        val p = NhBankSmsParser.parse("농협 출금412,000원\n11/14 06:00 352-****-7848-43\n현대카드 잔액10,000원", t)!!
        val x = p.toTx(1, Merchants.suggestCategory(p.merchant, p.kind))
        assertEquals(Categories.CARD_BILL, x.category)
        assertFalse(x.includeInSpending)
    }

    @Test
    fun atmWithdrawalIsNotSpending() {
        val p = NhBankSmsParser.parse("농협 출금50,000원\n11/02 10:00 352-****-7848-43\nATM출금 잔액10,000원", t)!!
        assertFalse(p.toTx(1, null).includeInSpending)
    }

    @Test
    fun friendTransferStaysSpending() {
        val p = NhBankSmsParser.parse("농협 출금11,700원\n10/31 00:53 352-****-7848-43\n카카오페이 잔액404,500원", t)!!
        val x = p.toTx(1, Merchants.suggestCategory(p.merchant, p.kind))
        assertTrue(x.includeInSpending)
        assertEquals(Categories.TRANSFER, x.category)
    }

    @Test
    fun taxiPreAuthorizationIsNotSpending() {
        val p = HyundaiCardMessageParser.parse("카카오T택시_가승인", "11,900원 · 일반승인\n현대 넥슨 승인 일시불, 10/30 1:07", t)!!
        assertFalse(p.toTx(1, null).includeInSpending)
    }

    @Test
    fun naverPayWithPointsMergesWithSmallerCardCharge() {
        // 카드 7,000원 먼저, 네이버페이 총액 10,000원(포인트 3,000원) 나중
        val card = HyundaiCardMessageParser.parse("네이버파이낸셜", "7,000원 · 일반승인\n현대 넥슨 승인 일시불, 11/2 10:00", t)!!
        val np = NaverPayParser.parse("결제완료", "어떤 가게\n10,000원 | 11. 2. 10:00 결제", t)!!
        assertIs<Matcher.Decision.AttachNaverPay>(Matcher.decide(np, listOf(tx(1, card))))

        // 순서가 반대여도 한 건, 금액은 실제 카드 금액
        val d = Matcher.decide(card, listOf(tx(1, np)))
        assertIs<Matcher.Decision.AttachCard>(d)
        assertEquals(7000, d.amount)
    }

    @Test
    fun foreignPaymentWithDifferentBilledAmountIsSameCharge() {
        val noti = HyundaiCardMessageParser.parse("kuro games", "12,000원 · 해외승인\n현대 넥슨 승인 일시불, 10/5 13:00", LocalDateTime.of(2026, 10, 5, 13, 0))!!
        val fileRow = Parsed(Source.CARD_FILE, Kind.PAYMENT, 12_261, "kuro games,KRW:12000.00", LocalDateTime.of(2026, 10, 5, 12, 0), timeKnown = false)
        val d = Matcher.decide(fileRow, listOf(tx(1, noti)))
        assertIs<Matcher.Decision.Duplicate>(d)
        assertEquals(12_261, d.amount)
    }

    @Test
    fun twoDifferentPurchasesSameShopSameDayStaySeparate() {
        val a = HyundaiCardMessageParser.parse("GS25용인점", "3,800원 · 일반승인\n현대 넥슨 승인 일시불, 11/2 09:00", t)!!
        val b = HyundaiCardMessageParser.parse("GS25용인점", "3,600원 · 일반승인\n현대 넥슨 승인 일시불, 11/2 18:00", t)!!
        assertEquals(Matcher.Decision.Insert, Matcher.decide(b, listOf(tx(1, a))))
    }

    private fun card(merchant: String, amount: Long, time: LocalDateTime, source: Source = Source.CARD_NOTI, timeKnown: Boolean = true) =
        Parsed(source, Kind.PAYMENT, amount, merchant, time, timeKnown = timeKnown)

    private fun np(merchant: String, amount: Long, time: LocalDateTime) = Parsed(Source.NAVERPAY, Kind.PAYMENT, amount, merchant, time)

    @Test
    fun naverPayMergesWhenCardShowsPgName() {
        val c = tx(1, card("이니시스 - 주식회사 팬딩", 33_000, t))
        val d = Matcher.decide(np("스텔라이브 스토어", 33_000, t.plusMinutes(1)), listOf(c))
        assertIs<Matcher.Decision.AttachNaverPay>(d)
        // 반대 순서
        val n = tx(2, np("ChatGPT Plus", 29_000, t))
        assertIs<Matcher.Decision.AttachCard>(Matcher.decide(card("NICE_통신판매 - 나이스정보통신(대리점)", 29_000, t), listOf(n)))
    }

    @Test
    fun naverPayWithoutShippingStillMerges() {
        val c = tx(1, card("네이버파이낸셜", 23_000, t))
        assertIs<Matcher.Decision.AttachNaverPay>(Matcher.decide(np("굿즈 세트", 20_000, t), listOf(c)))
        val n = tx(2, np("굿즈 세트", 20_000, t))
        val d = Matcher.decide(card("네이버파이낸셜", 23_000, t.plusMinutes(1)), listOf(n))
        assertIs<Matcher.Decision.AttachCard>(d)
        assertEquals(23_000, d.amount)
    }

    @Test
    fun unrelatedCardPaymentIsNotMergedByShippingRule() {
        // PG 이름 카드 결제와 2분 넘게 떨어진 네이버페이 알림은 따로
        val c = tx(1, card("GS25용인점", 5_000, t))
        assertIs<Matcher.Decision.Insert>(Matcher.decide(np("책", 3_000, t.plusMinutes(2)), listOf(c)))
    }

    @Test
    fun splitNaverPayOrderJoinsLinkedCard() {
        val c = tx(1, card("네이버파이낸셜", 30_000, t)).copy(linkedNaverPay = true)
        assertIs<Matcher.Decision.Duplicate>(Matcher.decide(np("상품 B", 12_000, t.plusMinutes(1)), listOf(c)))
    }

    @Test
    fun taxiStatementMatchesNotification() {
        val n = tx(1, card("카카오T일반택시_0", 11_700, t))
        val d = Matcher.decide(card("택시-경기 65 바 6509", 11_700, t.toLocalDate().atStartOfDay(), Source.CARD_FILE, timeKnown = false), listOf(n))
        assertIs<Matcher.Decision.Duplicate>(d)
    }
}
