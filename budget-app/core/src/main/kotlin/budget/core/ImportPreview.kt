package budget.core

/** 파일을 실제로 넣기 전에 몇 건이 새로 들어가고 몇 건이 겹치는지 미리 계산한다. */
object ImportPreview {

    data class Summary(
        val added: List<Parsed>,
        val duplicates: Int,
        val cancels: Int,
        val attached: Int,
        val ignored: Int,
    )

    /** @param independentRows 파일 안의 줄끼리는 비교하지 않는다 (이미 정리된 가계부 CSV) */
    fun simulate(rows: List<Parsed>, existing: List<Tx>, independentRows: Boolean = false): Summary {
        val list = existing.toMutableList()
        val consumed = mutableSetOf<Long>()
        var nextId = (existing.maxOfOrNull { it.id } ?: 0L) + 1_000_000L
        val added = mutableListOf<Parsed>()
        var dup = 0
        var cancels = 0
        var attached = 0
        var ignored = 0
        for (p in rows) {
            when (val d = Matcher.decide(p, list, consumed)) {
                Matcher.Decision.Insert -> {
                    val t = p.toTx(nextId++, null)
                    if (!independentRows) list += t
                    consumed += t.id
                    added += p
                }
                is Matcher.Decision.Duplicate -> {
                    consumed += d.existing.id
                    dup++
                }
                is Matcher.Decision.Cancel -> {
                    list.replaceAll { if (it.id == d.target.id) it.copy(cancelled = true) else it }
                    cancels++
                }
                is Matcher.Decision.AttachCard, is Matcher.Decision.AttachNaverPay -> attached++
                Matcher.Decision.Ignore -> ignored++
            }
        }
        return Summary(added, dup, cancels, attached, ignored)
    }
}

fun Parsed.toTx(id: Long, category: String?): Tx {
    val notSpending = NotSpending.ruleFor(this)
    return Tx(
    id = id,
    time = time,
    timeKnown = timeKnown,
    amount = amount,
    merchant = Merchants.displayName(merchant),
    originalMerchant = merchant,
    category = notSpending?.category ?: category,
    includeInSpending = notSpending == null,
    source = source,
    kind = kind,
    approvalNo = approvalNo,
    installmentMonths = installmentMonths,
    raw = raw,
    )
}
