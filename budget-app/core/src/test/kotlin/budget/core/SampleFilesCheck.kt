package budget.core

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * 실제 카드 파일로 확인하고 싶을 때만 돈다: BUDGET_SAMPLES=파일이 있는 폴더 경로.
 * 개인 결제 내역이라 파일은 저장소에 넣지 않는다.
 */
class SampleFilesCheck {
    @Test
    fun readAllSampleFiles() {
        val dir = System.getenv("BUDGET_SAMPLES") ?: return
        val files = File(dir).walk().filter { it.isFile && it.name.endsWith(".xls") }.toList()
        val all = mutableListOf<Tx>()
        val counts = mutableMapOf<String, Int>()
        var id = 1L
        for (f in files.sortedBy { it.name }) {
            val r = HyundaiCardFileParser.parse(f.readText())
            assertTrue(r != null, "못 읽음: ${f.name}")
            val consumed = mutableSetOf<Long>()
            for (p in r.rows) {
                val d = Matcher.decide(p, all, consumed)
                counts[d::class.simpleName!!] = (counts[d::class.simpleName!!] ?: 0) + 1
                when (d) {
                    Matcher.Decision.Insert -> {
                        all += Tx(id++, p.time, p.timeKnown, p.amount, p.merchant, p.merchant, null, p.source, p.kind, approvalNo = p.approvalNo)
                        consumed += all.last().id
                    }
                    is Matcher.Decision.Duplicate -> consumed += d.existing.id
                    is Matcher.Decision.Cancel -> all.replaceAll { if (it.id == d.target.id) it.copy(cancelled = true) else it }
                    else -> Unit
                }
            }
            println("${f.name}: ${r.type.label} ${r.title} ${r.rows.size}행")
        }
        println("결정: $counts, 저장 ${all.size}건, 취소표시 ${all.count { it.cancelled }}건, 취소단독 ${all.count { it.kind == Kind.CANCEL }}건")
        val s = Stats(all, true)
        s.monthly(java.time.YearMonth.of(2026, 11), 12).forEach { println("${it.first}: ${it.second}") }
    }
}
