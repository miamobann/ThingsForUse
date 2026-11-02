package budget.core

import java.time.LocalDateTime

private val AMOUNT = Regex("(-?[\\d,]+)\\s*원")
private val SLASH_TIME = Regex("(\\d{1,2})/(\\d{1,2})\\s+(\\d{1,2}):(\\d{2})")
private val DOT_TIME = Regex("(\\d{1,2})\\.\\s*(\\d{1,2})\\.\\s*(\\d{1,2}):(\\d{2})")

internal fun parseAmount(s: String): Long? = s.replace(",", "").trim().toLongOrNull()

/**
 * 알림에는 연도가 없어서, 알림을 받은 시각 기준으로 연도를 붙인다.
 * 12월 결제 알림을 1월에 처리하는 경우처럼 미래가 되면 작년으로 본다.
 */
internal fun resolveTime(month: Int, day: Int, hour: Int, minute: Int, ref: LocalDateTime): LocalDateTime? {
    if (month !in 1..12 || day !in 1..31 || hour !in 0..23 || minute !in 0..59) return null
    return try {
        val t = LocalDateTime.of(ref.year, month, day, hour, minute)
        if (t.isAfter(ref.plusDays(2))) t.minusYears(1) else t
    } catch (e: java.time.DateTimeException) {
        null
    }
}

private fun lines(title: String?, text: String): List<String> =
    (listOfNotNull(title) + text.split("\n")).map { it.trim() }.filter { it.isNotEmpty() }

private fun matchTime(re: Regex, s: String, ref: LocalDateTime): LocalDateTime? {
    val m = re.find(s) ?: return null
    val (mo, d, h, mi) = m.destructured
    return resolveTime(mo.toInt(), d.toInt(), h.toInt(), mi.toInt(), ref)
}

/**
 * 현대카드 앱 알림과 결제 문자.
 *
 * 예 (앱 알림):
 * ```
 * 네이버파이낸셜
 * 4,900원 · 일반승인
 * 홍*동님, 현대 넥슨 승인 일시불, 11/1 10:00
 * 누적83,960원
 * ```
 */
object HyundaiCardMessageParser {
    fun looksLikeCard(text: String): Boolean =
        text.contains("현대") && (text.contains("승인") || text.contains("취소")) && AMOUNT.containsMatchIn(text)

    fun parse(title: String?, text: String, postedAt: LocalDateTime, source: Source = Source.CARD_NOTI): Parsed? {
        val all = lines(title, text)
        val joined = all.joinToString("\n")
        if (!looksLikeCard(joined)) return null

        val amountLine = all.firstOrNull { AMOUNT.containsMatchIn(it) && !it.startsWith("누적") } ?: return null
        val amount = AMOUNT.find(amountLine)?.groupValues?.get(1)?.let(::parseAmount) ?: return null
        if (amount == 0L) return null

        val kind = if (joined.contains("취소")) Kind.CANCEL else Kind.PAYMENT
        val months = Regex("(\\d{1,2})개월").find(joined)?.groupValues?.get(1)?.toInt() ?: 0
        val time = matchTime(SLASH_TIME, joined, postedAt) ?: postedAt

        val merchant = all.firstOrNull { line -> isMerchantLine(line) } ?: return null
        return Parsed(
            source = source,
            kind = if (amount < 0) Kind.CANCEL else kind,
            amount = kotlin.math.abs(amount),
            merchant = merchant,
            time = time,
            installmentMonths = months,
            raw = joined,
        )
    }

    private fun isMerchantLine(line: String): Boolean {
        if (AMOUNT.containsMatchIn(line)) return false
        if (SLASH_TIME.containsMatchIn(line)) return false
        if (line.startsWith("누적") || line.startsWith("[Web발신]") || line == "알림") return false
        if (line.contains("현대카드") || line.contains("현대 ") || line.contains("님")) return false
        if (line.contains("*")) return false // 가려진 이름이나 카드번호
        if (line.contains("승인") && line.length <= 6) return false
        return true
    }
}

/**
 * 네이버페이 결제 알림. 카드 알림에는 "네이버파이낸셜"로만 찍히는 결제의 실제 가게·상품 이름이 들어 있다.
 *
 * 예:
 * ```
 * 결제완료
 * OPENAI *CHATGPT SUBSCR
 * 29,000원 | 10. 15. 15:20 결제
 * ```
 */
object NaverPayParser {
    private val SKIP = listOf("결제완료", "결제 완료", "결제취소", "결제 취소", "네이버페이", "N Pay", "N pay", "Npay")

    fun parse(title: String?, text: String, postedAt: LocalDateTime): Parsed? {
        val all = lines(title, text)
        val joined = all.joinToString("\n")
        if (!joined.contains("결제") && !joined.contains("취소")) return null
        val amountLine = all.firstOrNull { AMOUNT.containsMatchIn(it) && !it.contains("적립") } ?: return null
        val amount = AMOUNT.find(amountLine)?.groupValues?.get(1)?.let(::parseAmount) ?: return null
        if (amount == 0L) return null

        val merchant = all.firstOrNull { line ->
            !AMOUNT.containsMatchIn(line) && SKIP.none { line.equals(it, ignoreCase = true) } &&
                !line.contains("적립") && !DOT_TIME.containsMatchIn(line)
        }?.removeSuffix(">")?.trim() ?: return null

        val cancel = joined.contains("취소")
        return Parsed(
            source = Source.NAVERPAY,
            kind = if (cancel) Kind.CANCEL else Kind.PAYMENT,
            amount = kotlin.math.abs(amount),
            merchant = merchant,
            time = matchTime(DOT_TIME, joined, postedAt) ?: postedAt,
            raw = joined,
        )
    }
}

/**
 * 농협 입출금 문자. 출금만 기록한다(송금).
 *
 * 예:
 * ```
 * 농협 출금11,700원
 * 10/31 00:53 352-****-7848-43
 * 카카오페이 잔액404,500원
 * ```
 */
object NhBankSmsParser {
    private val HEAD = Regex("농협\\s*(출금|입금)\\s*([\\d,]+)\\s*원")
    private val ACCOUNT = Regex("\\d{3}-[\\d*]+-[\\d*]+-\\d{2}")

    fun looksLikeNh(text: String): Boolean = text.contains("농협") && (text.contains("출금") || text.contains("입금"))

    fun parse(text: String, receivedAt: LocalDateTime): Parsed? {
        val m = HEAD.find(text) ?: return null
        if (m.groupValues[1] != "출금") return null
        val amount = parseAmount(m.groupValues[2]) ?: return null
        if (amount == 0L) return null
        val time = matchTime(SLASH_TIME, text, receivedAt) ?: receivedAt

        val afterAccount = ACCOUNT.find(text)?.let { text.substring(it.range.last + 1) } ?: text.substring(m.range.last + 1)
        val counterpart = afterAccount
            .substringBefore("잔액")
            .replace(SLASH_TIME, "")
            .trim()
            .lines().map { it.trim() }.filter { it.isNotEmpty() }
            .joinToString(" ")
            .ifEmpty { "농협 출금" }

        return Parsed(
            source = Source.BANK_SMS,
            kind = Kind.TRANSFER,
            amount = amount,
            merchant = counterpart,
            time = time,
            raw = text.trim(),
        )
    }
}
