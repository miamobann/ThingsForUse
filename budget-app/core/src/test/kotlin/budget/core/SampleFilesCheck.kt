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

/** 분석 프로그램이 내보낸 가계부 CSV 확인: BUDGET_CSV=파일 경로 */
class AppCsvSampleCheck {
    @kotlin.test.Test
    fun readAppCsvSample() {
        val path = System.getenv("BUDGET_CSV") ?: return
        val r = AppCsv.parse(java.io.File(path).readText())
        val txs = r.rows.mapIndexed { i, row -> with(AppCsv) { row.toNewTx() }.copy(id = i + 1L) }
        val total = txs.sumOf { Stats(txs, true).effective(it) }
        println("rows=${r.rows.size} skipped=${r.skipped} total=$total kinds=${txs.groupingBy { it.kind }.eachCount()} sources=${txs.groupingBy { it.source }.eachCount()}")
        // 앱에 넣을 때처럼 하나씩 Matcher에 돌려본다
        val list = mutableListOf<Tx>()
        val counts = mutableMapOf<String, Int>()
        r.rows.forEachIndexed { i, row ->
            val d = Matcher.decide(row.parsed.copy(cancelled = false), list)
            counts.merge(d::class.simpleName ?: "?", 1, Int::plus)
            if (d == Matcher.Decision.Insert) list += with(AppCsv) { row.toNewTx() }.copy(id = i + 1L)
        }
        println("decisions(서로 비교)=$counts")
        val preview = ImportPreview.simulate(r.rows.map { it.parsed.copy(cancelled = false) }, emptyList(), independentRows = true)
        println("빈 앱에 넣으면 추가 ${preview.added.size}건")
    }
}
