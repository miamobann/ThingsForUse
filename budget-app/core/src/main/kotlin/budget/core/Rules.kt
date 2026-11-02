package budget.core

/**
 * 분류 기억. 찾는 순서: 메모·이름의 단어 규칙(치즈 '중천' = 후원) → 가게+금액 → 가게.
 * 가게 하나에 대분류 하나가 기본이고, 같은 가게라도 금액마다 다르면(치지직 4,900원 = 구독, 그 밖 = 후원)
 * '가게@금액' 규칙을 따로 둔다. 찾을 때는 금액 규칙이 먼저.
 */
object Rules {
    fun amountKey(ruleKey: String, amount: Long): String = "$ruleKey@$amount"

    /** 찾을 순서: 가게+금액, 가게 */
    fun lookupKeys(merchant: String, kind: Kind, amount: Long): List<String> {
        val k = MoneyFlow.ruleKey(merchant, kind)
        return listOf(amountKey(k, amount), k)
    }

    /** 단어 규칙 열쇠 (가게 규칙과 같은 표에 둔다) */
    const val WORD_PREFIX = "w:"

    fun wordKey(word: String): String = WORD_PREFIX + word.trim().lowercase()

    /** 분류할 때 단어를 찾아볼 글: 가게 이름, 카드 표시 이름, 메모(상품명), 알림 원문 */
    fun textOf(t: Tx): String = listOf(t.merchant, t.originalMerchant, t.memo, t.raw).joinToString("\n").lowercase()

    /** 단어 규칙(단어 → 대분류) 중 글에 들어 있는 것. 긴 단어가 먼저. */
    fun matchWord(words: Map<String, String>, text: String): String? {
        val lower = text.lowercase()
        return words.entries.filter { it.key.isNotBlank() && lower.contains(it.key.lowercase()) }
            .maxByOrNull { it.key.length }?.value
    }

    data class Seen(val merchant: String, val kind: Kind, val amount: Long, val category: String)

    /**
     * 이미 분류된 내역(가져온 CSV 등)에서 규칙을 배운다.
     * - 가게 규칙: 그 가게에서 가장 많이 쓴 대분류
     * - 금액 규칙: 같은 금액이 2건 이상이고 모두 같은 대분류인데 가게 규칙과 다를 때
     */
    fun learn(seen: List<Seen>): Map<String, String> {
        val out = mutableMapOf<String, String>()
        seen.filter { !Merchants.isPaymentAgentOnly(it.merchant) }
            .groupBy { MoneyFlow.ruleKey(it.merchant, it.kind) }
            .filterKeys { it.isNotEmpty() && it != "in:" }
            .forEach { (key, list) ->
                val main = list.groupingBy { it.category }.eachCount().maxByOrNull { it.value }!!.key
                out[key] = main
                list.groupBy { it.amount }.forEach { (amount, same) ->
                    val cats = same.map { it.category }.toSet()
                    if (same.size >= 2 && cats.size == 1 && cats.first() != main) out[amountKey(key, amount)] = cats.first()
                }
            }
        return out
    }
}
