package budget.core

import java.time.LocalDate
import java.time.LocalTime

/**
 * 앱이 내보내는 '가계부_내역_전체.csv'와 같은 열의 파일을 읽는다.
 * 분석 프로그램에서 정리한 기존 내역을 앱에 처음 넣을 때 쓴다.
 *
 * 열: id, 날짜, 시각, 금액, 가게명, 원래가게명, 카테고리, 결제수단, 할부, 송금여부, 지출포함여부, 취소됨, 메모, 출처
 * 금액이 음수면 환불(카테고리가 '입금'이면 입금), 송금여부=Y면 송금.
 */
object AppCsv {

    data class Row(
        val parsed: Parsed,
        /** 화면에 보일 가게 이름 */
        val merchant: String,
        val category: String?,
        val includeInSpending: Boolean,
        val memo: String,
    )

    data class Result(val rows: List<Row>, val skipped: Int)

    fun parse(text: String): Result {
        val lines = records(text.removePrefix("﻿"))
        if (lines.isEmpty()) return Result(emptyList(), 0)
        val header = lines.first().map { it.trim() }
        fun col(name: String) = header.indexOf(name)
        val iDate = col("날짜")
        val iAmount = col("금액")
        require(iDate >= 0 && iAmount >= 0 && (col("가게명") >= 0 || col("원래가게명") >= 0)) {
            "가계부 CSV 형식이 아니에요 (날짜·금액·가게명 열이 필요해요)"
        }
        val iTime = col("시각")
        val iName = col("가게명")
        val iOrig = col("원래가게명")
        val iCat = col("카테고리")
        val iInst = col("할부")
        val iTransfer = col("송금여부")
        val iInclude = col("지출포함여부")
        val iCancel = col("취소됨")
        val iMemo = col("메모")
        val iSource = col("출처")

        var skipped = 0
        val rows = lines.drop(1).mapNotNull { r ->
            fun get(i: Int) = if (i in r.indices) r[i].trim() else ""
            val date = runCatching { LocalDate.parse(get(iDate).replace('.', '-').replace('/', '-')) }.getOrNull()
            val signed = get(iAmount).replace(",", "").replace("원", "").toLongOrNull()
            val name = get(iName).ifEmpty { get(iOrig) }
            if (date == null || signed == null || signed == 0L || name.isEmpty()) {
                if (r.any { it.isNotBlank() }) skipped++
                return@mapNotNull null
            }
            val time = runCatching { LocalTime.parse(get(iTime).let { if (it.length == 4) "0$it" else it }) }.getOrNull()
            val category = get(iCat).ifEmpty { null }
            val kind = when {
                get(iTransfer) == "Y" -> Kind.TRANSFER
                signed < 0 && category == Categories.INCOME -> Kind.INCOME
                signed < 0 -> Kind.CANCEL
                else -> Kind.PAYMENT
            }
            val source = Source.entries.firstOrNull { it.label == get(iSource) } ?: Source.MANUAL
            Row(
                parsed = Parsed(
                    source = source,
                    kind = kind,
                    amount = kotlin.math.abs(signed),
                    merchant = get(iOrig).ifEmpty { name },
                    time = date.atTime(time ?: LocalTime.MIDNIGHT),
                    timeKnown = time != null,
                    installmentMonths = get(iInst).toIntOrNull() ?: 0,
                    cancelled = get(iCancel) == "Y",
                    raw = "",
                ),
                merchant = name,
                category = category,
                includeInSpending = get(iInclude) != "N",
                memo = get(iMemo),
            )
        }
        return Result(rows, skipped)
    }

    /** 따옴표 안의 쉼표·줄바꿈을 처리하는 CSV 읽기 */
    internal fun records(text: String): List<List<String>> {
        val out = mutableListOf<List<String>>()
        var row = mutableListOf<String>()
        val cell = StringBuilder()
        var quoted = false
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (quoted) {
                if (c == '"') {
                    if (i + 1 < text.length && text[i + 1] == '"') { cell.append('"'); i++ } else quoted = false
                } else cell.append(c)
            } else when (c) {
                '"' -> quoted = true
                ',' -> { row += cell.toString(); cell.clear() }
                '\r' -> Unit
                '\n' -> { row += cell.toString(); cell.clear(); out += row; row = mutableListOf() }
                else -> cell.append(c)
            }
            i++
        }
        if (cell.isNotEmpty() || row.isNotEmpty()) { row += cell.toString(); out += row }
        return out.filter { r -> r.any { it.isNotBlank() } }
    }

    fun Row.toNewTx(): Tx = Tx(
        id = 0,
        time = parsed.time,
        timeKnown = parsed.timeKnown,
        amount = parsed.amount,
        merchant = merchant,
        originalMerchant = parsed.merchant,
        category = category,
        source = parsed.source,
        kind = parsed.kind,
        cancelled = parsed.cancelled,
        includeInSpending = includeInSpending,
        installmentMonths = parsed.installmentMonths,
        memo = memo,
    )
}
