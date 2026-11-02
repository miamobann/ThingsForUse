package budget.core

import java.time.Duration

/**
 * 자동으로 합쳐지지 않았지만 같은 결제가 두 번 잡혔을 수 있는 쌍을 찾는다. 지우는 건 사용자가 고른다.
 * - 출처가 다르고 금액이 같으면: 시각을 둘 다 알면 10분 안, 하나라도 날짜만 있으면 같은 날
 * - 출처가 같으면: 시각을 둘 다 알고 2분 안일 때만 (같은 날 같은 금액이라도 시각이 다르면 다른 결제)
 * - 승인번호가 서로 다르면 다른 결제
 */
object DuplicateCheck {
    const val OTHER_SOURCE_MINUTES = 10L
    const val SAME_SOURCE_MINUTES = 2L

    data class Suspect(val a: Tx, val b: Tx) {
        val key: String get() = keyOf(a.id, b.id)
    }

    fun keyOf(x: Long, y: Long): String = "${minOf(x, y)}-${maxOf(x, y)}"

    fun suspects(txs: List<Tx>, dismissed: Set<String> = emptySet()): List<Suspect> {
        val out = mutableListOf<Suspect>()
        txs.filter { (it.kind == Kind.PAYMENT || it.kind == Kind.TRANSFER) && !it.cancelled }
            .groupBy { it.amount }
            .values.filter { it.size > 1 }
            .forEach { group ->
                val sorted = group.sortedBy { it.time }
                for (i in sorted.indices) for (j in i + 1 until sorted.size) {
                    val a = sorted[i]
                    val b = sorted[j]
                    if (Duration.between(a.time, b.time).toDays() > 1) break
                    if (looksSame(a, b) && keyOf(a.id, b.id) !in dismissed) out += Suspect(a, b)
                }
            }
        return out.sortedByDescending { it.b.time }
    }

    fun looksSame(a: Tx, b: Tx): Boolean {
        if (a.id == b.id || a.amount != b.amount) return false
        if (a.approvalNo != null && b.approvalNo != null && a.approvalNo != b.approvalNo) return false
        val minutes = kotlin.math.abs(Duration.between(a.time, b.time).toMinutes())
        val bothTimed = a.timeKnown && b.timeKnown
        return if (a.source == b.source) bothTimed && minutes <= SAME_SOURCE_MINUTES
        else if (bothTimed) minutes <= OTHER_SOURCE_MINUTES
        else a.time.toLocalDate() == b.time.toLocalDate()
    }
}
