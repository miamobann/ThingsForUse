package budget.core

import java.time.LocalDateTime

/**
 * 현대카드 홈페이지에서 받은 .xls 파일. 이름은 .xls지만 실제로는 HTML 표다.
 * 두 종류를 읽는다.
 * - 월 이용대금명세서: 이용일 · 이용카드 · 이용가맹점 · 이용금액 · 할부/회차 …  (시각 없음, 취소는 음수)
 * - 실시간 이용내역: 승인일 · 승인시각 · … · 가맹점명 · 승인금액 · 이용구분 · 할부개월 · 승인번호 · 취소일 · 승인구분
 */
object HyundaiCardFileParser {

    enum class FileType(val label: String) { STATEMENT("이용대금명세서"), REALTIME("실시간 이용내역") }

    data class Result(val type: FileType, val title: String, val rows: List<Parsed>)

    private val ROW = Regex("<tr[^>]*>(.*?)</tr\\s*>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
    private val CELL = Regex("<t[dh][^>]*>(.*?)</t[dh]\\s*>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
    private val DATE = Regex("(\\d{4})년\\s*(\\d{1,2})월\\s*(\\d{1,2})일")
    private val HM = Regex("(\\d{1,2}):(\\d{2})")

    private fun clean(cell: String): String =
        cell.replace(Regex("<[^>]*>"), "")
            .replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", "\"").replace("&#39;", "'")
            .replace(Regex("\\s+"), " ").trim()

    /** 표를 읽지 못하면 null */
    fun parse(html: String): Result? {
        val table = ROW.findAll(html).map { r -> CELL.findAll(r.groupValues[1]).map { clean(it.groupValues[1]) }.toList() }.toList()
        val header = table.firstOrNull { row -> row.any { it == "승인번호" } || row.any { it == "이용가맹점" } } ?: return null
        val title = table.firstOrNull()?.firstOrNull().orEmpty()
        return if (header.contains("승인번호")) {
            Result(FileType.REALTIME, title, table.mapNotNull { realtimeRow(it, header) })
        } else {
            Result(FileType.STATEMENT, title, table.mapNotNull { statementRow(it, header) })
        }
    }

    private fun date(s: String): Triple<Int, Int, Int>? {
        val m = DATE.find(s) ?: return null
        return Triple(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt())
    }

    private fun col(header: List<String>, vararg names: String): Int =
        names.firstNotNullOfOrNull { n -> header.indexOf(n).takeIf { it >= 0 } } ?: -1

    private fun statementRow(c: List<String>, header: List<String>): Parsed? {
        val iDate = col(header, "이용일")
        val iMerchant = col(header, "이용가맹점")
        val iAmount = col(header, "이용금액")
        val iInst = col(header, "할부/회차")
        if (iDate < 0 || iMerchant < 0 || iAmount < 0 || c.size <= iAmount) return null
        val (y, mo, d) = date(c[iDate]) ?: return null
        val amount = parseAmount(c[iAmount]) ?: return null
        if (amount == 0L) return null
        // 할부는 첫 회차에만 전체 금액으로 기록한다 ("3/2"처럼 2회차 이후는 건너뜀)
        val inst = c.getOrNull(iInst).orEmpty()
        val instMatch = Regex("(\\d+)\\s*/\\s*(\\d+)").find(inst)
        if (instMatch != null && instMatch.groupValues[2].toInt() > 1) return null
        val merchant = c[iMerchant].ifEmpty { return null }
        return Parsed(
            source = Source.CARD_FILE,
            kind = if (amount < 0) Kind.CANCEL else Kind.PAYMENT,
            amount = kotlin.math.abs(amount),
            merchant = merchant,
            time = LocalDateTime.of(y, mo, d, 12, 0),
            timeKnown = false,
            installmentMonths = instMatch?.groupValues?.get(1)?.toInt() ?: 0,
            raw = c.joinToString(" | "),
        )
    }

    private fun realtimeRow(c: List<String>, header: List<String>): Parsed? {
        val iDate = col(header, "승인일")
        val iTime = col(header, "승인시각")
        val iMerchant = col(header, "가맹점명")
        val iAmount = col(header, "승인금액")
        val iMonths = col(header, "할부개월")
        val iApproval = col(header, "승인번호")
        val iCancelDate = col(header, "취소일")
        val iStatus = col(header, "승인구분")
        if (iDate < 0 || iMerchant < 0 || iAmount < 0 || c.size <= iAmount) return null
        val (y, mo, d) = date(c[iDate]) ?: return null
        val amount = parseAmount(c[iAmount]) ?: return null
        if (amount == 0L) return null
        val hm = c.getOrNull(iTime)?.let { HM.find(it) }
        val time = LocalDateTime.of(y, mo, d, hm?.groupValues?.get(1)?.toInt() ?: 12, hm?.groupValues?.get(2)?.toInt() ?: 0)
        val status = c.getOrNull(iStatus).orEmpty()
        val cancelDate = c.getOrNull(iCancelDate).orEmpty()
        val cancelled = status.contains("취소") || DATE.containsMatchIn(cancelDate)
        return Parsed(
            source = Source.CARD_FILE,
            kind = if (amount < 0) Kind.CANCEL else Kind.PAYMENT,
            amount = kotlin.math.abs(amount),
            merchant = c[iMerchant].ifEmpty { return null },
            time = time,
            timeKnown = hm != null,
            installmentMonths = c.getOrNull(iMonths)?.toIntOrNull() ?: 0,
            approvalNo = c.getOrNull(iApproval)?.takeIf { it.isNotBlank() && it != "-" },
            cancelled = cancelled,
            raw = c.joinToString(" | "),
        )
    }
}
