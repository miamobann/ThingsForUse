package budget.core

import java.time.LocalDate
import java.time.LocalDateTime

/**
 * 직접 입력의 가게명·메모 자동 완성.
 * 후보 = 저장된 기록에 나온 값. 많이 쓴 순, 같으면 최근 순.
 * 검색은 대소문자 무시 부분 일치 + 초성 검색(ㅅㅂ → 스타벅스, 스ㅂ → 스타벅스).
 */
object Autocomplete {

    data class Candidate(val text: String, val count: Int, val last: LocalDateTime)

    private val CHOSUNG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"

    /** 한글 음절이면 초성, 아니면 null */
    fun chosungOf(c: Char): Char? = if (c in '가'..'힣') CHOSUNG[(c - '가') / 588] else null

    private fun isChosung(c: Char) = c in CHOSUNG

    /** 후보 목록 만들기. 빈 값·숨긴 값은 뺀다. 공백·대소문자만 다른 값은 최근 표기로 합친다. */
    fun build(values: List<Pair<String, LocalDateTime>>, hidden: Set<String> = emptySet()): List<Candidate> {
        val hiddenKeys = hidden.map { norm(it) }.toSet()
        return values.asSequence()
            .map { (v, t) -> v.trim() to t }
            .filter { (v, _) -> v.isNotEmpty() && norm(v) !in hiddenKeys }
            .groupBy { (v, _) -> norm(v) }
            .values.map { group ->
                val latest = group.maxBy { it.second }
                Candidate(latest.first, group.size, latest.second)
            }
            .sortedWith(compareByDescending<Candidate> { it.count }.thenByDescending { it.last })
    }

    /** 가게명 후보: 결제대행사 이름만 있는 기록은 뺀다 */
    fun merchants(txs: List<Tx>, hidden: Set<String> = emptySet()): List<Candidate> =
        build(txs.filter { !Merchants.isPaymentAgentOnly(it.merchant) }.map { it.merchant to it.time }, hidden)

    fun memos(txs: List<Tx>, hidden: Set<String> = emptySet()): List<Candidate> =
        build(txs.map { it.memo to it.time }, hidden)

    /** 입력값과 맞는 후보 [limit]개. 앞부분이 맞는 후보가 먼저. 입력값과 똑같은 후보는 뺀다. */
    fun suggest(cands: List<Candidate>, query: String, limit: Int = 5): List<Candidate> {
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        val nq = norm(q)
        return cands.asSequence()
            .filter { norm(it.text) != nq }
            .mapNotNull { c -> matchAt(c.text, q)?.let { pos -> c to pos } }
            .sortedBy { (_, pos) -> if (pos == 0) 0 else 1 }   // 안정 정렬이라 같은 그룹 안은 빈도순 유지
            .take(limit)
            .map { it.first }
            .toList()
    }

    /** 맞으면 맞는 위치(공백 뺀 기준), 아니면 null */
    fun matchAt(text: String, query: String): Int? {
        val t = text.lowercase().filterNot { it.isWhitespace() }
        val q = query.lowercase().filterNot { it.isWhitespace() }
        if (q.isEmpty() || q.length > t.length) return null
        for (start in 0..t.length - q.length) {
            var ok = true
            for (j in q.indices) {
                val tc = t[start + j]
                val qc = q[j]
                if (tc == qc) continue
                if (isChosung(qc) && chosungOf(tc) == qc) continue
                ok = false
                break
            }
            if (ok) return start
        }
        return null
    }

    private fun norm(s: String) = s.lowercase().filterNot { it.isWhitespace() }
}

/** 직접 입력 저장 전: 같은 날 같은 금액으로 이미 있는 기록 (누락된 줄 알고 다시 넣는 경우 막기) */
object SameDay {
    fun find(txs: List<Tx>, date: LocalDate, amount: Long, kind: Kind): List<Tx> {
        val kinds = if (kind == Kind.INCOME) setOf(Kind.INCOME) else setOf(Kind.PAYMENT, Kind.TRANSFER)
        return txs.filter { it.time.toLocalDate() == date && it.amount == amount && it.kind in kinds && !it.cancelled }
    }
}
