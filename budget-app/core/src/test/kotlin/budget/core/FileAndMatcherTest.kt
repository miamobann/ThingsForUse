package budget.core

import java.time.LocalDateTime
import java.time.YearMonth
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class FileAndMatcherTest {

    // 실제 파일과 같은 모양의 예시 (닫는 태그에 공백이 들어간 것까지 그대로)
    private val statement = """
        <html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /></head><body>
        <table><tr><td>2026년 01월 이용대금명세서</td></tr></table>
        <table border="1">
        <tr><th>이용일</th><th>이용카드</th><th>이용가맹점</th><th>이용금액</th><th>할부/회차</th><th>적립/할인율(%)</th><th>예상적립/할인</th><th>결제원금</th><th>결제후잔액</th><th>수수료(이자)</th></tr>
        <tr>
            <td align="center">2025년 12월 21일</td>
            <td>본인 넥슨현대카드</td>
            <td>토스페이먼츠 - 주식회사 파이어볼트</td   >
            <td align="right">25,320</td>
            <td align="center" style='mso-number-format:"\@";'>
            </td>
            <td align="center">0%</td><td>0</td><td>0</td><td>0</td><td>0</td>
        </tr>
        <tr>
            <td align="center">2025년 12월 21일</td><td>본인 넥슨현대카드</td>
            <td>토스페이먼츠 - 주식회사 파이어볼트</td   ><td align="right">-25,320</td><td></td>
            <td>0%</td><td>0</td><td>0</td><td>0</td><td>0</td>
        </tr>
        <tr>
            <td>2025년 12월 28일</td><td>본인 넥슨현대카드</td><td>엣더코인노래연습장</td><td>1,000</td><td></td>
            <td>2.0%</td><td>20</td><td>1,000</td><td>0</td><td>0</td>
        </tr>
        <tr>
            <td>2025년 12월 28일</td><td>본인 넥슨현대카드</td><td>엣더코인노래연습장</td><td>1,000</td><td></td>
            <td>2.0%</td><td>20</td><td>1,000</td><td>0</td><td>0</td>
        </tr>
        <tr><td>2025년 12월 30일</td><td>본인</td><td>가전매장</td><td>300,000</td><td>3/2</td><td>0%</td><td>0</td><td>100,000</td><td>100,000</td><td>0</td></tr>
        <tr><td>-</td><td></td><td>총 합계 5 건</td><td>0</td><td></td><td></td></tr>
        </table></body></html>
    """.trimIndent()

    private val realtime = """
        <table><tr><td>실시간 이용내역</td></tr></table>
        <table>
        <tr><th>승인일</th><th>승인시각</th><th>카드구분</th><th>카드종류</th><th>가맹점명</th><th>승인금액</th><th>이용구분</th><th>할부개월</th><th>승인번호</th><th>취소일</th><th>승인구분</th></tr>
        <tr><td>2026년 10월 30일</td><td>01:18</td><td> 본인 </td><td>5***-****-****-971*</td><td>카카오T일반택시_0</td><td>11,700</td><td> 일시불 </td><td>0</td><td>00752030</td><td>-</td><td> 전표접수 </td></tr>
        <tr><td>2026년 10월 30일</td><td>01:07</td><td>본인</td><td>5***</td><td>카카오T택시_가승인</td><td>11,900</td><td>일시불</td><td>0</td><td>00092219</td><td>2026년 10월 30일</td><td>취소</td></tr>
        <tr><td>2026년 10월 15일</td><td>15:19</td><td>본인</td><td>5***</td><td>ChatGPT_NICE_구 - 나이스정보통신(대리점)</td><td>29,000</td><td>일시불</td><td>0</td><td>11111111</td><td>-</td><td>전표접수</td></tr>
        <tr><td>-</td><td></td><td></td><td></td><td>총 합계 소계 3건</td><td>52,600</td></tr>
        </table>
    """.trimIndent()

    private var nextId = 1L

    /** 앱의 저장 과정을 흉내 내서 결정대로 목록을 바꾼다 */
    private fun apply(list: MutableList<Tx>, p: Parsed, consumed: MutableSet<Long>? = null): Matcher.Decision {
        val d = Matcher.decide(p, list, consumed ?: emptySet())
        when (d) {
            Matcher.Decision.Insert -> {
                val t = Tx(
                    nextId++, p.time, p.timeKnown, p.amount, p.merchant, p.merchant,
                    Merchants.suggestCategory(p.merchant, p.kind), p.source, p.kind,
                    approvalNo = p.approvalNo, raw = p.raw,
                )
                list += t
                consumed?.add(t.id)
            }
            is Matcher.Decision.Duplicate -> {
                consumed?.add(d.existing.id)
                if (d.approvalNo != null && d.existing.approvalNo == null) {
                    list.replaceAll { if (it.id == d.existing.id) it.copy(approvalNo = d.approvalNo) else it }
                }
            }
            is Matcher.Decision.AttachNaverPay ->
                list.replaceAll { if (it.id == d.existing.id) it.copy(merchant = d.merchant, linkedNaverPay = true) else it }
            is Matcher.Decision.AttachCard ->
                list.replaceAll { if (it.id == d.existing.id) it.copy(originalMerchant = d.cardMerchant, linkedNaverPay = true, approvalNo = d.approvalNo) else it }
            is Matcher.Decision.Cancel -> list.replaceAll { if (it.id == d.target.id) it.copy(cancelled = true) else it }
            Matcher.Decision.Ignore -> Unit
        }
        return d
    }

    private fun importFile(list: MutableList<Tx>, rows: List<Parsed>) {
        val consumed = mutableSetOf<Long>()
        rows.forEach { apply(list, it, consumed) }
    }

    @Test
    fun `명세서 읽기 - 취소는 음수, 할부 2회차 이후는 건너뜀`() {
        val r = HyundaiCardFileParser.parse(statement)!!
        assertEquals(HyundaiCardFileParser.FileType.STATEMENT, r.type)
        assertEquals(4, r.rows.size)
        assertEquals(Kind.CANCEL, r.rows[1].kind)
        assertEquals(false, r.rows[0].timeKnown)
    }

    @Test
    fun `명세서 가져오기 - 결제와 취소가 상계되고, 같은 날 같은 금액 두 건은 둘 다 남는다`() {
        val list = mutableListOf<Tx>()
        importFile(list, HyundaiCardFileParser.parse(statement)!!.rows)
        assertEquals(3, list.size)
        assertTrue(list.first { it.amount == 25320L }.cancelled)
        assertEquals(2, list.count { it.merchant == "엣더코인노래연습장" })

        // 같은 파일을 또 올려도 늘어나지 않는다
        importFile(list, HyundaiCardFileParser.parse(statement)!!.rows)
        assertEquals(3, list.size)
    }

    @Test
    fun `실시간 내역 - 가승인 취소는 무시, 승인번호로 중복 제거`() {
        val r = HyundaiCardFileParser.parse(realtime)!!
        assertEquals(HyundaiCardFileParser.FileType.REALTIME, r.type)
        assertTrue(r.rows[1].cancelled)
        val list = mutableListOf<Tx>()
        importFile(list, r.rows)
        assertEquals(2, list.size)
        importFile(list, HyundaiCardFileParser.parse(realtime)!!.rows)
        assertEquals(2, list.size)
    }

    @Test
    fun `카드 알림 + 문자 + 파일이 와도 한 건`() {
        val list = mutableListOf<Tx>()
        val noti = HyundaiCardMessageParser.parse("카카오T일반택시_0", "11,700원 · 일반승인\n현대 넥슨 승인 일시불, 10/30 1:18", LocalDateTime.of(2026, 10, 30, 1, 18))!!
        apply(list, noti)
        apply(list, noti.copy(source = Source.CARD_SMS, raw = "문자"))
        importFile(list, HyundaiCardFileParser.parse(realtime)!!.rows)
        assertEquals(2, list.size) // 택시 1건 + ChatGPT 1건
        assertEquals("00752030", list.first { it.amount == 11700L }.approvalNo)
    }

    @Test
    fun `네이버페이 알림이 카드 결제에 실제 가게 이름을 붙인다`() {
        val list = mutableListOf<Tx>()
        apply(list, HyundaiCardMessageParser.parse("네이버파이낸셜", "4,900원 · 일반승인\n현대 넥슨 승인 일시불, 10/8 9:22", LocalDateTime.of(2026, 10, 8, 9, 22))!!)
        val d = apply(list, NaverPayParser.parse("결제완료", "아야츠노 유니 1개월 아루냥 정기구독 >\n4,900원 | 10. 8. 09:22 결제", LocalDateTime.of(2026, 10, 8, 9, 23))!!)
        assertIs<Matcher.Decision.AttachNaverPay>(d)
        assertEquals(1, list.size)
        assertEquals("아야츠노 유니 1개월 아루냥 정기구독", list[0].merchant)
        assertEquals("네이버파이낸셜", list[0].originalMerchant)
    }

    @Test
    fun `네이버페이가 먼저 오고 카드가 나중에 와도 한 건`() {
        val list = mutableListOf<Tx>()
        apply(list, NaverPayParser.parse("결제완료", "Google One\n29,000원 | 10. 2. 15:26 결제", LocalDateTime.of(2026, 10, 2, 15, 26))!!)
        val d = apply(list, HyundaiCardMessageParser.parse("네이버페이_구글 - NHNKCP", "29,000원 · 일반승인\n현대 넥슨 승인 일시불, 10/2 15:26", LocalDateTime.of(2026, 10, 2, 15, 27))!!)
        assertIs<Matcher.Decision.AttachCard>(d)
        assertEquals(1, list.size)
        assertEquals("Google One", list[0].merchant)
    }

    @Test
    fun `포인트로만 낸 네이버페이 결제는 따로 기록`() {
        val list = mutableListOf<Tx>()
        apply(list, NaverPayParser.parse("결제완료", "시즈키 토아 1개월 팬 정기구독\n4,900원 | 10. 17. 16:59 결제", LocalDateTime.of(2026, 10, 17, 17, 0))!!)
        assertEquals(1, list.size)
        assertEquals(Source.NAVERPAY, list[0].source)
    }

    @Test
    fun `카드 취소 알림은 원래 결제를 취소 처리`() {
        val list = mutableListOf<Tx>()
        apply(list, HyundaiCardMessageParser.parse("GS25용인점", "3,800원 · 일반승인\n현대 넥슨 승인 일시불, 10/16 23:59", LocalDateTime.of(2026, 10, 16, 23, 59))!!)
        val d = apply(list, HyundaiCardMessageParser.parse("GS25용인점", "3,800원 · 승인취소\n현대 넥슨 취소, 10/17 10:00", LocalDateTime.of(2026, 10, 17, 10, 0))!!)
        assertIs<Matcher.Decision.Cancel>(d)
        assertTrue(list[0].cancelled)
    }

    @Test
    fun `통계 - 취소는 빠지고 송금은 설정에 따라`() {
        val t = LocalDateTime.of(2026, 10, 5, 12, 0)
        val txs = listOf(
            Tx(1, t, true, 10000, "가게", "가게", "식비", Source.CARD_NOTI, Kind.PAYMENT),
            Tx(2, t, true, 5000, "취소된 가게", "취소된 가게", "쇼핑", Source.CARD_NOTI, Kind.PAYMENT, cancelled = true),
            Tx(3, t, true, 20000, "카카오페이", "카카오페이", "송금", Source.BANK_SMS, Kind.TRANSFER),
            Tx(4, t, true, 7000, "친구 이체", "친구 이체", "송금", Source.BANK_SMS, Kind.TRANSFER, includeInSpending = false),
            Tx(5, t.plusMonths(-1), true, 9000, "지난달", "지난달", "식비", Source.CARD_NOTI, Kind.PAYMENT),
        )
        val ym = YearMonth.of(2026, 10)
        assertEquals(30000, Stats(txs, includeTransfers = true).monthTotal(ym))
        assertEquals(10000, Stats(txs, includeTransfers = false).monthTotal(ym))
        assertEquals(listOf("송금" to 20000L, "식비" to 10000L), Stats(txs, true).byCategory(ym))
        assertEquals(9000, Stats(txs, true).monthTotal(ym.minusMonths(1)))

        val b = BudgetStatus.of(500_000, 431_200, java.time.LocalDate.of(2026, 10, 27))
        assertEquals(5, b.daysLeft)
        assertEquals(68_800, b.remaining)
        assertEquals(80, BudgetAlert.due(500_000, 431_200, emptySet()))
        assertEquals(null, BudgetAlert.due(500_000, 431_200, setOf(80)))
        assertEquals(100, BudgetAlert.due(500_000, 510_000, setOf(80)))
    }
}
